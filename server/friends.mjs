import { randomUUID } from 'node:crypto';
import { idPattern, requireValue } from './groups.mjs';
import { transaction } from './storage.mjs';

const pair = (a, b) => a < b ? [a, b] : [b, a];

export function friendService(db, { occupied, revoke }) {
  const byUsername = db.prepare('SELECT id FROM accounts WHERE username=?');
  const byPair = db.prepare('SELECT * FROM friendships WHERE first=? AND second=?');
  const roster = db.prepare(`
    SELECT people.id, people.username, people.name, friendships.requester, friendships.room AS roomId
    FROM friendships JOIN accounts AS people ON people.id =
      CASE WHEN friendships.first = ? THEN friendships.second ELSE friendships.first END
    WHERE friendships.first=? OR friendships.second=?
    ORDER BY people.name, people.username
  `);

  return {
    list(accountId) {
      return roster.all(accountId, accountId, accountId).map(({ requester, ...person }) => ({
        ...person, incoming: requester !== accountId,
        calling: !!person.roomId && occupied(person.roomId, accountId),
      }));
    },
    request(accountId, handle) {
      requireValue(typeof handle === 'string' && handle.length <= 33, 400, 'Informe o @usuário.');
      const username = handle.trim().toLowerCase().replace(/^@/, '');
      requireValue(/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username), 400, 'Informe um @usuário válido.');
      const target = byUsername.get(username);
      requireValue(target && target.id !== accountId, 404, 'Usuário indisponível para adicionar.');
      const [first, second] = pair(accountId, target.id);
      if (byPair.get(first, second)) return {};
      const outstanding = db.prepare('SELECT count(*) AS total FROM friendships WHERE requester=? AND room IS NULL').get(accountId);
      requireValue(outstanding.total < 24, 429, 'Você já tem muitos pedidos pendentes.');
      db.prepare('INSERT INTO friendships (first,second,requester) VALUES (?,?,?)').run(first, second, accountId);
      return {};
    },
    update(accountId, other, action) {
      requireValue(idPattern.test(other) && other !== accountId && ['accept', 'remove'].includes(action),
        400, 'Ação de amizade inválida.');
      const [first, second] = pair(accountId, other);
      const revoked = transaction(db, () => {
        const friendship = byPair.get(first, second);
        if (action === 'remove') {
          if (!friendship) return null;
          db.prepare('DELETE FROM friendships WHERE first=? AND second=?').run(first, second);
          if (friendship.room) db.prepare("UPDATE members SET status='removed' WHERE group_id=?").run(friendship.room);
          return friendship.room;
        }

        requireValue(friendship && friendship.requester !== accountId, 404, 'Pedido de amizade indisponível.');
        if (friendship.room) return null;
        const id = randomUUID();
        db.prepare("INSERT INTO groups (id,name,owner,chat_mode) VALUES (?,'Conversa',?,'contact')").run(id, friendship.requester);
        const join = db.prepare("INSERT INTO members (group_id,account,role,status) VALUES (?,?,'member','active')");
        join.run(id, first);
        join.run(id, second);
        db.prepare("INSERT INTO rooms (id,group_id,creator,name,mode,created) VALUES (?,?,?,'Conversa','meet',?)")
          .run(id, id, friendship.requester, Date.now());
        db.prepare('UPDATE friendships SET room=? WHERE first=? AND second=?').run(id, first, second);
        return null;
      });
      if (revoked) {
        revoke(revoked, accountId);
        revoke(revoked, other);
      }
      return {};
    },
  };
}
