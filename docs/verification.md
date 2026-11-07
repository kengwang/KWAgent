# 验收记录

## v0.7.1

`verify-async-continuation.mjs` 使用真实后台文件操作和真实模型，在后续模型请求开始时释放文件条件，确保完成通知在 `job_output` 调用前已经进入收件队列。修复前仅写入 `race-source`，turn 以 `blocked` 结束；修复后继续写入 `after-read`，turn 正常 `completed`。完成事件仍为一条。验收守卫禁止全部社交调用。

57 项原有自动测试通过，实际结果位于 `.artifacts/verification/async-continuation.json`。生产恢复通过管理输入继续原活动，依据已有结果和成功回执判断后续事项。

## v0.7.0

57 项自动测试通过，包含真实文件异步操作后的原活动关联。实际 Harness 和模型验收验证普通程序约五秒返回后台句柄、显式提交立即返回、程序内顺序执行、后台运行时先处理另一条输入及结果接纳。隔离验收使用角色工具守卫禁止社交调用。

单独使用真实后台任务唤醒模型，确认新模型请求的任务执行上下文为空，后台任务归属不会沿唤醒传入新的模型步骤。结果位于 `.artifacts/verification/async-origin.json`。

生产通过固定 digest 的 `v0.7.0` 镜像更新，原有角色、Session、事件和 Schema 4 保留。已完成完整备份，确认任务记录、MCP、SSE、共享 Python 与 Chromium 正常；应用继续仅使用 `1panel-network`，没有宿主端口映射。

实际原生任务、图片读取、大结果分页、失败修正、暂停取消、Session 重置取消和强制终止后的中断恢复通过。未结束程序不会在重启后重放，稳定结果事件保持原标识。完整备份恢复到独立目录后，实际 SQLite 和负载读取保留任务及长内容。

浏览器验收完成任务详情、实际取消、重载恢复以及桌面和窄屏检查。Linux amd64 镜像以非 root、断网方式通过真实 Harness、数据库、单实例和完整备份恢复检查。具体结果位于忽略目录 `.artifacts/verification/async*.json`、`async-image.log`，截图位于 `.artifacts/browser/async-*.png`。最终发布镜像的相同检查由对应标签的 GitHub Actions 执行。

## v0.6.2

56 项自动测试通过。实际 Harness、浏览器与模型验收确认通过角色页面选择的 `high`、`low`、`off` 依次出现在真实前台请求中，恢复默认值后生效为提供商的 `medium`。运行中保存保留启用状态、绑定和其他字段；不支持的档位保存失败且不改变版本；编辑冲突保留选择。

关闭并恢复同一 Session 后，实际请求继续使用角色保存的 `high`。桌面与窄屏检查、模型请求记录和结果位于忽略目录 `.artifacts/browser/role-reasoning-*.png`、`.artifacts/verification/role-reasoning.json`。全部工具由隔离验收守卫拒绝执行，没有 QQ 或空间发送测试。

使用生产图片发送的原始失败参数和当时实际发现的远端 Schema 只读复现：缺少 `message[3].data.summary` 时校验失败，补充 `summary:null` 后校验成功，没有执行远端发送。记录位于 `.artifacts/verification/production-image-schema.log`。真实 SQLite 和磁盘媒体测试验证感知提供 `media_prepare`、`media_inspect` 的具体参数，并保留已固定的批次与角色归属。

## v0.6.1

55 项自动检查通过。共享 Python 的实际容器验收确认并行准备返回同一个 `/data/python/.venv/bin/python`，通过 uv 安装的包可以从不同角色工作目录导入，已有包在再次准备和断网重建后保留。Chromium 的页面操作、下载、截图、Cookie 与 localStorage 恢复通过。

断网镜像验收将共享环境写入完整备份并恢复到独立目录，实际启动恢复后的 Python，确认解释器前缀和 Playwright 导入正确。日志位于 `.artifacts/verification/shared-python-ci.log`、`shared-python-image.log` 和 `shared-python-runtime.log`。本次验收没有模型和社交发送调用。

