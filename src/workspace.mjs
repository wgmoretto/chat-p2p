import { createIdentity, eventStatement, packageStatement, sign, verify } from '../shared/crypto.mjs';
import { changeEncryptedGroup, encryptMessage, joinEncryptedGroup, makeKeyPackage,
  readEncryptedEvent, wipeConsumed } from './mls.mjs';
import { localGet, localSet, request } from './local.mjs';
import { storedChatKey, unlockChat } from './inbox.mjs';

const accountKey = (username) => 'account/' + username;
const dataKey = (account, group) => 'group/' + account.id + '/' + group;
const endpoint = (group, resource) => 'groups/' + group.id + '/' + resource;
const emptyGroup = () => ({ seq: 0, epoch: 0, roster: [], messages: [] });
const sorted = (rows) => rows.sort((a, b) => a.id.localeCompare(b.id));
const memberView = ({ id, name, signing, role }) => ({ id, name, signing, role });
const locked = (key, action) => navigator.locks.request('chat-p2p:' + key, action);

export function readInvite(hash = location.hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const invite = { token: params.get('invite'), group: params.get('group'), owner: params.get('owner') };
  return /^[a-zA-Z0-9_-]{32}$/.test(invite.token) && /^[0-9a-f-]{36}$/.test(invite.group) &&
    (invite.owner === null || /^[a-zA-Z0-9_-]{110,140}$/.test(invite.owner)) ? invite : null;
}

export async function makeInvite(group, role) {
  const { token } = await request(endpoint(group, 'invite'), { role });
  const params = new URLSearchParams({ invite: token, group: group.id });
  if (group.chat_mode === 'mls') params.set('owner', group.ownerSigning);
  return location.origin + '/#' + params.toString();
}

async function prepareInvite(account, identity, invite) {
  if (!invite.owner) return { token: invite.token, group: invite.group };
  if (!identity) throw Error('Use o perfil com as chaves da conta para aceitar este convite cifrado.');
  const key = dataKey(account, invite.group);
  return locked(key, async () => {
    const stored = await localGet(key);
    if (stored?.pin && stored.pin !== invite.owner) throw Error('A identidade do dono do grupo mudou.');
    const keys = stored?.token === invite.token ? stored.keys : await makeKeyPackage(account);
    await localSet(key, { ...emptyGroup(), pin: invite.owner, keys, token: invite.token });
    return { token: invite.token, group: invite.group, keyPackage: keys.encoded,
      packageSignature: await sign(identity.privateKey, packageStatement(account.id, invite.group, keys.encoded)) };
  });
}

export async function register(form, invite) {
  const username = form.username.trim().toLowerCase();
  const key = accountKey(username);
  return locked(key, async () => {
    let identity = await localGet(key);
    if (!identity) {
      identity = { id: crypto.randomUUID(), ...await createIdentity() };
      await localSet(key, identity);
    }
    const params = { id: identity.id, username, name: form.name, password: form.password,
      signing: identity.signing, bootstrapToken: form.bootstrapToken,
      signature: await sign(identity.privateKey, ['chat-p2p:register:v1', identity.id, username]) };
    if (invite) params.invite = await prepareInvite({ id: identity.id, signing: identity.signing }, identity, invite);
    const account = await request('register', params);
    if (invite) history.replaceState(null, '', location.pathname);
    const chatKey = await unlockChat(account, form.password).catch(() => null);
    return { account, identity, chatKey };
  });
}

export async function login(form) {
  const account = await request('login', { username: form.username, password: form.password });
  const session = await restore(account);
  return { ...session, chatKey: session.chatKey ?? await unlockChat(account, form.password).catch(() => null) };
}

export async function restore(account) {
  const [identity, chatKey] = await Promise.all([
    localGet(accountKey(account.username)).catch(() => null), storedChatKey(account),
  ]);
  const matches = identity?.id === account.id && identity.signing === account.signing;
  return { account, identity: matches ? identity : null, chatKey };
}

export async function requestAdmission(session, invite, fromLink = true) {
  const groups = await request('groups');
  if (groups.some(({ id }) => id === invite.group)) throw Error('Esta conta já tem um vínculo com o grupo.');
  const claim = await prepareInvite(session.account, session.identity, invite);
  await request('claim', claim);
  if (fromLink) history.replaceState(null, '', location.pathname);
}

function draft(group, account, epoch, kind, fields = {}) {
  return {
    id: crypto.randomUUID(), group: group.id, author: account.id, epoch, kind,
    ciphertext: null, target: null, welcome: null, roster: null, ...fields,
  };
}

export function newGroup(name) {
  return request('groups', { id: crypto.randomUUID(), name });
}

function append(list, message) {
  return message ? [...list, message].slice(-500) : list;
}

