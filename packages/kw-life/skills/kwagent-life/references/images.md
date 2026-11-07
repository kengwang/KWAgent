# 图片生成与编辑

使用管理者为当前角色选择的生图模型预设。API 地址、Key 和模型名称由 Panel 的“模型配置”页面管理；无需在程序中读取或填写凭据。

```typescript
return await tools.image_generate({
  prompt: description,
  size: "1024x1024",
  n: 1,
});
```

`description` 是当前需要的画面描述。可选 `quality`、`background`、`outputFormat`、`outputCompression`；具体支持能力由所选模型决定。省略参数时使用接口默认值。压缩比例需要同时指定 `jpeg` 或 `webp`。

```typescript
return await tools.image_edit({
  prompt: changes,
  imageIds: [sourceMediaId],
});
```

`changes` 描述所需修改，`sourceMediaId` 来自当前感知或 `media_prepare` 返回的真实 `media.id`。编辑支持多张参考图；首张为主要编辑图。可选 `maskId` 指向同尺寸、带透明通道的 PNG，透明区域为修改区域。可选 `inputFidelity` 由接口决定是否支持。输入图片支持 PNG、JPEG 和 WebP，原图继续保留。

生成和编辑返回 `images`，其中每项包括 `mediaId`、保存路径、尺寸及类型。需要发送时先执行 `media_prepare({mediaId:结果中的真实mediaId})`，再使用返回的 `uri` 组装 Lagrange 图片消息。可以先检查结果再决定是否发送。生成成功不证明已经发送。

耗时操作沿用后台任务规则。收到任务句柄后不要轮询 `job_output` 或 `job_list`，不要通过 sleep、循环或 `wait:true` 等待；任务完成、失败或取消后系统会自动通知并唤醒你。即使要用结果继续编辑或发送，也先结束本轮，收到通知后再继续；结束当前活动不会取消生图任务。不要重复提交相同请求。预计等待时，是否先向对方说明正在处理由你自主判断。通知中的结果足够时直接使用，仅在缺少具体内容时按需读取一次完整负载。错误或结果未知时读取实际操作记录，不把提交、计划或部分结果描述为完整成功。
