import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageStatement, verify } from '../shared/crypto.mjs';
import { openDatabase, transaction } from './storage.mjs';
import { attachRooms } from './rooms.mjs';
import { friendService } from './friends.mjs';
import { chatService } from './chat.mjs';
import { groupService, encoded, idPattern, shortName, HttpError, requireValue } from './groups.mjs';

const derivePassword = promisify(scrypt);
const DAY = 86_400_000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const usernameFormat = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const normalizeUsername = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const passwordValid = (value) => typeof value === 'string' && value.length >= 12 && value.length <= 200;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.woff2': 'font/woff2' };

async function encodePassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await derivePassword(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
  return salt + ':' + key.toString('hex');
}

function equal(a, b) {
  const one = Buffer.from(a);
  const other = Buffer.from(b);
  return one.length === other.length && timingSafeEqual(one, other);
}

async function payload(req) {
  requireValue(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'Formato inválido.');
  const limit = 300_000;
  requireValue(+req.headers['content-length'] <= limit || !req.headers['content-length'], 413, 'Conteúdo muito grande.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.byteLength;
    requireValue(length <= limit, 413, 'Conteúdo muito grande.');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  } catch {}
  throw new HttpError(400, 'Corpo da requisição inválido.');
}

function staticFiles(directory) {
  const files = new Map();
  for (const path of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!path.isFile()) continue;
    const absolute = resolve(path.parentPath, path.name);
    const url = '/' + absolute.slice(directory.length + 1).replaceAll('\\', '/');
    files.set(url, { content: readFileSync(absolute), type: mime[extname(absolute)] || 'application/octet-stream' });
  }
  return files;
}

