# 微信工作台 0.3：一体化安装设计

日期：2026-11-27
状态：待批准
取代：0.2.0（双宿主 + 终端向导 + 外置数据源）

## 意图

现在装一套「微信里能问自己聊天记录」的东西，用户要做四件事：装 tzwkb
（brew、venv、frida）、手动重签名微信、扫码重登取 key、再跑一次插件的
终端向导。0.2.0 的 README 把这四步写成了前置条件，也就等于把产品拆成了
半成品。

0.3 要的是：**装一次、扫一次，之后在微信里直接聊**。所有零件由插件自己
准备，用户看不到终端。

## 目标

- 安装是一次 **agent 现场执行**，不是写死的流水线：用户说一句，agent 探测
  机器、决定路径、逐步验证，全程无终端命令。
- 运行时由 agent 按现场情况准备：Python 3.12、SQLCipher、Frida、只读查询
  层，有现成的不重复装，没有的自己取。
- 取 key 收进产品：复制微信 → 重签名副本 → Frida 引导扫码 → 校验 key →
  落盘。失败可重试，不破坏 `/Applications/WeChat.app`。
- 授权一次覆盖整台机器，不再按 workspace 各授权一次。
- 微信里问「上周谁说了交付日期」，回答引用会话、时间、原话；代回只拟草稿。

## 非目标

- 不做云端托管。聊天库在本机且加密，云端取不到；本机必须留解密与查询的
  进程。
- 不改 `/Applications/WeChat.app` 的签名（见约束 1），不需要重装微信。
- 不做多微信账号、不做群消息代发、不做 Windows 的一体化取 key（Windows
  沿用 0.2.0 的明文镜像路线，单独迭代）。
- 不做聊天记录云端同步、不做向量索引、不做后台全量导入。

## 反目标

- 用户需要打开终端、需要 `brew install`、需要自己找 Python 路径——任一
  出现即视为本次设计失败。
- 任何一步失败后把微信留在「签名被破坏」的状态。
- 上传聊天明文或 raw key 到任何远端。
- 安装器要求关闭 SIP。

## 约束（2026-11-27 在本机实测）

1. **不能原地重签名**。`sudo codesign --force /Applications/WeChat.app`
   返回 `Operation not permitted`（App Management 保护，root 也无法绕过）。
   可行路径是复制 app、签副本、运行副本；官方签名保持完好，因此**不需要
   重装微信**。
2. **ad-hoc 签名不能带沙盒**。带 `com.apple.security.app-sandbox` 的
   ad-hoc 签名会被 AMFI 拒绝：`Code has restricted entitlements`。去掉
   entitlements 后可以运行，且实测微信仍从
   `~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/`
   读写，老数据不受影响。
3. **钩子对 4.2.0 有效**。`Resources/wechat.dylib`（337 MB）导入
   `_CCKeyDerivationPBKDF`；过滤条件 `dkLen==32 && rounds>1000 &&
   passwordLen==32` 能拿到 raw key。
4. **Frida CLI 不能后台跑**。`frida -f ... > log &` 时 stdin 立即 EOF，
   CLI 退出并把子进程带走。必须用 Python 绑定（spawn/attach/load/resume），
   或用管道保住 stdin。
5. **取 key 必然要重登一次微信**。key 是登录时从账号派生到内存的，磁盘上
   没有、钥匙串里也没有，无法离线获得。
6. **取完 key 后官方微信通常不用再扫码**。今天实测：重开
   `/Applications/WeChat.app` 会停在登录页，账号还在，点「进入微信」就进去
   了。个别情况下微信会要求重新扫码，那就按「重登」处理并明确告知。
7. **微信绑定走 ilink bot 通道**（`ilinkai.weixin.qq.com`，`bot_type=3`）：
   扫码拿 `bot_token`，长轮询 `getupdates`，`sendmessage` 回复。机器人在
   微信里是一个独立联系人，不冒充用户。
8. **回答需要零点运行时**。`bridge.mjs` 里 `answer()` 用
   `ctx.session.generate` 和 `ctx.session.create`，这是插件宿主提供的 API，
   脱离零点进程无法调用。
9. **宿主按工作区实例化插件**。`setup()` 在宿主实例化工作区时运行，零点
   启动会不会自动加载某个工作区，尚未验证；「启用即常驻」需要靠下面 §4 的
   监督进程保证。

## 方案选择

- **A. 本机一体化安装包（选中）**：插件自己带运行时和取 key 流程，一次装
  完，数据不出本机。
