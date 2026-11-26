# 微信工作台（第三方插件）

在零点里查自己的微信历史，并在微信里直接提问。

## 它做什么

- 只读打开本机微信 4.2.x 的加密库（SQLCipher），不写、不改、不上传。
- 微信里给机器人发一句话，回一段带会话名、时间、原话的答案。
- 记录是谁说的、什么时候说的；代回别人只拟草稿，不代发。

## 安装

插件自带运行时（Python 3.12 + SQLCipher + Frida），不要求 Homebrew，也不要求系统 Python。

```
# 1. 探测
node bin/wechatdesk.mjs probe --root "$HOME/Library/Application Support/WeChatDesk"
# 2. 复制并签名微信副本（官方 app 不动）
node bin/wechatdesk.mjs key prepare --root "$HOME/Library/Application Support/WeChatDesk"
# 3. 拉起副本，扫码登录，抓 key
node bin/wechatdesk.mjs key start --root "$HOME/Library/Application Support/WeChatDesk"
node bin/wechatdesk.mjs key wait  --root "$HOME/Library/Application Support/WeChatDesk"
# 4. 绑定机器人
node bin/wechatdesk.mjs bind --root "$HOME/Library/Application Support/WeChatDesk"
```

第 3 步会打开一个微信副本并显示登录页：这是唯一必须本人扫码的环节，key 只存在于登录时的内存里。

## 边界

- 只回答绑定本人的私聊；群消息与陌生人一律忽略。
- 停用插件后轮询与查询立即停止。
- 撤销授权会删除 `key.txt`、`binding.json` 与拉取游标；1.4 GB 的微信副本单独确认。

## 已知限制

- 微信升级到 4.3 之后钩子位置可能变化，`key status` 会显示失败码而不是静默返回空结果。
- 答案要调模型，模型 API 只在零点进程内，所以零点需要处于运行状态。
