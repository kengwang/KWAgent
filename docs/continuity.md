# 人格、生活与关系连续性

v0.3.0 在五个外部插件中增加连续性资料。Bun 管理依赖，Node.js 运行，Harness 保持 0.2.2-alpha.2，数据库升级到 Schema 3。

## 记录语义

| kind | 内容 | 状态 |
|---|---|---|
| life | 当前事情、进展、牵挂、多个感受 | active / archived |
| relationship | 对实际账号的相处理解与不确定之处 | active / archived |
| thread | 未完话头、预计时间、答复和承接 | active / deferred / resolved / declined / cancelled / expired |
| conversation | 会话收尾、暂缓及交流判断 | open / closed / deferred / archived |
| expression | 有实际实例的情境表达 | candidate / adopted / disabled / archived |
| reflection | 有期限的行为提醒 | active / archived |
| journal | 主观回顾与念头 | active / archived |

`life` 的标识固定为 `life:<roleId>`，其中 activity 区分 planned、in_progress、paused、completed 和 cancelled。感受包含文字、原因、形成时间和失效时间，默认持续二十四小时。反思默认七天有效。到期只改变默认上下文选择，原记录与修订继续保存。

人物使用实际账号，昵称资料沿用原始事件。共同字段包含标题、正文、人物、会话、现实/虚构情境、来源、关联记忆/计划/连续性记录及适用期限。`selfState` 保留整体自我状态，当前生活单独保存。

计划、主观感受、表达实例和内部文字保留各自语义。现实事情的进行和完成需要实际执行依据。失败媒体、未知操作、没有真实外部子调用的PTC父结果及内部修订不能被当作外部成功依据。PTC按parentExecutionId关联实际子调用，跨重启复用callId不复用旧证据；父结果的完整内容继续保存。自动整理遇到非法输出会保存实际输出与用量，向模型反馈具体校验问题并有限重试；全部尝试失败后停止依赖该状态的活动。

## 工具和管理

`continuity_read` 查询资料，支持 id、history、kind/kinds、person、context、status、query、since/until、cursor 和 limit。列表默认五十条，上限二百条。id 读取完整记录，history 读取该记录修订。大结果使用已有 payload_read。

`continuity_revise` 接收 `{ id?, expectedRevision, data, reason }`。data 使用上表中对应类型的完整资料。创建 expectedRevision 为 null，修改使用已读取修订号。角色身份由 Agent Context 确定。每次提交保存工具声明或管理操作依据，sources 可以另外提供实际事件和操作；关联记忆、计划及其他记录分别保存。

表达实例必须提供交流来源。自动整理只提出 candidate，角色自行使用工具采用、调整或停用。每步最多两条表达和两条反思；旧 expressionExamples 继续作为通用风格资料使用。

thread.followups 接收 `{ operationId, note, pending? }`。同一消息操作只能计入一次，已登记会话必须匹配话头。未知结果自动保留 pending；旧操作缺少可核实会话时必须明确 pending=true。失败或尚在执行的消息不能登记为成功承接。新操作在意图投影前保存独立会话元数据，长消息仍可核验目标。结果未知不会自动重放。

Panel 与命令行共用 continuity.list、continuity.read 和 continuity.revise。管理读取 raw=true 用于完整编辑；默认详情只提供有界预览、来源、回执与负载引用。编辑冲突保留输入，读取当前版本后重新提交。角色、人物、记忆及目标页面分别提供相应资料。

## 复核安排

life_plan 增加 purpose（internal / review / contact）和 relatedRecords；旧计划默认 internal。thread 与 conversation 的 reviewAt 请求一次复核，kw-life 创建或更新对应 Schedule。到期重新读取当前资料，由角色决定继续、交流、暂缓或结束，不自动发送。

结束、拒绝、取消、失效及清空 reviewAt 会取消后续复核。未来适用记录可以提前登记安排，实际投递时再核验有效性。复核时间不能早于适用时间。已经筛选的提醒在恢复时核验当前计划版本和关联记录，避免使用已取消或已经修改的旧内容。重复投递不重复消费同一发生事项。

## 步骤背景与整理

角色使用专用 kwagent preset，通过公开的 preset 声明接口继承宿主 standard 的工具及表达式，并在其隔离压缩组挂载 MindCompaction，默认摘要输出上限为8192 Token。人格前缀来自角色自身。原有Session继续使用原标识与记录；role.prepare返回实际压缩实现和预算，能够检查运行中的组成。

只有已经接纳的输入用于确定本步场合。每步冻结人格、自我状态、生活、关系、话头、会话判断、目标、记忆、表达、反思和实际近期交流；正文、版本、选择时间及预算写入同一 Session 快照。人工修改和新输入从后续步骤生效。

KW_CONTINUITY_CONTEXT_TOKENS 默认 3072，包含在角色原有记忆背景预算内（默认 8192）。当前人物、会话、关联事项和当前生活优先；未选中的适用资料提供读取引用。指定私聊的记录不会自动用于群聊表达。近期发送从真实操作记录读取，保留成功、失败、未知及来源。

记忆整理在事务外调用模型，在同一事务内提交记忆、连续性修订、来源和分片完成状态。内部工具读取/修订和 PTC父结果采用稳定摘要视图，完整原文继续保存在负载中。既有分片沿用原有视图和校验和。日记、反思及风格不会递归变成新的外部经历。

## 升级与验收

正常升级先创建完整备份，Schema 1/2 迁移前另存一致数据库快照。旧角色、经历、记忆、计划和表达示例保持可读，不根据旧文字推断生成连续性记录。已经作为连续性来源的经历保留原角色归属。

本地验收使用 `node scripts/verify-continuity.mjs` 和 `node scripts/verify-continuity-panel.mjs`。前者创建无会话绑定的专用角色，工具守卫禁止远程社交调用；应用重启后运行 `node scripts/verify-continuity.mjs resume`。浏览器验收使用实际管理流程检查编辑冲突、来源和复核取消。Linux 断网验收和旧镜像升级使用 `scripts/verify-image.mjs` 与 `scripts/verify-upgrade.mjs`。

`node scripts/verify-social-reasoning.mjs` 验证本地人工场景中的同名账号、私聊/群聊表达，以及真实文件错误和子进程终止后的未知结果。管理event动作可携带context和sender；来源始终标记manual，不作为真实QQ收发。`node scripts/verify-continuity-restore.mjs` 创建完整备份并在独立目录核验资料、来源和Schema。
