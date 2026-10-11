import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { historyFromBlob } from '../src/compat/projection.js';
import { stripDeviceTag } from '../src/routes/kosync.js';

function bookmarkBlob(marks: Record<string, unknown>[], tombs: Record<string, unknown>[] = []): string {
  return JSON.stringify({ b: marks, t: tombs });
}

const LONG = 'It was the best of times, it was the worst of times, it was the age of';

function quote(sw: number, ew: number, sn = 'short quote'): Record<string, unknown> {
  return { s: 3, p: 0.25, v: 7, ct: 'Chapter 3', pi: 12, sn, cp: 4, pc: 20, q: true, es: 3, ep: 0.25, sw, ew };
}

// ReadingTimeHistory::serializeBlob with the given heatmap levels (daysAgo -> level).
function historyBlob(anchorDay: number, levels: Record<number, number>): string {
  const heatmapOffset = 1 + 8 * (52 + 24 + 10);
  const buf = Buffer.alloc(heatmapOffset + 183 + 4);
  buf[0] = 1;
  for (const [day, level] of Object.entries(levels)) {
    const bit = Number(day) * 2;
    buf[heatmapOffset + (bit >> 3)] |= level << (bit & 7);
  }
  buf.writeUInt32LE(anchorDay, heatmapOffset + 183);
  return buf.toString('base64');
}

