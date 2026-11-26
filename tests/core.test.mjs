import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createIdentity, descriptionStatement, eventStatement, sign, verify } from '../shared/crypto.mjs';
import { makeRoomChatKey, roomChatCipher } from '../shared/room-chat.mjs';
import { createApplication } from '../server/index.mjs';
import { selectHost } from '../server/rooms.mjs';
import { openDatabase } from '../server/storage.mjs';
import { FileTransfer, MAX_FILE_BYTES } from '../src/file-transfer.mjs';
import { changeEncryptedGroup, encryptMessage, joinEncryptedGroup, makeKeyPackage,
  readEncryptedEvent, startGroup, wipeConsumed } from '../src/mls.mjs';

async function person(name, role) {
  return { id: randomUUID(), name, role, ...await createIdentity() };
}
const memberView = ({ id, name, signing, role }) => ({ id, name, signing, role });

test('sinalização assinada rejeita troca de SDP, destinatário e sessão', async () => {
  const a = { ...await person('Alice', 'owner'), instance: randomUUID() };
  const b = { ...await person('Bob', 'member'), instance: randomUUID() };
  const room = randomUUID();
  const offer = { type: 'offer', sdp: 'a=fingerprint:sha-256 11:22' };
  const payload = descriptionStatement(room, a, b, 1, offer);
  const proof = await sign(a.privateKey, payload);
  assert.equal(await verify(a.signing, proof, payload), true);
  assert.equal(await verify(a.signing, proof, descriptionStatement(room, a, b, 1, { ...offer, sdp: 'a=fingerprint:sha-256 44:55' })), false);
  assert.equal(await verify(a.signing, proof, descriptionStatement(room, a, { ...b, instance: randomUUID() }, 1, offer)), false);
  assert.equal(await verify(b.signing, proof, payload), false);
});

test('chat pelo servidor cifra o texto e vincula mensagem, remetente e destinatário à sessão', async () => {
  const room = randomUUID();
  const a = { ...await person('Alice', 'owner'), instance: randomUUID() };
  const b = { ...await person('Bob', 'member'), instance: randomUUID() };
  const keyA = await makeRoomChatKey(room, a, a.privateKey);
  const keyB = await makeRoomChatKey(room, b, b.privateKey);
  const alice = await roomChatCipher(room, a, keyA, { ...b, ...keyB });
  const bob = await roomChatCipher(room, b, keyB, { ...a, ...keyA });
  const text = 'mensagem apenas entre as pontas';
  const encrypted = await alice.encrypt(1, text);
  assert.equal(JSON.stringify(encrypted).includes(text), false);
  assert.equal(await bob.decrypt(encrypted), text);
  await assert.rejects(() => bob.decrypt({ ...encrypted, counter: 2 }));
  await assert.rejects(() => alice.decrypt(encrypted));
  assert.equal(await roomChatCipher(room, b, keyB, { ...a, ...keyA, instance: randomUUID() }), null);
  assert.equal(await roomChatCipher(randomUUID(), b, keyB, { ...a, ...keyA }), null);
});

test('MLS entrega a um membro e revoga leitura mesmo com o commit e o ciphertext', async () => {
  const alice = await person('Alice', 'owner');
  const bob = await person('Bob', 'member');
  const group = randomUUID();
  const bobKeys = await makeKeyPackage(bob);
  const roster = [alice, bob].map(memberView);
  let a = { roster: [memberView(alice)], state: await startGroup(group, alice) };
  const add = { group, epoch: 0, kind: 'add', roster };
  const added = await changeEncryptedGroup(a, add, { ...bob, keyPackage: bobKeys.encoded });
  a = { roster, state: added.state };
  wipeConsumed(added.consumed);
  let b = { roster, state: await joinEncryptedGroup(add, bobKeys) };
  const first = { group, epoch: 1, kind: 'message', author: alice.id, id: randomUUID() };
  const sent = await encryptMessage(a, first, { author: alice.id, id: first.id, text: 'para a equipe', created: 1 });
  a.state = sent.state;
  wipeConsumed(sent.consumed);
  const received = await readEncryptedEvent(b, first);
  assert.equal(received.message.text, 'para a equipe');
  b.state = received.state;
  wipeConsumed(received.consumed);
  const remove = { group, epoch: 1, kind: 'remove', roster: [memberView(alice)] };
  const removed = await changeEncryptedGroup(a, remove, bob);
  a = { roster: remove.roster, state: removed.state };
  const revoked = await readEncryptedEvent(b, remove);
  b = { roster: remove.roster, state: revoked.state };
  assert.equal(b.state.groupActiveState.kind, 'removedFromGroup');
  const next = { group, epoch: 2, kind: 'message', author: alice.id, id: randomUUID() };
  await encryptMessage(a, next, { author: alice.id, id: next.id, text: 'após remoção', created: 2 });
  await assert.rejects(() => readEncryptedEvent(b, next));
});