## v0.6.0

本地 Linux amd64 镜像通过 `verify-image.mjs`：UID 10001、断网 Harness、真实 Python venv、Chromium 页面交互、中文截图、实际下载、SQLite、单实例和完整备份恢复全部通过。55 项自动测试、构建、类型检查及凭据检查通过。

`verify-python-docker.mjs` 在第一个容器中用 uv 实际安装 `idna==3.11`，验证角色环境隔离与再次准备环境时保留额外依赖；第二个容器复用同一数据卷并关闭外网，成功导入该包，恢复浏览器 Cookie、localStorage、截图和下载文件，再次完成实际页面操作。日志位于忽略目录 `.artifacts/verification/python-image.log` 和 `python-runtime.log`。验收不调用模型或 QQ／空间发送。

GitHub Actions 增加同样的容器重建检查，实际结果以对应标签的工作流和生产部署记录为准。

## v0.5.5

`node scripts/verify-step-context.mjs` 在修复前于第二次实际模型请求失败，检测到两份完整步骤背景。修复后，真实 Harness 与模型完成初始化、三次连续输入及同一 Session 重启后的输入；五次请求均只包含一份当前背景，估算请求容量依次为 26814、27523、28069、28589、29111 Token。工具 Schema 始终为固定的 `run_code`，没有 QQ 或空间发送。结果保存在忽略目录 `.artifacts/verification/step-context.json`。

新增回归使用真实 Session 和磁盘记录，验证 20 份背景的替换、其他插件贡献、原始消息、不可变日志、重复执行和恢复。55 项自动测试、严格类型检查、Git 忽略与凭据检查通过。Linux 镜像检查和生产结果对应发布标签的实际工作流及部署记录。

## v0.5.4

生产最近感知帧确认每条新消息包含 1 条 `current` 和最多 20 条重复 `recent`，单帧约 4.1–4.5K Token。修复后消息触发步骤不再装配 `recent`；本地 54 项测试通过，新增回归确认已完成历史不会进入当前消息感知帧。

## v0.5.3

修复模型提供商保存错误。`bundle-config.test.ts` 验证 `cordis.patch.yml` 中的 provider 是普通对象，没有 `providers.__jsExpr`；真实 profile 加载和保存路径不再依赖动态表达式节点。

## v0.5.2

本地构建、严格类型检查和 53 项测试通过。真实 Harness 与模型验收中，管理员与普通输入使用完全相同的工具 Schema；普通来源及管理员来源均完成实际文件工具调用，正常消息入口到达隔离 QQ 守卫。16 条普通群消息合并为一次前台请求，重复投递没有新增请求，自动表情调用次数为零。字段纠正、实际 SQLite 故障和损坏持久来源继续按真实结果处理。

报告位于 `.artifacts/verification/resilience-boundaries.json`，验收禁止 QQ 和空间发送。生产更新保留当前角色、原会话及已有资料，使用固定提交镜像。

## v0.5.1

本地构建、类型检查和 57 项测试通过。群消息进度使用实际 Milky `send_group_message_reaction` 字段，处理状态与原始消息、活动及回执关联。回归检查自身表情回流不产生新的待处理输入、操作失败时不添加完成表情、重复事件和恢复不重放已有尝试。

更新后的 `verify-resilience-boundaries.mjs` 在真实 Harness 与模型中验证 18 条群消息的进度记录。QQ 守卫实际拒绝所有表情调用，记录保留真实失败，未写入成功；16 条普通消息仍合并为一次前台模型请求，重复投递没有新增请求。真实服务器回执以部署后的自然活动记录为准，隔离验收不执行 QQ 或空间发送。

## v0.5.0

2026 年 11 月 5 日，本地构建、严格类型检查、55 项测试、Git 忽略和凭据检查通过。新增检查覆盖已处理投递的单调状态、待处理消息背景隔离、完整步骤确认与中断保留、真实 SkillRegistry、修复 JSON 与严格来源校验、实际 SQLite usage 写入故障及损坏持久行分类。

