# 微信工作台 / WeChat Desk

把本机微信（macOS 4.2.x）的聊天记录变成可查询、可引用的本地资料：命令行查，或者在微信里直接问一个机器人。

**只读。数据不出本机。**

---

## 它解决什么

微信的历史只能翻，不能查。这个工具在本机做三件事：

1. 用 SQLCipher 只读打开微信自己的加密库，不复制聊天明文。
2. 提供 `list / read / search / recent / summary / events` 六个查询，输出带会话名、时间、原话。
3. 可选：把查询能力接到微信里的一个机器人上，你发一句话，它回一段带出处的答案。

## 为什么不是截图/导出

- 不截图、不模拟点击、不依赖界面。
- 不做全量导出、不建索引、不上传。每次查询现读现算。
- 代回别人只拟草稿，不代发。

## 安装

要求：macOS 12+，Node 22+，微信 4.2.x 桌面版并已登录。

```bash
git clone <this-repo>
cd wechat-desk
node --test test/*.test.mjs        # 89 个测试，不读任何个人数据
```

准备运行时（自带 Python 3.12 + SQLCipher，不需要 Homebrew）：

```bash
node bin/wechatdesk.mjs probe --root "$HOME/Library/Application Support/WeChatDesk"
```

取 key（唯一必须本人扫码的环节）：

```bash
# 复制并 ad-hoc 签名一份微信副本，/Applications 里的官方 app 不会被改动
node bin/wechatdesk.mjs key prepare --root "$HOME/Library/Application Support/WeChatDesk"
# 拉起副本，显示登录页；扫码登录后 raw key 会被捕获并立刻验证
node bin/wechatdesk.mjs key start  --root "$HOME/Library/Application Support/WeChatDesk"
node bin/wechatdesk.mjs key wait   --root "$HOME/Library/Application Support/WeChatDesk"
```

查询：

```bash
node bin/wechatdesk.mjs query search --root "$HOME/Library/Application Support/WeChatDesk" \
  --value "交付日期" --days 7 --limit 20
```

## 接入微信机器人（可选）

```bash
node bin/wechatdesk.mjs bind --root "$HOME/Library/Application Support/WeChatDesk"
```

扫码后微信里会多一个机器人联系人。它只回答你本人的私聊，群消息和陌生人一律忽略。回答需要模型，模型只在零点（Zero）进程内，所以机器人常驻依赖宿主在运行。

## 安全模型

- raw key 只存在 `~/Library/Application Support/WeChatDesk/key.txt`（0600），只经 stdin 传给子进程，不进 argv、不进日志、不进状态文件。
- 查询子进程以只读方式打开数据库（`-readonly` + `query_only`）。
- 取 key 用的是一份 ad-hoc 签名的**副本**：官方 `/Applications/WeChat.app` 的签名始终完好，不需要重装。
- 撤销：删除 `key.txt`、`binding.json` 即可；签名副本单独删除（约 1.4 GB）。

## 已知限制

- 只覆盖 macOS。Windows 的取 key 路线（明文镜像）尚未移植。
- 微信升级到 4.3 之后钩子位置可能变化；`probe` 会把版本标成 `supported: false`，`verify-key` 直接返回 `UNSUPPORTED_WECHAT`，不会让你白重登一次。
- 取 key 时微信会重登一次；官方 app 重开时通常停在登录页，点「进入微信」即可。

## 作为零点插件

本仓库同时是一个零点插件市场源：

```
.agents/plugins/marketplace.json
```

在零点「设置 → 插件」里添加本仓库地址，即可安装 `微信工作台`。

## 许可

MIT，见 `LICENSE`。`vendor/wechat-decrypt` 是 [tzwkb/wechat-decrypt](https://github.com/tzwkb/wechat-decrypt) 在固定 commit 上的原样副本（MIT），见 `THIRD_PARTY.md`。

## 免责

仅供读取你本人拥有或获授权访问的本机数据。修改客户端签名并在其中加载调试器属于微信不支持的用法，请自行评估账号风险。
