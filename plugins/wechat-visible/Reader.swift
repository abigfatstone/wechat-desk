import AppKit
import ScreenCaptureKit
import Vision

struct Line: Encodable { let line: Int; let text: String }
struct Snapshot: Encodable { let scope: String; let capturedAt: String; let lines: [Line] }
enum Failure: String, Error { case permission = "请在系统设置的屏幕录制权限中允许当前宿主，再重新打开。"; case window = "请登录微信并打开要读取的聊天窗口，保持窗口未最小化。"; case empty = "微信窗口右侧未识别到文字，请打开聊天后重试。" }
@main struct Reader {
  static func main() async {
    _ = NSApplication.shared
    do {
      guard CGPreflightScreenCaptureAccess() else { throw Failure.permission }
      let available = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      let windows = available.windows.filter { $0.owningApplication?.bundleIdentifier == "com.tencent.xinWeChat" && $0.windowLayer == 0 && $0.frame.width >= 480 && $0.frame.height >= 300 }
      guard let w = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { throw Failure.window }
      let filter = SCContentFilter(desktopIndependentWindow: w)
      let config = SCStreamConfiguration(); config.showsCursor = false; config.ignoreShadowsSingleWindow = true
      config.width = Int(w.frame.width * 2); config.height = Int(w.frame.height * 2)
      let img = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      let req = VNRecognizeTextRequest(); req.recognitionLevel = .accurate; req.recognitionLanguages = ["zh-Hans", "en-US"]; req.usesLanguageCorrection = true
      // Approximate conversation pane; never capture another app or persist the image.
      req.regionOfInterest = CGRect(x: 0.38, y: 0.06, width: 0.62, height: 0.93)
      try VNImageRequestHandler(cgImage: img).perform([req]); let texts = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }.filter { !$0.isEmpty }
      guard !texts.isEmpty else { throw Failure.empty }
      let data = try JSONEncoder().encode(Snapshot(scope:"微信当前窗口右侧可见文字（OCR）；可能含标题和界面标签，不是历史全库，不能据此确定发送者", capturedAt:ISO8601DateFormatter().string(from: Date()), lines:texts.prefix(150).enumerated().map { Line(line:$0.offset+1,text:$0.element) }))
      FileHandle.standardOutput.write(data)
    } catch { let message = (error as? Failure)?.rawValue ?? "微信窗口读取失败：\(error.localizedDescription)"; FileHandle.standardError.write(Data(message.utf8)); exit(1) }
  }
}
