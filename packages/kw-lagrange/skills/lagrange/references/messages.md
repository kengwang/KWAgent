# 普通消息和表情

以下是参数化组装方法，变量均来自当前事件或实际查询结果。组装完成后向工具提交标准 JSON。

## 文字

```typescript
const message = [{ type: 'text', data: { text: yourText } }];
const args = { group_id: event.peerId, message };
```

## 提及

`mention` 使用 `{user_id:number,name?:string}`。群内目标需要能解析为当前群成员。先查询成员列表或资料，确认真实身份。

`mention_all` 的 `data` 为 `{}`。账号权限、群限制和剩余次数仍然适用，可以查询 `get_group_at_all_remain`。

## 引用

```typescript
const args = {
  group_id: event.peerId,
  message: [
    { type: 'reply', data: { message_seq: event.messageSeq } },
    { type: 'text', data: { text: yourReply } },
  ],
};
```

引用按当前会话查找原消息。找不到消息时会失败。收到的引用片段中可能包含原作者和展开内容，可按需要阅读。

## 系统表情

使用 `get_system_faces`、`search_system_faces`、`get_system_face` 查询表情。

`face` 参数：

| 字段 | 类型 | 说明 |
|---|---|---|
| `face_id` | string | 十进制表情编号 |
| `is_large` | boolean，可选 | 大表情或动画 |
| `result_id` | string，可选 | 目录支持的动画结果 |
| `raw` | string，可选 | 已有表情附加内容 |

指定动画结果时需要对应动画元数据。编号使用查询结果，不推测编号。

`dice` 默认编号 358，`rps` 默认编号 359。它们没有指定点数或手势的专用字段。

## 图片表情

图片使用 `image`，其中 `sub_type:"sticker"` 表示图片表情。GIF 等资源的实际表现由远程上传结果和客户端决定。

```typescript
const prepared = await media_prepare({ mediaId, mode: 'url' });
const args = {
  group_id: event.peerId,
  message: [{ type: 'image', data: { uri: prepared.uri, sub_type: 'sticker', summary: yourSummary } }],
};
```

## 消息样式

顶层可选 `message_style` 包含 `bubble_id`、`pendant_id`、`font_id`、`font_effect_id`、`is_cs_font_effect_enabled`、`bubble_diy_text_id`。需要真实可用的样式标识。