`node scripts/verify-resilience.mjs` 使用隔离 Harness、实际模型和 GitHub 仓库导入 humanizer。16 条连续输入全部处理，查询扩展共 4 次；重复投递没有新增前台请求，重启没有重投。实际不可连接的辅助接口返回延后状态，原始经历保留，正常聊天模型继续完成前台输入。实际 Native/PTC 写文件、未授权拒绝和嵌套撤权检查通过。报告为 `.artifacts/verification/resilience.json`。

`node scripts/verify-resilience-boundaries.mjs` 通过真实 Milky 事件 Module 投递隔离资料，管理员与普通输入分别进入真实模型请求，未接纳的普通输入没有进入管理员请求。16 条普通消息合并为一次前台请求，全部完成。实际检查计划与 QQ 撤权、工具依据纠正、辅助请求中 SQLite usage 硬故障；数据库失败保持致命状态并保留原始资料。报告为 `.artifacts/verification/resilience-boundaries.json`。

真实浏览器完成角色创建、预注入 Skill 与管理员 QQ 保存及回读、GitHub Skill 导入与实际提交显示，检查 1366×900 和 420×900 页面。截图位于 `output/playwright/v050-*.png`。`verify-lifecycle.mjs` 再次通过归档恢复、真实进程中断、计划迁移、删除及完整历史读取。所有角色均无正式会话绑定，模型验收由工具守卫禁止 QQ 和空间调用。

网络测试使用实际 HTTP 服务与 CONNECT 代理，确认连接固定解析 IP、原域名 Host 保留及内网访问校验。公网脚本通过用户代理读取同一固定提交的实际 Skill 文件。Linux 镜像、旧版本升级及完整备份恢复由发布工作流的断网检查执行；结果对应实际标签工作流。

## v0.4.1

隔离 Host 将 Milky 地址配置为不可用的本机端口，实际验证未启用、暂停、停止三种角色的重置、空白 Session 持久化、Session 查询与删除。全部保留原有状态，没有模型或社交调用。报告位于 `.artifacts/verification/offline-lifecycle.log`。

## v0.4.0

验收日期：2026 年 11 月 5 日。真实 SQLite 检查会话轮换、删除标记、Schema 3 到 4 一致快照、原始经历保留、版本冲突、跨角色 Session 拒绝、事务失败撤销，以及已接纳输入不重复投递。

`node scripts/verify-lifecycle.mjs` 在独立目录使用真实 Harness 与模型，完成手动重置、空闲与运行中归档、关闭期间归档恢复、Session 切换后实际终止进程及同一目标恢复、角色计划重新登记、删除及历史详情读取、完整备份恢复。验收角色没有社交绑定，QQ 工具由守卫禁止。报告为 `.artifacts/verification/lifecycle.json`。

Playwright CLI 在隔离的真实 Panel 创建未启用角色，检查重置确认、外部修改导致的版本冲突、读取当前版本后重置、删除取消与确认、角色列表移除及成功提示。管理接口确认新 Session、保留人格与启停状态及删除后的历史；实际截图覆盖 1440×1000 和 640×900，保存在忽略目录 `output/playwright/`。

## v0.3.5

生产失败参数在实际 Lagrange 消息模型和 .NET 10 序列化器上离线回放：五份原始参数均复现判别字段错误。经过 KWAgent 发送参数处理与官方 MCP 请求 Schema 后，五份参数全部成功反序列化。回放使用忽略目录中的真实参数与上游模型源文件，不执行 QQ 操作。

回归覆盖嵌套转发的字段顺序、原始对象不变、数组和字符串载荷完整、重复处理幂等，以及通用端点异常的未知状态语义。报告位于 `.artifacts/verification/endpoint-binding-before.json` 和 `endpoint-binding-after.json`。

