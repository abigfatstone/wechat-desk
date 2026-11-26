# 第三方代码

## vendor/wechat-decrypt

- 来源：https://github.com/tzwkb/wechat-decrypt
- 固定 commit：`8a28b83e5d0b73180b915f68f5cc7dc464c26639`
- 许可：MIT（原文见 `vendor/wechat-decrypt/LICENSE`）
- 改动：无。原样引入，只读查询层由 `lib/query-layer.mjs` 调用，本仓库不修改其源码。

`vendor/wechat-decrypt/scripts/macos/hook_pbkdf.js` 是取 key 时注入微信副本的 Frida 脚本，同样来自上述项目。

## plugins/wechat-desk/vendor/qr.cjs

- 来源：qrcode-terminal 0.12.0 的构建产物
- 许可：见同目录 `LICENSE.qrcode-terminal` 与 `NOTICE.txt`
- 用途：在终端渲染微信返回的绑定二维码。
