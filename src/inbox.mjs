import { decode64, encode64 } from '../shared/crypto.mjs';
import { localGet, localSet, request } from './local.mjs';

const bytes = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true });
const rsa = { name: 'RSA-OAEP', hash: 'SHA-256' };
const random = (length) => crypto.getRandomValues(new Uint8Array(length));
const idbKey = ({ id }) => 'chat-key/' + id;
const encode = (buffer) => encode64(new Uint8Array(buffer));
const aes = (iv, scope) => ({ name: 'AES-GCM', iv, additionalData: bytes.encode(JSON.stringify(scope)) });
const messageScope = (conversation, id, author) => ['chat-p2p:inbox:v1', conversation, id, author];

async function wrappingKey(password, salt) {
  const secret = await crypto.subtle.importKey('raw', bytes.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' }, secret,
    { name: 'AES-GCM', length: 256 }, false, ['wrapKey','unwrapKey']);
}

export function storedChatKey(account) {
  return localGet(idbKey(account)).catch(() => null);
}

export function unlockChat(account, password) {
  return navigator.locks.request('chat-p2p:' + idbKey(account), async () => {
    const scope = ['chat-p2p:account-key:v1', account.id];
    let vault = await request('chat-key');
    if (!vault) {
      const pair = await crypto.subtle.generateKey({ ...rsa, modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1) },
        true, ['wrapKey','unwrapKey']);
      const salt = random(16);
      const iv = random(12);
      const secret = await wrappingKey(password, salt);
      vault = await request('chat-key', {
        password, salt: encode(salt), iv: encode(iv), publicKey: encode(await crypto.subtle.exportKey('spki', pair.publicKey)),
        wrapped: encode(await crypto.subtle.wrapKey('pkcs8', pair.privateKey, secret, aes(iv, scope))),
      });
    }
    let key;
    try {
      const secret = await wrappingKey(password, decode64(vault.salt));
      key = await crypto.subtle.unwrapKey('pkcs8', decode64(vault.wrapped), secret, aes(decode64(vault.iv), scope),
        rsa, false, ['unwrapKey']);
    } catch {
      throw Error('Não foi possível abrir o histórico com esta senha.');
    }
    await localSet(idbKey(account), key);
    return key;
  });
}

export async function sendMessage(conversation, account, people, value) {
  const id = crypto.randomUUID();
  const iv = random(12);
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt','decrypt']);
  const ready = people.filter(({ publicKey }) => publicKey);
  const recipients = await Promise.all(ready.map(async ({ id, publicKey }) => {
    const peer = await crypto.subtle.importKey('spki', decode64(publicKey), rsa, false, ['wrapKey']);
    return { id, wrapped: encode(await crypto.subtle.wrapKey('raw', key, peer, rsa)) };
  }));
  const content = await crypto.subtle.encrypt(aes(iv, messageScope(conversation, id, account.id)), key, bytes.encode(value));
  return request('groups/' + conversation + '/messages', { id, iv: encode(iv), content: encode(content), recipients });
}

export async function decryptMessage(conversation, key, { iv, wrapped, content, ...message }) {
  try {
    const aesKey = await crypto.subtle.unwrapKey('raw', decode64(wrapped), key, rsa, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(aes(decode64(iv), messageScope(conversation, message.id, message.author)), aesKey, decode64(content));
    return { ...message, text: text.decode(plain) };
  } catch {
    return { ...message, unreadable: true, text: 'Esta mensagem não pôde ser decifrada.' };
  }
}
