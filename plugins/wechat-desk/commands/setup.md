---
description: 安装或排查微信工作台（复制微信、取 key、绑定机器人、常驻）
---
微信工作台的安装分四步，全部由本机脚本完成，不需要 Homebrew 或系统 Python：

1. `node bin/wechatdesk.mjs probe --root "$HOME/Library/Application Support/WeChatDesk"` —— 确认机器是否满足（磁盘 ≥ 2.5 GB、微信 4.2.x）。
2. `key prepare` 复制并 ad-hoc 签名微信副本（官方 app 不动），`key start` 拉起副本等扫码，`key wait` 等结果。
3. `bind` 生成二维码，用微信扫码把机器人绑上。
4. 启用插件后由 LaunchAgent 保活，微信里直接提问。

排查：`key status`（取 key 四态）、`query list`（能否读库）。不要代用户扫码，不要输入验证码，不要修改 `/Applications`。