- B. 云端托管：微信连云端机器人，本机仍需代理解密与查询，等于 A 加一个
  云端，隐私面更大，不做。
- C. 维持 0.2.0 + 更好的文档：用户仍要装四样东西，与「一次性」直接冲突。

## 设计

### 1. 打包

安装目录 `~/Library/Application Support/WeChatDesk/<version>/`，同级
`current` 软链指向在用版本；卸载只删这个目录，不动用户数据。

内含：

- `runtime/python/` python-build-standalone 3.12（约 40 MB），
  `runtime/site-packages/` 预装 `frida`、`frida-tools`、`zstandard`；
- `runtime/bin/sqlcipher` 静态二进制（arm64 + x86_64，按安装时架构选）；
- `query/` 固定 commit 的只读查询层（现为 `8a28b83`），`query.py` 与
  `scripts/common/*` 原样保用，不做私有改动；
- `bridge/` 0.2.0 的桥接与 ilink 代码，去 openclaw 分支；
- `MACOS_BUILD` 记录封装日期与查询层 commit。

体积预算 ≤ 200 MB，不含微信副本。

### 2. 安装由 agent 执行

安装不是 `install.mjs` 那样的固定流水线，而是一个 skill：用户说「帮我装好
微信工作台」，零点里的 agent 读 playbook 在本机执行——先探测、再决定、每步
之后验证。

交付物三件：

- `skills/install/SKILL.md`：目标、前置探测、允许的步骤、每步的验证命令、
  失败码与处置、什么情况必须问人、什么情况必须停。
- `tools/`：只放不可再分的动作，每个脚本做一件事并返回结构化结果——
  `probe`（系统/微信版本/磁盘/已有依赖）、`prepare-runtime`、
  `prepare-query`、`copy-wechat`、`sign-copy`、`keyhook.py`（Frida 绑定）、
  `verify-key`、`bind`（ilink 扫码）、`status`。
- `state.json`：agent 写，记录阶段、结论、错误码；任何后续会话据此续跑。

agent 要自己判断的：

- 有 Homebrew 且已有 sqlcipher → 直接用；没有 → 取静态二进制。不要求用户
  先装 brew。
- 系统 Python 3.12 能建 venv → 用；否则取 standalone。
- 微信版本在支持矩阵内 → 继续；否则只装到「可聊天」，把取 key 标成不可用。
- `KEY_INVALID` → 复用已签的副本重取，不重新复制 1.4 GB。

护栏（写进 skill，不可协商）：

- 不 `sudo`、不改 `/Applications`、不关 SIP。
- 一次只做一步，做完必须验证；验证不过就停，回报事实，不猜着往下走。
- 重登微信、签名副本、删除副本，这三件事必须先问用户。
- 不在日志、state、命令行参数里出现 key。
- 同一失败不自动重试超过 2 次；每次失败保留日志路径。

为什么不做固定安装器：不同机器的 Python、Homebrew、微信版本、磁盘权限都
不一样，写死的分支很快变成一堆 `if`，出错只能吐一个错误码。让 agent 读
现场、决定、验证，能把「装不上」变成「它告诉我哪一步不对，为什么」。

代价：安装需要模型可用；同一台机器两次安装走的路径可能不同。用
`state.json` 加每步验证把不确定性收在边界内，运行时本身保持确定。

### 2.1 触发方式（平台能力）

0.2.0 已经在用、确认可用的三件事：

- 注册斜杠命令：`commands/setup.md` 会被装成 `/wechat-desk-setup`（见
  `zero-plugins/installed.json` 的 `commands` 字段）。
- 起会话并驱动模型：`bridge.mjs` 里 `ctx.session.create(...)` +
  `ctx.session.generate(...)` + `ctx.session.synthetic(...)`，已经在跑。
- 注册工具：`zero.mjs` 用 `ctx.tool.transform`。

所以「一句话安装」= 卡片按钮或一句话 → 插件起一个**可见的安装会话** →
agent 读 playbook 开始装。用户看到的是 agent 在做事，可以随时插话。

不做静默安装：`generate()` 是一次性的，不展示二维码、中途不能提问、不能
等用户确认签名副本。安装必须走真实会话。

未验证：插件包内 `skills/` 是否会被装进技能索引（`installed.json` 有
`skills` / `skillPaths` 字段，但 0.2.0 没用过）。兜底方案是把 playbook
内联进安装命令的提示词，不依赖索引。

### 3. 取 key 引导