describe('koreader-sync-server compat', () => {
  it('stores and returns the bookmark blob verbatim', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const empty = await app.request(`/syncs/bookmarks/${DOC}`, { headers });
    expect(await empty.json()).toEqual({});

    const blob = bookmarkBlob([{ s: 1, p: 0.1, v: 2, ct: 'One', pi: 4, sn: 'x', cp: 0, pc: 9, xp: '/body/p[1]' }]);
    const put = await app.request('/syncs/bookmarks', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, bookmarks: blob }),
    });
    expect(put.status).toBe(200);
    const got = (await (await app.request(`/syncs/bookmarks/${DOC}`, { headers })).json()) as Record<string, unknown>;
    expect(got.bookmarks).toBe(blob);
    expect(got.document).toBe(DOC);
    expect(typeof got.timestamp).toBe('number');
  });

  it('keeps one stats blob per device and echoes the server tag', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const [device, s] of [['crosspoint-aaa', 10], ['crosspoint-bbb', 20], ['crosspoint-aaa', 30]] as const) {
      const res = await app.request('/syncs/stats', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document: DOC, device_id: device, stats: JSON.stringify({ s, lr: 0, lh: 0, lm: 0 }) }),
      });
      expect(((await res.json()) as Record<string, unknown>).server).toBe('stats-v1');
    }
    const got = (await (await app.request(`/syncs/stats/${DOC}`, { headers })).json()) as {
      stats: Record<string, string>;
    };
    expect(Object.keys(got.stats).sort()).toEqual(['crosspoint-aaa', 'crosspoint-bbb']);
    expect(JSON.parse(got.stats['crosspoint-aaa']).s).toBe(30);

    const book = (await (await app.request(`/api/v1/stats/books/${DOC}`, { headers })).json()) as {
      combined: { seconds: number };
    };
    expect(book.combined.seconds).toBe(50);
  });

  it('rejects the reserved timestamp device id', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/syncs/stats', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, device_id: 'timestamp', stats: '{"s":1}' }),
    });
    expect(res.status).toBe(403);
  });

  it('projects quote highlights into clippings and follows deletes', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = (blob: string) =>
      app.request('/syncs/bookmarks', { method: 'PUT', headers, body: JSON.stringify({ document: DOC, bookmarks: blob }) });

    await put(bookmarkBlob([quote(5, 9), { s: 1, p: 0.1, v: 1, ct: 'One', pi: 2, sn: 'point bookmark' }]));
    let clips = (await (await app.request('/api/v1/clippings', { headers })).json()) as {
      items: { id: string; text: string; chapter: string; para: number }[];
    };
    expect(clips.items).toHaveLength(1);
    expect(clips.items[0]).toMatchObject({ id: 'kq-3-5-9', text: 'short quote', chapter: 'Chapter 3', para: 12 });

    await put(bookmarkBlob([], [{ s: 3, pi: 12, p: 0.25, v: 8, q: true, sw: 5, ew: 9 }]));
    clips = (await (await app.request('/api/v1/clippings', { headers })).json()) as typeof clips;
    expect(clips.items).toHaveLength(0);

    // The same words highlighted again come back as a live clipping.
    await put(bookmarkBlob([quote(5, 9)]));
    clips = (await (await app.request('/api/v1/clippings', { headers })).json()) as typeof clips;
    expect(clips.items.map((c) => c.id)).toEqual(['kq-3-5-9']);
  });

  it('asks for the full text of a possibly truncated quote and stores it', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const blob = bookmarkBlob([quote(5, 9, LONG.slice(0, 63)), quote(20, 22, 'short')]);
    const res = await app.request('/syncs/bookmarks', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, bookmarks: blob }),
    });
    expect(((await res.json()) as Record<string, unknown>).need_text).toEqual([[3, 5, 9]]);

    const full = `${LONG} wisdom, it was the age of foolishness`;
    const text = await app.request('/syncs/bookmarks/text', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, items: [{ s: 3, sw: 5, ew: 9, text: full }] }),
    });
    expect(((await text.json()) as Record<string, unknown>).accepted).toBe(1);

    const again = await app.request('/syncs/bookmarks', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, bookmarks: blob }),
    });
    expect(((await again.json()) as Record<string, unknown>).need_text).toBeUndefined();
    const clips = (await (await app.request('/api/v1/clippings', { headers })).json()) as {
      items: { id: string; text: string }[];
    };
    expect(clips.items.find((c) => c.id === 'kq-3-5-9')?.text).toBe(full);
  });

  it('projects the global stats blob into the summary', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const h = historyBlob(9700, { 0: 3, 1: 1, 2: 2, 5: 1 });
    const res = await app.request('/syncs/stats', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: 'crosspoint_global_stats',
        device_id: 'crosspoint-aaa',
        stats: JSON.stringify({ s: 7200, lr: 9700, lh: 8, lm: 30, h }),
      }),
    });
    expect(res.status).toBe(200);
    const summary = (await (await app.request('/api/v1/stats/summary', { headers })).json()) as Record<string, unknown>;
    expect(summary.seconds).toBe(7200);
    expect(summary.anchor_day).toBe(9700);
    expect(summary.streak).toBe(3);
  });

  it('converts the 2-bit heatmap to the 1-bit calendar', () => {
    const { anchorDay, bits } = historyFromBlob(Buffer.from(historyBlob(9000, { 0: 1, 9: 3, 729: 2 }), 'base64'));
    expect(anchorDay).toBe(9000);
    expect(bits[0]).toBe(1);
    expect(bits[1]).toBe(1 << 1);
    expect(bits[91] & (1 << 1)).toBeTruthy();
    expect(historyFromBlob(null).anchorDay).toBe(0);
  });

  it('returns the rich position only while it matches the stored percentage', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const position = { pctQ: 250000, spine: 3, page: 4, pages: 20, para: 12, xpath: '/body/DocFragment[4]/body/p[12]' };
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: position.xpath, percentage: 0.25, device: 'CrossPoint', device_id: 'cp-1', position }),
    });
    let got = (await (await app.request(`/syncs/progress/${DOC}`, { headers })).json()) as Record<string, unknown>;
    expect(got.position).toEqual(position);

    // Same device, no position this time: the old one must not come back.
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[5]', percentage: 0.4, device: 'CrossPoint', device_id: 'cp-1' }),
    });
    got = (await (await app.request(`/syncs/progress/${DOC}`, { headers })).json()) as Record<string, unknown>;
    expect(got.position).toBeUndefined();
    expect(got.percentage).toBe(0.4);
  });

  it('asks for metadata until the document has a title or filename', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = (metadata?: Record<string, string>) =>
      app.request('/syncs/progress', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document: DOC, progress: '/body/p[1]', percentage: 0.3, device: 'CrossPoint', device_id: 'cp-1', metadata }),
      });
    const get = async (offer = true) =>
      (await (
        await app.request(`/syncs/progress/${DOC}`, { headers: offer ? { ...headers, 'x-crosspoint-metadata': '1' } : headers })
      ).json()) as Record<string, unknown>;

    await put();
    expect((await get(false)).metadata_wanted).toBeUndefined();
    expect((await get()).metadata_wanted).toBe(true);
    await put({ title: 'A Tale of Two Cities', filename: 'tale.epub' });
    expect((await get()).metadata_wanted).toBeUndefined();
  });
});

