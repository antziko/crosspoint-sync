/**
 * One-time import from a koreader-sync-server Redis database: accounts,
 * progress (with the rich position), bookmark blobs and stats blobs. Safe to
 * re-run: a record already newer here is left alone.
 */
import net from 'node:net';
import { withTransaction, type DB } from '../db/db.js';
import { hashKey, looksLikeMd5 } from '../auth/password.js';
import { recordProgressSample, upsertProgress, USERNAME_RE } from '../routes/kosync.js';
import { resolveDocument } from '../models/merge.js';
import { parsePosition } from '../models/position.js';
import { projectBookmarks, projectStats } from './projection.js';
import { storeBookmarks, storeStats } from './routes.js';

export interface RedisReader {
  keys(pattern: string): Promise<string[]>;
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export interface ImportReport {
  users: number;
  usersSkipped: string[];
  progress: number;
  bookmarks: number;
  stats: number;
  skippedOlder: number;
}

const DOCUMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

export async function importFromRedis(db: DB, redis: RedisReader, dryRun = false): Promise<ImportReport> {
  const report: ImportReport = { users: 0, usersSkipped: [], progress: 0, bookmarks: 0, stats: 0, skippedOlder: 0 };
  const getUser = db.prepare('SELECT id FROM users WHERE username = ?');
  const addUser = db.prepare('INSERT INTO users (username, key_hash, created_at) VALUES (?, ?, ?)');
  const now = Math.floor(Date.now() / 1000);

  const userIds = new Map<string, number>();
  for (const key of await redis.keys('user:*:key')) {
    const username = key.slice('user:'.length, -':key'.length);
    const md5Key = await redis.get(key);
    if (!md5Key || !looksLikeMd5(md5Key) || !USERNAME_RE.test(username)) {
      report.usersSkipped.push(username);
      continue;
    }
    let row = getUser.get(username) as { id: number } | undefined;
    if (!row && !dryRun) {
      addUser.run(username, hashKey(md5Key.toLowerCase()), now);
      row = getUser.get(username) as { id: number };
      report.users++;
    }
    userIds.set(username, row?.id ?? -1);
  }

  const progressAt = db.prepare(
    'SELECT updated_at FROM progress WHERE user_id = ? AND document = ? AND device_id = ?'
  );
  const bookmarksAt = db.prepare('SELECT updated_at FROM compat_bookmarks WHERE user_id = ? AND document = ?');
  const statsAt = db.prepare(
    'SELECT updated_at FROM compat_stats WHERE user_id = ? AND document = ? AND device_id = ?'
  );

  for (const [username, userId] of userIds) {
    const prefix = `user:${username}:`;
    for (const key of await redis.keys(`${prefix}document:*`)) {
      const document = key.slice(`${prefix}document:`.length);
      const h = await redis.hgetall(key);
      const percentage = Number(h.percentage);
      if (!DOCUMENT_RE.test(document) || !h.progress || !Number.isFinite(percentage) || percentage < 0 || percentage > 1) {
        continue;
      }
      const deviceId = h.device_id || h.device || 'koreader-sync-import';
      const at = Number(h.timestamp) || now;
      const canonical = resolveDocument(db, userId, document);
      const existing = progressAt.get(userId, canonical, deviceId) as { updated_at: number } | undefined;
      if (existing && existing.updated_at >= at) {
        report.skippedOlder++;
        continue;
      }
      let position: string | null = null;
      if (h.position) {
        try {
          const parsed = parsePosition(JSON.parse(h.position));
          if (parsed) position = JSON.stringify(parsed);
        } catch {
          // Unreadable position: import the progress without it.
        }
      }
      report.progress++;
      if (dryRun) continue;
      const record = {
        userId,
        document: canonical,
        deviceId,
        device: h.device ?? '',
        percentage,
        progress: h.progress,
        position,
        metadata: null,
        updatedAt: at,
      };
      upsertProgress(db, record);
      recordProgressSample(db, userId, canonical, percentage, h.progress, position, at);
    }

    for (const key of await redis.keys(`${prefix}bookmarks:*`)) {
      const document = key.slice(`${prefix}bookmarks:`.length);
      const h = await redis.hgetall(key);
      if (!DOCUMENT_RE.test(document) || !h.bookmarks) continue;
      const at = Number(h.timestamp) || now;
      const existing = bookmarksAt.get(userId, document) as { updated_at: number } | undefined;
      if (existing && existing.updated_at >= at) {
        report.skippedOlder++;
        continue;
      }
      report.bookmarks++;
      if (dryRun) continue;
      withTransaction(db, () => {
        storeBookmarks(db, userId, document, h.bookmarks, at);
        projectBookmarks(db, userId, document, h.bookmarks, at, now);
      });
    }

    for (const key of await redis.keys(`${prefix}stats:*`)) {
      const document = key.slice(`${prefix}stats:`.length);
      if (!DOCUMENT_RE.test(document)) continue;
      const h = await redis.hgetall(key);
      const at = Number(h.timestamp) || now;
      for (const [deviceId, blob] of Object.entries(h)) {
        if (deviceId === 'timestamp' || !blob) continue;
        const existing = statsAt.get(userId, document, deviceId) as { updated_at: number } | undefined;
        if (existing && existing.updated_at >= at) {
          report.skippedOlder++;
          continue;
        }
        report.stats++;
        if (dryRun) continue;
        withTransaction(db, () => {
          storeStats(db, userId, document, deviceId, blob, at);
          projectStats(db, userId, document, deviceId, blob, at);
        });
      }
    }
  }
  return report;
}

type Reply = string | number | null | Reply[];

/** Minimal RESP2 client: enough for KEYS / GET / HGETALL against a local Redis. */
export class RespClient implements RedisReader {
  private buf = Buffer.alloc(0);
  private waiters: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    socket.on('error', (err) => {
      for (const w of this.waiters.splice(0)) w.reject(err);
    });
  }