1. 定位 `db_storage`，读微信版本；不在支持矩阵内（当前 4.2.x）直接说明并
   跳过，保留纯聊天。
2. `ditto /Applications/WeChat.app` 到安装目录 `wechat-copy/`（约 1.4 GB，
   磁盘不足先检查）。
3. `codesign --force --deep --sign -` 签副本，**不带** entitlements。
4. `keyhook.py` 以**独立守护进程**运行，不挂在 agent 那一轮里：它 spawn 副本、
   注入 `hook_pbkdf.js`、resume，把二维码写成图片文件、把捕获结果写进
   `state.json`，自己处理超时；agent 只读状态并向用户汇报。这样等待扫码能
   跨过多个对话轮次，宿主结束一轮也不会把微信和钩子一起收走。
5. 捕获到 key 立刻落盘 `0600`，然后**先用它真实打开一个 message 库**验证
   （`PRAGMA key` + `select count(*)`），通过才算成功。
6. 保留副本用于后续重取（微信升级后 key 可能变）；提供「删除副本」按钮。

失败码：`NO_SQLCIPHER` / `APP_COPY_FAILED` / `SIGN_FAILED` / `SPAWN_FAILED` /
`HOOK_NOT_FOUND`（版本变了）/ `LOGIN_TIMEOUT` / `KEY_INVALID`，每个都能
对应一句用户能懂的话和一个「重试」。

### 4. 常驻与授权

- 授权按用户：一份 `grant.json` 在安装目录，安装即授权。查询仍是只读子
  进程，参数不接受任意目录或命令。
- 桥接注册为**全局插件**（runtime 的全局插件目录），不再给每个 workspace
  写 `.opencode/plugins` 适配文件。这样一个进程、工具在所有工作区可见；每
  次调用仍校验 `grant` 与插件启用状态。
- 撤销语义拆开，不打包：撤销 = 删 key + 停长轮询 + 删 ilink binding，立即
  生效；已签的 1.4 GB 副本单独问是否删除（默认保留，重装要重签 + 重拷）。
  在市场里停用插件 → 查询与轮询立即停止，不需要用户再点撤销。
- key 放在版本目录之外的 `~/Library/Application Support/WeChatDesk/key.txt`
  （0600），升级不丢；`current` 软链只指向运行时本身。
- **启用即常驻，靠工作区适配器**（推翻初版的 LaunchAgent 方案）：市场安装只加载
  skills/commands/MCP，不加载 JS 入口，所以由 agent 在安装时写一行
  `<workspace>/.opencode/plugins/wechat-desk/index.ts` 再导出插件入口。宿主加载
  该工作区即执行插件 `setup()`，常驻循环、工具与模型调用都在零点进程内。
- **不做 launchd / supervisor**：回答要模型，模型只在零点进程里；脱离零点的
  常驻进程只能收消息、不能回答，是半成品。零点没启动时本来就答不了，正确做法
  是把零点设为登录启动项，而不是自建一个服务去拉它。
- 停用插件 → 删除适配器文件，轮询与查询同时停止。
- A2A 委派保留；peer 别名与 Agent UUID 由 agent 在会话里收集后写进
  `grant.json`（见 §6）。

### 5. 界面与状态

平台限制：插件包只能贡献静态清单字段（`displayName`、`description`、
`logo`、最多 5 条 `defaultPrompts`）、命令、skill 与 MCP 条目；宿主 API
只有 `ctx.tool.transform` 与 `ctx.session.*`，**没有插件 UI 或状态通道**。
所以不做有状态的卡片。

- 插件页保持静态：`defaultPrompts` 给三条——「安装/修复微信工作台」
  「提取聊天密钥」「查看状态」，点一条就是起一个会话。
- 状态在聊天里说：`/wechat-desk-status` 由 agent 读 `state.json` 后一句话
  汇报。
- 状态机四态：`未安装`、`待取 key`（可聊天、不能查历史）、`已连接`、
  `key 已失效`（查询报 `KEY_INVALID` 时自动降级并提示重取）。

微信侧：给机器人发「查项目群上周的交付日期」，回一段带会话名与时间的答案；
超长截断并提示到零点看全文。

### 6. 迁移 0.2.0

安装时扫描 `~/.zero-wechat-desk/*/grant.json`：存在则把 `binding`、`sync`
游标、`peers`（别名 + Agent UUID）迁到新位置，旧 workspace 的授权保留到
用户手动撤销（不静默删用户数据）。若 binding 已失效，提示重新扫码。新增
用户没有旧 grant 时，peers 留空，由 agent 在会话里按需补。

