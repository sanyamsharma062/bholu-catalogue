import { convert } from 'html-to-text';

const sites = {
  careers: [
    'job-boards.greenhouse.io', 'boards.greenhouse.io', 'jobs.lever.co',
    'jobs.ashbyhq.com', 'myworkdayjobs.com', 'jobs.smartrecruiters.com',
  ],
  infosys: ['career.infosys.com', 'digitalcareers.infosys.com'],
  ibm: ['careers.ibm.com'],
  tcs: ['ibegin.tcsapps.com', 'tcs.com/careers/india'],
};

export function webJobInput(input) {
  if (!input || !Object.hasOwn(sites, input.scope) || typeof input.q !== 'string' ||
      input.q.length > 450 || !/^[\p{L}\p{N} +#.“”"()–-]+$/u.test(input.q) ||
      !/\p{L}/u.test(input.q) || ![0, 1, 3, 7, 14, 30].includes(input.days)) {
    throw new Error('Invalid web search');
  }
  return { scope: input.scope, q: input.q.trim().replace(/ +/g, ' '), days: input.days };
}

function postingLink(raw, scope) {
  if (typeof raw !== 'string' || raw.length > 1500) return null;
  const value = URL.parse(raw);
  if (!value || value.protocol !== 'https:' || value.username || value.password || value.port) return null;
  const { hostname: host, pathname: path, searchParams } = value;
  let posting = false;
  if (scope === 'infosys') {
    posting = (host === 'career.infosys.com' && /^\/jobdesc\/?$/i.test(path) &&
      /^[\w-]+$/.test(searchParams.get('jobReferenceCode') ?? '')) ||
      (host === 'digitalcareers.infosys.com' && /\/(?:JobDetail|job)\/[^/]+\/\d+\/?$/i.test(path));
  } else if (scope === 'ibm') {
    posting = host === 'careers.ibm.com' && /\/careers\/JobDetail\/[^/]+(?:\/[^/]+)?\/?$/i.test(path);
  } else if (scope === 'tcs') {
    posting = (host === 'ibegin.tcsapps.com' && /^\/candidate\/next\/[a-z-]+\/jobs\/\d+J\/?$/i.test(path)) ||
      ((host === 'www.tcs.com' || host === 'tcs.com') &&
      /^\/careers\/india\/tcs-[a-z0-9-]+-hiring\/?$/i.test(path));
  } else if (host === 'job-boards.greenhouse.io' || host === 'boards.greenhouse.io') {
    posting = /^\/[^/]+\/jobs\/\d+\/?$/i.test(path);
  } else if (host === 'jobs.lever.co' || host === 'jobs.ashbyhq.com') {
    posting = /^\/[^/]+\/[a-f0-9]{8}(?:-[a-f0-9]+){4}(?:\/application|\/apply)?\/?$/i.test(path);
  } else if (host.endsWith('.myworkdayjobs.com')) {
    posting = /\/job\/[^/]+\/[^/]+/i.test(path);
  } else if (host === 'jobs.smartrecruiters.com') {
    posting = /^\/[^/]+\/\d+/i.test(path);
  }
  if (!posting) return null;
  value.hash = '';
  for (const key of [...searchParams.keys()]) if (/^utm_|^(gclid|fbclid)$/i.test(key)) searchParams.delete(key);
  return value.href;
}

export function createWebJobSearch({ key, maximum = 30, fetcher = fetch }) {
  const cache = new Map();
  let day = '', used = 0;
  return async ({ scope, q, days }) => {
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    if (day !== today) {
      day = today;
      used = 0;
    }
    const cacheKey = JSON.stringify([scope, q.toLowerCase(), days]);
    const previous = cache.get(cacheKey);
    if (previous?.expires > now) return previous.result;
    for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
    if (used >= maximum) throw new Error('Daily search limit reached');
    used++;
    const result = (async () => {
      const hostQuery = sites[scope].map(site => `site:${site}`).join(' OR ');
      const endpoint = new URL('https://serpapi.com/search.json');
      endpoint.search = new URLSearchParams({
        engine: 'google', q: `${q} (${hostQuery})`, gl: 'in', hl: 'en', api_key: key,
        ...(days ? { tbs: `qdr:${({ 1: 'd', 7: 'w', 30: 'm' })[days] ?? `d${days}`}` } : {}),
      });
      const response = await fetcher(endpoint, { redirect: 'error', signal: AbortSignal.timeout(9500) });
      if (!response.ok) throw new Error('Search provider unavailable');
      const data = await response.json();
      if (data.error || data.search_metadata?.status !== 'Success') throw new Error('Search provider unavailable');
      const matches = new Map();
      for (const row of (data.organic_results ?? []).slice(0, 30)) {
        const link = postingLink(row.link, scope);
        if (!link || typeof row.title !== 'string' || !row.title.trim()) continue;
        const title = convert(row.title.slice(0, 400));
        const snippet = typeof row.snippet === 'string' ? convert(row.snippet.slice(0, 800)) : '';
        if (/\b(?:no longer available|registration status:\s*closed|job has expired)\b/i.test(`${title} ${snippet}`)) continue;
        matches.set(link, { link, title, snippet });
      }
      return [...matches.values()];
    })();
    cache.set(cacheKey, { expires: now + 15 * 60000, result });
    try {
      return await result;
    } catch (error) {
      cache.delete(cacheKey);
      throw error;
    }
  };
}
