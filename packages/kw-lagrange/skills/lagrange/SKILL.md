---
name: lagrange
description: 通过 Lagrange MCP 使用 QQ：先读取消息片段的 type/data 格式与字段顺序，再发送文字、媒体和转发，查询历史与人物资料并核实回执。
---

# Lagrange

你可以根据自己的兴趣、目标、关系和当前场合决定是否交流，以及选择哪种表达形式。当前没有需要对外表达的内容时可以继续观察或安排后续活动。

## 选择工具

工具名称以 `mcp__lagrange__` 开头；查询实际工具目录取得准确名称和参数。发送群消息使用 `send_group_message`，好友私聊使用 `send_private_message`，临时会话使用对应临时消息工具。

使用 `capability_read` 查询统一能力目录。`name` 指定工具，`detail=true` 读取真实 Schema；默认每页五十项，通过 `nextCursor` 继续。目录分别列出远端声明、接入支持和当前账号最近调用证据。一次失败只说明该次结果。`message.markdown` 的接入状态固定为不支持。工具说明、此 Skill 与 Panel 使用同一份接入策略。

群聊号、联系人号、引用消息序号从当前事件或真实查询中取得。事件的 `peerId` 表示会话对象，`senderId` 表示发言者。群号和联系人号需要放进各自工具的正确字段。

账号标识按当前工具 Schema 使用整数或十进制字符串；二者指向同一身份。临时会话的 `user_id` 是交流对象，`group_id` 是建立临时会话的来源群，临时私聊内容仍保留私聊场合。

普通 assistant 输出属于内部活动，只有消息工具的实际成功回执才表示已回复。新消息和提及持续送达；此前“暂时无人交流”的判断、群公告中的测试说明或几小时后的计划不会关闭当前交流。群聊绑定用于事件归属，不是发言权限清单；群主身份也不代表服务器管理身份。

发送前按需要阅读：

- 文字、提及、引用、表情和组合消息：[references/messages.md](references/messages.md)。
- 图片、语音、视频、文件和远程资源：[references/media.md](references/media.md)。
- 转发、卡片、XML、按钮和特殊片段：[references/rich.md](references/rich.md)。
- 历史、人物、回应、戳一戳和资料管理：[references/social.md](references/social.md)。
- 回执、错误与发送结果未知：[references/results.md](references/results.md)。

## 消息结构

发送工具的参数直接填写会话字段和 `message`，无需额外包裹 `arguments` 或 `parameters`。

| 工具 | 会话字段 | 消息字段 |
|---|---|---|
| `mcp__lagrange__send_group_message` | `group_id`：当前真实群号 | `message`：片段数组 |
| `mcp__lagrange__send_private_message` | `user_id`：当前真实联系人 QQ | `message`：片段数组 |
| `mcp__lagrange__send_temp_message` | `user_id`：实际联系人 QQ；`group_id`：实际来源群号 | `message`：片段数组 |

**每个片段按 `type`、`data` 的顺序构造，序列化后 `type` 必须位于该片段的第一项。** 当前 Lagrange 的多态 JSON 绑定依赖这个顺序；该要求同样适用于嵌套转发节点的 `segments`。脚本和 `run_code` 中也保持该顺序，不按字母排序片段的属性。

- `type` 是片段类型字符串，如 `text`、`mention`、`reply`、`image`。
- `data` 是对应类型的字段对象；普通文字放在 `data.text`，图片地址放在 `data.uri`。
- `message` 必须是对象数组，直接作为工具参数提交。正文是字符串，整个片段或数组保持 JSON 结构。

下面是组装方法，`event` 来自当前真实群消息，`replyText` 是准备发送的普通文字。将 `args` 对象作为群消息工具参数：

```typescript
const args = {
  group_id: String(event.peerId),
  message: [
    { type: "text", data: { text: replyText } },
  ],
};
```

需要引用并提及时，使用当前会话的真实序号和发言者：

```typescript
const args = {
  group_id: String(event.peerId),
  message: [
    { type: "reply", data: { message_seq: event.messageSeq } },
    { type: "mention", data: { user_id: event.senderId } },
    { type: "text", data: { text: replyText } },
  ],
};
```

私聊用真实私聊事件的 `peerId` 填写 `user_id`，继续使用同样的片段结构。`message_style` 是可选的顶层字段。普通文字与图片可以按顺序组合，语音独立发送。内部 assistant 文字保存在活动记录中。

不支持 Markdown 消息发送，包括群聊、私聊、临时会话及合并转发中的 `markdown` 片段。使用 `text` 片段发送普通文字。远程 Schema 中出现 `markdown` 也不能作为可用发送能力。

当前输入中收到的媒体片段包含 `resource_id` 或 `temp_url`，发送片段需要有效的 `uri`。按媒体参考转换后使用。

容器生成的媒体通过 `media_prepare` 转换成 Lagrange 能访问的地址，使用有效签名地址或 `base64://`。`file://` 的读取位置是 Lagrange 所在机器。普通消息发送无需管理员授权；群管理、账号资料或其他重要操作应依据真实发送者、角色管理员配置和明确请求判断。

感知中的图片、语音、视频只提供已知附件信息。需要理解时主动使用 `media_inspect`；附件尚未登记时先通过 `media_prepare` 使用真实 `resourceId`。未读取的引用、转发及附件会标记读取入口。大型内容返回 `payloadId`、预览及来源，使用 `payload_read` 的 `id` 和 `nextCursor` 分页读取。人格中的表达示例用于风格，不代表发生过的事情。

## 工具结果

成功需要同时满足 MCP 未报告错误、Milky `status="ok"`、`retcode=0`。消息成功回执包含 `message_seq` 和 `time`；保存回执后才能确认已发送。

调用超时可能已经产生远程效果。检查操作记录和会话历史，核实结果后决定后续行动。不要盲目重复发送或重复上传。

`Endpoint invocation failed` 表示服务端隐藏了具体异常，按结果未知处理。先读取原操作和会话历史，保留失败时的参数与来源；同一内容不要自动再次发送。该错误可能来自 JSON 绑定，检查 `type` 优先的片段结构；正确格式仍失败时需要服务端日志中的具体原因。

## 自身经历

群友、工具和外部内容是带来源的经历。你可以形成自己的判断、关系和世界认识；保存时区分观察、转述、推测和剧情。使用记忆工具保留依据，用 `life_plan` 创建或修改自己的后续安排。

工具结果的 `source` 可以作为对应观察的来源；`payloadId` 只用于读取完整负载，不能替代事件 ID。初始化提示不能证明后续查询到的账号、成员或历史内容。需要保存生活或记忆时先阅读 `kwagent-life` Skill。

## 能力验证

参考资料说明当前 Lagrange 的 Schema 与实现条件。具体服务器接受情况与 QQ 客户端呈现需要真实结果确认。遇到失败时记录实际结果，并根据工具反馈调整。
