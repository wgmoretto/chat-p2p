import { decode64, encode64, sign, verify } from './crypto.mjs';

const utf8 = new TextEncoder();
const decodeText = new TextDecoder('utf-8', { fatal: true });
const ecdh = { name: 'ECDH', namedCurve: 'P-256' };
const endpoint = ({ id, instance }) => id + '/' + instance;
const keyStatement = (room, member, key) => ['chat-p2p:chat-key:v1', room, endpoint(member), key];

export async function makeRoomChatKey(room, self, signingKey) {
  const pair = await crypto.subtle.generateKey(ecdh, false, ['deriveBits']);
  const chatKey = encode64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
  const chatProof = await sign(signingKey, keyStatement(room, self, chatKey));
  return { privateKey: pair.privateKey, chatKey, chatProof };
}

export async function roomChatCipher(room, self, own, peer) {
  if (!peer.chatKey || !peer.chatProof ||
      !await verify(peer.signing, peer.chatProof, keyStatement(room, peer, peer.chatKey))) return null;
  const publicKey = await crypto.subtle.importKey('spki', decode64(peer.chatKey), ecdh, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, own.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  new Uint8Array(secret).fill(0);
  const info = utf8.encode(JSON.stringify(['chat-p2p:chat-pair:v1', room,
    [endpoint(self), endpoint(peer)].sort()]));
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', info, salt: new Uint8Array(32) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const aad = (from, to, counter) => utf8.encode(JSON.stringify(
    ['chat-p2p:chat:v1', room, endpoint(from), endpoint(to), counter]));

  return {
    async encrypt(counter, text) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const content = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(self, peer, counter) },
        key, utf8.encode(text));
      return { counter, iv: encode64(iv), content: encode64(new Uint8Array(content)) };
    },
    async decrypt({ counter, iv, content }) {
      const plain = await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: decode64(iv), additionalData: aad(peer, self, counter),
      }, key, decode64(content));
      return decodeText.decode(plain);
    },
  };
}
