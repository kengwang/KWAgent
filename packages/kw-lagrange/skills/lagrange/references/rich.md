# 转发和富消息

## 合并转发

`forward.data`：

```typescript
const forward = {
  type: 'forward',
  data: {
    title,
    preview: previewLines,
    summary,
    prompt,
    messages: actualMessages.map(item => ({
      user_id: item.senderId,
      sender_name: item.senderName,
      segments: item.outgoingSegments,
    })),
  },
};
```

节点字段为 `user_id`、`sender_name`、`segments` 和可选 `message_style`。节点时间由服务器生成。不要加入不存在的 `time` 或 `avatar_url` 参数。

可以嵌套转发。媒体准备按实际接收会话执行，任一节点准备失败会终止整次发送并返回位置说明。

当前转发内部 `reply` 会形成空引用并在编码时省略。需要保留引用语义时，把真实原文和作者作为节点内容表达。

转发内部 `file` 参数：`file_id`、`file_name`、`file_size`，可选 `file_hash`、`url`。它引用已有文件，不上传新文件。提供 MD5 时使用真实的 32 个十六进制字符。

## 卡片与特殊片段

| 类型 | `data` 字段与条件 |
|---|---|
| `light_app` | `json_payload:string`，完整合法卡片 JSON 字符串 |
| `json` | `data:string`，按实现包装为 JSON 卡片，与 `light_app` 含义分别处理 |
| `location` | `latitude:string,longitude:string,title?,content?` |
| `music` | `type,id,url,audio,title,content,image` 全部为必填字符串 |
| `share` | `url,title,content,image` 全部为必填字符串 |
| `contact` | `contact_type:string,id:string` |
| `markdown` | `content:string`，实际展示取决于 QQ 接受情况 |
| `xml` | `xml:string`，使用已验证载荷 |
| `keyboard` | `data:string`，内容为按钮结构的 JSON 字符串 |
| `market_face` | `face_id:number,name?,url?,summary?`；当前实现把 `url` 当作十六进制标识字节内容 |
| `special_poke` | `face_id:number,count?,face_name?` |
| `bounce_face` | `face_id:number,count?,name?` |
| `group_reaction` | `reactions:[{face_id:string,type?,count?,is_added?}]`，用于消息内容 |
| `long_msg` | `res_id:string`，引用已有长消息资源 |
| `grey_tip` | `text:string` |
| `stream` | `text:string`，当前每次生成新标识，没有续写和结束流参数 |

商城表情不能随意填入图片 URL。音乐类型没有根据歌曲 ID 自动查找播放地址的实现，需要自行获取真实地址。

按钮、XML、Markdown、商城表情和结构化卡片具有编码路径，远程服务器和 QQ 客户端是否接受需要真实验证。没有明确发送上限校验不代表可以无限发送。

`poke` 消息片段使用 `{type:number,strength?:number}`，仅适用于直接私人会话且必须独占消息。日常戳一戳优先选择相应交互工具。
