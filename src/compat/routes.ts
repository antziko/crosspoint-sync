/**
 * Fork-only: the /syncs/bookmarks and /syncs/stats extension of the self-hosted
 * koreader-sync-server, wire-compatible with it. Blobs are stored verbatim and
 * returned unchanged, so CrossPoint firmware and the KOReader plugin keep their
 * own merge rules; each upload is also projected for the app (./projection.ts).
 */
import { Hono } from 'hono';
import type { DB } from '../db/db.js';
import { authMiddleware, kosyncError, type AppEnv } from '../auth/middleware.js';
import { isValidDocument } from '../routes/kosync.js';
import { nowSeconds } from '../models/sync.js';
import { projectBookmarks, projectStats, storeQuoteText } from './projection.js';

/** Echoed by PUT /syncs/stats; the firmware shows it as the server build. */
export const STATS_SERVER_TAG = 'stats-v1';

const MAX_BLOB_BYTES = 1024 * 1024;
const MAX_TEXT_ITEMS = 16;
const MAX_TEXT_BYTES = 4096;

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isBlob(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= MAX_BLOB_BYTES;
}

function isWord(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff;
}

export function storeBookmarks(db: DB, userId: number, document: string, blob: string, at: number): void {
  db.prepare(
    `INSERT INTO compat_bookmarks (user_id, document, blob, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, document) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`
  ).run(userId, document, blob, at);
}

export function storeStats(db: DB, userId: number, document: string, deviceId: string, blob: string, at: number): void {
  db.prepare(
    `INSERT INTO compat_stats (user_id, document, device_id, blob, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, document, device_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`
  ).run(userId, document, deviceId, blob, at);
}

export function compatRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = authMiddleware(db);

  app.get('/syncs/bookmarks/:document', auth, (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    const row = db
      .prepare('SELECT blob, updated_at FROM compat_bookmarks WHERE user_id = ? AND document = ?')
      .get(c.get('user').id, document) as { blob: string; updated_at: number } | undefined;
    if (!row) return c.json({});
    return c.json({ bookmarks: row.blob, timestamp: row.updated_at, document });
  });

  app.put('/syncs/bookmarks', auth, async (c) => {
    const o = await jsonBody(c);
    if (!o || !isValidDocument(o.document)) return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    if (!isBlob(o.bookmarks)) return kosyncError(c, 403, 2003, 'Invalid request');
    const userId = c.get('user').id;
    const now = nowSeconds();
    storeBookmarks(db, userId, o.document, o.bookmarks, now);
    const needText = projectBookmarks(db, userId, o.document, o.bookmarks, now, now);
    return c.json({
      document: o.document,
      timestamp: now,
      ...(needText.length ? { need_text: needText.map((q) => [q.spine, q.startWord, q.endWord]) } : {}),
    });
  });

  // Full text for quotes the bookmark PUT listed in need_text: [{s, sw, ew, text}].
  app.put('/syncs/bookmarks/text', auth, async (c) => {
    const o = await jsonBody(c);
    if (!o || !isValidDocument(o.document)) return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    const items = o.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_TEXT_ITEMS) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const parsed: { spine: number; startWord: number; endWord: number; text: string }[] = [];
    for (const raw of items) {
      const i = (raw ?? {}) as Record<string, unknown>;
      if (!isWord(i.s) || !isWord(i.sw) || !isWord(i.ew) || typeof i.text !== 'string' || i.text.length === 0 ||
          Buffer.byteLength(i.text) > MAX_TEXT_BYTES) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      parsed.push({ spine: i.s, startWord: i.sw, endWord: i.ew, text: i.text });
    }
    const accepted = storeQuoteText(db, c.get('user').id, o.document, parsed, nowSeconds());
    return c.json({ document: o.document, accepted });
  });

  app.get('/syncs/stats/:document', auth, (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    const rows = db
      .prepare('SELECT device_id, blob, updated_at FROM compat_stats WHERE user_id = ? AND document = ?')
      .all(c.get('user').id, document) as unknown as { device_id: string; blob: string; updated_at: number }[];
    if (rows.length === 0) return c.json({});
    const stats: Record<string, string> = {};
    let timestamp = 0;
    for (const r of rows) {
      stats[r.device_id] = r.blob;
      if (r.updated_at > timestamp) timestamp = r.updated_at;
    }
    return c.json({ timestamp, stats, document });
  });

  app.put('/syncs/stats', auth, async (c) => {
    const o = await jsonBody(c);
    if (!o || !isValidDocument(o.document)) return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    const deviceId = o.device_id;
    if (typeof deviceId !== 'string' || !/^[^:]{1,128}$/.test(deviceId) || deviceId === 'timestamp' || !isBlob(o.stats)) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const userId = c.get('user').id;
    const now = nowSeconds();
    storeStats(db, userId, o.document, deviceId, o.stats, now);
    projectStats(db, userId, o.document, deviceId, o.stats, now);
    return c.json({ document: o.document, timestamp: now, server: STATS_SERVER_TAG });
  });

  return app;
}
