# 服务器部署

## 准备配置

Linux amd64 服务器需要 Docker 和 Compose。复制 `.env.example` 为 `.env`，填写管理 HTTPS 域名、聊天接口及模型。真实凭据留在 `.env`。

兼容 OpenAI Chat Completions 的连接使用 `KW_CHAT_BASE_URL`、`KW_CHAT_API_KEY`、`KW_LLM_PROVIDER` 和 `KW_LLM_MODEL`。视觉默认复用这组模型与连接，也可以通过 `KW_VISION_*` 明确配置独立模型。

接口支持 DeepSeek 思考协议时，设置 `KW_CHAT_THINKING_FORMAT=deepseek`，向 Harness 声明实际可用档位。聊天默认使用 medium，辅助整理与检索使用已声明的 off，避免思考内容挤占 JSON 输出预算；没有声明该配置时保留接口原有行为。

模型上下文容量、输出长度和自动压缩策略由 Harness 的模型目录、适配器与宿主配置解析。KWAgent 不覆盖这些 Token 参数。自定义模型没有目录条目时使用 Harness 适配器的默认能力声明；可以通过 Harness 模型设置维护接口实际提供的能力。`role.prepare` 返回生效的模型信息和继承的压缩策略。感知、记忆与工具预览预算只控制资料装配和分页，不作为模型窗口或压缩阈值。

`KW_DATA_ROOT` 是服务器上的持久目录。Compose 将它挂载到容器 `/data`。应用使用 UID/GID 10001；数据准备命令在停止应用时创建目录并设置权限。

## GHCR 镜像与 1Panel 网络

服务器只需要 Compose 文件和自己的 `.env`。使用 `deploy/compose.1panel.yaml`，无需上传应用源码、安装 Bun 或构建镜像。该配置没有 `build` 和 `ports`，仅接入已有的外部网络 `1panel-network`。

同目录已有 `compose.yml` 时，将模板保存为 `compose.kwagent.yaml`，在 `.env` 中组合两个文件：

```dotenv
COMPOSE_PROJECT_NAME=kwagent
COMPOSE_FILE=compose.yml:compose.kwagent.yaml
KW_IMAGE=ghcr.io/kengwang/kwagent:0.6.0
KW_DATA_ROOT=./data/agent
KW_PUBLIC_URL=https://YOUR_KWAGENT_DOMAIN/
```

没有已有 Compose 文件时，将模板保存为 `compose.yaml`，省略 `COMPOSE_FILE`。填写模型、Milky 和凭据后，执行：

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env pull kwagent
docker compose --env-file .env run --rm --no-deps --user 0 kwagent node scripts/prepare-data.mjs
docker compose --env-file .env up -d --no-build --wait kwagent
docker compose --env-file .env exec -T kwagent node scripts/admin.mjs doctor
```

反向代理接入同一网络，上游使用 `http://kwagent:3080`。保留外部 Host、WebSocket Upgrade、查询参数和 Range 请求，支持长连接，并为 HTTPS 出口 Cookie 添加 Secure。`KW_PUBLIC_URL` 同时配置宿主的公开地址与可信 Host。

需要使用镜像加速时，在 `.env` 中把 `KW_IMAGE` 设置为 `ghcr.nju.edu.cn/kengwang/kwagent:0.6.0` 或对应的 `ghcr.1ms.run` 地址，可追加正式发布的 `@sha256:...` 固定 digest。拉取后核验镜像的版本与 `org.opencontainers.image.revision`，保持与发布标签一致。

`.env` 设置为 `0600`，避免把本地开发代理地址带到服务器。应用数据与已有服务分别挂载；指定 `kwagent` 服务进行拉取和启动，可保留已有服务的运行状态。

## 持久 Python 与浏览器

镜像包含 Python 3.11、uv 0.13.7、Python Playwright 1.64.1 和对应的无界面 Chromium。首次准备角色 Agent 时，使用 uv 在 `/data/workspaces/<角色ID>/.venv` 创建环境。环境共享镜像内只读的 Playwright 基础包，每个角色额外安装的 Python 包只保存在自己的 venv。重启继续准备现有环境，保留已安装的包。

`/data` 已持久挂载，因此 venv、脚本、浏览器 `browser-profile`、截图和下载均可跨容器重建保留。uv 缓存位于 `/data/cache/uv`。如需单独保存工作目录，可在 Compose 的 `volumes` 中额外添加 `./workspaces:/data/workspaces`；挂载后在停机状态执行上述权限准备命令。浏览器 profile 包含登录资料，属于持久私密数据，随工作目录进入完整备份。

