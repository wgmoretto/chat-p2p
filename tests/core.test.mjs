import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createIdentity, descriptionStatement, eventStatement, sign, verify } from '../shared/crypto.mjs';
import { createApplication } from '../server/index.mjs';
import { selectHost } from '../server/rooms.mjs';
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

test('API exige origem, credenciais e assinatura e mantém evento idempotente', async (t) => {
  const front = 'http://localhost:3217';
  const token = 'bootstrap-test-that-is-long-enough';
  const app = createApplication({ origin: front, bootstrap: token, database: ':memory:', serveStatic: false });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.stop());
  const url = 'http://127.0.0.1:' + app.server.address().port;
  let cookie;
  function call(path, payload, origin = front) {
    return fetch(url + '/api/' + path, { method: payload ? 'POST' : 'GET',
      headers: { ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json', origin } : {}) },
      body: payload ? JSON.stringify(payload) : undefined });
  }
  const owner = await person('Alice', 'owner');
  const username = 'alice';
  const password = 'not-a-production-password';
  const signature = await sign(owner.privateKey, ['chat-p2p:register:v1', owner.id, username]);
  const registration = { id: owner.id, name: owner.name, username, password, signing: owner.signing, signature, bootstrapToken: token };
  assert.equal((await call('groups')).status, 401);
  assert.equal((await call('register', registration, 'https://untrusted.invalid')).status, 403);
  const registered = await call('register', registration);
  assert.equal(registered.status, 200);
  cookie = registered.headers.get('set-cookie').split(';')[0];
  const group = randomUUID();
  const event = { id: randomUUID(), group, author: owner.id, epoch: 0, kind: 'init',
    ciphertext: null, target: null, welcome: null, roster: [memberView(owner)] };
  event.signature = await sign(owner.privateKey, eventStatement(event));
  for (let count = 0; count < 2; count++) assert.equal((await call('groups', { id: group, name: 'Equipe', event })).status, 200);
  const ready = await (await call('groups/' + group + '/events')).json();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].kind, 'init');
  const invalid = { ...event, kind: 'message', roster: null, ciphertext: 'A'.repeat(60) };
  assert.equal((await call('groups/' + group + '/events', { event: invalid, expected: ready[0].seq })).status, 400);
  const { nonce } = await (await call('challenge', { username })).json();
  assert.equal((await call('login', { username, password, nonce, signature })).status, 401);
  assert.equal((await call('logout', {})).status, 200);
  assert.equal((await call('groups')).status, 401);
});
