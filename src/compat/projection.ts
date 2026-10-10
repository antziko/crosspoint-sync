/**
 * Projects the koreader-sync-server extension blobs (see ./routes.ts) into the
 * tables the app reads: quote highlights into `clippings`, stats blobs into
 * `stats_device_global` / `stats_device_book`. The blobs stay the devices' sync
 * source of truth; these rows are a read-only view of them and are rebuilt on
 * every upload.
 */
import { withTransaction, type DB } from '../db/db.js';
import { resolveDocument } from '../models/merge.js';
import { HISTORY_BYTES, HISTORY_DAYS, type BookStatsSnapshot, type GlobalStatsSnapshot } from '../models/stats.js';

/** Pseudo-document the firmware files its global stats blob under. */
export const GLOBAL_STATS_DOCUMENT = 'crosspoint_global_stats';

/** Clipping ids this module owns. */
export const QUOTE_ID_PREFIX = 'kq-';

/** Snippets shorter than this are already the whole quote (firmware snippet cap: 63 bytes). */
const SNIPPET_MAY_BE_TRUNCATED_BYTES = 56;
/** How many quotes one bookmark PUT response asks the device to send full text for. */
const MAX_NEED_TEXT = 8;
const MAX_CHAPTER = 64;
const NO_PARAGRAPH = 0xffff;

export interface BlobQuote {
  spine: number;
  startWord: number;
  endWord: number;
  page: number;
  pages: number;
  para: number | null;
  chapter: string;
  snippet: string;
}

export function quoteId(spine: number, startWord: number, endWord: number): string {
  return `${QUOTE_ID_PREFIX}${spine}-${startWord}-${endWord}`;
}

function u16(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff ? v : fallback;
}

/**
 * Live quote highlights in a bookmark blob. Reads the short keys and the legacy
 * long keys, and the legacy bare-array form, exactly as the firmware does.
 * Returns null when the blob is not JSON.
 */
export function parseBlobQuotes(blob: string): BlobQuote[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(blob);
  } catch {
    return null;
  }
  let list: unknown;
  if (Array.isArray(doc)) list = doc;
  else if (doc && typeof doc === 'object') {
    const o = doc as Record<string, unknown>;
    list = Array.isArray(o.b) ? o.b : o.bookmarks;
  }
  if (!Array.isArray(list)) return [];
  const out: BlobQuote[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if ((o.q ?? o.quote) !== true) continue;
    const spine = u16(o.s ?? o.spineIndex);
    const startWord = u16(o.sw ?? o.startWord);
    const endWord = u16(o.ew ?? o.endWord);
    const id = quoteId(spine, startWord, endWord);
    if (seen.has(id)) continue;
    seen.add(id);
    const para = u16(o.pi ?? o.paragraphIndex, NO_PARAGRAPH);
    const chapter = o.ct ?? o.chapterTitle;
    const snippet = o.sn ?? o.snippet;
    out.push({
      spine,
      startWord,
      endWord,
      page: u16(o.cp ?? o.chapterCurrentPage),
      pages: Math.max(1, u16(o.pc ?? o.chapterPageCount, 1)),
      para: para === NO_PARAGRAPH ? null : para,
      chapter: typeof chapter === 'string' ? chapter.slice(0, MAX_CHAPTER) : '',
      snippet: typeof snippet === 'string' ? snippet : '',
    });
  }
  return out;
}

interface ProjectedRow {
  id: string;
  spine_index: number;
  start_page: number;
  page_count: number;
  start_word: number;
  end_word: number;
  paragraph_index: number | null;
  chapter_title: string;
  text: string;
  created_at: number;
  deleted: number;
}

/**
 * Brings the document's projected clippings in line with a bookmark blob and
 * returns the quotes whose full text the server still lacks. `seenAt` is the
 * created_at given to quotes seen for the first time.
 */
