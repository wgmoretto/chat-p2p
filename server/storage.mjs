import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password TEXT NOT NULL, signing TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL REFERENCES accounts(id), epoch INTEGER NOT NULL DEFAULT 0,
      chat_mode TEXT NOT NULL DEFAULT 'mls' CHECK (chat_mode IN ('mls', 'session', 'contact'))
    );
    CREATE TABLE IF NOT EXISTS members (
      group_id TEXT NOT NULL REFERENCES groups(id), account TEXT NOT NULL REFERENCES accounts(id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'moderator', 'member')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'removed', 'banned')),
      joined INTEGER NOT NULL DEFAULT 0, key_package TEXT, package_signature TEXT, PRIMARY KEY (group_id, account)
    );
    CREATE TABLE IF NOT EXISTS invites (
      hash TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id),
      role TEXT NOT NULL CHECK (role IN ('moderator', 'member')), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      group_id TEXT NOT NULL REFERENCES groups(id), author TEXT NOT NULL REFERENCES accounts(id),
      epoch INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_by_group ON events(group_id, seq);
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id), creator TEXT NOT NULL REFERENCES accounts(id),
      name TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('meet', 'live')), created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rooms_by_group ON rooms(group_id, created);
    CREATE TABLE IF NOT EXISTS friendships (
      first TEXT NOT NULL REFERENCES accounts(id), second TEXT NOT NULL REFERENCES accounts(id),
      requester TEXT NOT NULL REFERENCES accounts(id), room TEXT UNIQUE REFERENCES rooms(id),
      PRIMARY KEY (first, second), CHECK (first < second), CHECK (requester IN (first, second))
    );
    CREATE INDEX IF NOT EXISTS friendships_by_second ON friendships(second);
    CREATE TABLE IF NOT EXISTS friend_invites (
      hash TEXT PRIMARY KEY REFERENCES invites(hash) ON DELETE CASCADE,
      token TEXT NOT NULL, group_id TEXT NOT NULL REFERENCES groups(id),
      inviter TEXT NOT NULL REFERENCES accounts(id), target TEXT NOT NULL REFERENCES accounts(id),
      UNIQUE (group_id, target)
    );
    CREATE INDEX IF NOT EXISTS friend_invites_inbox ON friend_invites(target);
    CREATE TABLE IF NOT EXISTS chat_keys (
      account TEXT PRIMARY KEY REFERENCES accounts(id),
      public_key TEXT NOT NULL, salt TEXT NOT NULL, iv TEXT NOT NULL, wrapped TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL REFERENCES groups(id),
      author TEXT NOT NULL REFERENCES accounts(id), created INTEGER NOT NULL, iv TEXT NOT NULL, content TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_by_group ON chat_messages(group_id, seq);
    CREATE TABLE IF NOT EXISTS chat_recipients (
      message INTEGER NOT NULL REFERENCES chat_messages(seq) ON DELETE CASCADE,
      account TEXT NOT NULL REFERENCES accounts(id), wrapped TEXT NOT NULL, PRIMARY KEY (message, account)
    );
    CREATE INDEX IF NOT EXISTS chat_recipients_by_account ON chat_recipients(account,message);
    CREATE TABLE IF NOT EXISTS chat_reads (
      group_id TEXT NOT NULL REFERENCES groups(id), account TEXT NOT NULL REFERENCES accounts(id),
      seq INTEGER NOT NULL, PRIMARY KEY (group_id, account)
    );
    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY, room TEXT NOT NULL REFERENCES rooms(id),
      actor TEXT NOT NULL REFERENCES accounts(id), target TEXT NOT NULL REFERENCES accounts(id),
      action TEXT NOT NULL, created INTEGER NOT NULL
    );
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('groups') WHERE name='chat_mode'").get()) {
    db.exec("ALTER TABLE groups ADD COLUMN chat_mode TEXT NOT NULL DEFAULT 'mls' CHECK (chat_mode IN ('mls', 'session', 'contact'))");
  }
  return db;
}

export function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
