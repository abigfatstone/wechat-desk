// Hook CCKeyDerivationPBKDF and capture WeChat's 32-byte raw key.
//
// Upstream's version attaches once, at script load time, and silently does
// nothing if libcommonCrypto has not been mapped yet. In a spawn-suspend
// startup that is exactly what happens: WeChat loads CommonCrypto only after
// main() starts. So this version keeps looking for the symbol until it appears.
//
// Filter: WeChat derives each database key with PBKDF2 over a 32-byte password
// (the raw key) for 256000 rounds. Nothing else in the process matches.

const captured = new Set();
let attached = false;

function attach() {
  let pbkdf = null;
  try {
    pbkdf = Module.findGlobalExportByName("CCKeyDerivationPBKDF");
  } catch (_) {
    return false;
  }
  if (!pbkdf) return false;

  Interceptor.attach(pbkdf, {
    onEnter(args) {
      const password = args[1];
      const passwordLen = args[2].toInt32();
      const rounds = args[6].toInt32();
      const derivedKey = args[7];
      const derivedKeyLen = args[8] ? args[8].toInt32() : 0;

      this.shouldCapture = derivedKeyLen === 32 && rounds > 1000 && passwordLen === 32;
      if (!this.shouldCapture) return;
      try {
        const bytes = password.readByteArray(passwordLen);
        const hex = Array.from(new Uint8Array(bytes))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (!captured.has(hex)) {
          captured.add(hex);
          console.log("RAW_KEY=" + hex);
          console.log("HOOK_CAPTURED");
        }
      } catch (_) {
        /* unreadable pointer: ignore, we will see the next call */
      }
    },
  });

  attached = true;
  console.log("HOOK_READY");
  return true;
}

if (!attach()) {
  console.log("HOOK_WAITING_FOR_COMMONCRYPTO");
  const timer = setInterval(() => {
    if (attach()) clearInterval(timer);
  }, 200);
  // Never keep the process alive just for the poller.
  if (timer.unref) timer.unref();
}
