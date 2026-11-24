import { boardsFrom } from './feeds.mjs';

const directory = 'https://raw.githubusercontent.com/ConorsCode/open-jobs-data/main/companies.json';
const directoryRoot = 'https://raw.githubusercontent.com/Riley-Dorrington/job-board-aggregator/main/data/';
const sweepProviders = ['greenhouse', 'lever', 'ashby', 'bamboohr', 'icims'];
const indiaHint = /(?:^|[^a-z])(?:india|bengaluru|bangalore|pune|hyderabad|mumbai|delhi|chennai|kolkata|noida|gurgaon|gurugram|kochi|ahmedabad)(?:$|[^a-z])/i;
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

async function workdayBoards(fetcher) {
  const data = await readDirectory(`${directoryRoot}workday_companies.json`, 25000, fetcher);
  return data.flatMap(row => {
    const match = typeof row === 'string' && /^([a-z0-9-]{1,60})\|(wd\d{1,3})\|([a-z0-9_-]{1,100})$/i.exec(row);
    if (!match) return [];
    const [, tenant, location, site] = match;
    const employer = Object.hasOwn(workdayNames, tenant) ? workdayNames[tenant] : boardName(tenant);
    return [['workday', `https://${tenant}.${location}.myworkdayjobs.com/${site}`, employer, !/india/i.test(site)]];
  });
}

function boardName(token) {
  const name = token.replace(/^careers?-/, '').replace(/[-_]+/g, ' ').trim() || token;
  return name[0].toUpperCase() + name.slice(1);
}

async function sweepBoards(provider, fetcher) {
  const data = await readDirectory(`${directoryRoot}${provider}_companies.json`, 25000, fetcher);
  return data.flatMap(token => {
    if (typeof token !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(token)) return [];
    return [[provider, token, boardName(token), true]];
  });
}

async function paylocityBoards(fetcher) {
  const data = await readDirectory(`${directoryRoot}paylocity_companies_clean.json`, 25000, fetcher);
  return data.flatMap(row => /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(row?.guid) &&
    typeof row.name === 'string' && row.name.trim() && row.name.length <= 180
    ? [['paylocity', row.guid, row.name, true]] : []);
}

async function joinBoards(fetcher) {
  const response = await fetcher('https://join.com/companies/sitemap.xml', {
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok || !response.body) throw new Error('JOIN directory unavailable');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 3 * 1024 * 1024) throw new Error('JOIN directory exceeds size limit');
    chunks.push(chunk);
  }
  return Array.from(Buffer.concat(chunks).toString('utf8')
    .matchAll(/<loc>https:\/\/join\.com\/companies\/([a-z0-9][a-z0-9_-]{0,79})<\/loc>/gi),
  ([, token]) => ['join', token, boardName(token), true]);
}

export async function discoverBoards(pool, builtIn, fetcher = fetch) {
  const results = await Promise.allSettled([
    publicBoards(fetcher),
    workdayBoards(fetcher),
    ...sweepProviders.map(provider => sweepBoards(provider, fetcher)),
    paylocityBoards(fetcher),
    joinBoards(fetcher),
  ]);
  if (results.every(result => result.status === 'rejected')) {
    throw new Error('Employer directories unavailable');
  }
  const seen = new Set(builtIn.map(board => board.id));
  const candidates = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const row of result.value) {
      const [board] = boardsFrom([row]);
      if (!seen.has(board.id) && !candidates.has(board.id)) {
        candidates.set(board.id, { ...board, discovered: true, fromSweep: row[3] === true });
      }
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
  const due = ordered.filter(board => !status.get(board.id)?.live_india && lastCheck(board) < cutoff);
  return [
    ...active,
    ...rotate(due.filter(board => !board.fromSweep), 24, 6),
    ...rotate(due.filter(board => board.fromSweep), 48, 6, true),
  ];
}

function rotate(boards, limit, rounds, prioritizeIndia = false) {
  const byProvider = new Map();
  for (const board of boards) {
    const queue = byProvider.get(board.provider) ?? { general: [], hinted: [] };
    const hinted = prioritizeIndia && (indiaHint.test(board.employer) || indiaHint.test(board.token));
    const lane = hinted ? queue.hinted : queue.general;
    if (lane.length < rounds) lane.push(board);
    byProvider.set(board.provider, queue);
  }
  const queues = [...byProvider.values()].map(({ general, hinted }) =>
    [...hinted.slice(0, 2), ...general, ...hinted.slice(2)]);
  const selected = [];
  for (let round = 0; round < rounds && selected.length < limit; round++) {
    for (const queue of queues) {
      if (queue[round]) selected.push(queue[round]);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}
