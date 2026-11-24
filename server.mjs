import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { database, migrate, coverage, search, sourceHealth } from './database.mjs';
import { configuredGlassdoor, glassdoorFeed } from './feeds.mjs';
import { createWebJobSearch, webJobInput } from './web-jobs.mjs';

function queryTerms(values, maximum) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.slice(0, maximum).filter(value => typeof value === 'string')
    .map(value => value.toLowerCase().replace(/[^a-z0-9+#. -]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80))
    .filter(value => /[a-z0-9]/.test(value)))];
}

export function searchInput(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected search parameters');
  const roles = queryTerms(input.roles, 8);
  const roleAliases = roles.flatMap(role =>
    /\b(java|spring)\b/.test(role) ? ['java', 'backend engineer', 'backend developer'] :
    /\b(backend|back.end)\b/.test(role) ? ['backend engineer', 'back end developer', 'server side engineer'] :
    /\b(frontend|front.end|react|angular)\b/.test(role) ? ['frontend engineer', 'front end developer'] :
    /\b(software|full.stack|sde)\b/.test(role) ? ['software engineer', 'software developer'] : []);
  const experience = ['Fresher', '0–2 years', '3–5 years', '6+ years'].includes(input.experience)
    ? input.experience : '';
  const experienceRanges = { Fresher: [0, 0], '0–2 years': [0, 2], '3–5 years': [3, 5], '6+ years': [6, null] };
  const [minimum, maximum] = experienceRanges[experience] ?? [null,
    Number.isInteger(input.maxExperience) && input.maxExperience >= 0 && input.maxExperience <= 40 ? input.maxExperience : null];
  return {
    terms: [...new Set([...roles, ...queryTerms(input.skills, 12), ...roleAliases])],
    roles,
    cities: queryTerms(input.cities, 12).map(city => city.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean),
    days: [0, 1, 3, 7, 14, 30].includes(input.days) ? input.days : 7,
    minExperience: minimum,
    maxExperience: maximum,
    includeUnknownExperience: input.includeUnknownExperience !== false,
    company: typeof input.company === 'string' ? input.company.trim().slice(0, 120) : '',
    workplace: ['Remote', 'Hybrid', 'Onsite'].includes(input.workplace) ? input.workplace : '',
    kind: ['Internship', 'Full-time', 'Part-time', 'Contract', 'Hiring drive'].includes(input.kind) ? input.kind : '',
    remote: input.remote === true,
    senior: input.senior === true || experience === '6+ years' || experience === '3–5 years',
    internships: input.internships === true,
    bestMatch: input.sort === 'match',
    limit: Number.isInteger(input.limit) ? Math.min(100, Math.max(1, input.limit)) : 30,
    offset: Number.isInteger(input.offset) ? Math.min(10000, Math.max(0, input.offset)) : 0,
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32768) throw new Error('Request exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

export function catalogServer(pool, { licensed = false, glassdoor = false, webSearch } = {}) {
  const hiddenFeeds = [];
  if (!licensed) hiddenFeeds.push('licensed:freehire');
  if (!glassdoor) hiddenFeeds.push(glassdoorFeed.id);
  return createServer({ requestTimeout: 18000, headersTimeout: 8000 }, async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        const status = await coverage(pool, hiddenFeeds);
        return send(response, status.usable ? 200 : 503, status);
      }
      if (request.method === 'GET' && request.url === '/v1/sources') {
        return send(response, 200, { sources: await sourceHealth(pool, hiddenFeeds) });
      }
      if (request.method === 'POST' && request.url === '/v1/job-search') {
        let query;
        try { query = searchInput(await readBody(request)); }
        catch { return send(response, 400, { error: 'Invalid search request' }); }
        const result = await search(pool, query, hiddenFeeds);
        if (!result.coverage.usable) return send(response, 503, { error: 'Catalogue is not ready' });
        const next = query.offset + result.jobs.length;
        return send(response, 200, { ...result, nextOffset: result.jobs.length && next < result.total ? next : null });
      }
      if (request.method === 'POST' && request.url === '/v1/web-job-search' && webSearch) {
        let query;
        try { query = webJobInput(await readBody(request)); }
        catch { return send(response, 400, { error: 'Invalid web search' }); }
        return send(response, 200, { results: await webSearch(query) });
      }
      if (request.method === 'GET' && request.url.startsWith('/v1/jobs/')) {
        let id;
        try { id = decodeURIComponent(request.url.slice('/v1/jobs/'.length)); } catch { id = ''; }
        if (!id || id.length > 1000) return send(response, 400, { error: 'Invalid posting ID' });
        const { rows: [row] } = await pool.query(`SELECT job FROM catalog_postings WHERE canonical_id=$1
          AND feed_id <> ALL($2::text[]) AND observed_at >= now() - interval '36 hours'
          AND (valid_through IS NULL OR valid_through >= now())
          ORDER BY (posted_at IS NULL), (feed_id LIKE 'licensed:%'), observed_at DESC LIMIT 1`, [id, hiddenFeeds]);
        return row ? send(response, 200, row.job) : send(response, 404, { error: 'Posting unavailable' });
      }
      send(response, 404, { error: 'Unknown endpoint' });
    } catch {
      send(response, 503, { error: 'Catalogue unavailable' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = database();
  await migrate(pool);
  const licensed = process.env.FREEHIRE_LICENSED === 'true' && Boolean(process.env.FREEHIRE_API_KEY);
  const searchKey = process.env.SERPAPI_KEY;
  const webSearch = searchKey ? createWebJobSearch({ key: searchKey,
    maximum: Math.min(500, Math.max(1, Number(process.env.WEB_SEARCH_DAILY_LIMIT) || 30)) }) : undefined;
  const server = catalogServer(pool, { licensed, glassdoor: Boolean(configuredGlassdoor()), webSearch });
  server.listen(Number(process.env.PORT) || 8788, process.env.HOST || '127.0.0.1');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => pool.end()));
}
