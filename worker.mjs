import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { database, migrate, replaceFeed, recordFailure } from './database.mjs';
import { boardsFrom, configuredGlassdoor, fetchBoard, fetchGlassdoor, fetchLicensed, glassdoorFeed, indiaLocation } from './feeds.mjs';
import { discoverBoards } from './directory.mjs';

const pool = database();
const boards = boardsFrom(JSON.parse(await readFile(process.env.BHOLU_BOARDS_FILE ?? new URL('./boards.json', import.meta.url), 'utf8')));
const key = process.env.FREEHIRE_API_KEY;
const licensed = process.env.FREEHIRE_LICENSED === 'true' && Boolean(key);
const builtInFeeds = boards.map(board => [board, () => fetchBoard(board)]);
if (licensed) builtInFeeds.push([{ id: 'licensed:freehire', employer: 'Licensed job index' }, () => fetchLicensed(key)]);
const glassdoor = configuredGlassdoor();
if (glassdoor) builtInFeeds.push([glassdoorFeed, () => fetchGlassdoor(glassdoor)]);

async function refresh() {
  const lock = await pool.connect();
  try {
    const { rows: [{ acquired }] } = await lock.query("SELECT pg_try_advisory_lock(hashtext('bholu.catalog.refresh')) AS acquired");
    if (!acquired) return;
    const feeds = [...builtInFeeds];
    if (!process.env.BHOLU_BOARDS_FILE && process.env.DISCOVER_EMPLOYERS !== 'false') {
      try {
        const discovered = await discoverBoards(pool, boards);
        feeds.push(...discovered.map(board => [board, async () => {
          const result = await fetchBoard(board);
          return { ...result, jobs: result.jobs.filter(job => indiaLocation.test(job.location)) };
        }]));
      } catch {
        console.warn('Employer directory unavailable. Refreshing configured boards.');
      }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, feeds.length) }, async () => {
      while (next < feeds.length) {
        const [feed, fetchJobs] = feeds[next++];
        try {
          const { jobs, complete } = await fetchJobs();
          await replaceFeed(pool, feed, jobs, { complete });
          console.log(`${feed.id}: ${jobs.length} postings${complete ? '' : ' (partial)'}`);
        } catch (error) {
          const failure = /^HTTP \d{3}$/.test(error.message) ? error.message : error.name === 'TimeoutError' ? 'Timed out' : 'Feed unavailable';
          await recordFailure(pool, feed, failure);
          console.warn(`${feed.id}: ${failure}`);
        }
      }
    }));
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('bholu.catalog.refresh'))");
    lock.release();
  }
}

try {
  await migrate(pool);
  if (process.argv.includes('--watch')) {
    const abort = new AbortController();
    process.once('SIGTERM', () => abort.abort());
    process.once('SIGINT', () => abort.abort());
    const minutes = Math.max(15, Number(process.env.REFRESH_MINUTES) || 60);
    while (!abort.signal.aborted) {
      try { await refresh(); } catch { console.error('Catalogue refresh failed'); }
      await sleep(minutes * 60000, undefined, { signal: abort.signal }).catch(() => {});
    }
  } else {
    await refresh();
  }
} finally {
  await pool.end();
}
