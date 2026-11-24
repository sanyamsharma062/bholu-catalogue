import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { database, coverage } from './database.mjs';
import { boardsFrom, glassdoorFeed, indiaLocation } from './feeds.mjs';

const maxChunkBytes = 2 * 1024 * 1024;
const maxChunks = 32;
const hidden = ['licensed:freehire', glassdoorFeed.id];
const boards = boardsFrom(JSON.parse(await readFile(new URL('./boards.json', import.meta.url), 'utf8')));
const output = process.argv[2] ?? 'public';
const pool = database();

try {
  const status = await coverage(pool, hidden);
  if (!status.usable || !status.indexedAt) throw new Error('No usable feeds to publish');
  const { rows } = await pool.query(`SELECT DISTINCT ON (canonical_id) job, observed_at
    FROM catalog_postings
    WHERE feed_id NOT LIKE 'licensed:%'
      AND observed_at >= now() - interval '36 hours'
      AND coalesce(valid_through, 'infinity') >= now()
      AND coalesce(posted_at, '-infinity') <= now()
      AND job->>'location' ~* $1
    ORDER BY canonical_id, (posted_at IS NULL), observed_at DESC`,
  [indiaLocation.source.replaceAll('\\b', '\\y').replace('(?:india|', '(?:india|ncr|blr|')]);
  if (!rows.length) throw new Error('No open India listings to publish');

  const shards = [];
  let lines = [];
  let size = 2;
  async function flush() {
    if (!lines.length) return;
    const body = `[${lines.join(',')}]`;
    const hash = createHash('sha256').update(body).digest('hex');
    const shard = `shards/${hash}.json`;
    const file = join(output, 'v1', 'public-catalogue', shard);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body);
    shards.push(shard);
    lines = [];
    size = 2;
  }
  for (const { job, observed_at: checkedAt } of rows) {
    const line = JSON.stringify({ ...job, checkedAt });
    const bytes = Buffer.byteLength(line) + 1;
    if (size + bytes > maxChunkBytes) await flush();
    if (bytes + 2 > maxChunkBytes) throw new Error('Listing exceeds shard size limit');
    lines.push(line);
    size += bytes;
  }
  await flush();
  if (shards.length > maxChunks) throw new Error('Catalogue exceeds Android download limit');

  const { rows: [{ refreshed }] } = await pool.query(`SELECT count(*)::int AS refreshed FROM catalog_feeds
    WHERE id = ANY($1::text[]) AND succeeded_at >= now() - interval '36 hours'`,
  [boards.map(board => board.id)]);
  if (!refreshed) throw new Error('No configured employer feeds are usable');

  const manifest = {
    version: 1, scope: 'india', ...status, shards, jobs: rows.length,
  };
  await writeFile(join(output, 'v1', 'public-catalogue', 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(output, '_headers'),
    '/v1/public-catalogue/manifest.json\n  Cache-Control: no-store\n' +
    '/v1/public-catalogue/shards/*\n  Cache-Control: public, max-age=31536000, immutable\n');
  console.log(`Exported ${rows.length} India listings from ${status.usable} usable feeds in ${shards.length} files.`);
} finally {
  await pool.end();
}