  static connect(host: string, port: number): Promise<RespClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => resolve(new RespClient(socket)));
      socket.once('error', reject);
    });
  }

  close(): void {
    this.socket.end();
  }

  private command(...args: string[]): Promise<Reply> {
    let out = `*${args.length}\r\n`;
    for (const a of args) out += `$${Buffer.byteLength(a)}\r\n${a}\r\n`;
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.socket.write(out);
    });
  }

  private drain(): void {
    while (this.waiters.length) {
      const parsed = this.parse(0);
      if (!parsed) return;
      this.buf = this.buf.subarray(parsed.end);
      const w = this.waiters.shift()!;
      if (parsed.value instanceof Error) w.reject(parsed.value);
      else w.resolve(parsed.value);
    }
  }

  private parse(at: number): { value: Reply | Error; end: number } | null {
    const eol = this.buf.indexOf('\r\n', at);
    if (eol < 0) return null;
    const line = this.buf.toString('utf8', at + 1, eol);
    const next = eol + 2;
    switch (String.fromCharCode(this.buf[at])) {
      case '+':
        return { value: line, end: next };
      case '-':
        return { value: new Error(line), end: next };
      case ':':
        return { value: Number(line), end: next };
      case '$': {
        const len = Number(line);
        if (len < 0) return { value: null, end: next };
        if (this.buf.length < next + len + 2) return null;
        return { value: this.buf.toString('utf8', next, next + len), end: next + len + 2 };
      }
      case '*': {
        const count = Number(line);
        if (count < 0) return { value: null, end: next };
        const items: Reply[] = [];
        let pos = next;
        for (let i = 0; i < count; i++) {
          const item = this.parse(pos);
          if (!item) return null;
          if (item.value instanceof Error) return item;
          items.push(item.value);
          pos = item.end;
        }
        return { value: items, end: pos };
      }
      default:
        return { value: new Error(`unexpected RESP reply: ${line}`), end: next };
    }
  }

  async keys(pattern: string): Promise<string[]> {
    return ((await this.command('KEYS', pattern)) as string[]) ?? [];
  }

  async get(key: string): Promise<string | null> {
    return (await this.command('GET', key)) as string | null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const flat = ((await this.command('HGETALL', key)) as string[]) ?? [];
    const out: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  }
}
