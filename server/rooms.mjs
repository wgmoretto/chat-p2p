import { WebSocketServer, WebSocket } from 'ws';
import { encoded, idPattern } from './groups.mjs';

const OPEN = WebSocket.OPEN;
const limits = { meet: 4, live: 5, voice: 4 };
const HEARTBEAT_MS = 4_000;
const HOST_TIMEOUT = 12_000;

export function selectHost(peers) {
  return [...peers].sort((a, b) =>
    (b.samples?.stable ?? 0) - (a.samples?.stable ?? 0) ||
    (a.samples?.loss ?? 100) - (b.samples?.loss ?? 100) ||
    (b.samples?.upload ?? 0) - (a.samples?.upload ?? 0) ||
    (a.samples?.rtt ?? 60_000) - (b.samples?.rtt ?? 60_000) ||
    a.joinedAt - b.joinedAt || a.id.localeCompare(b.id))[0]?.id ?? null;
}

export function attachRooms(server, db, config) {
  const rooms = new Map();
  let stopped = false;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 85_000, perMessageDeflate: false });
  const roomLookup = db.prepare('SELECT rooms.*, groups.chat_mode FROM rooms JOIN groups ON groups.id=rooms.group_id WHERE rooms.id=?');
  const record = db.prepare('INSERT INTO actions (room,actor,target,action,created) VALUES (?,?,?,?,?)');
  const send = (peer, data) => {
    if (peer.socket.readyState === OPEN && peer.socket.bufferedAmount < 256_000) peer.socket.send(JSON.stringify(data));
  };
  const report = (peer, message) => send(peer, { type: 'error', message });

  function publish(room) {
    const message = { type: 'room', room: room.id, host: room.host, term: room.term,
      publisher: room.publisher,
      peers: [...room.peers.values()].map(({ id, instance, role, name, signing, chatKey, chatProof }) => ({
        id, instance, role, name, signing, chatKey, chatProof, ...room.restrictions.get(id),
      })),
    };
    for (const peer of room.peers.values()) send(peer, message);
  }

  function elect(room) {
    if (room.host && room.peers.has(room.host)) return;
    room.host = selectHost(room.peers.values());
    room.term++;
  }

  function leave(room, peer, reason, code = 1000) {
    if (room.peers.get(peer.id) !== peer) return;
    room.peers.delete(peer.id);
    if (room.publisher === peer.id) room.publisher = null;
    if (room.peers.size === 0) rooms.delete(room.id);
    else {
      elect(room);
      publish(room);
    }
    if (peer.socket.readyState === OPEN) peer.socket.close(code, reason);
  }

  function relay(room, peer, message) {
    const target = room.peers.get(message.to);
    if (!target || target === peer || target.instance !== message.toInstance) return;
    const envelope = { from: peer.id, fromInstance: peer.instance };
    if (message.type === 'sdp') {
      const { description, signature, counter } = message;
      if (!description || !['offer','answer'].includes(description.type) || typeof description.sdp !== 'string' ||
          description.sdp.length > 72_000 || !encoded(signature, 86, 86) ||
          !Number.isSafeInteger(counter) || counter < 1) return;
      send(target, { type: 'sdp', ...envelope, description: { type: description.type, sdp: description.sdp }, signature, counter });
    } else if (message.type === 'chat') {
      const { counter, iv, content } = message;
      if (!peer.chatKey || !target.chatKey || !Number.isSafeInteger(counter) || counter < 1 ||
          !encoded(iv, 16, 16) || !encoded(content, 23, 8200)) return;
      send(target, { type: 'chat', ...envelope, counter, iv, content });
    } else if (message.type === 'media') {
      send(target, { type: 'media', ...envelope, mic: message.mic === true,
        camera: room.mode !== 'voice' && message.camera === true, screen: room.mode !== 'voice' && message.screen === true });
    } else {
      const candidate = message.candidate;
      if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > 3_000) return;
      send(target, { type: 'ice', ...envelope, candidate: {
        candidate: candidate.candidate,
        sdpMid: typeof candidate.sdpMid === 'string' ? candidate.sdpMid.slice(0, 40) : null,
        sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null,
        usernameFragment: typeof candidate.usernameFragment === 'string' ? candidate.usernameFragment.slice(0, 200) : null,
      } });
    }
  }

  function moderate(room, peer, message) {
    const target = room.peers.get(message.target);
    if (!target || target === peer || peer.role === 'member' ||
        (peer.role === 'moderator' && target.role !== 'member')) {
      report(peer, 'Você não pode moderar este participante.');
      return;
    }
    const actions = { mute: ['muted', true], unmute: ['muted', false],
      blockVideo: ['videoBlocked', true], allowVideo: ['videoBlocked', false] };
    const policy = actions[message.action];
    if (message.action !== 'kick' && !Object.hasOwn(actions, message.action)) return;
    record.run(room.id, peer.id, target.id, message.action, Date.now());
    if (message.action === 'kick') {
      room.excluded.add(target.id);
      leave(room, target, 'Removido desta sessão.', 4003);
      return;
    }
    room.restrictions.set(target.id, { ...room.restrictions.get(target.id), [policy[0]]: policy[1] });
    publish(room);
  }

  function receive(room, peer, raw) {
    const now = Date.now();
    if (now - peer.windowStart > 10_000) {
      peer.windowStart = now;
      peer.messageCount = 0;
    }
    if (++peer.messageCount > 600) return leave(room, peer, 'Limite de sinalização.', 4008);
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (room.mode === 'voice' && message.type === 'chat') return;
    switch (message.type) {
      case 'sdp':
      case 'ice':
      case 'chat':
      case 'media':
        relay(room, peer, message);
        break;
      case 'stats': {
        const bounded = (value, max) => Number.isFinite(value) ? Math.max(0, Math.min(value, max)) : undefined;
        peer.samples = { stable: bounded(message.stable, 4), loss: bounded(message.loss, 100),
          upload: bounded(message.upload, 20_000_000), rtt: bounded(message.rtt, 60_000) };
        break;
      }
      case 'live.start':
        if (room.mode !== 'live' || (room.publisher && room.publisher !== peer.id)) {
          report(peer, 'A sala já tem uma transmissão em andamento.');
          break;
        }
        if (room.restrictions.get(peer.id)?.videoBlocked) {
          report(peer, 'Sua publicação de vídeo está bloqueada.');
          break;
        }
        room.publisher = peer.id;
        publish(room);
        break;
      case 'live.stop':
        if (room.publisher === peer.id) {
          room.publisher = null;
          publish(room);
        }
        break;
      case 'host.transfer': {
        const next = room.peers.get(message.target);
        if (peer.id === room.host && room.term === message.term && next && next !== peer) {
          room.host = next.id;
          room.term++;
          publish(room);
        }
        break;
      }
      case 'moderate':
        moderate(room, peer, message);
        break;
      case 'leave':
        leave(room, peer, 'Saiu da sala.');
        break;
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, config.origin);
    const id = url.searchParams.get('room');
    const instance = url.searchParams.get('instance');
    const account = config.authenticate(req);
    const signing = url.searchParams.get('signing') ?? account?.signing;
    const chatKey = url.searchParams.get('chatKey');
    const chatProof = url.searchParams.get('chatProof');
    const chatValid = chatKey === null && chatProof === null || encoded(chatKey, 110, 140) && encoded(chatProof, 86, 86);
    if (url.pathname !== '/signal' || req.headers.origin !== config.origin || !idPattern.test(id) ||
        !idPattern.test(instance) || !account || !encoded(signing, 110, 140) || !chatValid) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      const profile = roomLookup.get(id);
      const membership = profile && config.member.get(profile.group_id, account.id);
      if (!profile || profile.mode === 'text' || membership?.status !== 'active' || (profile.chat_mode === 'mls' && signing !== account.signing)) {
        ws.close(4003, 'Sala indisponível.');
        return;
      }
      let room = rooms.get(id);
      if (!room) {
        room = { ...profile, term: 0, host: null, publisher: null, peers: new Map(),
          restrictions: new Map(), excluded: new Set() };
        rooms.set(id, room);
      }
      const capacity = room.chat_mode === 'contact' ? 2 : limits[room.mode];
      if (room.excluded.has(account.id) || room.peers.has(account.id) || room.peers.size >= capacity) {
        ws.close(4003, 'Sala cheia, acesso revogado ou conta já conectada.');
        return;
      }
      const now = Date.now();
      const peer = { id: account.id, instance, name: account.name, signing, chatKey, chatProof,
        socket: ws, expires: account.expires, session: account.session,
        role: membership.role, lastPong: now, joinedAt: now, windowStart: now, messageCount: 0 };
      room.peers.set(peer.id, peer);
      elect(room);
      ws.on('pong', () => { peer.lastPong = Date.now(); });
      ws.on('close', () => leave(room, peer, 'Saiu da sala.'));
      ws.on('message', (raw) => {
        if (room.peers.get(peer.id) !== peer) return;
        try { receive(room, peer, raw); }
        catch (error) {
          console.error('room action failed', error);
          report(peer, 'Não foi possível concluir a ação.');
        }
      });
      publish(room);
    });
  });

  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      for (const peer of room.peers.values()) {
        if (peer.expires <= now || now - peer.lastPong >= HOST_TIMEOUT) {
          leave(room, peer, 'Conexão expirada.', 4001);
          peer.socket.terminate();
        } else if (peer.socket.readyState === OPEN) peer.socket.ping();
      }
      if (room.peers.size) publish(room);
    }
  }, HEARTBEAT_MS);
  timer.unref();

  return {
    occupied(roomId, viewer) {
      const room = rooms.get(roomId);
      return room ? [...room.peers.values()].some((peer) => peer.id !== viewer && peer.socket.readyState === OPEN) : false;
    },
    revoke(groupId, accountId) {
      for (const room of rooms.values()) {
        const peer = room.peers.get(accountId);
        if (peer && room.group_id === groupId) leave(room, peer, 'Acesso ao grupo revogado.', 4003);
      }
    },
    endSession(session) {
      for (const room of rooms.values()) {
        for (const peer of room.peers.values()) {
          if (peer.session === session) leave(room, peer, 'Sessão encerrada.', 4003);
        }
      }
    },
    close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    },
  };
}
