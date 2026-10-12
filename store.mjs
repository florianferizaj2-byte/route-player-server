import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// One server process owns this store. Transactions replace the file atomically and serialize writes.
export class Store {
  constructor(directory) { this.directory = directory; this.tail = Promise.resolve(); }
  async initialize() {
    await mkdir(this.directory, { recursive: true });
    this.path = join(this.directory, 'accounts.json');
    try { this.state = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = { version: 1, users: [], sessions: [], cards: [], routes: [], audit: [] };
    }
    if (this.state.version !== 1 || !['users','sessions','cards','routes','audit'].every(k => Array.isArray(this.state[k]))) {
      throw new Error('Unsupported or damaged account database; restore a backup before starting.');
    }
    return this;
  }
  read(operation) { return operation(this.state); }
  async transact(operation) {
    const pending = this.tail.catch(() => {}).then(async () => {
      const next = structuredClone(this.state);
      const result = await operation(next);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, this.path);
        this.state = next;
        return result;
      } finally { await unlink(temporary).catch(() => {}); }
    });
    this.tail = pending;
    return pending;
  }
}
