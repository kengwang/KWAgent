# 模型配置与角色预设

在 KWAgent Panel 的“模型配置”页面新建聊天、视觉或生图预设，填写 API 根地址、API Key 和模型名称。在“角色 → 编辑角色”中选择各用途的预设。预设可以被多个角色共用，修改从后续模型请求生效，正在进行的请求继续使用发起时的配置。

聊天预设支持 Harness 的 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 兼容协议。按接口实际要求选择推理格式和默认等级；角色的推理等级可以单独覆盖预设默认值。不设置额外模型 Token 上限，压缩继续交给 Harness 判断。

视觉预设使用 OpenAI Chat Completions 图片输入接口。未单独选择时，支持图片输入的 Chat Completions 聊天预设可以提供视觉能力；否则使用现有部署视觉默认值。生图使用单独的生图预设，支持同一接口的生成与编辑功能。

API Key 保存到 Harness home 中的受保护凭据文件，业务数据库只保存预设正文。列表与读取结果只返回凭据是否存在。编辑时留空保留原有 Key；勾选清除后删除已保存的 Key。已有角色继续使用原模型配置，选择预设后才建立关联。仍被角色使用的预设不能删除。

部署默认值可通过现有聊天、视觉环境变量配置。可选生图默认变量为 `KW_IMAGE_BASE_URL`、`KW_IMAGE_MODEL`、`KW_IMAGE_API_KEY`。环境预设在页面只读，需要其他配置时新建预设。备份包含数据库、Harness 凭据与 profile、媒体和原始负载。

## 图片工具

`image_generate` 调用 `POST /images/generations`。`image_edit` 通过 OpenAI Node SDK 向 `POST /images/edits` 上传当前角色已登记的图片与可选蒙版。根地址可以指向兼容接口，模型名称由管理者填写。

生成参数包括 `prompt`，以及可选的 `n`、`size`、`quality`、`background`、`outputFormat`、`outputCompression`。编辑另外接收 `imageIds`、可选 `maskId` 和 `inputFidelity`。参数未提供时使用接口默认值，具体模型不支持的选项会返回实际错误。

工具接收接口返回的 Base64 图片或图片 URL，完整响应保存为负载对象，图片保存到现有媒体目录。模型收到媒体标识、真实尺寸和读取入口。原图保留，生成结果不自动发送；角色可使用 `media_prepare` 准备发送资源。图片 URL 使用已有的下载容量和地址检查，避免把 API Key 转发给图片下载地址。

请求不自动重试。网络中断、取消或保存不完整时，操作保持结果未知，并保存已经取得的响应引用。后台执行、查询及完成通知沿用现有异步任务流程。

接口依据：[Images](https://developers.openai.com/api/reference/resources/images)、[Generate](https://developers.openai.com/api/reference/resources/images/methods/generate)、[Edit](https://developers.openai.com/api/reference/resources/images/methods/edit)。