export function projectBookmarks(
  db: DB,
  userId: number,
  clientDocument: string,
  blob: string,
  seenAt: number,
  now: number
): { spine: number; startWord: number; endWord: number }[] {
  const quotes = parseBlobQuotes(blob);
  if (quotes === null) return [];
  const document = resolveDocument(db, userId, clientDocument);

  const existing = new Map<string, ProjectedRow>();
  for (const r of db
    .prepare(
      `SELECT id, spine_index, start_page, page_count, start_word, end_word, paragraph_index,
              chapter_title, text, created_at, deleted
       FROM clippings WHERE user_id = ? AND document = ? AND id LIKE ?`
    )
    .all(userId, document, `${QUOTE_ID_PREFIX}%`) as unknown as ProjectedRow[]) {
    existing.set(r.id, r);
  }
  const meta = new Map<string, { created_at: number; full_text: string | null }>();
  for (const r of db
    .prepare('SELECT clip_id, created_at, full_text FROM compat_quotes WHERE user_id = ? AND document = ?')
    .all(userId, document) as unknown as { clip_id: string; created_at: number; full_text: string | null }[]) {
    meta.set(r.clip_id, r);
  }

  const bumpRevision = db.prepare('UPDATE clipping_sync_clock SET revision = revision + 1 WHERE id = 1');
  const upsert = db.prepare(
    `INSERT INTO clippings (user_id, document, id, spine_index, start_page, end_page, page_count,
                            start_word, end_word, word_count, paragraph_index, chapter_title, text,
                            created_at, deleted, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, (SELECT revision FROM clipping_sync_clock WHERE id = 1))
     ON CONFLICT(user_id, document, id) DO UPDATE SET
       spine_index = excluded.spine_index, start_page = excluded.start_page, end_page = excluded.end_page,
       page_count = excluded.page_count, start_word = excluded.start_word, end_word = excluded.end_word,
       word_count = excluded.word_count, paragraph_index = excluded.paragraph_index,
       chapter_title = excluded.chapter_title, text = excluded.text, created_at = excluded.created_at,
       deleted = 0, updated_at = excluded.updated_at, revision = excluded.revision`
  );
  const tombstone = db.prepare(
    `UPDATE clippings SET deleted = 1, updated_at = ?, revision = (SELECT revision FROM clipping_sync_clock WHERE id = 1)
     WHERE user_id = ? AND document = ? AND id = ?`
  );
  const insertMeta = db.prepare(
    'INSERT OR IGNORE INTO compat_quotes (user_id, document, clip_id, created_at) VALUES (?, ?, ?, ?)'
  );
  const deleteMeta = db.prepare('DELETE FROM compat_quotes WHERE user_id = ? AND document = ? AND clip_id = ?');

  const needText: { spine: number; startWord: number; endWord: number }[] = [];
  withTransaction(db, () => {
    const live = new Set<string>();
    for (const q of quotes) {
      const id = quoteId(q.spine, q.startWord, q.endWord);
      live.add(id);
      let m = meta.get(id);
      if (!m) {
        m = { created_at: seenAt, full_text: null };
        insertMeta.run(userId, document, id, seenAt);
      }
      const text = m.full_text ?? (q.snippet || q.chapter || '(highlight)');
      // Word indices in KOReader's band (>= 0xC000) are hashes, not positions.
      const words = q.startWord < 0xc000 && q.endWord >= q.startWord ? q.endWord - q.startWord + 1 : 0;
      const prev = existing.get(id);
      const unchanged =
        prev !== undefined &&
        prev.deleted === 0 &&
        prev.spine_index === q.spine &&
        prev.start_page === q.page &&
        prev.page_count === q.pages &&
        prev.paragraph_index === q.para &&
        prev.chapter_title === q.chapter &&
        prev.text === text &&
        prev.created_at === m.created_at;
      if (!unchanged) {
        bumpRevision.run();
        upsert.run(userId, document, id, q.spine, q.page, q.page, q.pages, q.startWord, q.endWord, words, q.para,
          q.chapter, text, m.created_at, now);
      }
      if (m.full_text === null && Buffer.byteLength(q.snippet) >= SNIPPET_MAY_BE_TRUNCATED_BYTES &&
          needText.length < MAX_NEED_TEXT) {
        needText.push({ spine: q.spine, startWord: q.startWord, endWord: q.endWord });
      }
    }
    for (const [id, prev] of existing) {
      if (live.has(id)) continue;
      if (prev.deleted === 0) {
        bumpRevision.run();
        tombstone.run(now, userId, document, id);
      }
      // A later highlight on the same words is a new one: new created_at, new text.
      deleteMeta.run(userId, document, id);
    }
  });
  return needText;
}

/** Records full quote text a device sent and refreshes the projected clipping. Returns how many matched. */
export function storeQuoteText(
  db: DB,
  userId: number,
  clientDocument: string,
  items: { spine: number; startWord: number; endWord: number; text: string }[],
  now: number
): number {
  const document = resolveDocument(db, userId, clientDocument);
  const setText = db.prepare(
    'UPDATE compat_quotes SET full_text = ? WHERE user_id = ? AND document = ? AND clip_id = ?'
  );
  const bumpRevision = db.prepare('UPDATE clipping_sync_clock SET revision = revision + 1 WHERE id = 1');
  const setClipping = db.prepare(
    `UPDATE clippings SET text = ?, updated_at = ?, revision = (SELECT revision FROM clipping_sync_clock WHERE id = 1)
     WHERE user_id = ? AND document = ? AND id = ? AND deleted = 0 AND text <> ?`
  );
  let matched = 0;
  withTransaction(db, () => {
    for (const item of items) {
      const id = quoteId(item.spine, item.startWord, item.endWord);
      if (setText.run(item.text, userId, document, id).changes === 0) continue;
      matched++;
      bumpRevision.run();
      setClipping.run(item.text, now, userId, document, id, item.text);
    }
  });
  return matched;
}

