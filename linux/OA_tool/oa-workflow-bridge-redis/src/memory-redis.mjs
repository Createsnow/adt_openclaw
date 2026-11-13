/**
 * In-memory Redis subset for unit tests (no external Redis required).
 * Supports GET/SET/DEL/PING, SET EX/PX expiry and MULTI/EXEC. Does not implement SCAN.
 */
export class MemoryRedis {
  constructor(now = () => Date.now()) {
    this.strings = new Map();
    this.expiries = new Map();
    this.now = now;
  }

  #evictIfExpired(key) {
    const expiresAt = this.expiries.get(key);
    if (expiresAt === undefined || expiresAt > this.now()) return false;
    this.strings.delete(key);
    this.expiries.delete(key);
    return true;
  }

  async connect() {
    return this;
  }

  async quit() {
    this.strings.clear();
    this.expiries.clear();
  }

  async ping() {
    return "PONG";
  }

  async get(key) {
    this.#evictIfExpired(key);
    return this.strings.has(key) ? this.strings.get(key) : null;
  }

  async set(key, value, options = {}) {
    this.#evictIfExpired(key);
    if (options?.NX && this.strings.has(key)) return null;
    this.strings.set(key, value);
    if (options?.PX) this.expiries.set(key, this.now() + Number(options.PX));
    else if (options?.EX) this.expiries.set(key, this.now() + Number(options.EX) * 1000);
    else this.expiries.delete(key);
    return "OK";
  }

  async del(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    let removed = 0;
    for (const key of list) {
      this.expiries.delete(key);
      if (this.strings.delete(key)) removed += 1;
    }
    return removed;
  }

  multi() {
    const ops = [];
    const chain = {
      set: (key, value, options) => {
        ops.push(() => this.set(key, value, options));
        return chain;
      },
      del: (keys) => {
        ops.push(() => this.del(keys));
        return chain;
      },
      exec: async () => {
        const results = [];
        for (const op of ops) results.push(await op());
        return results;
      },
    };
    return chain;
  }
}
