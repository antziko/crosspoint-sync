/**
 * CLI: node dist/compat/import-redis.js [--redis host:port] [--redis-db N] [--db path] [--dry-run]
 * Without --redis-db, the first Redis database holding users is used; koreader-sync-server
 * keeps its production data in database 1.
 * Imports a koreader-sync-server Redis database (see ./import.ts).
 */
import { migrate, openDatabase } from '../db/db.js';
import { importFromRedis, RespClient } from './import.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function pickRedisDb(redis: RespClient, wanted: string): Promise<number> {
  if (wanted) {
    await redis.select(Number(wanted));
    return Number(wanted);
  }
  for (const index of [1, 0, 2, 3, 4]) {
    await redis.select(index);
    if ((await redis.keys('user:*:key')).length > 0) return index;
  }
  await redis.select(0);
  return 0;
}

const [host, portText] = arg('--redis', '127.0.0.1:6379').split(':');
const dbPath = arg('--db', process.env.DATABASE_PATH ?? '/data/crosspoint.db');
const dryRun = process.argv.includes('--dry-run');

const db = openDatabase(dbPath);
migrate(db);
const redis = await RespClient.connect(host, Number(portText ?? 6379));
try {
  const redisDb = await pickRedisDb(redis, arg('--redis-db', ''));
  const report = await importFromRedis(db, redis, dryRun);
  console.log(
    JSON.stringify({ msg: dryRun ? 'dry run, nothing written' : 'import done', db: dbPath, redisDb, ...report }, null, 2),
  );
} finally {
  redis.close();
  db.close();
}
