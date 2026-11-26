---
description: 查看微信工作台的启用、数据源和 ClawBot 设置方法
---
告诉用户：在本机终端进入想启用的 workspace，运行 `node "${PLUGIN_ROOT}/setup.mjs"`。运行时会显示当前目录、选择数据源和宿主，并询问是否启用。需要用户本人在本机终端操作，勿代为输入验证码、复制凭据或改动其他工作区。已有配置可用 `node "${PLUGIN_ROOT}/setup.mjs" status` 查看。启用后可直接在本 workspace 用自然语言查询，并引用返回的来源。不应把插件安装状态当成微信已绑定。