interface StatsBlob {
  seconds: number;
  history: Buffer | null;
}

function parseStatsBlob(blob: string): StatsBlob | null {
  let o: unknown;
  try {
    o = JSON.parse(blob);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const s = r.s;
  const seconds = typeof s === 'number' && Number.isInteger(s) && s >= 0 && s <= 0xffffffff ? s : 0;
  const history = typeof r.h === 'string' ? Buffer.from(r.h, 'base64') : null;
  return { seconds, history };
}

// ReadingTimeHistory::serializeBlob layout (firmware, little-endian):
// u8 version=1, WeekEntry[52], MonthEntry[24], YearEntry[10] (8 bytes each),
// heatmap 2 bits/day for 730 days (183 bytes), u32 anchor day (days since 2000-01-01).
const HISTORY_BLOB_VERSION = 1;
const HEATMAP_OFFSET = 1 + 8 * (52 + 24 + 10);
const HEATMAP_BYTES = (HISTORY_DAYS * 2 + 7) >> 3;
const ANCHOR_OFFSET = HEATMAP_OFFSET + HEATMAP_BYTES;
const HISTORY_BLOB_BYTES = ANCHOR_OFFSET + 4;

/** The server's 1-bit/day calendar from the firmware's 2-bit/day heatmap. */
export function historyFromBlob(blob: Buffer | null): { anchorDay: number; bits: Buffer } {
  const bits = Buffer.alloc(HISTORY_BYTES);
  if (!blob || blob.length < HISTORY_BLOB_BYTES || blob[0] !== HISTORY_BLOB_VERSION) {
    return { anchorDay: 0, bits };
  }
  const anchorDay = blob.readUInt32LE(ANCHOR_OFFSET);
  for (let day = 0; day < HISTORY_DAYS; day++) {
    const bit = day * 2;
    const level = (blob[HEATMAP_OFFSET + (bit >> 3)] >> (bit & 7)) & 3;
    if (level !== 0) bits[day >> 3] |= 1 << (day & 7);
  }
  if (anchorDay === 0 && (bits[0] & 1) === 0) return { anchorDay: 0, bits: Buffer.alloc(HISTORY_BYTES) };
  return { anchorDay, bits };
}

function longestRun(bits: Buffer): number {
  let best = 0;
  let run = 0;
  for (let day = 0; day < HISTORY_DAYS; day++) {
    if (bits[day >> 3] & (1 << (day & 7))) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * Projects one device's stats blob. The firmware tracks reading time and the
 * dated calendar only, so the counters it has no equivalent for are zero.
 */
export function projectStats(
  db: DB,
  userId: number,
  document: string,
  deviceId: string,
  blob: string,
  now: number
): void {
  const parsed = parseStatsBlob(blob);
  if (!parsed) return;
  if (document === GLOBAL_STATS_DOCUMENT) {
    const { anchorDay, bits } = historyFromBlob(parsed.history);
    const snapshot: GlobalStatsSnapshot = {
      v: 5,
      sessions: 0,
      seconds: parsed.seconds,
      pages: 0,
      completed: 0,
      tod: [0, 0, 0, 0],
      dow: [0, 0, 0, 0, 0, 0, 0],
      anchor_day: anchorDay,
      history_b64: bits.toString('base64'),
      streak: longestRun(bits),
    };
    db.prepare(
      `INSERT INTO stats_device_global (user_id, device_id, device, payload, updated_at)
       VALUES (?, ?, 'CrossPoint', ?, ?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
    ).run(userId, deviceId, JSON.stringify(snapshot), now);
    return;
  }
  const snapshot: BookStatsSnapshot = {
    v: 5,
    sessions: 0,
    seconds: parsed.seconds,
    pages: 0,
    completed: false,
    avg_fwd: 0,
    pace_n: 0,
    eta: 0,
    start_manual: false,
    finish_manual: false,
    start_date: 0,
    finished_date: 0,
    tod: [0, 0, 0, 0],
    dow: [0, 0, 0, 0, 0, 0, 0],
  };
  db.prepare(
    `INSERT INTO stats_device_book (user_id, device_id, document, payload, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id, document) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
  ).run(userId, deviceId, document, JSON.stringify(snapshot), now);
}