async function settle(key, group, record) {
  const { pending } = record;
  if (!pending) return record;
  try {
    const { seq } = await request(endpoint(group, 'events'), { expected: record.seq, event: pending.event });
    const next = { ...record, ...pending.next, seq, pending: undefined };
    await localSet(key, next);
    return next;
  } catch (error) {
    if (error.status !== 409) throw error;
    const next = { ...record, pending: undefined };
    await localSet(key, next);
    return next;
  }
}

async function advance(account, group, record, event) {
  if (event.group !== group.id || event.seq <= record.seq) throw Error('Ordem de eventos inválida.');
  const isMessage = event.kind === 'message';
  const signing = isMessage ? record.roster.find(({ id }) => id === event.author)?.signing : record.pin;
  if (!signing || (!isMessage && event.author !== group.owner) ||
      !await verify(signing, event.signature, eventStatement(event))) {
    if (isMessage) return { ...record, seq: event.seq };
    throw Error('A assinatura de um evento do grupo não pôde ser verificada.');
  }

  if (!record.state && event.kind === 'add' && event.target === account.id && record.keys) {
    const self = event.roster.find(({ id }) => id === account.id);
    const owner = event.roster.find(({ role }) => role === 'owner');
    if (self?.signing !== account.signing || owner?.signing !== record.pin || owner.id !== group.owner)
      throw Error('Identidades no convite não correspondem ao grupo.');
    const state = await joinEncryptedGroup(event, record.keys);
    return { ...record, state, keys: undefined, token: undefined,
      roster: event.roster, epoch: event.epoch + 1, seq: event.seq };
  }
  if (event.epoch !== record.epoch || !record.state) throw Error('O histórico criptográfico do grupo está incompleto.');
  if (event.kind === 'init' && record.seq === 0) {
    const owner = event.roster?.[0];
    if (owner?.signing !== record.pin || owner.id !== account.id) throw Error('Grupo inicial inválido.');
    return { ...record, seq: event.seq };
  }
  let result;
  try { result = await readEncryptedEvent(record, event); }
  catch (error) {
    if (isMessage) return { ...record, seq: event.seq };
    throw error;
  }
  const next = { ...record, state: result.state, seq: event.seq,
    roster: isMessage ? record.roster : event.roster,
    epoch: isMessage ? record.epoch : record.epoch + 1,
    messages: append(record.messages, result.message && { ...result.message,
      name: record.roster.find(({ id }) => id === event.author)?.name }),
  };
  wipeConsumed(result.consumed);
  return next;
}

async function sync(key, account, group) {
  let record = await localGet(key);
  if (!record?.pin || record.pin !== group.ownerSigning) throw Error('A identidade do dono do grupo não está verificada.');
  record = await settle(key, group, record);
  let rows;
  do {
    rows = await request(endpoint(group, 'events?after=' + record.seq));
    for (const event of rows) record = await advance(account, group, record, event);
    if (rows.length) await localSet(key, record);
  } while (rows.length === 50);
  if (!record.state) throw Error('Esperando as chaves de entrada do grupo.');
  return record;
}

export function syncGroup(account, group) {
  const key = dataKey(account, group.id);
  return locked(key, () => sync(key, account, group));
}

async function submit(session, group, build) {
  const { account, identity } = session;
  const key = dataKey(account, group.id);
  return locked(key, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await sync(key, account, group);
      const { event, next, consumed } = await build(record);
      event.signature = await sign(identity.privateKey, eventStatement(event));
      const queued = { ...record, pending: { event, next } };
      await localSet(key, queued);
      const committed = await settle(key, group, queued);
      wipeConsumed(consumed);
      if (committed.seq !== record.seq) return committed;
    }
    throw Error('O grupo mudou durante o envio. Tente novamente.');
  });
}

export function postGroupMessage(session, group, text) {
  return submit(session, group, async (record) => {
    const event = draft(group, session.account, record.epoch, 'message');
    const message = { id: event.id, author: session.account.id, text, name: session.account.name, created: Date.now() };
    const { state, consumed } = await encryptMessage(record, event, message);
    return { event, next: { state, messages: append(record.messages, message) }, consumed };
  });
}

export async function changeMembership(session, group, target, kind) {
  if (kind === 'add' && !await verify(target.signing, target.packageSignature,
    packageStatement(target.id, group.id, target.keyPackage))) throw Error('O convite tem um pacote de chaves inválido.');
  return submit(session, group, async (record) => {
    const roster = sorted(kind === 'add'
      ? [...record.roster, memberView(target)]
      : record.roster.filter(({ id }) => id !== target.id));
    const event = draft(group, session.account, record.epoch, kind, { roster, target: target.id });
    const { state, consumed } = await changeEncryptedGroup(record, event, target);
    return { event, next: { roster, state, epoch: record.epoch + 1 }, consumed };
  });
}
