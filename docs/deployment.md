# 服务器部署

## 准备配置

Linux amd64 服务器需要 Docker 和 Compose。复制 `.env.example` 为 `.env`，填写管理 HTTPS 域名、聊天接口及模型。真实凭据留在 `.env`。

兼容 OpenAI Chat Completions 的连接使用 `KW_CHAT_BASE_URL`、`KW_CHAT_API_KEY`、`KW_LLM_PROVIDER` 和 `KW_LLM_MODEL`。视觉默认复用这组模型与连接，也可以通过 `KW_VISION_*` 明确配置独立模型。

`KW_DATA_ROOT` 是服务器上的持久目录。Compose 将它挂载到容器 `/data`。应用使用 UID/GID 10001；数据准备命令在停止应用时创建目录并设置权限。

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

## 备份和恢复

每天按配置时间创建备份，保留期限由 `KW_BACKUP_KEEP_DAYS` 指定。完整备份包含数据库、Session、工作目录、扩展、媒体和 `artifacts/` 负载对象，以及版本清单与校验和。

v0.3.0 启动时将数据库升级到 Schema 3，并在迁移前保存原 Schema 1/2 的 SQLite 快照。正常升级先执行完整备份。连续性资料、来源、修订和计划关联保存在同一数据库；负载对象保持完整备份。新建对象目录使用 UID/GID 10001 和私有权限；全部中间文件继续写入 `/data/tmp`。

停止应用后，恢复到独立目录：

```sh
node scripts/admin.mjs restore /path/to/backup /path/to/restored-data
```

校验恢复内容后，将 `KW_DATA_ROOT` 指向恢复目录，使用备份对应的镜像，并执行数据权限准备与启动检查。恢复命令拒绝覆盖现有业务数据目录。

## 健康检查

`/kw-health` 返回进程存活、管理就绪和业务就绪状态。健康检查不调用模型，也不发送 QQ 消息。业务细节通过受管理权限保护的 Panel 和本地 socket 查询。
