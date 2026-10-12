# 部署与数据维护

在仓库根目录执行以下命令。命名卷保存账号、卡密摘要、会话、路线与管理员初始登录文件，不要提交它们。

## 备份

先停止应用进程再复制完整数据目录；`docker compose stop app` 保留容器和命名卷。操作期间 App 无法完成核验。

```bash
mkdir -p backups
docker compose stop app
docker compose cp app:/app/data ./backups/data
docker compose start app
```

每次备份使用一个新的目录，避免混合不同时间的文件。只有基础配置也可以按以上命令操作；HTTPS 入口仍在运行，但维护期间接口暂不可用。

## 恢复或迁移

如果服务器已有账号，先备份当前数据。将原电脑 `account-server/data` 中的完整数据通过 SSH/SFTP 等私密方式传到新服务器。GitHub 源码仓库不包含这些文件。

启动一次以创建容器和卷，然后停止应用，把备份目录内容放入卷，并修复容器用户的文件权限：

```bash
docker compose stop app
docker compose cp ./backups/data/. app:/app/data/
docker compose run --rm --no-deps --user root --cap-add CHOWN app chown -R node:node /app/data
docker compose start app
curl --fail http://127.0.0.1:8790/health
```

恢复是覆盖操作，执行前应核对源备份和目标项目。恢复后验证管理员登录、现有用户状态和一条已备份路线。数据目录中如果保留旧的 admin-login.txt，它记录的是首次密码；已修改密码时仍使用修改后的密码。

## 常见问题

- 端口 8790 被占用：调整 `.env` 的 PORT，应用容器内部仍使用 8790。
- HTTPS 后台无法登录：确认浏览器使用 HTTPS；已有代理应保留外部 Host，ROUTE_HTTPS 应为 true。
- 权限错误：容器以 node 用户运行，恢复文件后按上方修复数据卷权限。
- 首次管理员登录文件未生成：自定义了 ROUTE_ADMIN_PASSWORD 时使用该密码；已有管理员时启动不会重新生成。
- Caddy 证书未取得：检查域名 DNS、服务器 80/443 入口和网络可达性。服务器保持单实例；不要让多个进程同时修改同一数据库。