describe('device copy tag', () => {
  it('shows every copy of a book under one name', () => {
    for (const name of ['(X3) Dune - Herbert.epub', '(x4) Dune - Herbert.epub', 'Dune - Herbert (X4).epub', 'Dune - Herbert.epub']) {
      expect(stripDeviceTag(name)).toBe('Dune - Herbert.epub');
    }
    expect(stripDeviceTag('Herbert - (X4) Dune.epub')).toBe('Herbert - Dune.epub');
    expect(stripDeviceTag('(X3) Dune')).toBe('Dune');
    expect(stripDeviceTag('Dune (x3)')).toBe('Dune');
    expect(stripDeviceTag('Vol. 2 (X4)')).toBe('Vol. 2');
    expect(stripDeviceTag('(X5) Dune')).toBe('(X5) Dune');
    expect(stripDeviceTag('(X4)')).toBe('(X4)');
  });

  it('strips the single optimized copy tag "(x)"', () => {
    for (const name of ['(x) Dune - Herbert.epub', '(X) Dune - Herbert.epub', 'Dune - Herbert (x).epub']) {
      expect(stripDeviceTag(name)).toBe('Dune - Herbert.epub');
    }
    expect(stripDeviceTag('Herbert - (x) Dune.epub')).toBe('Herbert - Dune.epub');
    expect(stripDeviceTag('(x)tra Dune')).toBe('(x)tra Dune');
    expect(stripDeviceTag('(y) Dune')).toBe('(y) Dune');
    expect(stripDeviceTag('(x)')).toBe('(x)');
  });

  it('stores the name without the tag and cleans names already stored', async () => {
    const { migrate } = await import('../src/db/db.js');
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC, progress: '/body/p[1]', percentage: 0.3, device: 'CrossPoint', device_id: 'cp-1',
        metadata: { title: '(X4) Dune', filename: '(x4) Dune - Herbert.epub' },
      }),
    });
    const row = () => db.prepare('SELECT title, filename FROM documents WHERE document = ?').get(DOC);
    expect(row()).toEqual({ title: 'Dune', filename: 'Dune - Herbert.epub' });

    db.prepare('UPDATE documents SET title = ?, filename = ? WHERE document = ?').run('Dune (X3)', 'Dune - Herbert (X3).epub', DOC);
    db.prepare("DELETE FROM migrations WHERE name LIKE '9002%'").run();
    migrate(db);
    expect(row()).toEqual({ title: 'Dune', filename: 'Dune - Herbert.epub' });

    const cases: [string, string, string, string][] = [
      ['(x) Dune', '(x) Dune - Herbert.epub', 'Dune', 'Dune - Herbert.epub'],
      ['Dune (x)', 'Dune - Herbert (x).epub', 'Dune', 'Dune - Herbert.epub'],
      ['Herbert - (X) Dune', 'Herbert - (x) Dune.pdf', 'Herbert - Dune', 'Herbert - Dune.pdf'],
      ['(x)tra', 'Dune (x).fb2.zip', '(x)tra', 'Dune (x).fb2.zip'],
    ];
    for (const [title, filename, wantTitle, wantFilename] of cases) {
      db.prepare('UPDATE documents SET title = ?, filename = ? WHERE document = ?').run(title, filename, DOC);
      db.prepare("DELETE FROM migrations WHERE name LIKE '9003%'").run();
      migrate(db);
      expect(row()).toEqual({ title: wantTitle, filename: wantFilename });
    }
  });
});

describe('koreader-sync-server Redis import', () => {
  it('imports accounts, progress, bookmarks and stats once', async () => {
    const { importFromRedis } = await import('../src/compat/import.js');
    const { md5 } = await import('./helpers.js');
    const { app, db } = makeTestApp();
    const key = md5('pw');
    const strings: Record<string, string> = { 'user:Reader:key': key };
    const hashes: Record<string, Record<string, string>> = {
      [`user:Reader:document:${DOC}`]: {
        percentage: '0.5', progress: '/body/p[3]', device: 'CrossPoint', device_id: 'cp-1', timestamp: '1700000000',
      },
      [`user:Reader:bookmarks:${DOC}`]: { bookmarks: bookmarkBlob([quote(1, 2)]), timestamp: '1700000001' },
      [`user:Reader:stats:${DOC}`]: { 'cp-1': '{"s":120}', timestamp: '1700000002' },
    };
    const all = [...Object.keys(strings), ...Object.keys(hashes)];
    const redis = {
      keys: async (pattern: string) => {
        const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
        return all.filter((k) => re.test(k));
      },
      get: async (k: string) => strings[k] ?? null,
      hgetall: async (k: string) => hashes[k] ?? {},
    };
    const first = await importFromRedis(db, redis);
    expect(first).toMatchObject({ users: 1, progress: 1, bookmarks: 1, stats: 1 });
    const second = await importFromRedis(db, redis);
    expect(second).toMatchObject({ users: 0, progress: 0, bookmarks: 0, stats: 0, skippedOlder: 3 });

    const headers = { 'x-auth-user': 'Reader', 'x-auth-key': key };
    const progress = (await (await app.request(`/syncs/progress/${DOC}`, { headers })).json()) as Record<string, unknown>;
    expect(progress).toMatchObject({ percentage: 0.5, device_id: 'cp-1', timestamp: 1700000000 });
    const clips = (await (await app.request('/api/v1/clippings', { headers })).json()) as { items: unknown[] };
    expect(clips.items).toHaveLength(1);
  });
});
