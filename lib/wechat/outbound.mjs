// 串行发送队列：命令回复、agent 转发、未读提示都走这里。
// 负责加前缀、分片、限速；发送失败时 reject，让调用方（poller）保留游标重试。
const MAX_CHUNK = 1800;
const MAX_CHUNKS = 4;
const DEFAULT_GAP_MS = 250;
const DEFAULT_PREFIX = '🤖 ';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 按换行/长度切片；最多 MAX_CHUNKS 片，多出的截断并提示看面板。 */
export function chunk(text, max = MAX_CHUNK, maxChunks = MAX_CHUNKS) {
  const parts = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  if (parts.length <= maxChunks) return parts;
  const kept = parts.slice(0, maxChunks);
  kept[maxChunks - 1] += '\n…（已截断，完整内容见 super chat 面板）';
  return kept;
}

export class Outbound {
  constructor({ send, log = () => {}, gapMs = DEFAULT_GAP_MS, prefix = DEFAULT_PREFIX } = {}) {
    this.send = send;
    this.log = log;
    this.gapMs = gapMs;
    this.prefix = prefix;
    this.queue = [];
    this.running = false;
  }

  /** 入队并返回发送完成的 promise；resolve 值是最后一次 webwxsendmsg 的 MsgID。 */
  enqueue(text, { ref, prefix = true } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ text: String(text ?? ''), ref, prefix, resolve, reject });
      this.kick();
    });
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
      const job = this.queue.shift();
      try {
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
      }
    }
  }
}
