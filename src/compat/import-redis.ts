/**
 * CLI: node dist/compat/import-redis.js [--redis host:port] [--db path] [--dry-run]
 * Imports a koreader-sync-server Redis database (see ./import.ts).
 */
import { migrate, openDatabase } from '../db/db.js';
import { importFromRedis, RespClient } from './import.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const [host, portText] = arg('--redis', '127.0.0.1:6379').split(':');
const dbPath = arg('--db', process.env.DATABASE_PATH ?? '/data/crosspoint.db');
const dryRun = process.argv.includes('--dry-run');

const db = openDatabase(dbPath);
migrate(db);
const redis = await RespClient.connect(host, Number(portText ?? 6379));
try {
  const report = await importFromRedis(db, redis, dryRun);
  console.log(JSON.stringify({ msg: dryRun ? 'dry run, nothing written' : 'import done', db: dbPath, ...report }, null, 2));
} finally {
  redis.close();
  db.close();
}