test('arquivos exigem aceite, limitam o tamanho e rejeitam transferência incompleta', () => {
  let state;
  const sent = [];
  const channel = Object.assign(new EventTarget(), { readyState: 'open', send: (frame) => sent.push(JSON.parse(frame)) });
  const files = new FileTransfer((value) => { state = value; });
  const id = randomUUID();
  const offer = { kind: 'offer', id, name: 'pasta/relatorio.txt', size: 32_000 };
  const deliver = (data) => channel.dispatchEvent(new MessageEvent('message', { data }));
  try {
    files.bind(channel);
    deliver(JSON.stringify({ ...offer, size: MAX_FILE_BYTES + 1 }));
    assert.equal(sent.at(-1).kind, 'decline');
    assert.equal(state.transfer, undefined);

    deliver(JSON.stringify(offer));
    assert.equal(state.transfer.phase, 'incoming');
    assert.equal(state.transfer.name, 'pasta_relatorio.txt');
    deliver(new ArrayBuffer(16 * 1024));
    assert.equal(state.transfer.bytes, 0);
    files.accept();
    assert.equal(sent.at(-1).kind, 'accept');
    deliver(new ArrayBuffer(16 * 1024));
    deliver(JSON.stringify({ kind: 'done', id }));
    assert.equal(sent.at(-1).kind, 'cancel');
    assert.equal(state.transfer.phase, 'invalid');
    assert.equal(files.download, undefined);

    deliver(JSON.stringify(offer));
    files.accept();
    deliver(new ArrayBuffer(1));
    assert.equal(state.transfer.phase, 'invalid');
  } finally {
    files.close();
  }
});

test('eleição usa estabilidade e qualidade, com desempate determinístico', () => {
  assert.equal(selectHost([]), null);
  assert.equal(selectHost([
    { id: 'slow', joinedAt: 0, samples: { stable: 2, loss: 2, upload: 200_000 } },
    { id: 'fast', joinedAt: 1, samples: { stable: 2, loss: 0, upload: 4_000_000 } },
    { id: 'unmeasured', joinedAt: 2 },
  ]), 'fast');
});

test('login funciona em outro cliente e preserva grupos MLS e assinatura de histórico', async (t) => {
  const { call } = await startApi(t);
  const owner = await registerForTest(call, 'alice', 'Alice', bootstrap);
  assert.equal(owner.response.status, 200);
  const wrongOrigin = await call('login', { username: 'alice', password }, null, 'https://untrusted.invalid');
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await call('login', { username: 'alice', password: 'incorrect-test-password' })).status, 401);
  const login = await call('login', { username: 'alice', password });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), {
    id: owner.person.id, name: 'Alice', username: 'alice', signing: owner.person.signing,
  });
  const session = cookieFrom(login);
  assert.notEqual(session, owner.cookie);
  assert.equal((await call('groups', undefined, owner.cookie)).status, 200);

  const group = randomUUID();
  const event = { id: randomUUID(), group, author: owner.person.id, epoch: 0, kind: 'init',
    ciphertext: null, target: null, welcome: null, roster: [memberView(owner.person)] };
  event.signature = await sign(owner.person.privateKey, eventStatement(event));
  for (let count = 0; count < 2; count++)
    assert.equal((await call('groups', { id: group, name: 'Equipe', event }, session)).status, 200);
  const list = await (await call('groups', undefined, session)).json();
  assert.equal(list[0].chat_mode, 'mls');
  const ready = await (await call('groups/' + group + '/events', undefined, session)).json();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].kind, 'init');
  const invalid = { ...event, kind: 'message', roster: null, ciphertext: 'A'.repeat(60) };
  assert.equal((await call('groups/' + group + '/events', { event: invalid, expected: ready[0].seq }, session)).status, 400);
  assert.equal((await call('logout', {}, session)).status, 200);
  assert.equal((await call('groups', undefined, session)).status, 401);
  assert.equal((await call('groups', undefined, owner.cookie)).status, 200);
});

