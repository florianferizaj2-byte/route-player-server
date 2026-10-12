import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Store } from './store.mjs';

const derive = promisify(scrypt);
const DAY = 86_400_000;
const MAX_BODY = 2_097_152;
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (status, error) => { throw Object.assign(new Error(error), { status, code: error }); };
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const normalizedUser = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(value)) failure(400, 'invalid_username');
  return value.toLowerCase();
};
const validPassword = value => {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) failure(400, 'invalid_password');
  return value;
};
const device = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) failure(400, 'invalid_device');
  return value;
};
async function passwordRecord(value) {
  const salt = randomBytes(16).toString('hex');
  return { salt, digest: (await derive(value, salt, 64, { N: 16384, r: 8, p: 1 })).toString('hex') };
}
async function matchesPassword(value, record) {
  const digest = await derive(value, record?.salt ?? 'dummy-password-salt', 64, { N: 16384, r: 8, p: 1 });
  return record ? timingSafeEqual(digest, Buffer.from(record.digest, 'hex')) : false;
}
function validPoints(points, limit) {
  return Array.isArray(points) && points.length <= limit && points.every(p => Array.isArray(p) && p.length === 2 &&
    Number.isFinite(p[0]) && Math.abs(p[0]) <= 90 && Number.isFinite(p[1]) && Math.abs(p[1]) <= 180);
}
export function validateRoute(document) {
  const d = document?.draft;
  const selected = d?.mode === 'TWO_POINTS' ? d.twoPoints : d?.pathPoints;
  if (!document || document.format !== 'route-player' || document.version !== 1 || document.coordinateSystem !== 'WGS84' ||
    !validId(document.id) || typeof document.name !== 'string' || !document.name.trim() || document.name.length > 120 || /[\u0000-\u001f]/.test(document.name) ||
    !Number.isSafeInteger(document.createdAt) || document.createdAt < 0 ||
    !d || !['TWO_POINTS','PATH'].includes(d.mode) || !['ONCE','CLOSED_LOOP','PING_PONG'].includes(d.repeat) ||
    !Number.isFinite(d.speed) || d.speed < 0.5 || d.speed > 120 ||
    !validPoints(d.twoPoints, 2) || !validPoints(d.pathPoints, 200) || !selected || selected.length < 2 ||
    new Set(selected.map(p => p.join(','))).size < 2) failure(400, 'invalid_route');
  // Drop unknown keys instead of persisting client-controlled object shapes.
  return { format: 'route-player', version: 1, coordinateSystem: 'WGS84', id: document.id, name: document.name.trim(),
    createdAt: document.createdAt, draft: { mode: d.mode, repeat: d.repeat, speed: d.speed,
      twoPoints: d.twoPoints.map(p => [...p]), pathPoints: d.pathPoints.map(p => [...p]) } };
}

