let database;
function connect() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('chat-p2p', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

export async function localGet(key) {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const request = db.transaction('state').objectStore('state').get(key);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
export async function localSet(key, value) {
  const db = await connect();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite', { durability: 'strict' });
    tx.objectStore('state').put(value, key);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
}

export async function request(path, body) {
  const result = await fetch('/api/' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await result.json();
  if (!result.ok) throw Object.assign(new Error(data.error || 'Não foi possível concluir a ação.'), { status: result.status });
  return data;
}