test('amizade exige aceite, dá acesso só aos dois participantes e revoga a sala ao remover', async (t) => {
  const { call } = await startApi(t);
  assert.equal((await call('friends')).status, 401);
  const alice = await registerForTest(call, 'alice', 'Alice', bootstrap);
  const bob = await registerForTest(call, 'bob', '');
  const outsider = await registerForTest(call, 'carol', 'Carolina');
  assert.equal(bob.response.status, 200);
  assert.equal(outsider.response.status, 200);
  assert.equal((await call('friends', { username: '@alice' }, alice.cookie)).status, 404);
  assert.equal((await call('friends', { username: '@bob' }, alice.cookie)).status, 200);
  assert.equal((await call('friends', { username: '@BOB' }, alice.cookie)).status, 200);
  const waiting = await (await call('friends', undefined, bob.cookie)).json();
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].roomId, null);
  assert.equal(waiting[0].incoming, true);
  assert.equal((await call('friends/action', { id: bob.person.id, action: 'accept' }, alice.cookie)).status, 404);
  assert.equal((await call('friends/action', { id: alice.person.id, action: 'accept' }, outsider.cookie)).status, 404);
  assert.equal((await call('friends/action', { id: alice.person.id, action: 'accept' }, bob.cookie)).status, 200);
  const results = await (await call('friends', undefined, alice.cookie)).json();
  assert.equal(results[0].name, 'bob');
  const room = results[0].roomId;
  assert.ok(room);
  assert.deepEqual(await (await call('groups', undefined, alice.cookie)).json(), []);
  assert.equal((await call('groups/' + room + '/ice', undefined, alice.cookie)).status, 200);
  assert.equal((await call('groups/' + room + '/ice', undefined, bob.cookie)).status, 200);
  assert.equal((await call('groups/' + room + '/ice', undefined, outsider.cookie)).status, 404);
  assert.equal((await call('groups/' + room + '/rooms', { mode: 'meet', name: 'Outra' }, bob.cookie)).status, 404);
  assert.equal((await call('friends/action', { id: alice.person.id, action: 'remove' }, bob.cookie)).status, 200);
  assert.equal((await call('groups/' + room + '/ice', undefined, alice.cookie)).status, 404);
  assert.deepEqual(await (await call('friends', undefined, alice.cookie)).json(), []);
});

