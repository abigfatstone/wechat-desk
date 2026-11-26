# 微信工作台 0.3 · 查询运行时 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本机准备一套自包含运行时，使得给定一个 raw key 就能只读查询微信 4.2 的消息库，并且所有失败都有稳定错误码。

**Architecture:** 运行时 = 固定的目录布局（`runtime/<version>/` 放 Python 与 SQLCipher，`query/` 放固定 commit 的查询层，`key.txt` 在层根），由一组单职责脚本准备与使用。脚本只做一件事、返回结构化 JSON；不做安装流程编排，那是 agent playbook 的事（后续计划）。

**Tech Stack:** Node.js 22（ESM，`node:test`）、python-build-standalone 3.12、静态 SQLCipher、上游只读查询层 `tzwkb/wechat-decrypt@8a28b83`

**Spec:** `docs/superpowers/specs/2026-11-27-one-click-wechat-desk-design.md`

## Global Constraints

- 只读：打开数据库必须 `PRAGMA query_only=ON`，任何写路径都不允许。
- raw key 只允许出现在两处：`key.txt`（0600）和传给子进程的 stdin。禁止出现在 argv、日志、`state.json`、错误消息里。
- 不调用 `sudo`，不修改 `/Applications`，不要求关闭 SIP。
- 上游查询层按 commit `8a28b83e5d0b73180b915f68f5cc7dc464c26639` 原样引入，不改源码；需要改行为就在本仓库包一层。
- 安装根目录 `~/Library/Application Support/WeChatDesk/`，版本目录 `<version>/`，`current` 是软链；`key.txt` 放在根目录，不在版本目录里（升级不丢 key）。
- 所有脚本的 stdout 是 JSON（`JSON.parse` 可直接用），诊断信息走 stderr。
- 错误码固定集合：`BAD_ARGS` `NO_RUNTIME` `NO_QUERY_LAYER` `NO_WECHAT` `UNSUPPORTED_WECHAT` `KEY_INVALID` `DB_BUSY` `TIMEOUT` `IO_ERROR`。

## Review Focus

1. **半装状态**：`prepare` 中途被杀后再跑，不能重复下载、不能留下半个运行时。任何一步失败都必须让 `status` 看得出来。
2. **key 泄漏**：进程列表（`ps`）、stderr、`state.json`、错误对象里都不得出现 key 的原文或前缀。
3. **版本误判**：微信不在支持矩阵时必须回 `UNSUPPORTED_WECHAT`，不能退化成 `KEY_INVALID` 让用户白重登一次。
4. **库被占用**：微信正在写入时（WAL 有未提交页），只读打开要么读到最后一次提交，要么明确回 `DB_BUSY`，不能返回半写数据。
5. **输出完整性**：中文与 emoji 必须原样往返，长结果不能被 `maxBuffer` 截断成非法 JSON。

---

### Task 0: 仓库骨架

**Files:**
- Create: `package.json`（根，`"type": "module"`, `engines.node >= 22`, `scripts.test = "node --test test/"`）
- Create: `bin/wechatdesk.mjs`
- Create: `lib/state.mjs`
- Create: `lib/errors.mjs`
- Test: `test/state.test.mjs`

**Interfaces:**
- Produces:
  - `class DeskError extends Error { code: string; detail?: unknown }`
  - `readState(root: string): Promise<State>`，文件不存在返回 `{}`
  - `mergeState(root: string, patch: object): Promise<State>`，原子写（临时文件 + rename），0600
  - `CODES: Record<string, string>`（全局约束里的 9 个码）

- [ ] **Step 1: 初始化仓库**

`/Users/code/wechat-desk` 目前不是 git 仓库。先 `git init`，用 `.gitignore` 排除 `node_modules/`、`decrypted/`、`key.txt`、`state.json`、`.venv/`，提交当前 0.2.0 代码作为基线。

- [ ] **Step 2: 写失败测试**

```js
// test/state.test.mjs
test("mergeState 原子写且权限 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-"));
  await mergeState(root, { runtime: { version: "1.0.0" } });
  const mode = (await stat(join(root, "state.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual((await readState(root)).runtime.version, "1.0.0");
});

test("readState 在文件缺失时返回空对象", async () => {
  assert.deepEqual(await readState(await mkdtemp(join(tmpdir(), "desk-"))), {});
});

test("DeskError 携带稳定 code", () => {
  assert.equal(new DeskError("KEY_INVALID").code, "KEY_INVALID");
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/state.test.mjs`
Expected: FAIL，`Cannot find module '../lib/state.mjs'`

