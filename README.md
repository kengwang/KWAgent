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

```sh
node scripts/start.mjs
node scripts/admin.mjs doctor
```

服务器部署见 [部署说明](docs/deployment.md)，角色与 Module 的行为见 [运行与持久化](docs/architecture.md)。

GitHub 自动检查、GHCR 镜像标签和私密文件规则见 [GitHub 与镜像发布](docs/github.md)。

## 验证

```sh
node scripts/verify-milky.mjs
node scripts/verify-models.mjs
node scripts/verify-harness.mjs
node scripts/verify-life.mjs
node scripts/verify-plans.mjs
node scripts/verify-extensions.mjs
node scripts/verify-v2.mjs
node scripts/verify-panel.mjs
node scripts/verify-v2.mjs resume
node scripts/verify-docker.mjs kwagent:verification
```

这些命令验证只读 Milky 连接、聊天与图片理解、真实浏览器流程、记忆保存、备份恢复、自主工具调用和容器重启。浏览器和 Harness 命令需要先启动本地应用。自主活动验收创建无会话绑定的专用角色，并用实际 Harness 工具守卫禁止该角色调用 QQ 工具；结束后暂停角色并停用验收扩展。模型验收应依次执行。

实际验收结果和外部条件见 [验收记录](docs/verification.md)。

v0.3.0 的生活、人物关系、未完话头、情境表达和自我反思见 [连续性说明](docs/continuity.md)。新增资料沿用实际来源、修订号和步骤快照；时间事项用于重新判断，发送仍由角色选择。

v0.3.1 提供 `kwagent-life` 运行 Skill，并修复负载预览的来源语义和收尾整理阻塞新输入的问题，见 [发布说明](docs/releases/v0.3.1.md)。

v0.3.2 为自动整理补齐完整输出 Schema，并统一新建记录的 JSON null 标识用法，见 [发布说明](docs/releases/v0.3.2.md)。

v0.2.0 增加不可变感知批次、活动时间线、人物与来源浏览、统一能力目录和有界负载读取。原始 JSON 与长文档保存到持久目录 `artifacts/`，`payload_read` 使用角色授权和 UTF-8 字节游标读取。`self_revise` 修订人格、自我状态与表达示例，并保存真实来源；`capability_read` 查询 Schema、接入支持及最近调用证据。Markdown 消息发送不支持。

`verify-v2` 使用实际 Harness 与 PTC 执行长文档生成、失败及取消，验证有界预览、完整负载、分页、修订冲突和步骤快照。应用重启后执行 `resume` 检查持久引用。上述流程禁止 QQ 与空间发送。

浏览器扩展验收遇到待重启状态时，重启应用后执行 `node scripts/verify-extensions.mjs resume`，继续检查实际加载和卸载。

## Module

`kw-lagrange` 管理事件与工具，`kw-mind` 管理记忆与修订，`kw-life` 管理角色活动，`kw-panel` 提供 Harness 内的管理界面，`kw-bundle` 组合专用 profile。

数据库使用 SQLite 和 FTS5，当前角色模型扩展检索表达，结合人物、来源与时间查阅记忆。角色与记忆修改采用修订号检查，原始事件通过会话和消息序号去重。所有模型可见的经历由 Harness Session 保存。