test('convite de amigo exige destinatário e o histórico cifrado mantém paginação e leitura monotônica', async (t) => {
  const { call } = await startApi(t);
  const alice = await registerForTest(call, 'alice', 'Alice', bootstrap);
  const bob = await registerForTest(call, 'bob', 'Bob');
  const carol = await registerForTest(call, 'carol', 'Carolina');
  await call('friends', { username: 'bob' }, alice.cookie);
  await call('friends/action', { id: alice.person.id, action: 'accept' }, bob.cookie);
  const id = randomUUID();
  assert.equal((await call('groups', { id, name: 'Equipe' }, alice.cookie)).status, 200);
  const root = 'groups/' + id + '/';
  const invitation = { role: 'member', target: bob.person.id };
  assert.equal((await call(root + 'invite-friend', invitation, alice.cookie)).status, 200);
  assert.equal((await call(root + 'invite-friend', invitation, alice.cookie)).status, 200);
  const workspace = async (cookie) => (await call('workspace', undefined, cookie)).json();
  const { invites } = await workspace(bob.cookie);
  assert.equal(invites.length, 1);
  assert.deepEqual((await workspace(carol.cookie)).invites, []);
  const claim = { group: id, token: invites[0].token };
  assert.equal((await call('claim', claim, carol.cookie)).status, 404);
  assert.equal((await call('claim', claim, bob.cookie)).status, 200);
  assert.deepEqual((await workspace(bob.cookie)).invites, []);

  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const vault = {
    password, publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    salt: 'B'.repeat(22), iv: 'C'.repeat(16), wrapped: 'D'.repeat(1630),
  };
  assert.equal((await call('chat-key', { ...vault, publicKey: 'A'.repeat(392) }, bob.cookie)).status, 400);
  assert.equal((await call('chat-key', { ...vault, password: 'incorrect-password' }, bob.cookie)).status, 401);
  assert.equal((await call('chat-key', vault, alice.cookie)).status, 200);
  assert.equal((await call('chat-key', vault, bob.cookie)).status, 200);
  const recipients = [alice, bob].map(({ person }) => ({ id: person.id, wrapped: 'E'.repeat(342) }));
  const initial = { id: randomUUID(), iv: 'F'.repeat(16), content: 'G'.repeat(50), recipients };
  assert.equal((await call(root + 'messages', { ...initial, recipients: recipients.slice(0,1) }, alice.cookie)).status, 409);
  const start = await (await call(root + 'messages', initial, alice.cookie)).json();
  assert.deepEqual(await (await call(root + 'messages', initial, alice.cookie)).json(), start);
  for (let index = 0; index < 41; index++) {
    assert.equal((await call(root + 'messages', { ...initial, id: randomUUID() }, alice.cookie)).status, 200);
  }
  assert.equal((await call(root + 'messages', undefined, carol.cookie)).status, 404);
  const newest = await (await call(root + 'messages', undefined, bob.cookie)).json();
  const older = await (await call(root + 'messages?before=' + newest.messages[0].seq, undefined, bob.cookie)).json();
  const catchup = await (await call(root + 'messages?after=' + start.seq, undefined, bob.cookie)).json();
  assert.equal(newest.more, true);
  assert.equal(older.messages.length, 2);
  assert.equal(older.messages[0].content, initial.content);
  assert.equal(catchup.messages[0].seq, start.seq + 1);
  assert.equal(catchup.more, true);
  assert.equal((await workspace(bob.cookie)).groups[0].unread, 42);
  const seq = newest.messages.at(-1).seq;
  await call(root + 'read', { seq }, bob.cookie);
  await call(root + 'read', { seq: start.seq }, bob.cookie);
  assert.equal((await workspace(bob.cookie)).groups[0].unread, 0);

  const create = (name, mode) => call(root + 'rooms', { name, mode }, alice.cookie);
  assert.equal((await create('Inválida', 'other')).status, 400);
  const textRoom = await (await create('Avisos', 'text')).json();
  const voice = await (await create('Papo', 'voice')).json();
  assert.equal(voice.mode, 'voice');
  const textRoot = 'groups/' + textRoom.id + '/';
  assert.equal((await call(textRoot + 'messages', undefined, carol.cookie)).status, 404);
  assert.equal((await call('groups/' + voice.id + '/messages', undefined, bob.cookie)).status, 404);
  assert.equal((await call(textRoot + 'messages', initial, alice.cookie)).status, 409);
  const textMessage = { ...initial, id: randomUUID() };
  const saved = await (await call(textRoot + 'messages', textMessage, alice.cookie)).json();
  await call(root + 'messages', { ...initial, id: randomUUID() }, alice.cookie);
  const onlyText = await (await call(textRoot + 'messages', undefined, bob.cookie)).json();
  assert.deepEqual(onlyText.messages.map(({ id }) => id), [textMessage.id]);
  const groupMessages = await (await call(root + 'messages?after=' + seq, undefined, bob.cookie)).json();
  assert.equal(groupMessages.messages.length, 1);
  assert.notEqual(groupMessages.messages[0].id, textMessage.id);
  const unreadRooms = await workspace(bob.cookie);
  assert.equal(unreadRooms.groups[0].unread, 2);
  assert.equal(unreadRooms.roomUnread[textRoom.id], 1);
  await call(textRoot + 'read', { seq: saved.seq }, bob.cookie);
  const afterRoomRead = await workspace(bob.cookie);
  assert.equal(afterRoomRead.groups[0].unread, 1);
  assert.deepEqual(afterRoomRead.roomUnread, {});
});

