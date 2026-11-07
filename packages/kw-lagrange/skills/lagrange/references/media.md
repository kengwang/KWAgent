# 图片、语音、视频与文件

## 资源位置

Lagrange.Milky 进程读取发送 URI：

- `http://` 和 `https://`：远程可访问地址。
- `base64://`：标准 Base64 内容。
- `file://`：Lagrange 所在机器的文件。

KWAgent 容器中的本地路径需要通过 `media_prepare` 发布。裸路径、相对路径和 `data:` URI 不能直接充当 Lagrange 的发送 URI。

`media_prepare` 可以登记当前角色工作目录中的文件，或者下载已有 HTTP 资源。传入真实 `resourceId` 会查询新的资源地址再保存。较大内容使用签名 URL，小型内容可以选择 Base64。

```typescript
const prepared = await tools.media_prepare({ uri: actualWorkspacePath, mode: 'url' });
// prepared.uri 用于发送；prepared.media.id 用于理解或再次准备。
const analysis = await tools.media_inspect({ mediaId: prepared.media.id });
```

`actualWorkspacePath` 使用当前角色工作目录中实际存在的绝对路径；传入字段是 `uri`。接收附件使用 `media_prepare({resourceId: segment.metadata.resource_id, eventId: event.sourceId})`，或直接使用感知提供的 `prepare.arguments`。已经登记的附件使用 `media_inspect({mediaId: media.id})`，也可以直接使用感知提供的 `inspect.arguments`。每次读取结果后再取得下一步标识，参数错误时读取当前 Schema，避免循环尝试不同字段名。

## 接收资源

使用 `get_resource_temp_url({resource_id})` 刷新资源地址，成功结果为 `{url}`。

语音和视频也有对应的 `get_group_ptt_url`、`get_private_ptt_url`、`get_group_video_url`、`get_private_video_url`，请求字段为 `resource_id`。

群文件地址使用 `get_group_file_download_url({group_id,file_id})`；私人文件使用 `get_private_file_download_url({file_id})`，结果字段为 `download_url`。

临时地址可能过期。不要将 `resource_id` 或 `file_id` 当作普通 HTTP 地址。

## 图片

`image.data`：`{uri,summary:string|null,sub_type?:"normal"|"sticker"}`。当前远端 Schema 要求提供 `summary` 字段；没有自定义摘要时填写 `summary:null`。

可以与普通文字组合。当前 outgoing image 没有闪照发送字段。

## 语音

`record.data` 为 `{uri}`。Lagrange 读取音频并转换、上传。语音单独组成一条消息，尤其是私人语音。

`transcribe_voice` 转写已经存在的 QQ 语音消息，参数为 `message_scene:"group"|"friend"`、`peer_id`、`message_seq`。使用 `media_prepare` 登记这类语音时保留 `eventId`。

可以使用远程语音合成工具取得真实资源，再发送。语音工具的音色等参数从对应目录查询。

## 视频

`video.data`：`{uri,thumb_uri:string|null}`。当前远端 Schema 要求提供 `thumb_uri` 字段；没有自定义封面时填写 `thumb_uri:null`。

未提供封面时实现使用内置图片，不会自动截取视频画面。需要明确封面时自行生成并准备资源。

## 文件

群文件通过：

```typescript
const args = {
  group_id: event.peerId,
  file_uri: prepared.uri,
  file_name: actualFilename,
  parent_folder_id: '/',
};
```

调用 `upload_group_file` 会进入群文件发送流程，成功返回 `file_id`。

私人文件使用 `upload_private_file({user_id,file_uri,file_name})`，该工具会直接发送给好友。

普通顶层消息不能包含 `file` 片段。转发节点中的文件片段表示已有文件引用，详见富消息参考。

## 理解媒体

`media_inspect` 处理已登记的图片、语音、视频和文档。视频理解保存抽帧结果；可以选择 `extract_audio` 提取音轨。提取文件需要可处理本地音频的独立语音识别工具，Lagrange 的语音转写只接受已有 QQ 语音消息。

理解失败时只根据实际已获得内容判断，不编造未读取的图片细节或语音。