## v0.3.4

验收日期：2026 年 11 月 4 日。完整构建、严格类型检查、32 项测试和私密文件检查通过。

`verify-compaction-policy.mjs` 使用独立数据目录、真实 Harness 与模型执行四个模型步骤。请求估算分别为 45272、47406、49025、50641 Token；请求头没有 KWAgent 指定的输出上限。运行策略与实际 BasicCompactionEngine 默认配置一致，自动及手动压缩均为零。工具检查后主动暂停，正常关闭并恢复同一 Session，暂停状态和策略保持一致；社交工具由守卫禁止。

`verify-auxiliary.mjs` 在禁用的独立角色上完成一次真实辅助整理，使用模型声明的 off 档位；记忆与一项连续性记录通过 Schema 和来源检查，角色保持禁用。连续性记录可以为空，验收检查实际生成条目的来源和会话，不要求每次整理生成固定数量。

报告保存在忽略目录 `.artifacts/verification/compaction-policy.json`、`auxiliary.json` 和 `review-harness-capacity.md`。上述过程没有触发手动压缩。

## v0.3.0

验收日期：2026 年 11 月 4 日。Node.js 24.18.0、Bun 1.4.2、Harness 0.2.2-alpha.2；新增功能均来自外部插件。

| 项目 | 实际结果 |
|---|---|
| 自动检查 | 28 项真实 SQLite/磁盘测试、严格类型检查、凭据和忽略规则检查通过 |
| Schema 3 | Schema 1/2 迁移、迁移前一致快照、旧记录读取与连续性持久化通过 |
| 连续性 | CAS、角色归属、期限、表达上限、私聊场合、内部来源及 PTC 执行身份回归通过 |
| 真实模型 | 实际读取本地文件，保存生活及面试话头；明确拒绝后结束话头并取消复核；保存有期限的短期反思，长期人格保持原样 |
| 同名与场合 | 同名人物按账号分别保存；同一人物的私聊表达没有进入群聊背景，实际拟表达保持群聊场合 |
| 真实故障 | 实际ENOENT及写入后子进程终止；操作保持unknown，生活记录paused，写操作仅执行一次 |
| 真实 Schedule | 未来适用复核保留；结束话头、修改计划后的缓存重放被拒绝，重复发生事项保持幂等 |
| 专用 preset | 实际运行 MindCompaction，摘要预算8192；原有Session继续恢复，真实压缩成功 |
| Panel | 实际浏览器完成创建、编辑冲突保留、当前版本读取、来源导航及话头取消；错误为零 |
| 桌面与窄屏 | 检查1440×1000和390×844实际截图 |
| Linux 镜像 | 非 root、断网Harness、SQLite、连续性、负载、单实例和完整备份恢复通过 |
| 旧镜像升级 | 保留v0.1.0、v0.2.0镜像生成旧数据，实际升级及一致快照检查通过 |
| 原有状态 | 正式角色及原有角色启停状态保持原样，本地社交脚本完整保留 |

实际结果位于忽略目录 `.artifacts/verification/continuity.json`、`social-reasoning.json`、`plans.json`；浏览器截图为 `.artifacts/browser/continuity-desktop.png`、`continuity-mobile.png`。`verify-continuity.mjs resume` 在重启后检查暂停角色、连续性正文和负载引用，已通过。行为测试使用没有会话绑定的专用角色和明确标记的本地场景，守卫禁止所有远程社交工具。

发布标签、镜像和提交必须一致，GitHub Actions实际结果以对应提交和标签的运行记录为准。QQ、私聊和空间发送验收均关闭；生产服务器HTTPS及代理环境未部署。

## v0.2.0

验收日期：2026 年 11 月 3–4 日。Node.js 24.18.0 运行，Bun 1.4.2 管理依赖，Harness 0.2.2-alpha.2 通过外部插件接入。验收使用真实 SQLite、磁盘、Harness、浏览器及已配置的聊天接口。

