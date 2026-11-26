# 微信工作台 0.3 · 取 key 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在本机把微信复制一份、ad-hoc 签名、用 Frida 拉起并捕获 raw key，全程不碰 `/Applications/WeChat.app`，失败可重试且不损坏现有微信。

**Architecture:** 三个动作分开：`bundle`（复制+签名，幂等）、`keyhook`（Python 守护进程：spawn→注入→等登录→写 key，跨对话轮次存活）、`keyflow`（JS 侧轮询 state 并向调用者汇报）。**Tech Stack:** Node 22、Python 3.12（运行时自带）、Frida 17 Python 绑定、codesign/ditto。

**Spec:** `docs/superpowers/specs/2026-11-27-one-click-wechat-desk-design.md` §3

## Global Constraints

- 不 `sudo`、不修改 `/Applications`、不关闭 SIP；官方 app 签名必须保持 `codesign --verify` 通过。
- key 只出现在两处：`<root>/key.txt`（0600）与子进程 stdin；不得进 argv、日志、`state.json`、错误消息。
- 签名副本**不带** entitlements（带 `app-sandbox` 会被 AMFI 拒绝）。
- 失败码沿用 `CODES`，新增：`APP_COPY_FAILED` `SIGN_FAILED` `SPAWN_FAILED` `HOOK_MISSING` `LOGIN_TIMEOUT`。
- 副本默认保留（1.4 GB），删除必须用户显式确认。
- 单文件单职责；测试不碰真实微信。

## Review Focus

1. **官方微信被改坏**：任何路径都不能写到 `/Applications`；签名副本失败后官方 app 仍 `--verify` 通过。
2. **跨轮次存活**：扫码等待期间宿主结束一轮，副本与钩子不能被杀掉。
3. **半装残留**：复制中断留下 1.4 GB 残骸、重复复制、重复签名，都必须能被 `status` 看出来。
4. **key 泄漏**：`ps`、daemon 日志、state、错误对象。
5. **重试语义**：超时后重试不能叠加出两个微信进程或两个接收者。

---

### Task 1: 复制与签名

**Files:** Create `lib/bundle.mjs`、`lib/sign.mjs`；Test `test/bundle.test.mjs`、`test/sign.test.mjs`

**Interfaces:**
- `prepareCopy({ appPath, root, onEvent }): Promise<{ copyPath, version, copiedAt }>` —— 目标是 `<root>/wechat-copy/WeChat.app`；已存在且版本一致则直接复用；磁盘 < `requiredBytes` 抛 `APP_COPY_FAILED`；用 `ditto` 保留 xattr；先写 `<root>/.tmp/copy-<uuid>` 再 rename。
- `signCopy(copyPath): Promise<{ signature: "adhoc" }>` —— `codesign --force --deep --sign -`，随后 `codesign -dv` 必须显示 `Signature=adhoc`，否则 `SIGN_FAILED`。

- [ ] **Step 1: 写失败测试**（复制：用假 `.app` 目录；签名：用 `clang` 编一个桩二进制，不动真实 app）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**

### Task 2: keyhook 守护进程

**Files:** Create `tools/keyhook.py`；Test `test/keyhook.test.mjs`（用 `--dry-run` 只验状态机，不碰 Frida）

**Interfaces:**
- CLI：`keyhook.py --app <bin> --hook <js> --state <json> --timeout <s>`
- 状态序列写入 `<state>`：`spawning` → `attached` → `waiting`（用户扫码）→ `captured`|`failed`
- 捕获后写 `<root>/key.txt`（0600）并 `chmod`，**不打印**
- `--dry-run`：只走状态序列并退出，用于测试与自检

- [ ] **Step 1: 写失败测试**（dry-run 产出状态序列；超时 → `LOGIN_TIMEOUT`；已存在 key 不覆盖）
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**（延迟 import frida；缺 frida → `HOOK_MISSING`）
- [ ] **Step 4: 运行确认通过**
- [ ] **Step 5: 提交**

### Task 3: 跨轮次等待与启动

**Files:** Create `lib/keyflow.mjs`；Modify `bin/wechatdesk.mjs`（`key start|wait|status`）；Test `test/keyflow.test.mjs`

**Interfaces:**
- `startKeyhook({ root, appBin, hookPath, timeoutSec }): Promise<{ pid }>` —— `detached: true, stdio: "ignore"`，父进程退出不影响
- `waitForKey({ root, timeoutMs }): Promise<{ ok: true } | { ok: false, code }>` —— 轮询 `state.wechatKey`，`captured` 时校验 `<root>/key.txt` 存在且 64 hex
- 单实例：`<root>/keyhook.lock` 记录 pid，活跃则 `start` 返回既有 pid

- [ ] **Step 1–5**：同 TDD 序列；测试覆盖「另一轮结束后 wait 仍能读到 captured」「并发 start 不产生两个 pid」

### Task 4: 真机冒烟

- [ ] 用真实微信副本跑到 `waiting`，确认官方 app `codesign --verify` 仍通过，然后杀进程清锁（不要求用户扫码）
- [ ] 记录：副本体积、签名结果、状态序列

## 验收

`node --test test/*.test.mjs` 全绿；Task 4 的手动记录进 PR 描述；官方微信签名在冒烟前后均为 `valid on disk`。