export async function createAccountServer({ dataDirectory, adminUsername, adminPassword, clock = Date.now, secureCookies = false,
  rateLimit = 240, authRateLimit = 30, onError = () => {} }) {
  const store = await new Store(dataDirectory).initialize();
  let createdAdmin = false;
  if (!store.read(s => s.users.some(u => u.role === 'admin'))) {
    const username = normalizedUser(adminUsername);
    const password = await passwordRecord(validPassword(adminPassword));
    await store.transact(s => s.users.push({ id: randomUUID(), username, password, role: 'admin', createdAt: clock(), disabled: false }));
    createdAdmin = true;
  }
  const requests = new Map();
  function limited(request, auth = false) {
    const period = Math.floor(clock() / 60_000);
    const key = `${request.socket.remoteAddress}:${auth ? 'auth' : 'all'}`;
    const old = requests.get(key);
    const next = old?.period === period ? { period, count: old.count + 1 } : { period, count: 1 };
    if (requests.size > 10000) requests.clear();
    requests.set(key, next);
    if (next.count > (auth ? authRateLimit : rateLimit)) failure(429, 'rate_limited');
  }
  const json = (response, status, body, headers = {}) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
    response.end(JSON.stringify(body));
  };
  async function body(request) {
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) failure(413, 'payload_too_large');
      chunks.push(chunk);
    }
    try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (result === null || Array.isArray(result) || typeof result !== 'object') failure(400, 'invalid_json');
      return result;
    } catch (error) { if (error.status) throw error; failure(400, 'invalid_json'); }
  }
  function authenticated(request, admin = false) {
    const bearer = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? '')?.[1];
    const cookie = /(?:^|;\s*)rp_admin=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
    const token = admin ? cookie : bearer;
    const result = store.read(s => {
      const session = s.sessions.find(v => v.hash === hash(token ?? '') && v.expiresAt > clock());
      const user = session && s.users.find(v => v.id === session.userId && !v.disabled);
      return { session, user };
    });
    if (!token || !result.user || (admin ? result.user.role !== 'admin' : result.user.role !== 'user')) failure(401, 'unauthorized');
    if (admin && !['GET','HEAD'].includes(request.method)) {
      let origin;
      try { origin = new URL(request.headers.origin).host; } catch { failure(403, 'invalid_origin'); }
      if (origin !== request.headers.host) failure(403, 'invalid_origin');
    }
    return result;
  }
  function activation(s, user, deviceId) {
    const card = s.cards.find(v => v.id === user.cardId);
    let state = 'inactive';
    if (card) {
      if (card.disabled) state = 'disabled';
      else if (card.expiresAt <= clock()) state = 'expired';
      else if (!card.deviceId) state = 'unbound';
      else if (card.deviceId !== deviceId || card.userId !== user.id) state = 'other_device';
      else state = 'active';
    }
    return { state, expiresAt: card?.expiresAt ?? null, cardLabel: card?.label ?? '', checkedAt: clock(), leaseSeconds: 300 };
  }
  const accountView = (s, session, user) => ({ user: { id: user.id, username: user.username },
    activation: activation(s, user, session.deviceId), expiresAt: session.expiresAt });
  const audit = (s, actor, action, target) => { s.audit.push({ id: randomUUID(), actor, action, target, at: clock() }); s.audit = s.audit.slice(-2000); };
  const publicCard = (s, c) => ({ id: c.id, hint: c.hint, label: c.label, durationDays: c.durationDays,
    disabled: c.disabled, createdAt: c.createdAt, activatedAt: c.activatedAt, expiresAt: c.expiresAt, redeemBefore: c.redeemBefore,
    username: s.users.find(u => u.id === c.userId)?.username ?? null, deviceId: c.deviceId,
    state: c.disabled ? 'disabled' : c.expiresAt && c.expiresAt <= clock() ? 'expired' : c.userId ? c.deviceId ? 'active' : 'unbound' :
      c.redeemBefore && c.redeemBefore <= clock() ? 'redeem_expired' : 'unused' });
  const summary = r => ({ id: r.id, name: r.document.name, uploadedAt: r.uploadedAt, pointCount:
    r.document.draft.mode === 'PATH' ? r.document.draft.pathPoints.length : r.document.draft.twoPoints.length,
    speed: r.document.draft.speed, repeat: r.document.draft.repeat });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { status: 'ok', service: 'route-player', version: '1.1.0' });
      limited(request);
      if (request.method === 'GET' && ['/', '/admin', '/admin/', '/admin/app.js', '/admin/style.css'].includes(url.pathname)) {
        const name = url.pathname.endsWith('app.js') ? 'app.js' : url.pathname.endsWith('style.css') ? 'style.css' : 'index.html';
        response.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
        return response.end(await readFile(new URL(`./web/${name}`, import.meta.url)));
      }
      if (request.method === 'POST' && ['/v1/auth/register', '/v1/auth/login', '/v1/admin/login'].includes(url.pathname)) {
        limited(request, true);
        const data = await body(request);
        const username = normalizedUser(data.username); const password = validPassword(data.password);
        const admin = url.pathname === '/v1/admin/login';
        const deviceId = admin ? 'admin-browser' : device(data.deviceId);
        if (url.pathname === '/v1/auth/register') {
          const record = await passwordRecord(password);
          await store.transact(s => {
            if (s.users.some(u => u.username === username)) failure(409, 'username_taken');
            if (s.users.length >= 10000) failure(409, 'user_limit');
            s.users.push({ id: randomUUID(), username, password: record, role: 'user', createdAt: clock(), disabled: false });
          });
        }
        const user = store.read(s => s.users.find(u => u.username === username));
        const matches = await matchesPassword(password, user?.password);
        if (!matches || user.disabled || user.role !== (admin ? 'admin' : 'user')) failure(401, 'invalid_credentials');
        const token = randomBytes(32).toString('hex');
        const session = { hash: hash(token), userId: user.id, deviceId, expiresAt: clock() + (admin ? 8 * 3_600_000 : 7 * DAY) };
        const view = await store.transact(s => {
          s.sessions = s.sessions.filter(v => v.expiresAt > clock());
          const existing = s.sessions.filter(v => v.userId === user.id && v.deviceId === deviceId);
          if (existing.length >= 10) s.sessions = s.sessions.filter(v => v !== existing[0]);
          s.sessions.push(session);
          return accountView(s, session, user);
        });
        return json(response, url.pathname.endsWith('register') ? 201 : 200, admin ? { user: view.user } : { ...view, token }, admin ? {
          'set-cookie': `rp_admin=${token}; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age=28800${secureCookies ? '; Secure' : ''}`,
        } : {});
      }
      if (url.pathname.startsWith('/v1/admin/')) {
        const { user, session } = authenticated(request, true);
        if (request.method === 'GET' && url.pathname === '/v1/admin/me') return json(response, 200, { user: { username: user.username } });
        if (request.method === 'POST' && url.pathname === '/v1/admin/logout') {
          await store.transact(s => { s.sessions = s.sessions.filter(v => v.hash !== session.hash); });
          return json(response, 200, { ok: true }, { 'set-cookie': 'rp_admin=; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age=0' });
        }
        if (request.method === 'GET' && url.pathname === '/v1/admin/users') return json(response, 200, { users: store.read(s =>
          s.users.filter(u => u.role === 'user').map(u => ({ id: u.id, username: u.username, createdAt: u.createdAt, disabled: u.disabled, cardId: u.cardId ?? null }))) });
        if (request.method === 'GET' && url.pathname === '/v1/admin/audit') return json(response, 200, { events: store.read(s => s.audit.slice(-100).reverse()) });
        if (request.method === 'GET' && url.pathname === '/v1/admin/cards') {
          const page = Number(url.searchParams.get('page') ?? 1);
          if (!Number.isInteger(page) || page < 1) failure(400, 'invalid_page');
          const query = (url.searchParams.get('q') ?? '').toLowerCase().slice(0, 120);
          return json(response, 200, store.read(s => {
            const cards = [...s.cards].reverse().map(c => publicCard(s, c)).filter(c => `${c.label} ${c.hint} ${c.username ?? ''}`.toLowerCase().includes(query));
            return { cards: cards.slice((page-1)*50, page*50), total: cards.length, page };
          }));
        }
        if (request.method === 'POST' && url.pathname === '/v1/admin/cards') {
          const data = await body(request);
          if (!Number.isInteger(data.count) || data.count < 1 || data.count > 500 ||
            !Number.isFinite(data.durationDays) || data.durationDays <= 0 || data.durationDays > 3650 ||
            (data.redeemBefore != null && (!Number.isSafeInteger(data.redeemBefore) || data.redeemBefore <= clock())) ||
            typeof data.label !== 'string' || data.label.length > 120) failure(400, 'invalid_card_settings');
          const cards = await store.transact(s => {
            if (s.cards.length + data.count > 30000) failure(409, 'card_limit');
            const result = [];
            for (let i = 0; i < data.count; i++) {
              const code = `RP-${randomBytes(18).toString('hex').toUpperCase().match(/.{1,6}/g).join('-')}`;
              const c = { id: randomUUID(), codeHash: hash(code), hint: code.slice(-6), label: data.label.trim(), durationDays: data.durationDays,
                createdAt: clock(), disabled: false, activatedAt: null, expiresAt: null, redeemBefore: data.redeemBefore ?? null, userId: null, deviceId: null };
              s.cards.push(c); result.push({ ...publicCard(s, c), code });
            }
            audit(s, user.id, 'cards.generate', `count:${data.count}`); return result;
          });
          return json(response, 201, { cards });
        }
        const match = /^\/v1\/admin\/cards\/([a-f0-9-]{36})(\/unbind)?$/.exec(url.pathname);
        if (match && ((request.method === 'PATCH' && !match[2]) || (request.method === 'POST' && match[2]))) {
          const data = match[2] ? {} : await body(request);
          const result = await store.transact(s => {
            const c = s.cards.find(v => v.id === match[1]); if (!c) failure(404, 'not_found');
            if (match[2]) { c.deviceId = null; audit(s, user.id, 'card.unbind', c.id); }
            else {
              if (!['disabled','expiresAt','durationDays','label'].some(k => k in data)) failure(400, 'invalid_card_settings');
              if ('disabled' in data) { if (typeof data.disabled !== 'boolean') failure(400, 'invalid_card_settings'); c.disabled = data.disabled; }
              if ('label' in data) { if (typeof data.label !== 'string' || data.label.length > 120) failure(400, 'invalid_card_settings'); c.label = data.label.trim(); }
              if ('durationDays' in data) {
                if (c.activatedAt || !Number.isFinite(data.durationDays) || data.durationDays <= 0 || data.durationDays > 3650) failure(400, 'invalid_card_settings');
                c.durationDays = data.durationDays;
              }
              if ('expiresAt' in data) {
                if (!c.activatedAt || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= 0) failure(400, 'invalid_card_settings');
                c.expiresAt = data.expiresAt;
              }
              audit(s, user.id, 'card.update', c.id);
            }
            return publicCard(s, c);
          });
          return json(response, 200, { card: result });
        }
        failure(404, 'not_found');
      }
      const { session, user } = authenticated(request);
      if (request.method === 'GET' && url.pathname === '/v1/account/me') return json(response, 200, store.read(s => accountView(s, session, user)));
      if (request.method === 'POST' && url.pathname === '/v1/auth/logout') {
        await store.transact(s => { s.sessions = s.sessions.filter(v => v.hash !== session.hash); }); return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/v1/auth/password') {
        limited(request, true); const data = await body(request);
        if (!await matchesPassword(validPassword(data.currentPassword), user.password)) failure(401, 'invalid_credentials');
        const record = await passwordRecord(validPassword(data.password));
        await store.transact(s => { s.users.find(u => u.id === user.id).password = record; s.sessions = s.sessions.filter(v => v.userId !== user.id); });
        return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/v1/account/activate') {
        limited(request, true); const data = await body(request);
        if (typeof data.code !== 'string' || data.code.length > 100) failure(400, 'invalid_card');
        const codeHash = hash(data.code.trim().toUpperCase());
        const result = await store.transact(s => {
          const c = s.cards.find(v => v.codeHash === codeHash);
          if (!c) failure(400, 'invalid_card');
          if (c.disabled) failure(403, 'card_disabled');
          if (c.expiresAt && c.expiresAt <= clock()) failure(403, 'card_expired');
          if (!c.activatedAt && c.redeemBefore && c.redeemBefore <= clock()) failure(403, 'card_redeem_expired');
          if (c.userId && c.userId !== user.id) failure(409, 'card_owned');
          if (c.deviceId && c.deviceId !== session.deviceId) failure(409, 'card_bound');
          if (!c.activatedAt) { c.activatedAt = clock(); c.expiresAt = clock() + Math.round(c.durationDays * DAY); }
          c.userId = user.id; c.deviceId = session.deviceId;
          const currentUser = s.users.find(v => v.id === user.id); currentUser.cardId = c.id;
          audit(s, user.id, 'card.activate', c.id); return accountView(s, session, currentUser);
        });
        return json(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/v1/routes') return json(response, 200, { routes: store.read(s => s.routes.filter(r => r.userId === user.id).sort((a,b) => b.uploadedAt-a.uploadedAt).map(summary)) });
      if (request.method === 'POST' && url.pathname === '/v1/routes') {
        const document = validateRoute((await body(request)).document);
        const result = await store.transact(s => {
          const current = s.users.find(v => v.id === user.id);
          if (activation(s, current, session.deviceId).state !== 'active') failure(403, 'activation_required');
          if (s.routes.filter(r => r.userId === user.id).length >= 100) failure(409, 'route_limit');
          // Each upload is an immutable backup. Reusing a local route id never overwrites another backup.
          const route = { id: randomUUID(), userId: user.id, uploadedAt: clock(), document };
          s.routes.push(route); return summary(route);
        });
        return json(response, 201, { route: result });
      }
      const routeMatch = /^\/v1\/routes\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (routeMatch && request.method === 'GET') {
        const route = store.read(s => s.routes.find(r => r.id === routeMatch[1] && r.userId === user.id));
        if (!route) failure(404, 'not_found'); return json(response, 200, { route: summary(route), document: route.document });
      }
      if (routeMatch && request.method === 'DELETE') {
        await store.transact(s => {
          const index = s.routes.findIndex(r => r.id === routeMatch[1] && r.userId === user.id);
          if (index < 0) failure(404, 'not_found'); s.routes.splice(index, 1);
        }); return json(response, 200, { ok: true });
      }
      failure(404, 'not_found');
    } catch (error) {
      if (!error.status) onError(error);
      if (!response.headersSent) json(response, error.status ?? 500, { error: error.code ?? 'server_error' });
      else response.end();
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  return { server, store, createdAdmin };
}