| 项目 | 实际结果 |
|---|---|
| 构建与检查 | Host、Client、严格 TypeScript 检查及凭据检查通过 |
| 自动测试 | 20 项通过，覆盖真实 SQLite、FTS5、来源、版本、分页及发布文件隔离 |
| 旧数据库 | 升级到 Schema 2；迁移前保存完整备份和 Schema 1 一致快照 |
| 负载存储 | Unicode 字节分页、无效字符偏移拒绝、角色授权、取消、完整内容与重启读取通过 |
| 整理进度 | 实际终止分片写入子进程，重新打开后保留已提交分片，未完成经历继续待整理 |
| 感知 | 提及、引用、嵌套转发、缺失内容、同名账号、顺序及不可变批次通过 |
| 原生工具 | 实际 PTC 子调用生成长文档，模型预览受预算限制，原文和二进制数据完整保留，文件操作回执按独立执行标识关联 |
| 执行状态 | 实际失败、运行中取消及重复调用提醒通过；结果未被改写为成功 |
| 人格 | 真实来源、版本冲突、表达示例与步骤冻结通过 |
| 能力目录 | Schema、接入支持、调用证据分别展示；Markdown 固定不支持 |
| 自主活动 | 实际模型完成三轮活动，处理运行中新输入、定时事项及暂停后积累的另一条输入 |
| 活动与压缩 | 感知、步骤、工具和上下文引用关联通过；压缩后仍可检索此前记忆 |
| Panel | 创建、编辑冲突、完整正文读取、嵌套负载跳转、能力详情和目标取消通过；其他角色更新后已加载的历史页保持可读，浏览器错误为零 |
| 人物来源 | 同名账号分别展示；记忆检索关键词不作为账号昵称，昵称与群名片保留原始消息依据 |
| 桌面与窄屏 | 已检查 1440×1000 和 390×844 的实际截图 |
| 角色状态 | 原有角色维持原启停状态，正式 QQ 角色保持暂停 |

详细结果保存在忽略目录 `.artifacts/verification/`，截图保存在 `.artifacts/browser/`。QQ 与空间发送测试在本次 v0.2.0 验收中关闭。媒体理解保持角色主动选择，使用现有聊天／视觉配置，未接入 Embedding。

## Linux 发布检查

v0.3.0 在独立测试卷中使用保留的旧镜像创建数据，再启动候选镜像验证 Schema 3 迁移、原有角色、非 root、原生 SQLite、单实例、对象引用、容器重启、完整备份恢复与 Host 校验。本地连接验收结果写入 `.artifacts/verification/docker.json`；CI 分别验证 Schema 1、2 升级，结果写入 `.artifacts/verification/image-upgrade.json`。通过后才发布版本镜像与 Git 标签。

## 部署条件

生产实例已通过固定 digest 的 v0.3.0 镜像部署在 `/root/KWAgent`，拉取使用 `ghcr.1ms.run`。服务器只保存 Compose、环境配置和持久数据，应用以 UID/GID 10001 运行，仅接入 `1panel-network`，没有宿主端口映射。已验证 Schema 3、Milky MCP、事件连接、容器健康、网络 DNS、公开 Host 接受及初始完整备份；原有 Lagrange 容器和配置保持完整。

生产实例使用独立数据目录，角色通过 Panel 创建和启用。登录入口保存在服务器权限为 `0600` 的 `.deployment/login-url.txt`。反向代理由服务器管理方配置，外部 TLS、Cookie、代理长连接和 Lagrange 访问签名媒体需要在公开入口继续验收。

GitHub 仓库配置为 `kengwang/KWAgent`（公开），GHCR 路径为 `ghcr.io/kengwang/kwagent`。自动化规则、标签含义和私密文件边界见 `docs/github.md`，远端运行结果以 GitHub Actions 记录为准。v0.3.0 使用版本标签、版本镜像及完整提交镜像标识，保留 v0.1.0、v0.2.0 发布物。
