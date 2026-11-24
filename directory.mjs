import { boardsFrom } from './feeds.mjs';

const directory = 'https://raw.githubusercontent.com/ConorsCode/open-jobs-data/main/companies.json';
const workdayDirectory = 'https://raw.githubusercontent.com/Riley-Dorrington/job-board-aggregator/main/data/workday_companies.json';
const supported = new Set(['greenhouse', 'ashby', 'lever', 'workable', 'recruitee', 'bamboohr', 'smartrecruiters']);
const workdayNames = {
  aliaxis: 'Aliaxis', alliancedata: 'Bread Financial', armaninollp: 'Armanino',
  availity: 'Availity', bdx: 'BD', cengage: 'Cengage', corrohealth: 'CorroHealth',
  fastretailing: 'Fast Retailing', mywdhr: 'Hudson’s Bay', phreesia: 'Phreesia',
  roberthalf: 'Protiviti', soti: 'SOTI', svb: 'First Citizens',
};

async function readDirectory(url, maximum, fetcher) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Employer directory unavailable');
  const data = await response.json();
  if (!Array.isArray(data) || data.length > maximum) throw new Error('Invalid employer directory');
  return data;
}

async function publicBoards(fetcher) {
  const data = await readDirectory(directory, 4000, fetcher);
  return data.filter(row => row && supported.has(row.platform) &&
    typeof row.name === 'string' && row.name.trim() && row.name.length <= 180 &&
    typeof row.slug === 'string' && /^[a-z0-9_-]{1,80}$/i.test(row.slug))
    .map(row => [row.platform, row.slug, row.name]);
}

async function indiaWorkdayBoards(fetcher) {
  const data = await readDirectory(workdayDirectory, 25000, fetcher);
  return data.flatMap(row => {
    const match = typeof row === 'string' && /^([a-z0-9-]{1,60})\|(wd\d{1,3})\|([a-z0-9_-]{1,100})$/i.exec(row);
    if (!match) return [];
    const [, tenant, location, site] = match;
    const employer = Object.hasOwn(workdayNames, tenant) ? workdayNames[tenant] : null;
    if (!employer || !/india/i.test(site)) return [];
    return [['workday', `https://${tenant}.${location}.myworkdayjobs.com/${site}`, employer]];
  });
}

export async function discoverBoards(pool, builtIn, fetcher = fetch) {
  const results = await Promise.allSettled([publicBoards(fetcher), indiaWorkdayBoards(fetcher)]);
  if (results.every(result => result.status === 'rejected')) {
    throw new Error('Employer directories unavailable');
  }
  const seen = new Set(builtIn.map(board => board.id));
  const candidates = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const row of result.value) {
      const [board] = boardsFrom([row]);
      if (!seen.has(board.id) && !candidates.has(board.id)) candidates.set(board.id, board);
    }
  }
  if (!candidates.size) return [];

  const { rows } = await pool.query(
    'SELECT id, checked_at, live_india FROM catalog_feeds WHERE id = ANY($1::text[])',
    [[...candidates.keys()]],
  );
  const status = new Map(rows.map(row => [row.id, row]));
  const lastCheck = board => status.get(board.id)?.checked_at?.valueOf() ?? 0;
  const ordered = [...candidates.values()].sort((a, b) => lastCheck(a) - lastCheck(b));
  const active = ordered.filter(board => status.get(board.id)?.live_india).slice(0, 48);
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const byProvider = new Map();
  for (const board of ordered) {
    if (status.get(board.id)?.live_india || lastCheck(board) >= cutoff) continue;
    const queue = byProvider.get(board.provider) ?? [];
    if (queue.length < 6) queue.push(board);
    byProvider.set(board.provider, queue);
  }
  const due = [];
  for (let round = 0; round < 6 && due.length < 24; round++) {
    for (const queue of byProvider.values()) {
      if (queue[round]) due.push(queue[round]);
      if (due.length >= 24) break;
    }
  }
  return [...active, ...due].map(board => ({ ...board, discovered: true }));
}
