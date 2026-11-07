# 记忆、连续性和计划的实际参数

先阅读工具当前 Schema。以下构造方式中的 `current`、`role`、`note`、`sceneRealm`、`eventIds` 都来自当前角色、真实查询和本次事件，不是固定账号或可直接复制的来源。

## 当前生活

先用 `continuity_read` 的 `kind="life"` 查询。已有记录保留其完整资料并修改需要变化的字段：

```javascript
const request = {
  id: current?.id ?? `life:${role.id}`,
  expectedRevision: current?.revision ?? null,
  reason: note,
  data: {
    ...(current?.data ?? {}),
    kind: "life",
    title: "当前关注",
    content: note,
    realm: sceneRealm,
    sources: eventIds,
    memories: current?.data.memories ?? [],
    plans: current?.data.plans ?? [],
    relatedRecords: current?.data.relatedRecords ?? [],
    activity: current?.data.activity ?? null,
  },
};
```

这是 `continuity_revise` 的输入对象。新感受可以没有外部来源，由工具保存声明依据。真实活动的 `in_progress` 和 `completed` 需要实际执行观察；还没执行时使用 `planned`，没有特定活动时使用 `activity=null`。

## 关联记录与来源

| 字段 | 内容从哪里取得 |
|---|---|
| `memories` | `memory_recall` 或 `memory_read` 返回的记忆 `id` |
| `plans` | `life_plan` 的 `action="list"` 返回的计划 `id` |
| `relatedRecords` | `continuity_read` 返回的其他记录 `id` |
| `sources` | 实际原始事件 `id`、工具结果的 `source` 或操作记录 `id` |
| `people` | 真实账号标识的字符串；昵称写正文或人物别名 |
| `context` | `{"scene":"group"或"private","peerId":真实会话对象}` |

## 长期记忆

`memory_revise` 的顶层字段是 `memory`、`expectedRevision`、`reason`。创建新记忆使用完整对象：

```javascript
const saved = await tools.memory_revise({
  expectedRevision: null,
  reason: note,
  memory: {
    kind: "episode",
    title: memoryTitle,
    content: observedText,
    realm: sceneRealm,
    epistemic: "observed",
    sources: eventIds,
    people: personIds,
    aliases: [],
  },
});
```

`memoryTitle`、`observedText`、`sceneRealm`、`eventIds`、`personIds` 来自本次实际经历。`kind` 只能使用 `episode/self/person/relationship/world/promise/focus`。`epistemic` 按内容选择 `observed`、`reported`、`inferred` 或 `fictional`。判断一群人是否只想测试工具属于推测，不由成员名单或公告直接证明。

创建时 `memory.id` 可以省略或为 null，`expectedRevision` 必须为 null。修改先读取原记忆，提交完整 `memory`、原记忆 `id` 与正整数 `revision`。`continuity_revise` 的 `data` 用于连续性记录，长期记忆使用上面的 `memory` 结构。

`sources` 使用感知中真实的 `sourceId`、工具结果中明确提供的来源事件标识，或 `operation_read` 返回的操作 `id`。查阅发送回执时，可以用 `operation_read({})` 获取实际操作标识与状态。当前上下文未提供来源时先查询核实；工具调用编号、Session 编号、媒体编号、负载编号和自行生成的 UUID 均不能作为来源。初始化事件只证明初始化内容。

`memory_read({id: eventId, source:"event"})` 可以核对已有原始经历。工具 `callId` 关联执行过程，不能替代来源事件 ID。

## 话头与复核

`thread` 使用 `active/deferred/resolved/declined/cancelled/expired`。`reviewAt` 是 ISO 时间，安排届时复核，不自动发言。对方拒绝或事情解决后更新状态并清除不再需要的复核。

`life_plan` 的 `action` 为 `list/create/update/complete/cancel`。创建时间事项提供 `kind="time"`、`title`、`instruction` 和 `timing`；例如 `timing={kind:"after",after_seconds:600}`。修改或取消必须使用查询返回的计划 `id` 和当前 `expectedRevision`。`relatedRecords` 仍然只放连续性记录 ID。

## 工具校验失败

先读取错误涉及的记录或 Schema，修正对应字段后继续。不存在的记忆或计划不能以一段正文充当 ID；把文字移入 `content`，关联数组留空或填写已有 ID。不要为修正工具参数而改写人格、编辑数据库或不断重新初始化。
