# 路线定位服务器

Android 路线定位 App 的独立账号服务器，包含中文管理后台、登录、卡密激活和每账号路线备份。服务端协议版本 1.1.0，兼容 App 1.1.0 / 1.1.1。此仓库只包含服务器，不包含 Android 工程、APK 或本机用户数据。

## 功能

- 用户注册、登录、退出、改密码及会话撤销。
- 卡密批量生成、CSV 下载、有效期修改、停用 / 启用、设备解绑。
- 首次激活计时，绑定账号和随机 App 安装编号；解绑保留账号及原到期时间。
- 路线备份、列表、下载和删除，按账号隔离，完整保存点序、速度、循环和两种模式草稿。
- 随机管理员初始密码，密码、卡密和会话分别保存校验摘要。

## 本机启动

安装 Node.js 24+，无需安装第三方运行依赖。在本仓库目录运行：

```bash
cp .env.example .env
npm start
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。打开 `http://127.0.0.1:8790/admin`，管理员账号和随机密码在 `data/admin-login.txt`。完整卡密只在生成后显示一次，及时下载 CSV。

`.env` 在 Node 启动时读取，也供 Docker Compose 配置变量。已有数据时不会重置管理员密码，修改首次初始化配置不等于修改现有账号。

## Docker 部署

需要 Docker Engine 和 Compose。克隆本仓库后：

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec app cat /app/data/admin-login.txt
curl --fail http://127.0.0.1:8790/health
```

基础配置只把端口开放给服务器本机，适合本机验证或已有反向代理。数据保存在 `route-data` 命名卷，重建容器仍保留。不要使用 `docker compose down -v`，它会删除持久数据卷。

## 公网 HTTPS

将真实域名解析到服务器，开放 80、443 端口，在 `.env` 把 `ROUTE_DOMAIN` 改成该域名。使用附带 Caddy 入口：

```bash
docker compose -f compose.yaml -f deploy/compose.https.yaml up -d --build
docker compose exec app cat /app/data/admin-login.txt
```

管理后台为 `https://你的域名/admin`；App 的服务器地址填写 `https://你的域名`，不带 `/admin`。HTTPS 配置会启用 Secure Cookie。已有 HTTPS 代理时使用基础配置，将 `.env` 的 `ROUTE_HTTPS` 设为 `true`，代理保留原请求 Host；代理到 `127.0.0.1:8790`。

当前按直接连接地址限流，同一个反向代理转发的请求共享计数。数据存储由一个进程管理，不能启动多个实例共享 JSON；多用户大规模部署前需调整代理限流并迁移共享数据库。

## 更新与备份

更新前备份；拉取代码并使用原 Compose 项目和命名卷启动：

```bash
git pull --ff-only
docker compose up -d --build
```

使用 HTTPS 配置时，更新命令同样带上 `-f compose.yaml -f deploy/compose.https.yaml`。完整备份和恢复步骤见 [部署说明](deploy/README.md)。

本仓库不含原电脑的数据。新服务器第一次启动会建立空数据库；需要保留现有账号时单独迁移数据目录，不能通过 GitHub 传输数据库或管理员密码。

## 验证

```bash
npm test
```

13 项 HTTP 测试覆盖卡密期限、并发归属、设备迁移、账号隔离、路线完整往返、持久化和会话撤销。`test/admin-ui.mjs` 是可选的 Playwright 管理后台检查，使用独立临时数据；可用 `ROUTE_PLAYWRIGHT_MODULE` 和 `ROUTE_BROWSER_PATH` 指定已有安装。

GitHub Actions 会运行 HTTP 测试，检查 Compose 配置，构建并启动 Docker 镜像，检查健康状态和容器重建后的数据保留。生产域名、证书和公网服务器需要实际部署后验收。

接口和配置见 [API 说明](docs/api.md)。保留原工程 MIT 许可，来源见 [NOTICE](NOTICE)。

部署配置参考：[Node 官方镜像](https://hub.docker.com/_/node)、[Compose 文件合并规则](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/)、[Caddy 反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。
