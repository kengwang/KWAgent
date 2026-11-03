# KWAgent

DeepSeek Harness 外部插件工程，用于具有长期记忆、人格、关系、世界认识和自主活动的群聊角色。

依赖由 Bun 1.4.2 管理；构建、测试和运行使用 Node.js 24.18.0。Harness 兼容版本为 0.2.2-alpha.2。

## 开发

```powershell
bun install --frozen-lockfile
node scripts/build.mjs
node scripts/test.mjs
```

复制 `.env.example` 为 `.env` 并填写连接配置。实际凭据、运行数据和 `.artifacts` 不进入 Git。

## Module

`kw-lagrange` 管理事件与工具，`kw-mind` 管理记忆与修订，`kw-life` 管理角色活动，`kw-panel` 提供 Harness 内的管理界面，`kw-bundle` 组合专用 profile。

数据库与向量使用真实 SQLite 和 sqlite-vec。角色与记忆修改采用修订号检查，原始事件通过会话和消息序号去重。所有模型可见的经历由 Harness Session 保存。
