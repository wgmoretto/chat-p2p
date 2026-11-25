import { randomBytes, randomUUID } from 'node:crypto';
import { eventStatement, verify } from '../shared/crypto.mjs';
import { transaction } from './storage.mjs';

export const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const encoded = (value, min, max) => typeof value === 'string' &&
  value.length >= min && value.length <= max && /^[a-zA-Z0-9_-]+$/.test(value);
export const shortName = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function requireValue(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}

export function groupService(db, hash, onRevoke) {
  const getGroup = db.prepare('SELECT * FROM groups WHERE id = ?');
  const member = db.prepare('SELECT role, status, joined FROM members WHERE group_id = ? AND account = ?');
  const keyList = db.prepare(`
    SELECT accounts.id, accounts.name, accounts.signing, members.role,
           members.key_package AS keyPackage, members.package_signature AS packageSignature
    FROM members JOIN accounts ON members.account = accounts.id
    WHERE group_id = ? AND status = ? ORDER BY accounts.id
  `);
  const head = db.prepare('SELECT coalesce(max(seq),0) AS seq FROM events WHERE group_id = ?');
  const findEvent = db.prepare('SELECT seq, payload, author, group_id FROM events WHERE id = ?');
  const insertEvent = db.prepare('INSERT INTO events (id,group_id,author,epoch,payload) VALUES (?,?,?,?,?)');
  const groupsForAccount = db.prepare(`
    SELECT groups.*, members.role, members.status, members.joined, accounts.signing AS ownerSigning
    FROM groups JOIN members ON groups.id = members.group_id
    JOIN accounts ON accounts.id = groups.owner
    WHERE members.account = ? AND members.status IN ('pending','active') ORDER BY groups.name, groups.id
  `);

  function check(groupId, accountId, role) {
    const group = getGroup.get(groupId);
    const membership = member.get(groupId, accountId);
    requireValue(group && membership?.status === 'active', 404, 'Grupo indisponível.');
    requireValue(!role || membership.role === role, 403, 'Você não tem permissão para essa ação.');
    return { group, membership };
  }
  function invite(token) {
    requireValue(encoded(token, 26, 100), 400, 'Convite inválido.');
    const result = db.prepare('SELECT * FROM invites WHERE hash = ? AND expires > ?').get(hash(token), Date.now());
    requireValue(result, 404, 'Convite expirado ou já usado.');
    return result;
  }
  function claim(token, groupId, accountId, keyPackage, packageSignature) {
    const link = invite(token);
    requireValue(link.group_id === groupId, 400, 'Este convite pertence a outro grupo.');
    const previous = member.get(link.group_id, accountId);
    requireValue(!previous || previous.status === 'removed', 409, 'Este grupo já tem uma solicitação ou um vínculo com a conta.');
    db.prepare(`
      INSERT INTO members (group_id,account,role,status,key_package,package_signature) VALUES (?,?,?,'pending',?,?)
      ON CONFLICT(group_id,account) DO UPDATE SET role=excluded.role,status='pending',joined=0,
        key_package=excluded.key_package,package_signature=excluded.package_signature
    `).run(link.group_id, accountId, link.role, keyPackage, packageSignature);
    db.prepare('DELETE FROM invites WHERE hash = ?').run(link.hash);
  }
  const rosterRow = ({ id, name, signing, role }) => ({ id, name, signing, role });
  const canonicalRoster = (rows) => rows.map(rosterRow).sort((a, b) => a.id.localeCompare(b.id));

  function parseEvent(groupId, account, raw) {
    requireValue(raw && idPattern.test(raw.id) && Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 &&
      encoded(raw.signature, 86, 86), 400, 'Evento inválido.');
    const event = { group: groupId, id: raw.id, author: account.id, epoch: raw.epoch, kind: raw.kind,
      ciphertext: raw.ciphertext ?? null, target: raw.target ?? null, welcome: raw.welcome ?? null,
      roster: raw.roster ?? null, signature: raw.signature };
    requireValue(event.roster === null || Array.isArray(event.roster) && event.roster.length <= 32 &&
      event.roster.every((row) => row && idPattern.test(row.id) && shortName(row.name) &&
        encoded(row.signing, 110, 140) && ['owner','moderator','member'].includes(row.role)), 400, 'Lista de participantes inválida.');
    if (event.roster) event.roster = canonicalRoster(event.roster);
    return event;
  }

  async function initialize(account, body) {
    const { id, name } = body;
    requireValue(idPattern.test(id) && shortName(name), 400, 'Informe um nome válido para o grupo.');
    const event = parseEvent(id, account, body.event);
    const roster = [{ id: account.id, name: account.name, signing: account.signing, role: 'owner' }];
    requireValue(event.kind === 'init' && event.epoch === 0 && !event.ciphertext && !event.target && !event.welcome &&
      JSON.stringify(roster) === JSON.stringify(event.roster) &&
      await verify(account.signing, event.signature, eventStatement(event)), 400, 'Identidade inicial do grupo inválida.');
    transaction(db, () => {
      const device = db.prepare('SELECT signing FROM accounts WHERE id=?').get(account.id);
      requireValue(device?.signing === account.signing, 401, 'Entre novamente para continuar.');
      const current = getGroup.get(id);
      if (current && current.owner === account.id && findEvent.get(event.id)) return;
      requireValue(!current, 409, 'Grupo já existe.');
      db.prepare('INSERT INTO groups (id,name,owner) VALUES (?,?,?)').run(id, name.trim(), account.id);
      db.prepare("INSERT INTO members (group_id,account,role,status) VALUES (?,?,'owner','active')").run(id, account.id);
      insertEvent.run(event.id, id, account.id, 0, JSON.stringify(event));
    });
    return { id };
  }

  async function publish(groupId, account, body) {
    check(groupId, account.id);
    const event = parseEvent(groupId, account, body.event);
    const isCommit = ['add','remove','ban'].includes(event.kind);
    requireValue(['message','add','remove','ban'].includes(event.kind) &&
      encoded(event.ciphertext, 35, isCommit ? 140000 : 12000) &&
      (isCommit ? idPattern.test(event.target) && event.roster : !event.target && !event.roster) &&
      (event.kind === 'add' ? encoded(event.welcome, 35, 140000) : !event.welcome) &&
      await verify(account.signing, event.signature, eventStatement(event)), 400, 'Assinatura ou conteúdo do evento inválido.');
    const result = transaction(db, () => {
      const { group } = check(groupId, account.id, isCommit ? 'owner' : undefined);
      const prior = findEvent.get(event.id);
      if (prior) {
        requireValue(prior.author === account.id && prior.group_id === groupId &&
          prior.payload === JSON.stringify(event), 409, 'Identificador já usado.');
        return { seq: prior.seq, repeated: true };
      }
      requireValue(event.epoch === group.epoch && body.expected === head.get(groupId).seq,
        409, 'O grupo foi atualizado. Sincronize e tente novamente.');
      let nextEpoch = group.epoch;
      if (isCommit) {
        const active = keyList.all(groupId, 'active');
        const target = member.get(groupId, event.target);
        requireValue(target && event.target !== account.id, 400, 'Participante inválido.');
        const adding = event.kind === 'add';
        requireValue(adding ? target.status === 'pending' && active.length < 32 : target.status === 'active',
          409, 'Não foi possível aplicar a mudança de participação.');
        const updated = adding
          ? [...active, keyList.all(groupId, 'pending').find((item) => item.id === event.target)]
          : active.filter(({ id }) => id !== event.target);
        requireValue(JSON.stringify(canonicalRoster(updated)) === JSON.stringify(event.roster), 409, 'A lista de participantes mudou.');
        nextEpoch++;
      }
      const seq = Number(insertEvent.run(event.id, groupId, account.id, event.epoch, JSON.stringify(event)).lastInsertRowid);
      if (isCommit) {
        const status = event.kind === 'add' ? 'active' : (event.kind === 'ban' ? 'banned' : 'removed');
        db.prepare('UPDATE members SET status=?, joined=? WHERE group_id=? AND account=?')
          .run(status, seq, groupId, event.target);
        db.prepare('UPDATE groups SET epoch=? WHERE id=?').run(nextEpoch, groupId);
      }
      return { seq, repeated: false };
    });
    if (!result.repeated && ['remove','ban'].includes(event.kind)) onRevoke(groupId, event.target);
    return { seq: result.seq };
  }

  return {
    check, claim, initialize, publish,
    list: (accountId) => groupsForAccount.all(accountId),
    listEvents(groupId, accountId, after) {
      const { membership } = check(groupId, accountId);
      requireValue(Number.isSafeInteger(after) && after >= 0, 400, 'Cursor inválido.');
      return db.prepare(`
        SELECT seq, payload FROM events WHERE group_id=? AND seq>? AND seq>=? ORDER BY seq LIMIT 50
      `).all(groupId, after, membership.joined).map(({ seq, payload }) => ({ seq, ...JSON.parse(payload) }));
    },
    pending(groupId, accountId) {
      check(groupId, accountId, 'owner');
      return keyList.all(groupId, 'pending');
    },
    issueInvite(groupId, accountId, role) {
      const { group } = check(groupId, accountId, 'owner');
      requireValue(['member','moderator'].includes(role), 400, 'Papel inválido.');
      const token = randomBytes(24).toString('base64url');
      db.prepare('INSERT INTO invites (hash,group_id,role,expires) VALUES (?,?,?,?)')
        .run(hash(token), group.id, role, Date.now() + 86400000);
      return { token };
    },
    listRooms(groupId, accountId) {
      check(groupId, accountId);
      return db.prepare('SELECT id,name,mode FROM rooms WHERE group_id=? ORDER BY created DESC LIMIT 100').all(groupId);
    },
    createRoom(groupId, accountId, { name, mode }) {
      check(groupId, accountId);
      requireValue(shortName(name) && ['meet','live'].includes(mode), 400, 'Informe o nome e o tipo da sala.');
      const id = randomUUID();
      db.prepare('INSERT INTO rooms (id,group_id,creator,name,mode,created) VALUES (?,?,?,?,?,?)')
        .run(id, groupId, accountId, name.trim(), mode, Date.now());
      return { id, name: name.trim(), mode };
    },
    member,
  };
}
