# GitHub 与镜像发布

仓库为 `kengwang/KWAgent`，镜像使用 `ghcr.io/kengwang/kwagent`。GitHub Actions 使用仓库自己的 `GITHUB_TOKEN`，构建和推送无需保存个人访问令牌。工作流对源码只申请读取权限，对镜像发布申请 `packages: write`。

## 自动检查

`main` 推送、Pull Request、`v*` 标签及手动运行触发 `.github/workflows/ci.yml`：

1. Gitleaks 扫描完整 Git 历史，日志中的命中内容脱敏。
2. Actionlint 检查工作流，下载包校验固定 SHA-256。
3. Bun 1.4.2 冻结锁文件安装，Node.js 24.18.0 完成构建、类型检查、真实 SQLite 测试和发布文件检查。
4. 构建 Linux amd64 镜像，在断网容器中启动实际 Harness，验证 UID 10001、管理就绪、SQLite、连续性记录、负载对象、单实例锁及完整备份恢复。
Docker 任务在 GitHub 临时 Runner 中准备构建空间，再构建和验证当前镜像；管理脚本同样使用固定的 Node.js 24.18.0。Schema 迁移仍由真实 SQLite 自动测试覆盖，保留版本的完整镜像升级专项可以通过 `node scripts/verify-upgrade.mjs <镜像>` 按需执行。

自动化不使用生产 `.env`，不连接 QQ、空间、Milky 或模型。验收数据保存在临时容器自己的 `/data`，退出后删除容器。

## 镜像标签

| 事件 | 发布标签 |
|---|---|
| `main` 推送／手动运行 | `main`、`sha-<完整提交>` |
| 正式版本 `vX.Y.Z` | `X.Y.Z`、`latest`、`sha-<完整提交>` |
| 预发布版本 | 完整预发布版本、`sha-<完整提交>` |
| Pull Request | 只构建和验收 |

镜像包含源码地址、版本和提交标识，并生成 SBOM 与构建来源记录。版本标签必须和 `package.json` 一致；已有版本镜像会阻止再次发布，新的发布需要新的版本号。原有本地 `v0.1.0`、`v0.2.0` 标签保持不变；旧标签的源码没有该工作流，首次自动发布由当前 `main` 触发。

第三方 Actions 固定到完整 commit SHA。升级 Actions、扫描器和基础运行环境时，一并检查依赖、工作流和实际镜像。

同一提交的镜像任务串行执行；已经存在的完整SHA镜像保持不变，main与版本标签发布不会覆盖它。版本镜像仍通过独立检查防止重复发布。

## 私密数据

`.env`、私钥、数据库及 WAL、媒体、备份、运行日志、Session、动态扩展、工作目录、本地 Compose 覆盖文件和本地社交验收脚本由 `.gitignore` 排除。`.env.example` 使用公开通用默认值；真实端点、账号和凭据只保存到本地配置或数据库。

Docker 使用构建上下文白名单，排除 `.git`、实际环境配置、构建输出及本地运行文件。`check-secrets.mjs` 在 CI 和本地检查待发布文件；即使文件被强制加入 Git，私密路径仍然会使检查失败。

忽略规则仅影响新文件。完整 Git 历史已经过凭据扫描及实际 API Key 的精确匹配检查，未发现凭据；历史保留早期的服务地址和验收账号。不要将运行日志或包含登录入口的截图作为工作流附件上传。

仓库已公开。GHCR 容器包的可见性单独管理；在包设置中将其设为 Public 后，服务器可以匿名拉取。将仓库设为 Public 不会自动公开已有容器包。

## 使用 GHCR 镜像部署

私有包需要服务器使用具有 `read:packages` 权限的凭据登录 GHCR。通过 `docker login ghcr.io --password-stdin` 输入凭据，避免写入仓库、Compose 或命令参数。

在服务器的 `.env` 中设置固定版本或提交镜像：

```dotenv
KW_IMAGE=ghcr.io/kengwang/kwagent:sha-<完整提交>
```

```sh
docker compose --env-file .env pull
docker compose --env-file .env run --rm --no-deps --user 0 kwagent node scripts/prepare-data.mjs
docker compose --env-file .env up -d --no-build --wait
```

已有实例升级前使用完整备份流程。服务器仍需配置自己的 Milky、模型接口、HTTPS 域名和持久目录。构建与部署详情见 `docs/deployment.md`。