角色的固定系统提示包含当前解释器路径与简短用法，详细 Python 浏览器示例位于 `kwagent-life` 的 `references/python.md`。工作目录内使用：

```sh
. .venv/bin/activate
uv pip install --python .venv/bin/python 包名
python script.py
```

每次 shell 调用分别激活，或直接调用 `.venv/bin/python`。服务器无须安装桌面或暴露浏览器调试端口。Compose 为浏览器提供 1 GiB 的共享内存，沿用现有 CPU、内存限制及 `init: true`。容器环境使用镜像中的 Linux Python，恢复时使用备份对应的镜像。

## 构建与启动

```sh
bun install --frozen-lockfile
node scripts/ci.mjs
node scripts/release.mjs --candidate
node scripts/release.mjs
node scripts/deploy.mjs
```

发布和部署要求受版本管理的修改全部提交。发布构建直接使用 `git archive` 的提交内容，未提交的个人脚本不进入镜像。候选镜像通过 Linux 容器验收后才登记版本镜像与标签。发布标签、镜像版本与提交一一对应，已有发布物保持不变。

`--candidate` 完成构建与验收后保留候选镜像。正式发布继续执行相同检查，并登记版本镜像与标签。迁移验收使用保留的 `kwagent:0.1.0` 镜像，在独立测试卷中生成旧数据库、升级和检查快照；不会操作现有业务卷。

首次手动准备和启动也可以执行：

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env run --rm --no-deps --user 0 kwagent node scripts/prepare-data.mjs
docker compose --env-file .env up -d --no-build --wait
```

容器日志输出 Harness 登录入口，启动凭据由 Harness 管理。管理页面通过已有 HTTPS 代理访问。代理配置参考 `deploy/nginx.conf.example`，保留 Host、WebSocket、签名参数和 Range 请求，并为 HTTPS 出口 Cookie 添加 Secure。

## 代理

本地开发的 `HTTP_PROXY`、`HTTPS_PROXY` 用于启动进程。Compose 的 `KW_BUILD_PROXY` 用于镜像构建，`KW_RUNTIME_PROXY` 用于运行容器，`NO_PROXY` 列出直接访问的地址。

在 Docker Desktop 中访问宿主代理可配置 `http://host.docker.internal:7897`。服务器根据实际网络配置。`KW_NODE_IMAGE` 可以指定可访问的 Node 镜像地址及固定 digest。Bun Linux 二进制从官方 npm 制品安装，并验证固定 SHA-256。

## 管理

```sh
docker compose exec -T kwagent node scripts/admin.mjs doctor
docker compose exec -T kwagent node scripts/admin.mjs status
docker compose exec -T kwagent node scripts/admin.mjs backup
docker compose exec -T kwagent node scripts/admin.mjs quiesce
docker compose exec -T kwagent node scripts/admin.mjs resume
```

创建角色可以编辑 `deploy/role.example.json`，通过 Panel 或 `node scripts/admin.mjs role.create @deploy/role.example.json` 提交。创建时角色默认未启用，绑定真实群聊或联系人并检查设定后启用。

对话重置、归档后自动创建新会话、删除角色和历史读取见 [角色管理](role-lifecycle.md)。

## 备份和恢复

每天按配置时间创建备份，保留期限由 `KW_BACKUP_KEEP_DAYS` 指定。完整备份包含数据库、Session、工作目录、扩展、媒体和 `artifacts/` 负载对象，以及版本清单与校验和。

v0.4.0 启动时将数据库升级到 Schema 4，并在迁移前保存原 Schema 1/2/3 的 SQLite 快照。正常升级先执行完整备份。连续性资料、角色删除标记、来源、修订和计划关联保存在同一数据库；负载对象保持完整备份。新建对象目录使用 UID/GID 10001 和私有权限；全部中间文件继续写入 `/data/tmp`。

停止应用后，恢复到独立目录：

```sh
node scripts/admin.mjs restore /path/to/backup /path/to/restored-data
```

校验恢复内容后，将 `KW_DATA_ROOT` 指向恢复目录，使用备份对应的镜像，并执行数据权限准备与启动检查。恢复命令拒绝覆盖现有业务数据目录。

## 健康检查

`/kw-health` 返回进程存活、管理就绪和业务就绪状态。健康检查不调用模型，也不发送 QQ 消息。业务细节通过受管理权限保护的 Panel 和本地 socket 查询。
