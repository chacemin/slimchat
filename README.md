# SlimChat

SlimChat 是一个**纯本地、单进程**的团队聊天系统：Vue 3 前端 + Hono 路由 + Bun 运行时 + 一个 SQLite 文件 + 一个本地附件目录。它不依赖 Cloudflare、Redis、对象存储或任何公网服务，断网可用，备份就是复制 `data/`。

> 本项目基于 [aozorae/Edgechat](https://github.com/aozorae/Edgechat) `v2.21.3`（提交 `2c18b63`，GPL-3.0）修改而来，保留 GPL-3.0 许可证并删除了 Telegram 桥接、跨实例互联、Cloudflare 绑定与云端部署流程。修改说明与实施方案见 [docs/](docs/README.md)。

## 功能

- 群聊、私信、邀请制注册、封禁、RBAC 与审计日志
- 消息与附件 AES-256-GCM 加密，密钥环保存在本机，管理员后台不读取正文
- Markdown、回复、提及、置顶、已读、语音消息
- WebSocket 实时推送 + `/api/v1/rooms/:kind/:id/sync` 断线补偿
- WebMCP `/api/v1`，供 AI 客户端接入
- 1v1 语音通话：P2P 直连 + 本地 coturn TURN 中继
- PWA 安装与 Capacitor Android 客户端
- 站点外观、主题、隐身登录
- 本地文件附件、本地会话、内存 WebSocket 集线器、进程内定时任务

## 快速开始

需要 [Bun](https://bun.sh/) ≥ 1.2。

```bash
bun install
cp .env.example .env
# 至少设置 SLIMCHAT_ADMIN_PASSWORD

bun run keyring:init     # 只执行一次；丢失后历史消息/附件将永久不可解密
bun run db:migrate
bun run admin:bootstrap
bun run build
bun run start            # http://127.0.0.1:8787
```

开发模式：

```bash
bun run dev              # 后端 --watch
bun run dev:frontend     # Vite 5173，代理 /api 与 /files 到 8787
```

## 飞书通知

每个用户可以在「设置 → 飞书通知」单独填写自己的飞书机器人 Webhook：

- 仅接受 `https://open.feishu.cn/open-apis/bot/v2/hook/...`
- 仅在该用户**没有任何客户端在线**时发送
- 只发送**私聊消息**和**群组中 @ 该用户**的消息
- **每一次私聊语音来电**都会给被叫方发送提醒（不受在线状态限制，避免漏接）
- Webhook 使用现有密钥环加密保存；可在设置页发送测试消息

公共群里的普通消息、回复和被拉黑的会话不会触发飞书提醒。

## Docker Compose

仓库自带 `Dockerfile` 与 `docker-compose.yml`。首次启动会自动生成密钥环、建库迁移，并在提供了管理员密码时创建首个管理员。

```bash
cp .env.example .env
# 编辑 .env，至少设置 SLIMCHAT_ADMIN_PASSWORD

docker compose up -d --build
docker compose logs -f slimchat
# http://127.0.0.1:8787
```

国内网络默认使用 `docker.m.daocloud.io/oven/bun` 基础镜像和 `registry.npmmirror.com` 依赖源，避免 Docker Hub / npm 官方源无法访问。若你的网络环境不同，在 `.env` 中覆盖：

```dotenv
BUN_IMAGE=docker.m.daocloud.io/oven/bun
BUN_VERSION=1.4.5
NPM_REGISTRY=https://registry.npmmirror.com
```

海外网络可改为 `BUN_IMAGE=oven/bun`、`NPM_REGISTRY=https://registry.npmjs.org`。如果 DaoCloud 镜像也不可达，请先在 Docker 中配置可用的 registry mirror，或先把 `oven/bun:1.4.5` 拉取到本地后再构建。

- 数据保存在命名卷 `slimchat-data`（容器内 `/app/data`），删除容器不会丢数据。
- 宿主机默认只发布到 `127.0.0.1:8787`；局域网访问请设置 `SLIMCHAT_PUBLISH_ADDRESS=0.0.0.0`，同步修改 `SLIMCHAT_PUBLIC_ORIGIN` / `SLIMCHAT_SITE_ORIGINS`，并启用登录口令。
- 备份与恢复在容器内执行：

```bash
docker compose exec slimchat bun run backup
docker compose exec slimchat bun run restore --from /app/data/backups/<时间戳>
docker compose cp slimchat:/app/data/backups ./backups
```

- 升级：`docker compose build --pull && docker compose up -d`；升级前先备份。

## 数据与备份

运行期数据全部位于 `data/`：

```
data/
├── slimchat.db           # 业务数据 + 会话 + 消息事件
├── files/                # AES-GCM 密文附件
├── secrets/keyring.json  # 加密密钥环（权限 600）
├── logs/
└── backups/
```

```bash
bun run backup                              # VACUUM INTO + 文件 + 密钥环 + manifest
bun run restore --from data/backups/<时间戳>
```

**必须同时备份数据库、`files/` 与 `keyring.json`。** 只备份数据库会导致历史消息和附件无法读取。不要把 `data/` 放在 OneDrive、网盘、SMB/NFS 等同步目录，SQLite WAL 会损坏。

## 配置

所有配置使用 `SLIMCHAT_` 前缀，详见 [.env.example](.env.example)。默认只监听 `127.0.0.1`。局域网访问时：

1. 设置 `SLIMCHAT_HOST=0.0.0.0` 与 `SLIMCHAT_PUBLIC_ORIGIN` / `SLIMCHAT_SITE_ORIGINS`；
2. 启用 `SLIMCHAT_LOGIN_GATE_ENABLED=true` 并设置访问口令；
3. 建议使用 Caddy / nginx 提供 HTTPS；WebSocket 需透传 `Upgrade` 头。

## 语音通话

P2P 直连无需配置。跨网段通话需在本机或内网启动 coturn，并设置：

```dotenv
SLIMCHAT_TURN_URL=turn:127.0.0.1:3478
SLIMCHAT_TURN_USERNAME=...
SLIMCHAT_TURN_CREDENTIAL=...
# 或使用 coturn 共享密钥，进程内签发短期凭据
SLIMCHAT_TURN_SHARED_SECRET=...
```

## 测试与检查

```bash
bun test
bun run biome:ci
bun run build
```

## 安全边界

- `/files/:key` 必须经过会话和消息/头像/站点图标授权，磁盘目录永不经静态服务暴露。
- 会话 token 只存 SHA-256；Cookie 为 HttpOnly；CORS 使用站点白名单。
- 登录限流同时落库，重启不能绕过；可选访问口令替代 Turnstile。
- 日志不记录消息正文、token 或密钥。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证与来源

本项目沿用上游 **GPL-3.0**，`LICENSE` 原文保留。SlimChat 是基于 Edgechat 的衍生作品；如需再分发，请继续使用 GPL-3.0、保留原版权声明，并注明对 Telegram/桥接/Cloudflare 运行时的删除与 Bun/SQLite 本地化改造。

实施方案文档：[docs/README.md](docs/README.md)。
