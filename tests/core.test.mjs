import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
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

test('migração mantém os grupos e eventos do SQLite anterior', () => {
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
      INSERT INTO accounts VALUES ('owner','admin','Admin','test-password-hash','test-signed-identity');
      INSERT INTO groups VALUES ('legacy','Equipe','owner',3);
      INSERT INTO events (id,group_id,author,epoch,payload) VALUES ('old','legacy','owner',3,'old-ciphertext');
    `);
    db.close();
    db = openDatabase(path);
    const before = db.prepare('SELECT id,name,epoch,chat_mode FROM groups').get();
    assert.deepEqual({ ...before }, { id: 'legacy', name: 'Equipe', epoch: 3, chat_mode: 'mls' });
    assert.equal(db.prepare('SELECT payload FROM events').get().payload, 'old-ciphertext');
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
