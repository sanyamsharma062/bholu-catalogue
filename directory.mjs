import { boardsFrom } from './feeds.mjs';

const directory = 'https://raw.githubusercontent.com/ConorsCode/open-jobs-data/main/companies.json';

export async function discoverBoards(pool, builtIn, fetcher = fetch) {
  const response = await fetcher(directory, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Employer directory unavailable');
  const data = await response.json();
  if (!Array.isArray(data) || data.length > 4000) throw new Error('Invalid employer directory');
  const candidates = new Map();
  const seen = new Set(builtIn.map(board => board.id));
  for (const row of data) {
    if (!row || typeof row.name !== 'string' || row.name.length > 180) continue;
    if (!['greenhouse', 'ashby', 'lever', 'workable', 'recruitee', 'bamboohr', 'smartrecruiters'].includes(row.platform)) continue;
    if (typeof row.slug !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(row.slug)) continue;
    const [board] = boardsFrom([[row.platform, row.slug, row.name]]);
    if (!seen.has(board.id)) candidates.set(board.id, board);
  }

  const { rows } = await pool.query(
    `SELECT id, checked_at, live_india FROM catalog_feeds WHERE id = ANY($1::text[])`,
    [[...candidates.keys()]],
  );
  const status = new Map(rows.map(row => [row.id, row]));
  const ordered = [...candidates.values()].sort((a, b) =>
    (status.get(a.id)?.checked_at?.valueOf() ?? 0) - (status.get(b.id)?.checked_at?.valueOf() ?? 0));
  const active = ordered.filter(board => status.get(board.id)?.live_india).slice(0, 24);
  const due = ordered.filter(board => !status.get(board.id)?.live_india &&
    (status.get(board.id)?.checked_at?.valueOf() ?? 0) < Date.now() - 24 * 60 * 60 * 1000).slice(0, 12);
  return [...active, ...due].map(board => ({ ...board, discovered: true }));
}