0.2.0 的两条数据源路线怎么处理：**`tzwkb` 变成内置**（不再让用户准备）；
**`archive`（导入的 TXT/JSONL）保留**，作为「用户不愿为取 key 重登微信」时
的降级路径，`history.mjs` 继续支持两种 source kind。`setup.mjs` 保留，但
只作为 agent 调用的脚本层（`status`/`disable`/`unlock`），不再是用户入口；
`/wechat-desk-setup` 命令改为「引导 agent 执行安装」。

## 风险

- 微信升级导致 `_CCKeyDerivationPBKDF` 钩子失效：靠 `HOOK_NOT_FOUND` 明示，
  不做猜测性适配。
- 副本触发反复的 TCC 权限弹窗：UI 说明这是副本的代价，官方 app 不受影响。
- 账号风控：改签名 + 挂调试器属微信不支持的用法，需在首次启用时明确告知，
  由用户确认后继续。
- 插件市场对下载二进制的限制：若不允许外网取运行时，改为包内置（体积换
  确定性），由 agent 在探测阶段判断用哪条。

## 需要构建者决定

- 运行时用 python-build-standalone 还是直接把查询层用 Node 重写（后者能
  去掉 40 MB 与 Python 依赖，但等于重写 SQLCipher 访问层）。
- 已决定不加 LaunchAgent（见 §4）：自建常驻进程拿不到模型，只能排队消息。
- 静态 SQLCipher 的来源与更新策略（自建构建 vs 可信第三方产物）。
- skill 里哪些步骤允许 agent 自行决定、哪些必须用户点头，护栏已给底线，
  细化到步骤粒度留给构建者。

## 验收

- 单元：`node --test test/desk.test.mjs`，合成数据库，不读个人数据。
- 安装 playbook：用 `state.json` 的假现场跑三种断点（运行时半装、key 失效、
  绑定过期），断言 agent 走对分支、不重复下载、不重复签副本。
- 脚本层：`tools/` 每个脚本的输入校验与失败码，含「参数里不允许出现 key」。
- 取 key：用一个假 app（自建 Mach-O 桩）跑通 spawn / 注入 / 超时 / 校验，
  CI 不碰真实微信。
- 本机端到端：从「跟 agent 说装好微信工作台」到「微信里问一句话得到带出处
  的回答」，中间不打开终端；失败路径各录一次错误码与文案。

## 决策记录（我定的，你可以否）

1. **不做有状态卡片**。插件没有 UI/状态通道，做卡片要改零点 web 端，等于
   第二个代码库；改为静态 `defaultPrompts` + 聊天里报状态。
2. **桥接走全局插件**。每个 workspace 写适配文件会让"授权一次覆盖全机"变成
   空话；全局注册才有一个进程、所有工作区可用。
3. **撤销与删除分开**。撤销立即删 key、停轮询、删 binding；1.4 GB 副本默认
   保留，单独问。市场停用插件等同于撤销运行能力。
4. **key 存版本目录之外**。升级不丢 key，`current` 只切运行时。
5. **保留 archive 降级源**。用户不愿为取 key 重登微信时，仍可用导入目录。
6. **`setup.mjs` 降级为脚本层**。只给 agent 调 `status/disable/unlock`，
   不再是用户入口。
7. **加第四态「key 已失效」**。查询报 `KEY_INVALID` 自动降级并提示重取；
   微信重登或用官方版升级都会触发，这是最可能的第一个支持工单。
8. **keyhook 改为守护进程**。等待扫码要跨多轮对话，不能压在一个 turn 里。
9. **启用即常驻**。插件 enabled 就必须一直在收消息；LaunchAgent supervisor
   负责拉起宿主与工作区。实测不成立时降级并明说，不假装。
10. **官方微信按「点一下就回」处理**。取 key 后官方 app 回到登录页，账号
   还在，点「进入微信」即可；只有微信主动要求扫码时才提示重登。

## 已确认

1. 取 key 之后官方微信**不需要再扫码**：会回到登录页，点「进入微信」就进去；
   个别情况微信会重新要求扫码，按重登处理并告知。（用户 2026-11-27 确认）
2. 常驻程度：**插件 enable 就应当常驻**，不做「打开工作区才生效」的妥协。
   由 §4 的 supervisor 实现；若宿主能力不支持，降级必须明示。

## 留给构建者

- 插件包内 `skills/` 是否被索引：未验证。不被索引就把 playbook 内联进命令
  提示词，不额外造机制。