- [ ] **Step 4: 实现 `lib/errors.mjs` 与 `lib/state.mjs`**

`mergeState` 用 `writeFile(tmp, ..., {mode: 0o600})` + `rename`；合并是浅合并到顶层键，嵌套由调用方整体覆盖（不做深合并，避免语义歧义）。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/state.test.mjs`
Expected: PASS，3 个测试

- [ ] **Step 6: 提交**

```bash
git add package.json bin lib test .gitignore
git commit -m "chore: 0.3 骨架与状态/错误基础"
```

---

### Task 1: `probe`

**Files:**
- Create: `lib/probe.mjs`
- Create: `bin/wechatdesk.mjs`（子命令 `probe`）
- Test: `test/probe.test.mjs`

**Interfaces:**
- Produces: `probe(opts?: { appPath?: string, dataRoot?: string }): Promise<Probe>`
  - `Probe = { arch, macos, disk: { freeBytes, requiredBytes, ok }, wechat: { version, appPath, supported, dbs: Array<{ path, size }> } | null, deps: { sqlcipher: string | null, python: string | null, brew: boolean } }`
  - `SUPPORTED_WECHAT = /^4\.2\./`
  - 微信缺失时 `wechat = null`，不抛错；`disk.requiredBytes = 2_500_000_000`（副本 1.4 GB + 运行时 0.2 GB + 余量）

- [ ] **Step 1: 写失败测试**

```js
test("不支持版本标记 supported=false 但仍返回 dbs", async () => {
  const p = await probe({ appPath: fixtureApp("4.1.0"), dataRoot: fixtureData() });
  assert.equal(p.wechat.supported, false);
  assert.equal(p.wechat.dbs.length, 1);
});

test("微信不存在时 wechat 为 null 而不抛错", async () => {
  const p = await probe({ appPath: "/nonexistent/WeChat.app", dataRoot: "/nonexistent" });
  assert.equal(p.wechat, null);
});

