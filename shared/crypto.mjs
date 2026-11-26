const bytes = new TextEncoder();
const curve = { name: 'ECDSA', namedCurve: 'P-256' };
const algorithm = { name: 'ECDSA', hash: 'SHA-256' };

export function encode64(value) {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decode64(value) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
}

export async function createIdentity() {
  const keys = await crypto.subtle.generateKey(curve, false, ['sign', 'verify']);
  const signing = encode64(new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)));
  return { signing, privateKey: keys.privateKey };
}

export function importSigningKey(encoded) {
  return crypto.subtle.importKey('spki', decode64(encoded), curve, false, ['verify']);
}

export async function sign(privateKey, values) {
  return encode64(new Uint8Array(await crypto.subtle.sign(algorithm, privateKey, bytes.encode(JSON.stringify(values)))));
}

export async function verify(signing, signature, values) {
  try {
    const key = await importSigningKey(signing);
    return await crypto.subtle.verify(algorithm, key, decode64(signature), bytes.encode(JSON.stringify(values)));
  } catch {
    return false;
  }
}

export function packageStatement(id, group, keyPackage) {
  return ['chat-p2p:key-package:v1', id, group, keyPackage];
}

export function eventStatement(event) {
  return ['chat-p2p:group:v1', event.group, event.id, event.author, event.epoch,
    event.kind, event.ciphertext, event.target, event.welcome,
    event.roster?.map(({ id, name, signing, role }) => [id, name, signing, role]) ?? null];
}

export function descriptionStatement(room, from, to, counter, description) {
  return ['chat-p2p:sdp:v1', room, from.id, from.instance, to.id, to.instance,
    counter, description.type, description.sdp];
}