export function createApplication(options = {}) {
  const origin = new URL(options.origin ?? process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000').origin;
  const secure = origin.startsWith('https:');
  if (!secure && !['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname))
    throw new Error('PUBLIC_ORIGIN deve usar HTTPS fora do localhost.');
  const cookieName = secure ? '__Host-chat-p2p' : 'chat-p2p-dev';
  const bootstrap = options.bootstrap ?? process.env.BOOTSTRAP_TOKEN ?? '';
  if (bootstrap && bootstrap.length < 24) throw new Error('BOOTSTRAP_TOKEN precisa ter pelo menos 24 caracteres.');
  const turnSecret = options.turnSecret ?? process.env.TURN_SECRET ?? '';
  const turnUrls = (options.turnUrls ?? process.env.TURN_URLS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const stunUrls = (options.stunUrls ?? process.env.STUN_URLS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (turnUrls.some((value) => !/^turns?:[^\s]+$/.test(value)) ||
      stunUrls.some((value) => !/^stuns?:[^\s]+$/.test(value)) || (turnUrls.length && turnSecret.length < 32))
    throw new Error('Confira TURN_URLS, STUN_URLS e TURN_SECRET (mínimo de 32 caracteres).');
  const db = openDatabase(options.database ?? process.env.DATABASE_PATH ?? 'data/chat.sqlite');
  const files = options.serveStatic === false ? new Map() : staticFiles(resolve(options.staticDir ?? 'dist'));
  const authSessions = db.prepare(`
    SELECT accounts.id,accounts.name,accounts.username,accounts.signing,sessions.expires
    FROM sessions JOIN accounts ON sessions.account=accounts.id WHERE sessions.hash=? AND sessions.expires > ?
  `);
  const countAccounts = db.prepare('SELECT count(*) AS count FROM accounts');
  const accountsByUsername = db.prepare('SELECT * FROM accounts WHERE username = ?');
  const authLimits = new Map();
  const group = groupService(db, hash, (groupId, accountId) => runtime.revoke(groupId, accountId));
  const chat = chatService(db, group);
  const onlineUntil = new Map();
  const userData = ({ id, username, name, signing }) => ({ id, username, name, signing });
  let runtime;
  const friends = friendService(db, {
    occupied: (room, account) => runtime.occupied(room, account),
    revoke: (groupId, accountId) => runtime.revoke(groupId, accountId),
  });

  function authenticate(req) {
    const pair = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(cookieName + '='));
    const token = pair?.slice(cookieName.length + 1);
    if (!encoded(token, 43, 43)) return null;
    const session = hash(token);
    const account = authSessions.get(session, Date.now());
    return account ? { ...account, session } : null;
  }

  function cookie(token, seconds) {
    return cookieName + '=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + seconds + (secure ? '; Secure' : '');
  }
  function issueSession(res, account) {
    const token = randomToken();
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), account.id, Date.now() + 7 * DAY);
    res.setHeader('Set-Cookie', cookie(token, 7 * 86400));
    return userData(account);
  }

  function limitAuth(req) {
    const forwarded = process.env.TRUST_PROXY === '1' && typeof req.headers['x-forwarded-for'] === 'string'
      ? req.headers['x-forwarded-for'].split(',').at(-1)?.trim().slice(0, 64) : null;
    const key = forwarded || req.socket.remoteAddress;
    const now = Date.now();
    for (const [ip, window] of authLimits) if (window.until <= now) authLimits.delete(ip);
    const window = authLimits.get(key) ?? { until: now + 300_000, attempts: 0 };
    authLimits.set(key, window);
    requireValue(++window.attempts <= 35 && authLimits.size <= 10000, 429, 'Aguarde antes de tentar novamente.');
  }

  async function register(body, res) {
    const username = normalizeUsername(body.username);
    const { id, password, signing, signature, invite, bootstrapToken } = body;
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : username;
    requireValue(idPattern.test(id) && shortName(name) && usernameFormat.test(username) && passwordValid(password) &&
      encoded(signing, 110, 140) && encoded(signature, 86, 86),
    400, 'Preencha os dados e use uma senha com pelo menos 12 caracteres.');
    const first = !countAccounts.get().count;
    requireValue(!first || bootstrap && typeof bootstrapToken === 'string' && equal(bootstrapToken, bootstrap),
      403, 'Código de instalação inválido.');
    requireValue(await verify(signing, signature, ['chat-p2p:register:v1', id, username]), 400, 'Chaves de dispositivo inválidas.');
    if (invite) await validateClaim(id, signing, invite);
    const passwordHash = await encodePassword(password);
    return transaction(db, () => {
      requireValue(!accountsByUsername.get(username), 409, 'Nome de usuário já está em uso.');
      requireValue(!db.prepare('SELECT 1 FROM accounts WHERE id=?').get(id), 409, 'Identidade de dispositivo já registrada.');
      requireValue(!first || !countAccounts.get().count, 409, 'A configuração inicial já foi concluída.');
      db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run(id, username, name.trim(), passwordHash, signing);
      if (invite) group.claim(invite.token, invite.group, id, invite.keyPackage, invite.packageSignature);
      return issueSession(res, { id, username, name: name.trim(), signing });
    });
  }

  async function validateClaim(id, signing, claim) {
    requireValue(typeof claim === 'object' && idPattern.test(claim?.group), 400, 'Convite inválido.');
    const { token, group: groupId, keyPackage, packageSignature } = claim;
    const invite = group.invite(token, id);
    requireValue(invite.group_id === groupId, 400, 'Este convite pertence a outro grupo.');
    if (invite.chat_mode === 'mls') {
      requireValue(encoded(keyPackage, 80, 16000) && encoded(packageSignature, 86, 86) &&
        await verify(signing, packageSignature, packageStatement(id, groupId, keyPackage)),
        400, 'Convite ou chaves de dispositivo inválidas.');
    }
  }

  async function api(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    const account = authenticate(req);
    if (method === 'GET' && pathname === '/api/session') {
      const initialized = !!countAccounts.get().count;
      return { account: account ? userData(account) : null, signup: initialized || !!bootstrap,
        bootstrap: !!bootstrap && !initialized };
    }
    if (method === 'POST') requireValue(req.headers.origin === origin, 403, 'Origem da requisição inválida.');
    if (method === 'POST' && pathname === '/api/register') {
      limitAuth(req);
      return register(await payload(req), res);
    }
    if (method === 'POST' && pathname === '/api/login') {
      limitAuth(req);
      const { username: input, password } = await payload(req);
      const target = accountsByUsername.get(normalizeUsername(input));
      requireValue(target && passwordValid(password), 401, 'Usuário ou senha inválidos.');
      const valid = equal(await encodePassword(password, target.password.split(':')[0]), target.password);
      requireValue(valid, 401, 'Usuário ou senha inválidos.');
      return issueSession(res, target);
    }

    requireValue(account, 401, 'Entre para continuar.');
    if (method === 'POST' && pathname === '/api/logout') {
      db.prepare('DELETE FROM sessions WHERE hash=?').run(account.session);
      runtime.endSession(account.session);
      res.setHeader('Set-Cookie', cookie('', 0));
      return {};
    }
    if (method === 'GET' && pathname === '/api/workspace') {
      const now = Date.now();
      for (const [id, until] of onlineUntil) if (until <= now) onlineUntil.delete(id);
      onlineUntil.set(account.id, now + 15_000);
      const { threads: unread, rooms: roomUnread } = chat.unread(account.id);
      return {
        roomUnread,
        friends: friends.list(account.id).map((friend) => ({
          ...friend, online: Boolean(friend.roomId && onlineUntil.has(friend.id)), unread: unread[friend.roomId] ?? 0,
        })),
        groups: group.list(account.id).map((item) => ({ ...item, unread: unread[item.id] ?? 0 })),
        invites: group.friendInvites(account.id),
      };
    }
    if (pathname === '/api/chat-key') {
      if (method === 'GET') return chat.vault(account.id);
      if (method === 'POST') {
        limitAuth(req);
        const { password, ...vault } = await payload(req);
        const { password: expected } = accountsByUsername.get(account.username);
        requireValue(passwordValid(password) && equal(await encodePassword(password, expected.split(':')[0]), expected),
          401, 'Senha inválida.');
        return chat.enroll(account.id, vault);
      }
    }
    if (method === 'POST' && pathname === '/api/invitations/decline') {
      return group.declineInvite(account.id, (await payload(req)).token);
    }
    if (pathname === '/api/friends') {
      if (method === 'GET') return friends.list(account.id);
      if (method === 'POST') {
        limitAuth(req);
        return friends.request(account.id, (await payload(req)).username);
      }
    }
    if (method === 'POST' && pathname === '/api/friends/action') {
      const { id, action } = await payload(req);
      return friends.update(account.id, id, action);
    }
    if (method === 'GET' && pathname === '/api/groups') return group.list(account.id);
    if (method === 'POST' && pathname === '/api/groups') return group.initialize(account, await payload(req));
    if (method === 'POST' && pathname === '/api/claim') {
      const claim = await payload(req);
      await validateClaim(account.id, account.signing, claim);
      transaction(db, () => group.claim(claim.token, claim.group, account.id, claim.keyPackage, claim.packageSignature));
      return {};
    }
    const conversation = pathname.match(/^\/api\/groups\/([0-9a-f-]{36})\/(messages|recipients|read|invite-friend)$/);
    if (conversation) {
      const [, id, action] = conversation;
      if (method === 'GET' && action === 'recipients') return chat.recipients(id, account.id);
      if (method === 'GET' && action === 'messages') return chat.history(id, account.id, url.searchParams.get('before'), url.searchParams.get('after'));
      if (method === 'POST' && action === 'messages') return chat.post(id, account.id, await payload(req));
      if (method === 'POST' && action === 'read') return chat.read(id, account.id, (await payload(req)).seq);
      if (method === 'POST' && action === 'invite-friend') return group.inviteFriend(id, account.id, await payload(req));
    }

    const rename = pathname.match(/^\/api\/groups\/([0-9a-f-]{36})\/rooms\/([0-9a-f-]{36})\/rename$/);
    if (method === 'POST' && rename) {
      return group.renameRoom(rename[1], account.id, rename[2], (await payload(req)).name);
    }

    const route = pathname.match(/^\/api\/groups\/([0-9a-f-]{36})\/(events|pending|people|invite|rooms|ice)$/);
    if (route) {
      const [, id, part] = route;
      if (method === 'GET' && part === 'events') return group.listEvents(id, account.id, Number(url.searchParams.get('after') ?? 0));
      if (method === 'POST' && part === 'events') return group.publish(id, account, await payload(req));
      if (method === 'GET' && part === 'pending') return group.pending(id, account.id);
      if (method === 'GET' && part === 'people') return group.people(id, account.id);
      if (method === 'POST' && part === 'people') return group.removeMember(id, account.id, await payload(req));
      if (method === 'POST' && part === 'invite') return group.issueInvite(id, account.id, (await payload(req)).role);
      if (method === 'GET' && part === 'rooms') return group.listRooms(id, account.id);
      if (method === 'POST' && part === 'rooms') return group.createRoom(id, account.id, await payload(req));
      if (method === 'GET' && part === 'ice') {
        group.check(id, account.id);
        const iceServers = [];
        if (stunUrls.length) iceServers.push({ urls: stunUrls });
        if (turnUrls.length) {
          const username = Math.floor(Date.now() / 1000 + 3600) + ':' + account.id;
          const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
          iceServers.push({ urls: turnUrls, username, credential });
        }
        return { iceServers, forceRelay: process.env.FORCE_TURN === '1' };
      }
    }
    throw new HttpError(404, 'Recurso indisponível.');
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' " +
      origin.replace(/^http/, 'ws') + "; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === '/healthz' && req.method === 'GET') return json(200, { ok: true });
      if (url.pathname.startsWith('/api/')) return json(200, await api(req, res, url));
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = files.get(path);
      if (!file || !['GET','HEAD'].includes(req.method)) return json(404, { error: 'Recurso indisponível.' });
      res.writeHead(200, { 'Content-Type': file.type,
        'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : file.content);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.message });
      console.error(error);
      json(500, { error: 'Falha interna. Tente novamente.' });
    }
  });
  runtime = attachRooms(server, db, { origin, authenticate, member: group.member });
  server.requestTimeout = 15_000;
  server.on('close', () => { runtime.close(); db.close(); });
  return { server, stop: () => { runtime.close(); server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.env.CHAT_ENV_FILE) process.loadEnvFile(process.env.CHAT_ENV_FILE);
  const app = createApplication();
  const productionOrigin = process.env.PUBLIC_ORIGIN?.startsWith('https://');
  app.server.listen(Number(process.env.PORT ?? 3000), process.env.BIND_HOST ?? (productionOrigin ? '0.0.0.0' : '127.0.0.1'));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, app.stop);
}