test("磁盘不足时 disk.ok=false", async () => {
  const p = await probe({ freeBytes: 1000 });
  assert.equal(p.disk.ok, false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/probe.test.mjs`
Expected: FAIL，`probe is not a function`

- [ ] **Step 3: 实现 `probe`**

版本从 `Info.plist` 读 `CFBundleShortVersionString`（用 `plutil -extract ... -o - json -` 或读 plist 文本，选一种并在代码注释里写明）。db 列表取 `dataRoot/xwechat_files/*/db_storage/message/message_[0-9].db`，按 mtime 选最新账号。`freeBytes` 用 `statfs`（`node:fs.statfs`）。依赖探测：`which sqlcipher`、`python3 --version` 是否 ≥3.10、`which brew`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/probe.test.mjs`
Expected: PASS

- [ ] **Step 5: 接上 CLI**

`bin/wechatdesk.mjs probe [--json]` 输出 `JSON.stringify(probe(), null, 2)`；参数错误回 `{ok:false, code:"BAD_ARGS"}` 且退出码 2。

- [ ] **Step 6: 提交**

```bash
git add lib/probe.mjs bin/wechatdesk.mjs test/probe.test.mjs
git commit -m "feat: probe 探测架构/磁盘/微信版本/依赖"
```

---

### Task 2: 运行时准备

**Files:**
- Create: `lib/runtime.mjs`
- Modify: `bin/wechatdesk.mjs`（子命令 `prepare-runtime`）
- Test: `test/runtime.test.mjs`

**Interfaces:**
- Produces: `prepareRuntime(opts?: { root?: string, offlineDir?: string, onEvent?: (e: {stage, message}) => void }): Promise<{ root, version, python, sqlcipher }>`
  - 布局：`<root>/runtime/<version>/python/bin/python3`、`<root>/runtime/<version>/bin/sqlcipher`
  - `offlineDir` 给了就从本地取（`python-*.tar.gz`、`sqlcipher-<arch>`），否则走 `RUNTIME_BASE_URL`
  - 已存在且 `<root>/state.json` 里 `runtime.sha256` 匹配则直接返回，不重复下载
  - 失败抛 `DeskError("IO_ERROR" | "NO_RUNTIME")`，并清理本阶段临时目录

- [ ] **Step 1: 写失败测试**

```js
test("第二次调用复用已有运行时，不再下载", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-"));
  const a = await prepareRuntime({ root, offlineDir: fixtureOffline() });
  let downloads = 0;
  const b = await prepareRuntime({ root, offlineDir: fixtureOffline(), onDownload: () => downloads++ });
  assert.equal(b.python, a.python);
  assert.equal(downloads, 0);
});

test("中断后重跑不留半个运行时", async () => {
  // fixture 提供一个只能解压一半的 tarball，第一次抛错
  await assert.rejects(prepareRuntime({ root, offlineDir: fixtureBroken() }), /NO_RUNTIME/);
  assert.equal(await exists(join(root, "runtime", "1.0.0", "python")), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/runtime.test.mjs`
Expected: FAIL，`prepareRuntime is not a function`

- [ ] **Step 3: 实现 `prepareRuntime`**

下载到 `<root>/.tmp/<uuid>/`，校验 sha256，解压，最后一步 `rename` 到目标目录——保证目标目录要么完整要么不存在。SQLCipher 按 `process.arch` 选 `arm64`/`x64` 产物，`chmod 0o755`。写 `state.runtime = { version, sha256, readyAt }`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/runtime.test.mjs`
Expected: PASS

- [ ] **Step 5: 手动验证真实产物**

Run: `node bin/wechatdesk.mjs prepare-runtime --root /tmp/desk-try --offline ./offline`
Expected: 输出 `{ok:true, python:"/tmp/desk-try/runtime/1.0.0/python/bin/python3", sqlcipher:"..."}`，且 `<python> -V` 打印 3.12.x。

- [ ] **Step 6: 提交**

```bash
git add lib/runtime.mjs bin/wechatdesk.mjs test/runtime.test.mjs
git commit -m "feat: 运行时准备（幂等、可离线、失败不留残骸）"
```

---

### Task 3: 查询层落地

**Files:**
- Create: `lib/query-layer.mjs`
- Create: `vendor/wechat-decrypt/`（固定 commit 的副本，含 `scripts/common/query.py`、`key.txt` 位置）
- Modify: `bin/wechatdesk.mjs`（子命令 `prepare-query`）
- Test: `test/query-layer.test.mjs`

**Interfaces:**
- Produces: `prepareQuery(opts: { sourceDir: string, root: string }): Promise<{ root: string, commit: string, sha256: string }>`
  - 拷到 `<root>/query/`，写 `<root>/query/BUILD`（两行：`commit=<sha>`、`key=<相对路径 key.txt>`）
  - 验证 `scripts/common/query.py` 存在且 `python query.py list --json` 能跑（无 key 时应回可识别的错误，不是崩溃）
  - key 文件路径固定 `<root>/query/key.txt`，缺失时**不创建**

- [ ] **Step 1: 写失败测试**

```js
test("prepareQuery 写入 BUILD 并保留上游文件哈希", async () => {
  const root = await mkdtemp(join(tmpdir(), "desk-"));
  const r = await prepareQuery({ sourceDir: fixtureUpstream(), root });
  assert.match(await readFile(join(r.root, "query/BUILD"), "utf8"), /commit=[0-9a-f]{40}/);
  assert.equal(r.commit, "8a28b83e5d0b73180b915f68f5cc7dc464c26639");
});

test("没有 key 时 list 返回结构化错误而不是崩溃", async () => {
  const out = await runQueryLayer({ root, op: "list" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "KEY_INVALID");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/query-layer.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 `prepareQuery`**

拷贝用 `cp -R` 语义但排除 `.venv/`、`__pycache__/`、`decrypted/`、`key.txt`。算目录哈希（排序后的 `path:sha256` 拼接）写进 BUILD。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/query-layer.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/query-layer.mjs vendor/wechat-decrypt test/query-layer.test.mjs
git commit -m "feat: 固定 commit 的查询层落地与 BUILD 记录"
```

---

### Task 4: key 校验

**Files:**
- Create: `lib/verify-key.mjs`
- Modify: `bin/wechatdesk.mjs`（子命令 `verify-key`）
- Test: `test/verify-key.test.mjs`

**Interfaces:**
- Produces: `verifyKey(opts: { root: string, key: string, dbPath: string }): Promise<{ ok: true, messages: number, tables: number } | { ok: false, code: "KEY_INVALID" | "DB_BUSY" | "IO_ERROR" }>`
  - key 通过 `PRAGMA key` 的参数化形式传入 stdin（`printf "PRAGMA key='x';"` 不可取——用查询层的既有机制，key 走环境/文件，具体沿用 `crypto.py` 的约定）
  - 打开后 `PRAGMA query_only=ON`，再 `select count(*) from sqlite_master` + 一条 `Msg_` 表计数

- [ ] **Step 1: 写失败测试**

```js
test("正确 key 返回 message 表数量", async () => {
  const { dbPath, key } = await makeSyntheticDb({ messages: 3 });
  const r = await verifyKey({ root: fixtureRoot, key, dbPath });
  assert.equal(r.ok, true);
  assert.ok(r.tables > 0);
});

test("错误 key 返回 KEY_INVALID 而不是抛异常", async () => {
  const r = await verifyKey({ root, key: "00".repeat(32), dbPath });
  assert.deepEqual(r, { ok: false, code: "KEY_INVALID" });
});

test("错误 key 不出现在返回值和 stderr 里", async () => {
  const bad = "ab".repeat(32);
  const r = await verifyKey({ root, key: bad, dbPath });
  assert.equal(JSON.stringify(r).includes(bad), false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/verify-key.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 `verifyKey`**

用 `spawn` 调运行时 python 跑一小段内联脚本（或查询层已提供的 `test_key`），超时 10s → `DB_BUSY`（WAL 被占用时重试一次 200ms 再判）。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/verify-key.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add lib/verify-key.mjs bin/wechatdesk.mjs test/verify-key.test.mjs
git commit -m "feat: key 校验（KEY_INVALID/DB_BUSY 稳定错误码）"
```

---

### Task 5: 查询封装与 CLI

**Files:**
- Create: `lib/query.mjs`
- Modify: `bin/wechatdesk.mjs`（子命令 `query <op>`）
- Test: `test/query.test.mjs`

**Interfaces:**
- Produces: `queryOnce(opts: { root, op, value?, days?, limit?, signal? }): Promise<{ ok: true, data: unknown } | { ok: false, code: string }>`
  - `op ∈ {list, read, search, recent, summary, events}`，其余 → `BAD_ARGS`
  - `days 1..3650`，`limit 1..100`，`value ≤ 180` 字符且不含 `\0`
  - 调用 `query.py <op> --json ...`，`cwd = <root>/query`，`maxBuffer 3 MiB`，`timeout 45s`
  - 输出非 JSON → `IO_ERROR`；超时 → `TIMEOUT`；`KEY_INVALID` 由查询层 stderr 识别后透传

- [ ] **Step 1: 写失败测试**

```js
test("op 白名单之外返回 BAD_ARGS", async () => {
  assert.deepEqual(await queryOnce({ root, op: "drop" }), { ok: false, code: "BAD_ARGS" });
});

test("中文与 emoji 原样往返", async () => {
  const r = await queryOnce({ root, op: "search", value: "截止🐙" });
  assert.match(JSON.stringify(r.data), /截止🐙/);
});

test("超长 value 被拒而不是截断后查询", async () => {
  assert.deepEqual(await queryOnce({ root, op: "search", value: "x".repeat(181) }), { ok: false, code: "BAD_ARGS" });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/query.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 `queryOnce`**

参数一律作为独立 argv 传给子进程，值前面加 `--` 防止被当作选项（沿用 0.2.0 `history.mjs` 的写法）。`PYTHONUTF8=1`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/query.test.mjs`
Expected: PASS

- [ ] **Step 5: 接上 CLI 并做一次真机冒烟**

Run: `node bin/wechatdesk.mjs query list --root ~/Library/Application\ Support/WeChatDesk`
Expected: 有 key 时输出会话 JSON；无 key 时 `{ok:false, code:"KEY_INVALID"}` 且退出码 3。

- [ ] **Step 6: 提交**

```bash
git add lib/query.mjs bin/wechatdesk.mjs test/query.test.mjs
git commit -m "feat: 查询封装（白名单、超时、UTF-8、错误码透传）"
```

---

## 自检

- **spec 覆盖**：查询运行时对应 spec 的「§1 打包」与「§3 取 key 的第 5 步校验」；取 key、常驻、agent 安装整合各自单列计划，本文不覆盖。
- **类型一致**：`DeskError.code` 与 `queryOnce` 返回的 `code` 用同一组 `CODES`；`root` 在所有签名里都指安装根（非版本目录）。
- **Review Focus 落点**：1→Task 2 中断测试；2→Task 4 泄漏断言；3→Task 1 `supported` 标记；4→Task 4 `DB_BUSY`；5→Task 5 往返与超长拒绝。
- **比例**：五个实现任务对应五组测试，没有为「以后可能要」的东西预留接口。

## 后续计划（不在本文）

1. 取 key：副本复制/签名/守护进程 + 状态机（spec §3）。
2. 常驻桥接：全局插件 + supervisor + ilink 收发（spec §4）。
3. agent 安装整合：`skills/install`、`tools/` 编排、迁移与状态机（spec §2、§6）。