test('migração mantém os grupos, salas e referências do SQLite anterior', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat-p2p-upgrade-'));
  const path = join(directory, 'chat.sqlite');
  let db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE accounts (id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
        password TEXT NOT NULL,signing TEXT NOT NULL);
      CREATE TABLE groups (id TEXT PRIMARY KEY,name TEXT NOT NULL,owner TEXT NOT NULL REFERENCES accounts(id),
        epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL REFERENCES groups(id),author TEXT NOT NULL REFERENCES accounts(id),
        epoch INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE rooms (id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id),creator TEXT NOT NULL REFERENCES accounts(id),
        name TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('meet','live')),created INTEGER NOT NULL);
      CREATE TABLE friendships (first TEXT NOT NULL REFERENCES accounts(id),second TEXT NOT NULL REFERENCES accounts(id),
        requester TEXT NOT NULL REFERENCES accounts(id),room TEXT UNIQUE REFERENCES rooms(id),PRIMARY KEY(first,second));
      CREATE TABLE actions (id INTEGER PRIMARY KEY,room TEXT NOT NULL REFERENCES rooms(id),
        actor TEXT NOT NULL REFERENCES accounts(id),target TEXT NOT NULL REFERENCES accounts(id),action TEXT NOT NULL,created INTEGER NOT NULL);
      INSERT INTO accounts VALUES ('owner','admin','Admin','test-password-hash','test-signed-identity');
      INSERT INTO accounts VALUES ('other','other','Other','hash','signing');
      INSERT INTO groups VALUES ('legacy','Equipe','owner',3);
      INSERT INTO events (id,group_id,author,epoch,payload) VALUES ('old','legacy','owner',3,'old-ciphertext');
      INSERT INTO rooms VALUES ('old-room','legacy','owner','Antiga','meet',0);
      INSERT INTO friendships VALUES ('other','owner','owner','old-room');
      INSERT INTO actions VALUES (1,'old-room','owner','other','mute',0);
    `);
    db.close();
    db = openDatabase(path);
    const before = db.prepare('SELECT id,name,epoch,chat_mode FROM groups').get();
    assert.deepEqual({ ...before }, { id: 'legacy', name: 'Equipe', epoch: 3, chat_mode: 'mls' });
    assert.equal(db.prepare('SELECT payload FROM events').get().payload, 'old-ciphertext');
    assert.equal(db.prepare("SELECT mode FROM rooms WHERE id='old-room'").get().mode, 'meet');
    assert.equal(db.prepare('SELECT room FROM friendships').get().room, 'old-room');
    assert.equal(db.prepare('SELECT room FROM actions').get().room, 'old-room');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.exec("INSERT INTO rooms VALUES ('new-room','legacy','owner','Avisos','text',0)");
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare("SELECT mode FROM rooms WHERE id='new-room'").get().mode, 'text');
  } finally {
    if (db.isOpen) db.close();
    for (const file of [path, path + '-wal', path + '-shm']) rmSync(file, { force: true });
    rmdirSync(directory);
  }
});

const origin = 'http://localhost:3217';
const bootstrap = 'bootstrap-test-that-is-long-enough';
const password = 'not-a-production-password';
const cookieFrom = (response) => response.headers.get('set-cookie')?.split(';')[0];

async function startApi(t) {
  const app = createApplication({ origin, bootstrap, database: ':memory:', serveStatic: false });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.stop());
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api/';
  return {
    call(path, body, cookie, from = origin) {
      return fetch(base + path, { method: body ? 'POST' : 'GET',
        headers: { ...(cookie ? { cookie } : {}),
          ...(body ? { 'content-type': 'application/json', origin: from } : {}) },
        body: body ? JSON.stringify(body) : undefined });
    },
  };
}

async function registerForTest(call, username, name, bootstrapToken) {
  const applicant = await person(name, 'owner');
  const response = await call('register', {
    id: applicant.id, name, username, password, signing: applicant.signing, bootstrapToken,
    signature: await sign(applicant.privateKey, ['chat-p2p:register:v1', applicant.id, username]),
  });
  return { response, person: applicant, cookie: cookieFrom(response) };
}
