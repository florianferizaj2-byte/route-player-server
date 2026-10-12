# 路线定位账号与卡密服务器

独立部署仓库使用 Node.js 24+，无第三方运行依赖。提供中文后台、App 登录、卡密激活及每账号路线备份。默认 `127.0.0.1:8790`。

## 启动与数据

从本仓库根目录使用 `npm start`，自动读取本地 `.env`（如果存在）。首次初始化管理员，无指定密码时随机生成并保存 `data/admin-login.txt`；后续启动不重置密码。Docker、HTTPS 和维护步骤见根目录 README。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `8790` | 端口 |
| `HOST` | `127.0.0.1` | 本机监听；局域网 `0.0.0.0` |
| `ROUTE_DATA_DIR` | 本目录 `data` | 持久化目录 |
| `ROUTE_ADMIN_USERNAME` | `admin` | 首次管理员账号 |
| `ROUTE_ADMIN_PASSWORD` | 随机生成 | 首次管理员密码，8–128 位 |
| `ROUTE_HTTPS` | `false` | HTTPS 代理后设 true，使 Cookie 带 Secure |

数据库保存 scrypt 密码摘要和盐、卡密 / 会话 SHA-256 摘要及完整路线。完整卡密只在生成响应和 CSV 中提供，不写数据库。管理员登录文件属于私密运行数据，不应分发。

`data` 已从 Git 和 Docker 构建上下文排除。停止服务后备份整个数据目录；恢复也先停止，再放回。数据库为单进程事务队列、临时文件同步与原子替换。多进程共享 JSON 不受支持，多实例需迁移至共享数据库并使用 HTTPS。

## 卡密与云备份

每批 1–500 张，正数有效天数最大 3650，支持小数供测试。首次激活计算到期时间并绑定账号、设备。未激活卡改有效天数；已激活卡改绝对到期时间。解绑只清设备，保留账号、期限。停用不暂停计时，启用不续期。

另一设备登录可查看状态，但原绑定卡不能用于定位和新备份。解绑后原账号用原卡密重新激活绑定新设备。云备份按账号隔离，最多 100 份，每次上传独立版本。到期后可下载 / 删除自己的数据，上传需有效卡密。

## 接口

请求与响应均为 JSON。App 用户使用 `Authorization: Bearer <登录令牌>`，会话 7 天。账号 3–32 位字母、数字和下划线，不区分大小写；密码 8–128 位。

| 方法 / 路径 | 内容 |
| --- | --- |
| GET `/health` | 身份、版本和状态 |
| POST `/v1/auth/register` | `{username,password,deviceId}` |
| POST `/v1/auth/login` | 同上，返回会话与激活状态 |
| POST `/v1/auth/logout` | 撤销当前会话 |
| POST `/v1/auth/password` | `{currentPassword,password}`，撤销全部会话 |
| GET `/v1/account/me` | 账号、卡密状态 / 期限、服务器核验时间 |
| POST `/v1/account/activate` | `{code}` 激活 / 重绑 |
| GET `/v1/routes` | 该账号备份列表 |
| POST `/v1/routes` | `{document:<rplroute对象>}` |
| GET `/v1/routes/:id` | 下载完整文档 |
| DELETE `/v1/routes/:id` | 删除自己的备份 |

管理员使用 HttpOnly、SameSite=Strict Cookie，8 小时，修改请求必须同源，无跨域开放接口。

| 方法 / 路径 | 内容 |
| --- | --- |
| POST `/v1/admin/login` | `{username,password}` |
| POST `/v1/admin/logout` | 撤销会话 |
| GET `/v1/admin/me` | 登录状态 |
| GET `/v1/admin/cards?page=1&q=...` | 每页 50 张，搜索 |
| POST `/v1/admin/cards` | `{count,durationDays,label,redeemBefore?}`，一次性完整卡密 |
| PATCH `/v1/admin/cards/:id` | `{disabled?,expiresAt?,durationDays?,label?}` |
| POST `/v1/admin/cards/:id/unbind` | 解绑设备 |
| GET `/v1/admin/users` | 账号列表 |
| GET `/v1/admin/audit` | 最近 100 条操作 |

默认每 IP 每分钟 240 次请求，注册 / 登录 / 改密码 / 激活最多 30 次。最大请求体 2 MB。服务器限制文档形状、版本、坐标、速度和点数，不信任客户端到期时间。公开服务需另做部署和规模验证，当前仅本机验收。

## 测试

`npm test` 运行 13 项 HTTP 测试，包含持久化、会话撤销、并发激活、期限、卡密管理、账号隔离和完整路线往返。Android `AccountApiTest` 启动独立临时服务，验证实际客户端契约。

`test/admin-ui.mjs` 用 Playwright 验收后台，独立临时数据库，输出报告和截图。可通过 `ROUTE_PLAYWRIGHT_MODULE`、`ROUTE_BROWSER_PATH` 指定现有安装；不操作用户数据。

密码实现依据：[Node scrypt 文档](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。
