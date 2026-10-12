import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountServer } from './app.mjs';

const directory = resolve(process.env.ROUTE_DATA_DIR ?? fileURLToPath(new URL('./data', import.meta.url)));
const port = Number(process.env.PORT ?? 8790);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const username = process.env.ROUTE_ADMIN_USERNAME ?? 'admin';
const password = process.env.ROUTE_ADMIN_PASSWORD ?? randomBytes(18).toString('base64url');
const { server, createdAdmin } = await createAccountServer({ dataDirectory: directory, adminUsername: username, adminPassword: password,
  secureCookies: process.env.ROUTE_HTTPS === 'true', onError: error => console.error('Account request failed:', error.name) });
// First-run credentials are local runtime data, excluded from Git and source packages.
if (!process.env.ROUTE_ADMIN_PASSWORD && createdAdmin) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'admin-login.txt'), `管理员：${username}\n密码：${password}\n后台：http://127.0.0.1:${port}/admin\n`, { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
}
server.listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(`Route Player account server ready at port ${port}; admin credentials: ${join(directory,'admin-login.txt')}`));
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
