export const MAX_FILE_BYTES = 64 * 1024 * 1024;
const CHUNK = 16 * 1024;
const BUFFER_LIMIT = 256 * 1024;
// shortcut: cap the in-memory download at 64 MiB until receivers can stream to disk.
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sanitizeName = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '_')
  .trim().slice(0, 180) || 'arquivo';

function waitForDrain(channel, signal) {
  if (channel.bufferedAmount <= BUFFER_LIMIT || signal.aborted) return;
  return new Promise((resolve) => {
    const listeners = new AbortController();
    const complete = () => { listeners.abort(); resolve(); };
    const options = { once: true, signal: listeners.signal };
    channel.addEventListener('bufferedamountlow', complete, options);
    channel.addEventListener('close', complete, options);
    signal.addEventListener('abort', complete, options);
    if (channel.bufferedAmount <= BUFFER_LIMIT || channel.readyState !== 'open' || signal.aborted) complete();
  });
}

export class FileTransfer {
  constructor(onChange) {
    this.onChange = onChange;
  }

  get ready() {
    return this.channel?.readyState === 'open';
  }

  bind(channel) {
    if (this.channel && this.channel !== channel && this.job) this.finish('interrupted');
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LIMIT;
    channel.addEventListener('open', () => this.publish());
    channel.addEventListener('message', ({ data }) => {
      if (this.channel === channel) this.receive(data);
    });
    const disconnected = () => {
      if (this.channel !== channel) return;
      this.channel = null;
      if (this.job) this.finish('interrupted');
      else this.publish();
    };
    channel.addEventListener('close', disconnected);
    channel.addEventListener('error', disconnected);
    this.publish();
  }

  publish() {
    const current = this.job ?? this.result;
    const transfer = current && {
      phase: current.phase, name: current.name, size: current.size, bytes: current.bytes,
    };
    this.onChange({ ready: this.ready, transfer });
  }

  control(kind, id, extras) {
    if (!this.ready) return false;
    try {
      this.channel.send(JSON.stringify({ kind, id, ...extras }));
      return true;
    } catch { return false; }
  }

  start(job) {
    this.result = null;
    this.job = { ...job, bytes: 0, percent: 0, abort: new AbortController(), last: Date.now() };
    this.timer = setInterval(() => {
      if (!this.job || Date.now() - this.job.last < 120_000) return;
      this.abort('expired');
    }, 5000);
    this.publish();
  }

  offer(file) {
    if (!this.ready || this.job || this.download) return false;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) return false;
    const id = crypto.randomUUID();
    const name = sanitizeName(file.name);
    this.start({ id, name, size: file.size, phase: 'offered', file });
    if (!this.control('offer', id, { name, size: file.size })) this.finish('interrupted');
    return true;
  }

  accept() {
    const job = this.job;
    if (job?.phase !== 'incoming') return;
    job.phase = 'receiving';
    job.parts = [];
    job.last = Date.now();
    if (!this.control('accept', job.id)) this.finish('interrupted');
    else this.publish();
  }

  decline() {
    if (this.job?.phase !== 'incoming') return;
    this.control('decline', this.job.id);
    this.finish('declined');
  }

  abort(reason = 'canceled') {
    if (!this.job) return;
    this.control('cancel', this.job.id);
    this.finish(reason);
  }

  finish(phase) {
    const job = this.job;
    if (!job) return;
    job.abort.abort();
    clearInterval(this.timer);
    this.job = null;
    this.result = { phase, name: job.name, size: job.size, bytes: job.bytes };
    this.publish();
  }

  progress(job, bytes) {
    job.bytes = bytes;
    job.last = Date.now();
    const percent = Math.floor(bytes * 100 / (job.size || 1));
    if (job.percent !== percent) {
      job.percent = percent;
      this.publish();
    }
  }

  async send(job) {
    const channel = this.channel;
    try {
      let offset = 0;
      while (offset < job.size) {
        const end = Math.min(offset + CHUNK, job.size);
        const chunk = await job.file.slice(offset, end).arrayBuffer();
        await waitForDrain(channel, job.abort.signal);
        if (job.abort.signal.aborted) return;
        channel.send(chunk);
        offset = end;
        this.progress(job, offset);
      }
      job.phase = 'confirming';
      job.last = Date.now();
      if (this.control('done', job.id)) this.publish();
      else this.finish('interrupted');
    } catch {
      if (this.job === job) this.abort('interrupted');
    }
  }

  receive(data) {
    const job = this.job;
    if (data instanceof ArrayBuffer) {
      if (job?.phase !== 'receiving') return;
      const length = data.byteLength;
      if (length === 0 || length !== Math.min(CHUNK, job.size - job.bytes)) {
        this.abort('invalid');
        return;
      }
      job.parts.push(data);
      this.progress(job, job.bytes + length);
      return;
    }
    if (typeof data !== 'string' || data.length > 1024) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (!event || typeof event.id !== 'string' || !ID.test(event.id)) return;

    if (event.kind === 'offer') {
      if (typeof event.name !== 'string' || !event.name.length || event.name.length > 180 ||
          !Number.isSafeInteger(event.size) || event.size < 0 || event.size > MAX_FILE_BYTES) {
        this.control('decline', event.id);
      } else if (job || this.download) this.control('busy', event.id);
      else this.start({ id: event.id, name: sanitizeName(event.name), size: event.size, phase: 'incoming' });
      return;
    }

    if (!job || event.id !== job.id) return;
    if (event.kind === 'cancel') this.finish('canceled');
    else if (job.phase === 'offered' && ['decline','busy'].includes(event.kind))
      this.finish(event.kind === 'busy' ? 'busy' : 'declined');
    else if (job.phase === 'offered' && event.kind === 'accept') {
      job.phase = 'sending';
      job.last = Date.now();
      this.publish();
      void this.send(job);
    } else if (job.phase === 'receiving' && event.kind === 'done') {
      if (job.bytes !== job.size) { this.abort('invalid'); return; }
      this.download = new Blob(job.parts, { type: 'application/octet-stream' });
      this.control('ack', job.id);
      this.finish('received');
    } else if (job.phase === 'confirming' && event.kind === 'ack') this.finish('sent');
  }

  save() {
    if (!this.download) return;
    const url = URL.createObjectURL(this.download);
    const link = document.createElement('a');
    link.href = url;
    link.download = this.result.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

  }

  dismiss() {
    this.download = null;
    this.result = null;
    this.publish();
  }

  close() {
    this.onChange = () => {};
    this.abort();
    this.channel = null;
    this.dismiss();
  }
}
