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

v0.6.2 在角色编辑页提供独立的对话推理等级，显示所选模型实际支持的档位，支持恢复提供商默认值、运行中修改及重启恢复。

v0.7.0 支持整段 `run_code` 异步执行：显式选择后台或等待五秒自动转换。结果作为新的持久事件送达，角色可以先继续交流。活动页面提供任务详情和取消入口，暂停角色同时取消任务。

v0.6.1 提供所有角色共用的持久 uv／Python venv，以及可由 Python Playwright 控制的 Chromium。共享环境、各自工作目录和浏览器 profile 均可挂载保存，见 [部署说明](docs/deployment.md)。

v0.5.5 每步只保留当前角色背景，旧背景通过 Harness 的公开会话接口退出模型输入，原始记录和完整快照持续保留。已推送的历史消息继续按 v0.5.4 的规则处理。详见 [发布说明](docs/releases/v0.5.5.md)。

v0.5.0 增加每角色的预注入 Skill、GitHub Skill 导入和管理员 QQ 配置。真实身份在首次模型请求前准备，已处理事件持久确认，记忆后台整理与前台交流独立推进。配置及权限规则见 [角色 Skill、身份与管理员](docs/role-skills-and-authority.md)，变更见 [发布说明](docs/releases/v0.5.0.md)。

v0.3.0 的生活、人物关系、未完话头、情境表达和自我反思见 [连续性说明](docs/continuity.md)。新增资料沿用实际来源、修订号和步骤快照；时间事项用于重新判断，发送仍由角色选择。

v0.3.1 提供 `kwagent-life` 运行 Skill，并修复负载预览的来源语义和收尾整理阻塞新输入的问题，见 [发布说明](docs/releases/v0.3.1.md)。

v0.3.2 为自动整理补齐完整输出 Schema，并统一新建记录的 JSON null 标识用法，见 [发布说明](docs/releases/v0.3.2.md)。

v0.3.3 统一远端整数与字符串账号标识、私聊交接及新旧回执的会话关联，见 [发布说明](docs/releases/v0.3.3.md)。只读连接及预取消派发验收使用 `node scripts/verify-milky-routing.mjs <实际群号> <实际联系人QQ>`，不会发送消息。

v0.3.4 将模型容量、输出长度和压缩策略交由 Harness 解析，见 [发布说明](docs/releases/v0.3.4.md)。`node scripts/verify-compaction-policy.mjs` 使用隔离的真实 Harness 和模型检查请求参数、自动压缩与重启恢复，禁止社交发送。

v0.3.5 在 MCP 发送边界统一消息判别字段的顺序，补全 Lagrange Skill 的发送格式和端点异常核实规则，见 [发布说明](docs/releases/v0.3.5.md)。

v0.4.0 增加 Panel 的“重置对话”和“删除角色”。原会话归档后自动创建新会话，保留人设、长期记忆、绑定和角色计划；删除角色释放绑定、取消安排并保留历史。具体行为与管理命令见 [角色管理](docs/role-lifecycle.md)。

v0.4.1 支持在 Milky 暂时不可连接时重置未启用、暂停和停止角色的对话，新 Session 直接持久保存，启用后加载实际工具，见 [发布说明](docs/releases/v0.4.1.md)。

v0.2.0 增加不可变感知批次、活动时间线、人物与来源浏览、统一能力目录和有界负载读取。原始 JSON 与长文档保存到持久目录 `artifacts/`，`payload_read` 使用角色授权和 UTF-8 字节游标读取。`self_revise` 修订人格、自我状态与表达示例，并保存真实来源；`capability_read` 查询 Schema、接入支持及最近调用证据。Markdown 消息发送不支持。

`verify-v2` 使用实际 Harness 与 PTC 执行长文档生成、失败及取消，验证有界预览、完整负载、分页、修订冲突和步骤快照。应用重启后执行 `resume` 检查持久引用。上述流程禁止 QQ 与空间发送。

浏览器扩展验收遇到待重启状态时，重启应用后执行 `node scripts/verify-extensions.mjs resume`，继续检查实际加载和卸载。

## Module

`kw-lagrange` 管理事件与工具，`kw-mind` 管理记忆与修订，`kw-life` 管理角色活动，`kw-panel` 提供 Harness 内的管理界面，`kw-bundle` 组合专用 profile。

数据库使用 SQLite 和 FTS5，当前角色模型扩展检索表达，结合人物、来源与时间查阅记忆。角色与记忆修改采用修订号检查，原始事件通过会话和消息序号去重。所有模型可见的经历由 Harness Session 保存。
