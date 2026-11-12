// 串行发送队列：命令回复、agent 转发、未读提示都走这里。
// 负责加前缀、分片、限速；发送失败时 reject，让调用方（poller）保留游标重试。
const MAX_CHUNK = 1800;
const MAX_CHUNKS = 4;
const DEFAULT_GAP_MS = 250;
const DEFAULT_PREFIX = '🌊 ';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejection used when a queued send is dropped because WeChat pushes are paused. */
export class PauseError extends Error {
  constructor(message = '微信推送已暂停') {
    super(message)
    this.name = 'PauseError'
    this.code = 'WECHAT_PAUSED'
  }
}

/** 按换行/长度切片；最多 MAX_CHUNKS 片，多出的截断并提示看面板。 */
export function chunk(text, max = MAX_CHUNK, maxChunks = MAX_CHUNKS) {
  const parts = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    // Keep UTF-16 surrogate pairs intact at a hard length boundary.
    const before = rest.charCodeAt(cut - 1);
    const after = rest.charCodeAt(cut);
    if (before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF) {
      cut = cut > 1 ? cut - 1 : cut + 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  if (parts.length <= maxChunks) return parts;
  const kept = parts.slice(0, maxChunks);
  kept[maxChunks - 1] += '\n…（已截断，完整内容见 Ria 会话）';
  return kept;
}

export class Outbound {
  constructor({ send, sendFile, sendImage, log = () => {}, gapMs = DEFAULT_GAP_MS, prefix = DEFAULT_PREFIX } = {}) {
    this.send = send;
    this.sendFile = sendFile;
    this.sendImage = sendImage;
    this.log = log;
    this.gapMs = gapMs;
    this.prefix = prefix;
    this.queue = [];
    this.running = false;
    this.paused = false;
    this.onDrop = undefined;
    this.current = undefined;
  }

  /** 入队并返回发送完成的 promise；resolve 值是最后一次 webwxsendmsg 的 MsgID。 */
  enqueue(text, { ref, prefix = true } = {}) {
    if (this.paused) return Promise.reject(new PauseError());
    return new Promise((resolve, reject) => {
      this.queue.push({ text: String(text ?? ''), ref, prefix, resolve, reject });
      this.kick();
    });
  }

  /** 入队一张图片；和文本、文件共用同一条串行队列。 */
  enqueueImage({ name, buffer, mime = 'image/png', ref } = {}) {
    if (this.paused) return Promise.reject(new PauseError());
    return new Promise((resolve, reject) => {
      this.queue.push({ image: true, name, buffer, mime, ref, resolve, reject });
      this.kick();
    });
  }

  /** 入队一个文件；和文本共用同一条串行队列。 */
  enqueueFile({ name, buffer, mime = 'text/markdown', ref } = {}) {
    if (this.paused) return Promise.reject(new PauseError());
    return new Promise((resolve, reject) => {
      this.queue.push({ file: true, name, buffer, mime, ref, resolve, reject });
      this.kick();
    });
  }

  /**
   * Pause or resume delivery. Pausing rejects every job that has not started,
   * reports each through onDrop, and leaves the in-flight job to finish its
   * current message. Resuming restarts the queue.
   */
  setPaused(paused, { onDrop } = {}) {
    this.paused = Boolean(paused);
    if (!this.paused) {
      this.onDrop = undefined;
      this.kick();
      return 0;
    }
    if (typeof onDrop === 'function') this.onDrop = onDrop;
    return this.dropQueued();
  }

  dropQueued() {
    const dropped = this.queue.splice(0);
    for (const job of dropped) {
      try { this.onDrop?.(job) } catch { /* the log callback must not break delivery state */ }
      job.reject(new PauseError());
    }
    return dropped.length;
  }

  get pending() {
    return this.queue.length;
  }

  kick() {
    if (this.running) return;
    this.running = true;
    this.loop().finally(() => {
      this.running = false;
      if (this.queue.length) this.kick();
    });
  }

  async loop() {
    while (this.queue.length) {
      if (this.paused) {
        this.dropQueued();
        return;
      }
      const job = this.queue.shift();
      this.current = job;
      try {
        if (job.image) {
          if (typeof this.sendImage !== 'function') throw new Error('图片发送不可用');
          const id = await this.sendImage(job.name, job.buffer, job.mime);
          job.resolve(id);
          continue;
        }
        if (job.file) {
          if (typeof this.sendFile !== 'function') throw new Error('文件发送不可用');
          const id = await this.sendFile(job.name, job.buffer, job.mime);
          job.resolve(id);
          continue;
        }
        const body = (job.prefix ? this.prefix : '') + job.text;
        const parts = chunk(body);
        let lastId;
        for (let i = 0; i < parts.length; i++) {
          lastId = await this.send(parts[i]);
          if (i < parts.length - 1) await sleep(this.gapMs);
        }
        job.resolve(lastId);
      } catch (e) {
        this.log('[outbound] 发送失败: ' + e.message);
        job.reject(e);
      } finally {
        this.current = undefined;
      }
    }
  }
}
