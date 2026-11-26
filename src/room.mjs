import { createIdentity, descriptionStatement, sign, verify } from '../shared/crypto.mjs';
import { makeRoomChatKey, roomChatCipher } from '../shared/room-chat.mjs';
import { readPreference, writePreference } from './local.mjs';

const mediaOrder = ['mic','camera','screen'];
export const videoProfiles = {
  480: { width: 854, height: 480, bitrate: 850_000 },
  720: { width: 1280, height: 720, bitrate: 1_800_000 },
  1080: { width: 1920, height: 1080, bitrate: 4_000_000 },
  1440: { width: 2560, height: 1440, bitrate: 6_000_000 },
};

function displayProfile(value) {
  const { width, height } = videoProfiles[value];
  return { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30, max: 30 } };
}

function initialMedia() {
  return Object.fromEntries(mediaOrder.map((kind) => [kind, { track: null, stream: null }]));
}

class Peer {
  constructor(room, member) {
    this.room = room;
    this.member = member;
    this.remoteCounter = 0;
    this.counter = 0;
    this.sender = member.id + '/' + member.instance;
    this.candidates = [];
    this.tracks = initialMedia();
    this.announced = {};
    this.initiator = room.instance.localeCompare(member.instance) < 0;
    this.pc = new RTCPeerConnection(room.configuration);
    this.chatReady = roomChatCipher(room.id, room.self, room.chatIdentity, member)
      .then((cipher) => {
        this.chatCipher = cipher;
        this.room.render();
        return cipher;
      }).catch(() => null);
    this.watchMedia();
    this.pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ type: 'ice', candidate: candidate.toJSON() });
    };
    this.pc.ontrack = (event) => {
      const kind = mediaOrder[this.pc.getTransceivers().indexOf(event.transceiver)];
      if (!kind) return;
      this.tracks[kind] = { track: event.track, stream: new MediaStream([event.track]) };
      this.room.render();
    };
    this.pc.ondatachannel = ({ channel }) => {
      if (!this.initiator && channel.label === 'room') this.bindChannel(channel);
    };
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'connected') {
        clearTimeout(this.mediaTimer);
        this.mediaTimer = null;
        this.mediaDelayed = false;
        this.mediaRetried = false;
      } else if (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed') {
        this.watchMedia();
      }
      this.room.render();
    };
    if (this.initiator) {
      for (const kind of mediaOrder) this.pc.addTransceiver(kind === 'mic' ? 'audio' : 'video', { direction: 'sendrecv' });
      this.bindChannel(this.pc.createDataChannel('room', { ordered: true }));
      this.offer(false).catch((error) => this.room.report(error));
    }
  }

  watchMedia() {
    if (this.mediaTimer) return;
    this.mediaTimer = setTimeout(() => {
      this.mediaTimer = null;
      if (this.pc.connectionState === 'connected' || this.pc.connectionState === 'closed') return;
      const retry = this.initiator && this.pc.signalingState === 'stable' && this.room.isOnline() && !this.mediaRetried;
      this.mediaDelayed = !retry;
      if (retry) {
        this.mediaRetried = true;
        this.offer(true).catch((error) => this.room.report(error));
        this.watchMedia();
      }
      this.room.render();
    }, 10_000);
  }

  send(signal) {
    return this.room.send({ ...signal, to: this.member.id, toInstance: this.member.instance });
  }

  get canChat() {
    return this.channel?.readyState === 'open' || (this.room.isOnline() && !!this.chatCipher);
  }

  async sendChat(text) {
    if (this.data({ kind: 'chat', text })) return true;
    if (!this.room.isOnline() || !this.chatCipher) return false;
    const envelope = await this.chatCipher.encrypt(++this.room.chatCounter, text);
    return this.send({ type: 'chat', ...envelope });
  }

  async readChat(event) {
    if (!Number.isSafeInteger(event.counter) || event.counter <= (this.room.receivedChat.get(this.sender) ?? 0)) return;
    const cipher = await this.chatReady;
    if (!cipher) return;
    try {
      const text = await cipher.decrypt(event);
      if (!text.trim() || text.length > 1500) return;
      this.room.receivedChat.set(this.sender, event.counter);
      this.room.message(this.member.id, text);
    } catch {}
  }

  bindChannel(channel) {
    if (this.channel) {
      channel.close();
      return;
    }
    this.channel = channel;
    channel.onopen = () => {
      this.announce();
      this.room.render();
    };
    channel.onclose = () => this.room.render();
    channel.onmessage = ({ data }) => {
      if (typeof data !== 'string' || data.length > 5000) return;
      let event;
      try { event = JSON.parse(data); } catch { return; }
      if (event?.kind === 'chat' && typeof event.text === 'string' && event.text.trim() && event.text.length <= 1500)
        this.room.message(this.member.id, event.text);
      if (event?.kind === 'media') this.setAnnouncement(event);
    };
  }

  data(payload) {
    if (this.channel?.readyState !== 'open' || this.channel.bufferedAmount > 65536) return false;
    try {
      this.channel.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  setAnnouncement(event) {
    this.announced = Object.fromEntries(mediaOrder.map((kind) => [kind, event[kind] === true]));
    this.room.render();
  }

  announce() {
    const media = Object.fromEntries(mediaOrder.map((kind) => [kind, Boolean(this.room.sendTrack(kind))]));
    if (!this.member.chatKey || !this.send({ type: 'media', ...media })) this.data({ kind: 'media', ...media });
  }

  async setTracks() {
    await Promise.all(this.pc.getTransceivers().map(async ({ sender }, index) => {
      const kind = mediaOrder[index];
      const track = kind ? this.room.sendTrack(kind) : null;
      if (sender.track !== track) await sender.replaceTrack(track);
      if (track?.kind !== 'video') return;
      const parameters = sender.getParameters();
      if (!parameters.encodings.length) return;
      parameters.encodings[0].maxBitrate = videoProfiles[this.room.quality].bitrate;
      await sender.setParameters(parameters).catch(() => {});
    }));
    this.announce();
  }

  async localDescription() {
    const raw = this.pc.localDescription;
    const description = { type: raw.type, sdp: raw.sdp };
    const counter = ++this.counter;
    const values = descriptionStatement(this.room.id, this.room.self, this.member, counter, description);
    const signature = await sign(this.room.device.privateKey, values);
    this.send({ type: 'sdp', description, counter, signature });
  }

  async offer(iceRestart) {
    if (this.offering || this.pc.signalingState !== 'stable') return;
    this.offering = true;
    try {
      if (iceRestart && this.room.hasTurn) {
        this.pc.setConfiguration({ ...this.room.configuration, iceTransportPolicy: 'relay' });
      }
      await this.setTracks();
      await this.pc.setLocalDescription(await this.pc.createOffer({ iceRestart }));
      await this.localDescription();
    } finally {
      this.offering = false;
    }
  }

  async ice(candidate) {
    const remote = this.pc.remoteDescription;
    if (!remote || (candidate.usernameFragment &&
        !remote.sdp.split(/\r?\n/).includes('a=ice-ufrag:' + candidate.usernameFragment))) {
      if (this.candidates.length < 100) this.candidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate).catch(() => {});
  }

  async description(event, signing) {
    const { description, counter, signature } = event;
    if ((this.initiator ? 'answer' : 'offer') !== description?.type || !Number.isSafeInteger(counter) ||
        counter <= this.remoteCounter ||
        !await verify(signing, signature, descriptionStatement(this.room.id, this.member, this.room.self, counter, description)))
      throw Error('Uma conexão com assinatura inválida foi recusada.');
    this.remoteCounter = counter;
    await this.pc.setRemoteDescription(description);
    if (!this.initiator) {
      // A transceiver created by an incoming offer defaults to recvonly.
      for (const transceiver of this.pc.getTransceivers()) transceiver.direction = 'sendrecv';
    }
    for (const candidate of this.candidates.splice(0)) await this.ice(candidate);
    await this.setTracks();
    if (!this.initiator) {
      await this.pc.setLocalDescription(await this.pc.createAnswer());
      await this.localDescription();
    }
  }

  close() {
    clearTimeout(this.mediaTimer);
    this.channel?.close();
    this.pc.close();
  }
}

export class RoomConnection {
  constructor(room, group, session, roster, onState, onError) {
    this.id = room.id;
    this.mode = room.mode;
    this.device = group.chat_mode === 'mls' ? session.identity : null;
    this.roster = roster;
    this.onState = onState;
    this.onError = onError;
    this.instance = crypto.randomUUID();
    this.self = { id: session.account.id, instance: this.instance };
    this.peers = new Map();
    this.local = initialMedia();
    this.messages = [];
    this.chatCounter = 0;
    this.receivedChat = new Map();
    const savedQuality = Number(readPreference('video-quality', '720'));
    this.quality = Object.hasOwn(videoProfiles, savedQuality) ? savedQuality : 720;
    this.incoming = Promise.resolve();
    this.unverified = [];
    this.retries = 0;
    this.status = 'Conectando';
  }

  async connect(ice) {
    if (this.closed) return;
    this.device ??= await createIdentity();
    this.chatIdentity ??= await makeRoomChatKey(this.id, this.self, this.device.privateKey);
    if (this.closed) return;
    this.hasTurn = ice.iceServers.some(({ urls }) => [urls].flat().some((url) => /^turns?:/.test(url)));
    this.configuration = {
      iceServers: ice.iceServers,
      iceTransportPolicy: ice.forceRelay ? 'relay' : 'all',
    };
    this.ice = ice;
    const url = new URL('/signal', location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const { chatKey, chatProof } = this.chatIdentity;
    url.search = new URLSearchParams({
      room: this.id, instance: this.instance, signing: this.device.signing, chatKey, chatProof,
    }).toString();
    this.socket = new WebSocket(url);
    this.socket.onmessage = ({ data }) => {
      this.incoming = this.incoming.then(() => this.receive(JSON.parse(data))).catch((error) => this.report(error));
    };
    this.socket.onclose = ({ code, reason }) => {
      if (this.closed) return;
      if (code === 4003 || code === 4008) {
        this.report(Error(reason || 'Acesso à sala encerrado.'));
        this.close();
        return;
      }
      this.status = 'Reconectando';
      this.render();
      if (!this.expiry) this.expiry = setTimeout(() => this.close(), 15_000);
      this.reconnect = setTimeout(() => { this.connect(ice).catch((error) => this.report(error)); }, Math.min(3000, 500 * ++this.retries));
    };
    if (!this.metrics) this.metrics = setInterval(() => this.reportStats().catch(() => {}), 4000);
    this.render();
  }

  isOnline() { return this.socket?.readyState === WebSocket.OPEN; }
  send(event) {
    if (!this.isOnline()) return false;
    this.socket.send(JSON.stringify(event));
    return true;
  }
  report(error) {
    if (!this.closed) this.onError(error);
  }
  setRoster(roster) {
    this.roster = roster;
    if (this.closed) return;
    this.reconcile();
    const waiting = this.unverified.splice(0);
    if (waiting.length) this.incoming = this.incoming.then(async () => {
      for (const event of waiting) await this.receive(event).catch((error) => this.report(error));
    }).catch((error) => this.report(error));
    this.render();
  }

  trustedMember(summary) {
    if (!this.roster) return summary;
    return this.roster.find(({ id, signing }) => id === summary.id && signing === summary.signing);
  }

  reconcile() {
    const admitted = new Map(this.map.filter((item) => this.trustedMember(item)).map((item) => [item.id, item]));
    for (const [id, peer] of this.peers) {
      const member = admitted.get(id);
      if (!member || member.instance !== peer.member.instance || member.signing !== peer.member.signing || member.chatKey !== peer.member.chatKey) {
        peer.close();
        this.peers.delete(id);
      }
    }
    for (const [id, member] of admitted) {
      if (!this.peers.has(id) && id !== this.self.id) this.peers.set(id, new Peer(this, member));
    }
  }

  get map() { return this.state?.peers ?? []; }
  get personalPolicy() { return this.map.find(({ id }) => id === this.self.id) ?? {}; }
  get canPublish() { return this.mode === 'meet' || this.state?.publisher === this.self.id; }

  async receive(event) {
    if (this.closed) return;
    if (event.type === 'error') { this.report(Error(event.message)); return; }
    if (event.type === 'room' && event.room === this.id) {
      const before = this.state?.publisher;
      this.state = event;
      this.status = 'Conectado';
      this.retries = 0;
      clearTimeout(this.expiry);
      this.expiry = null;
      const policy = this.personalPolicy;
      if (policy.muted) this.stopLocal('mic');
      if (policy.videoBlocked) {
        this.stopLocal('camera');
        this.stopLocal('screen');
      }
      if (before === this.self.id && !this.canPublish) {
        for (const kind of mediaOrder) this.stopLocal(kind);
      }
      this.reconcile();
      await this.refreshTracks();
      return;
    }
    const peer = this.peers.get(event.from);
    if (!peer && this.roster && this.unverified.length < 100 && ['ice','sdp','chat','media'].includes(event.type) &&
        this.map.some(({ id, instance }) => event.from === id && event.fromInstance === instance)) {
      this.unverified.push(event);
      return;
    }
    if (!peer || peer.member.instance !== event.fromInstance) return;
    if (event.type === 'ice') await peer.ice(event.candidate);
    if (event.type === 'chat') await peer.readChat(event);
    if (event.type === 'media') peer.setAnnouncement(event);
    if (event.type === 'sdp') await peer.description(event, peer.member.signing);
  }

  stopLocal(kind) {
    this.local[kind].track?.stop();
    this.local[kind] = { track: null, stream: null };
  }

  async toggle(kind) {
    if (this.local[kind].track) {
      this.stopLocal(kind);
    } else {
      if (!this.isOnline()) throw Error('A sala está desconectada.');
      if (!this.canPublish) throw Error('Inicie a live antes de publicar mídia.');
      if (kind === 'mic' ? this.personalPolicy.muted : this.personalPolicy.videoBlocked)
        throw Error('A publicação está bloqueada pela moderação.');
      if (!navigator.mediaDevices) throw Error('A captura exige HTTPS ou localhost.');
      const stream = kind === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia({ video: displayProfile(this.quality), audio: false })
        : await navigator.mediaDevices.getUserMedia(kind === 'mic' ? { audio: true } : { video: displayProfile(this.quality) });
      const track = stream.getTracks()[0];
      const blocked = kind === 'mic' ? this.personalPolicy.muted : this.personalPolicy.videoBlocked;
      if (this.closed || !this.canPublish || blocked) { track.stop(); return; }
      this.local[kind] = { track, stream };
      track.contentHint = kind === 'screen' ? 'detail' : kind === 'camera' ? 'motion' : 'speech';
      track.onended = () => {
        if (this.local[kind].track !== track) return;
        this.stopLocal(kind);
        this.refreshTracks().catch((error) => this.report(error));
      };
    }
    await this.refreshTracks();
  }

  sendTrack(kind) {
    if (!this.canPublish || (kind === 'mic' ? this.personalPolicy.muted : this.personalPolicy.videoBlocked)) return null;
    return this.local[kind].track;
  }

  async refreshTracks() {
    const previous = this.refreshing ?? Promise.resolve();
    this.refreshing = previous.catch(() => {}).then(async () => {
      await Promise.allSettled([...this.peers.values()].map((peer) => peer.setTracks()));
      this.render();
    });
    await this.refreshing;
  }

  async setQuality(quality) {
    if (!Object.hasOwn(videoProfiles, quality)) return;
    this.quality = quality;
    writePreference('video-quality', String(quality));
    this.render();
    for (const kind of ['camera','screen']) {
      await this.local[kind].track?.applyConstraints(displayProfile(quality)).catch(() => {});
    }
    await this.refreshTracks();
  }

  message(author, text) {
    const participant = this.map.find(({ id }) => id === author);
    const name = participant && this.trustedMember(participant)?.name;
    this.messages = [...this.messages, { author, name, text, id: crypto.randomUUID(), created: Date.now() }].slice(-300);
    this.render();
  }

  async chat(text) {
    const peers = [...this.peers.values()];
    const deliveries = await Promise.allSettled(peers.map((peer) => peer.sendChat(text)));
    const sent = deliveries.filter((result) => result.status === 'fulfilled' && result.value).length;
    if (!sent) throw Error('Aguarde a conexão com outro participante para enviar.');
    this.message(this.self.id, text);
    if (sent < peers.length) this.report(Error('Alguns participantes ainda não estavam conectados para receber a mensagem.'));
  }

  async reportStats() {
    const scores = [];
    let relay = false;
    let direct = false;
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState !== 'connected') continue;
      const stats = await peer.pc.getStats();
      const transport = [...stats.values()].find((item) => item.type === 'transport' && item.selectedCandidatePairId);
      const pair = transport && stats.get(transport.selectedCandidatePairId);
      if (!pair) continue;
      const usingTurn = [pair.localCandidateId, pair.remoteCandidateId].some((id) => stats.get(id)?.candidateType === 'relay');
      if (usingTurn) relay = true; else direct = true;
      const sent = [...stats.values()].filter((item) => item.type === 'remote-inbound-rtp' && Number.isFinite(item.fractionLost));
      scores.push({ upload: pair.availableOutgoingBitrate, rtt: pair.currentRoundTripTime * 1000,
        loss: sent.length ? Math.max(...sent.map(({ fractionLost }) => fractionLost)) * 100 : undefined });
    }
    this.path = relay ? (direct ? 'Direta e TURN' : 'Relay TURN') : direct ? 'Direta' : null;
    const aggregate = (key, combine) => {
      const values = scores.map((score) => score[key]).filter(Number.isFinite);
      return values.length ? combine(...values) : undefined;
    };
    this.send({ type: 'stats', stable: scores.length, loss: aggregate('loss', Math.max),
      rtt: aggregate('rtt', Math.max), upload: aggregate('upload', Math.min) });
    this.render();
  }

  render() {
    const people = this.map.flatMap((policy) => {
      const account = this.trustedMember(policy);
      if (!account) return [];
      const self = account.id === this.self.id;
      const peer = this.peers.get(account.id);
      const allowed = this.mode === 'meet' || this.state?.publisher === account.id;
      const media = Object.fromEntries(mediaOrder.map((kind) => {
        const isBlocked = kind === 'mic' ? policy.muted : policy.videoBlocked;
        const stream = allowed && !isBlocked && (self ? this.local[kind].stream : peer?.pc.connectionState === 'connected' && peer.announced[kind] && peer.tracks[kind].stream);
        return [kind, stream || null];
      }));
      return [{ ...policy, name: account.name, self, media }];
    });
    const peers = [...this.peers.values()];
    const mediaReady = peers.filter((peer) => peer.pc.connectionState === 'connected').length;
    const mediaFailed = peers.some((peer) => peer.mediaDelayed || peer.pc.connectionState === 'failed');
    let media = this.status;
    if (this.status === 'Conectado') {
      if (!peers.length) media = 'Aguardando participante';
      else if (mediaReady === peers.length) media = this.path ?? 'Mídia conectada';
      else if (mediaFailed) media = mediaReady ? 'Mídia conectada parcialmente' : 'Mídia indisponível';
      else media = 'Conectando mídia';
    }
    this.onState({ people, host: this.state?.host, term: this.state?.term, publisher: this.state?.publisher,
      status: this.status, media, mediaFailed, hasTurn: this.hasTurn, canChat: peers.some((peer) => peer.canChat),
      canPublish: this.canPublish, policy: this.personalPolicy,
      messages: this.messages, quality: this.quality, closed: this.closed });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.send({ type: 'leave' });
    this.socket?.close();
    clearInterval(this.metrics);
    clearTimeout(this.expiry);
    clearTimeout(this.reconnect);
    for (const peer of this.peers.values()) peer.close();
    for (const kind of mediaOrder) this.stopLocal(kind);
    this.peers.clear();
    this.unverified = [];
    this.state = null;
    this.status = 'Desconectado';
    this.render();
  }
}
