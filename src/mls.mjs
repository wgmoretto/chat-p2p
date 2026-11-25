import {
  acceptAll, createApplicationMessage, createCommit, createGroup, decodeMlsMessage,
  defaultCapabilities, defaultKeyPackageEqualityConfig, defaultKeyRetentionConfig, defaultLifetime, defaultLifetimeConfig,
  defaultPaddingConfig, emptyPskIndex, encodeMlsMessage, generateKeyPackage, getCiphersuiteFromName,
  getCiphersuiteImpl, joinGroup, processMessage, zeroOutUint8Array,
} from 'ts-mls';
import { decode64, encode64 } from '../shared/crypto.mjs';

const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true });
const config = {
  authService: { async validateCredential(credential) {
    return credential.credentialType === 'basic' &&
      /^[0-9a-f-]{36}:[a-zA-Z0-9_-]{110,140}$/.test(text.decode(credential.identity));
  } },
  keyRetentionConfig: { ...defaultKeyRetentionConfig, retainKeysForEpochs: 0 },
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
};
let cipher;
const cipherSuite = () => cipher ??= getCiphersuiteImpl(getCiphersuiteFromName('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'));
const identityFor = ({ id, signing }) => id + ':' + signing;
const decodeIdentity = (node) => node?.nodeType === 'leaf' && node.leaf.credential.credentialType === 'basic'
  ? text.decode(node.leaf.credential.identity) : null;
const leafIndex = (state, member) => state.ratchetTree.findIndex((node) => decodeIdentity(node) === identityFor(member)) / 2;
const encode = (message) => encode64(encodeMlsMessage(message));

function decode(value, allowed) {
  const bytes = decode64(value);
  const [message, end] = decodeMlsMessage(bytes, 0) ?? [];
  if (!message || end !== bytes.length || !allowed.includes(message.wireformat)) throw Error('Envelope MLS inválido.');
  return message;
}

function validate(state, group, roster, epoch) {
  const actual = state.ratchetTree.map(decodeIdentity).filter(Boolean).sort();
  const signed = roster.map(identityFor).sort();
  if (text.decode(state.groupContext.groupId) !== group || Number(state.groupContext.epoch) !== epoch ||
      actual.length !== signed.length || actual.some((item, i) => item !== signed[i]))
    throw Error('As chaves do grupo não correspondem à lista assinada.');
}

export function snapshot(state) {
  const { clientConfig, ...data } = state;
  return data;
}

export async function makeKeyPackage(account) {
  const keys = await generateKeyPackage({ credentialType: 'basic', identity: utf8.encode(identityFor(account)) },
    defaultCapabilities(), defaultLifetime, [], await cipherSuite());
  return { ...keys, encoded: encode({ version: 'mls10', wireformat: 'mls_key_package', keyPackage: keys.publicPackage }) };
}

export async function startGroup(group, creator) {
  const { publicPackage, privatePackage } = await makeKeyPackage(creator);
  const state = await createGroup(utf8.encode(group), publicPackage, privatePackage, [], await cipherSuite(), config);
  return snapshot(state);
}

export async function joinEncryptedGroup(event, keys) {
  const { welcome } = decode(event.welcome, ['mls_welcome']);
  const state = await joinGroup(welcome, keys.publicPackage, keys.privatePackage,
    emptyPskIndex, await cipherSuite(), undefined, undefined, config);
  validate(state, event.group, event.roster, event.epoch + 1);
  return snapshot(state);
}

export async function changeEncryptedGroup(record, event, target) {
  const state = { ...record.state, clientConfig: config };
  let proposal;
  if (event.kind === 'add') {
    const { keyPackage } = decode(target.keyPackage, ['mls_key_package']);
    const credential = keyPackage.leafNode.credential;
    if (credential.credentialType !== 'basic' || text.decode(credential.identity) !== identityFor(target))
      throw Error('O pacote de chaves pertence a outro dispositivo.');
    proposal = { proposalType: 'add', add: { keyPackage } };
  } else {
    const removed = leafIndex(state, target);
    if (!Number.isInteger(removed) || removed < 0) throw Error('Dispositivo não consta no grupo criptográfico.');
    proposal = { proposalType: 'remove', remove: { removed } };
  }
  const result = await createCommit({ state, cipherSuite: await cipherSuite(), pskIndex: emptyPskIndex }, {
    extraProposals: [proposal], ratchetTreeExtension: event.kind === 'add',
  });
  validate(result.newState, event.group, event.roster, event.epoch + 1);
  event.ciphertext = encode(result.commit);
  event.welcome = result.welcome ? encode({ version: 'mls10', wireformat: 'mls_welcome', welcome: result.welcome }) : null;
  return { state: snapshot(result.newState), consumed: result.consumed };
}

export async function encryptMessage(record, event, message) {
  const state = { ...record.state, clientConfig: config };
  const result = await createApplicationMessage(state, utf8.encode(JSON.stringify(message)), await cipherSuite());
  event.ciphertext = encode({ version: 'mls10', wireformat: 'mls_private_message', privateMessage: result.privateMessage });
  return { state: snapshot(result.newState), consumed: result.consumed };
}

export async function readEncryptedEvent(record, event) {
  const state = { ...record.state, clientConfig: config };
  const isMessage = event.kind === 'message';
  const message = decode(event.ciphertext, isMessage ? ['mls_private_message'] : ['mls_private_message','mls_public_message']);
  const owner = record.roster.find(({ role }) => role === 'owner');
  const callback = isMessage ? acceptAll : (incoming) =>
    incoming.kind === 'commit' && incoming.senderLeafIndex === leafIndex(state, owner) ? 'accept' : 'reject';
  const result = await processMessage(message, state, emptyPskIndex, callback, await cipherSuite());
  if (isMessage) {
    if (result.kind !== 'applicationMessage') throw Error('Era esperada uma mensagem criptografada.');
    const plaintext = JSON.parse(text.decode(result.message));
    if (plaintext.author !== event.author || plaintext.id !== event.id ||
        typeof plaintext.text !== 'string' || plaintext.text.length > 1500 || !Number.isSafeInteger(plaintext.created))
      throw Error('Mensagem criptografada sem vínculo com o remetente.');
    zeroOutUint8Array(result.message);
    return { state: snapshot(result.newState), consumed: result.consumed, message: plaintext };
  }
  if (result.kind !== 'newState' || result.actionTaken !== 'accept')
    throw Error('Alteração de membros recusada pelo cliente.');
  if (result.newState.groupActiveState.kind !== 'removedFromGroup')
    validate(result.newState, event.group, event.roster, event.epoch + 1);
  return { state: snapshot(result.newState), consumed: result.consumed };
}

export function wipeConsumed(list) {
  list?.forEach(zeroOutUint8Array);
}
