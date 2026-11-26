import { createPublicKey } from 'node:crypto';
import { encoded, idPattern, requireValue } from './groups.mjs';
import { transaction } from './storage.mjs';

function validPublicKey(value) {
  if (!encoded(value, 380, 420)) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64url'), type: 'spki', format: 'der' });
    return key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails?.modulusLength === 2048 &&
      key.asymmetricKeyDetails.publicExponent === 65537n && key.export({ type: 'spki', format: 'der' }).toString('base64url') === value;
  } catch { return false; }
}

export function chatService(db, groups) {
  const vault = db.prepare('SELECT public_key AS publicKey,salt,iv,wrapped FROM chat_keys WHERE account=?');
  const active = db.prepare(`
    SELECT accounts.id,accounts.name,chat_keys.public_key AS publicKey
    FROM members JOIN accounts ON accounts.id=members.account
    LEFT JOIN chat_keys ON chat_keys.account=members.account WHERE group_id=? AND status='active' ORDER BY accounts.id
  `);
  const history = (order) => db.prepare(`
    SELECT m.seq,m.id,m.author,m.created,m.iv,m.content,r.wrapped,a.name
    FROM chat_messages m JOIN chat_recipients r ON r.message=m.seq JOIN accounts a ON a.id=m.author
    WHERE m.group_id=? AND r.account=? AND m.seq>? AND m.seq<? ORDER BY m.seq ${order} LIMIT 41
  `);
  const older = history('DESC');
  const newer = history('ASC');
  const unread = db.prepare(`
    SELECT m.group_id AS id,count(*) AS total
    FROM chat_recipients r JOIN chat_messages m ON m.seq=r.message
    JOIN members p ON p.group_id=m.group_id AND p.account=r.account
    LEFT JOIN chat_reads x ON x.group_id=m.group_id AND x.account=r.account
    WHERE r.account=? AND p.status='active' AND m.author<>r.account AND m.seq>coalesce(x.seq,0)
    GROUP BY m.group_id
    UNION ALL
    SELECT e.group_id,count(*)
    FROM members p JOIN groups g ON g.id=p.group_id AND g.chat_mode='mls'
    JOIN events e ON e.group_id=p.group_id
    LEFT JOIN chat_reads x ON x.group_id=g.id AND x.account=p.account
    WHERE p.account=? AND p.status='active' AND e.author<>p.account AND e.seq>=p.joined AND e.seq>coalesce(x.seq,0)
      AND (CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.kind') END)='message'
    GROUP BY e.group_id
  `);
  const ceiling = db.prepare(`
    SELECT max(m.seq) AS seq FROM chat_messages m JOIN chat_recipients r ON r.message=m.seq
    WHERE m.group_id=? AND r.account=?
  `);
  const legacyCeiling = db.prepare('SELECT max(seq) AS seq FROM events WHERE group_id=?');
  const byId = db.prepare('SELECT group_id,author,seq FROM chat_messages WHERE id=?');
  const insert = db.prepare('INSERT INTO chat_messages (id,group_id,author,created,iv,content) VALUES (?,?,?,?,?,?)');
  const recipient = db.prepare('INSERT INTO chat_recipients VALUES (?,?,?)');

  function latest(group, account) {
    return (group.chat_mode === 'mls' ? legacyCeiling.get(group.id) : ceiling.get(group.id, account)).seq ?? 0;
  }

  return {
    vault: (account) => vault.get(account) ?? null,
    enroll(account, { publicKey, salt, iv, wrapped }) {
      requireValue(validPublicKey(publicKey) && encoded(salt, 22, 22) &&
        encoded(iv, 16, 16) && encoded(wrapped, 1500, 2000), 400, 'Chaves de conversa inválidas.');
      db.prepare('INSERT OR IGNORE INTO chat_keys VALUES (?,?,?,?,?)').run(account, publicKey, salt, iv, wrapped);
      return vault.get(account);
    },
    unread: (account) => Object.fromEntries(unread.all(account, account).map(({ id, total }) => [id, total])),
    recipients(id, account) {
      const { group } = groups.check(id, account);
      requireValue(group.chat_mode !== 'mls', 404, 'Use o histórico cifrado do grupo.');
      return active.all(id);
    },
    read(id, account, seq) {
      const { group } = groups.check(id, account);
      requireValue(Number.isSafeInteger(seq) && seq >= 0, 400, 'Posição de leitura inválida.');
      db.prepare(`
        INSERT INTO chat_reads VALUES (?,?,?)
        ON CONFLICT(group_id,account) DO UPDATE SET seq=max(chat_reads.seq,excluded.seq)
      `).run(id, account, Math.min(seq, latest(group, account)));
      return {};
    },
    history(id, account, rawBefore, rawAfter) {
      const { group } = groups.check(id, account);
      requireValue(group.chat_mode !== 'mls', 404, 'Use o histórico cifrado do grupo.');
      const before = rawBefore === null ? Number.MAX_SAFE_INTEGER : Number(rawBefore);
      const after = rawAfter === null ? 0 : Number(rawAfter);
      requireValue(Number.isSafeInteger(before) && before > 0 && Number.isSafeInteger(after) && after >= 0,
        400, 'Posição de conversa inválida.');
      const rows = (rawAfter === null ? older : newer).all(id, account, after, before);
      const entries = rows.slice(0, 40);
      return { more: rows.length > 40, messages: rawAfter === null ? entries.reverse() : entries };
    },
    post(id, account, body) {
      requireValue(idPattern.test(body.id) && encoded(body.iv, 16, 16) &&
        encoded(body.content, 23, 6200) && Array.isArray(body.recipients) && body.recipients.length <= 32 &&
        body.recipients.every((row) => row && idPattern.test(row.id) && encoded(row.wrapped, 342, 342)),
      400, 'Mensagem cifrada inválida.');
      return transaction(db, () => {
        const people = this.recipients(id, account);
        const ready = people.filter(({ publicKey }) => publicKey).map(({ id }) => id);
        const sentTo = body.recipients.map(({ id }) => id).sort();
        const prior = byId.get(body.id);
        if (prior) {
          requireValue(prior.group_id === id && prior.author === account, 409, 'Identificador indisponível.');
          return { seq: prior.seq };
        }
        const { group } = groups.check(id, account);
        requireValue(ready.includes(account) && (group.chat_mode !== 'contact' || ready.length === 2),
          409, 'A conversa ainda está aguardando as chaves de um participante.');
        requireValue(ready.length === sentTo.length && ready.every((peer, index) => peer === sentTo[index]),
          409, 'Os participantes mudaram. Tente enviar novamente.');
        const seq = Number(insert.run(body.id, id, account, Date.now(), body.iv, body.content).lastInsertRowid);
        for (const row of body.recipients) recipient.run(seq, row.id, row.wrapped);
        return { seq };
      });
    },
  };
}
