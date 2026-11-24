import { convert } from 'html-to-text';
import { connect } from 'node:http2';
import { Readable } from 'node:stream';
import { DomUtils, parseDocument } from 'htmlparser2';

const providers = {
  greenhouse: 'Greenhouse', ashby: 'Ashby', lever: 'Lever',
  smartrecruiters: 'SmartRecruiters', workday: 'Workday',
  workable: 'Workable', recruitee: 'Recruitee', bamboohr: 'BambooHR',
  honeywell: 'Honeywell', amazon: 'Amazon Jobs',
  icims: 'iCIMS', speedrun: 'a16z Speedrun',
};
const workdaySite = /^https:\/\/([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com\/[a-z0-9_-]+$/i;
export const indiaLocation = /\b(?:india|bengaluru|bangalore|pune|hyderabad|mumbai|delhi|chennai|kolkata|noida|gurgaon|gurugram|kochi|ahmedabad|bhubaneswar|vadodara|coimbatore)\b/i;

export function boardsFrom(rows) {
  if (!Array.isArray(rows)) throw new Error('Expected an array of employer boards');
  const boards = rows.map(([provider, token, employer]) => {
    const validToken = typeof token === 'string' && (provider === 'workday'
      ? workdaySite.test(token) : /^[a-zA-Z0-9_-]{1,80}$/.test(token));
    if (!Object.hasOwn(providers, provider) || !validToken ||
        typeof employer !== 'string' || !employer.trim()) throw new Error('Invalid employer board');
    return { provider, token, employer, id: `${provider}:${token.toLowerCase()}` };
  });
  if (new Set(boards.map(board => board.id)).size !== boards.length) throw new Error('Duplicate employer board');
  return boards;
}

async function readBody(url, { fetcher, key, payload, timeout = 19000, accept = 'application/json' }) {
  const headers = { Accept: accept, 'User-Agent': 'Bholu Job Catalogue' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (payload) headers['Content-Type'] = 'application/json';
  const response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(timeout),
    ...(payload && { method: 'POST', body: JSON.stringify(payload) }) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('Feed exceeds size limit');
    bytes.push(chunk);
  }
  return Buffer.concat(bytes).toString('utf8');
}

async function readJson(url, options) {
  return JSON.parse(await readBody(url, options));
}

function text(value, limit = 30000) {
  return typeof value === 'string'
    ? convert(value.slice(0, limit * 3), { wordwrap: false, selectors: [
      { selector: 'a', options: { ignoreHref: true } }, { selector: 'img', format: 'skip' },
    ] }).trim().slice(0, limit) : '';
}

function timestamp(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.includes('T'))) return null;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

// Date-only India listings use the earliest possible time on that calendar day.
function indiaDate(value, end = false) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return timestamp(`${value}T${end ? '23:59:59.999' : '00:00:00'}+05:30`);
  }
  return timestamp(value);
}

function cleanUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !url.hostname.includes('.') || url.hostname.endsWith('.local') ||
        url.hostname.endsWith('.localhost') || /^[0-9.]+$/.test(url.hostname)) return null;
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$)/i.test(name)) url.searchParams.delete(name);
    }
    return url;
  } catch {
    return null;
  }
}

function minimumExperience(description) {
  if (/\b(?:no (?:prior |previous )?(?:work )?experience (?:is )?required|freshers (?:are )?(?:welcome|eligible))\b/i.test(description)) return 0;
  const match = /\b(?:minimum(?: of)?|at least)\s*(\d{1,2})\+?\s*years?\b|\b(\d{1,2})(?:\s*(?:[-–—]|to)\s*\d{1,2}|\+)?\s*years?(?:\s+of)?\s+(?:[a-z-]+\s+){0,5}experience\b/i.exec(description);
  return match ? Number(match[1] ?? match[2]) : null;
}

export function jobFrom({ url, title, employer, location, description, posted, expires, kind, workplace, source, years }) {
  const address = cleanUrl(url);
  title = text(title, 240);
  employer = text(employer, 200);
  location = text(location, 400);
  if (!address || !title || !employer || !location) return null;
  description = text(description);
  const greenhouseId = address.searchParams.get('gh_jid') ??
    (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(address.hostname)
      ? /\/jobs\/(\d+)\/?$/.exec(address.pathname)?.[1] : null);
  const workableId = address.hostname === 'apply.workable.com'
    ? /(?:^|\/)j\/([a-z0-9]+)(?:\/|$)/i.exec(address.pathname)?.[1] : null;
  const id = greenhouseId && /^\d+$/.test(greenhouseId)
    ? `greenhouse:${greenhouseId}`
    : workableId ? `workable:${workableId.toLowerCase()}` : address.href;
  return {
    id, title, company: employer, location, description, source, url: address.href,
    posted: timestamp(posted), validThrough: timestamp(expires),
    minimumExperience: Number.isFinite(years) && years >= 0 ? Math.ceil(years) : minimumExperience(description),
    kind: /\bintern(?:ship)?\b/i.test(kind ?? '') ? 'Internship'
      : /\bfull[ -]?time\b/i.test(kind ?? '') ? 'Full-time'
      : /\bpart[ -]?time\b/i.test(kind ?? '') ? 'Part-time'
      : /\bcontract(?:or)?\b/i.test(kind ?? '') ? 'Contract' : '',
    workplace: ['remote', 'hybrid', 'onsite'].includes(workplace?.toLowerCase())
      ? workplace[0].toUpperCase() + workplace.slice(1).toLowerCase() : '',
  };
}

export const glassdoorFeed = { id: 'licensed:glassdoor', employer: 'Glassdoor' };

export function configuredGlassdoor(env = process.env) {
  if (env.GLASSDOOR_LICENSED !== 'true' || !env.GLASSDOOR_FEED_URL || !env.GLASSDOOR_FEED_TOKEN) return null;
  const url = new URL(env.GLASSDOOR_FEED_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('GLASSDOOR_FEED_URL must be an HTTPS endpoint without credentials, query, or fragment');
  }
  return { url, key: env.GLASSDOOR_FEED_TOKEN };
}

export async function fetchGlassdoor({ url, key }, fetcher = fetch) {
  const data = await readJson(url, { fetcher, key });
  if (!Array.isArray(data?.jobs) || data.complete !== true) throw new Error('Expected a complete Glassdoor feed snapshot');
  const jobs = new Map();
  for (const row of data.jobs) {
    if (!row || typeof row !== 'object') throw new Error('Invalid Glassdoor listing');
    if (row.closed === true) continue;
    const job = jobFrom({ url: row.applyUrl, title: row.title, employer: row.company,
      location: row.location, description: row.description, posted: row.postedAt, expires: row.validThrough,
      source: 'Glassdoor', kind: row.employmentType, workplace: row.workplace,
      years: row.minimumExperience });
    if (!job) throw new Error('Invalid Glassdoor listing');
    jobs.set(job.id, job);
  }
  return { jobs: [...jobs.values()], complete: true };
}

export async function fetchBoard(board, fetcher) {
  const { provider, token, employer } = board;
  if (provider === 'workday') {
    if (fetcher) return fetchWorkday(board, fetcher);
    const session = connect(new URL(token).origin, { settings: { enablePush: false } });
    // HTTP/2 stream errors still reject their individual requests.
    session.on('error', () => {});
    try {
      return await fetchWorkday(board, (url, options) => requestWorkday(session, url, options));
    } finally {
      session.destroy();
    }
  }
  fetcher ??= fetch;
  if (provider === 'icims') return fetchIcims(board, fetcher);
  if (provider === 'speedrun') return fetchSpeedrun(fetcher);
  if (provider === 'honeywell' || provider === 'amazon') return fetchIndiaEmployer(board, fetcher);
  if (provider === 'smartrecruiters') return fetchSmartRecruiters(board, fetcher);
  if (['workable', 'recruitee', 'bamboohr'].includes(provider)) return fetchWidgetBoard(board, fetcher);
  let rows;
  let complete = true;
  if (provider === 'greenhouse') {
    const data = await readJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`, { fetcher });
    rows = data.jobs;
    complete = !Number.isInteger(data.meta?.total) || data.meta.total === rows?.length;
  } else if (provider === 'ashby') {
    const data = await readJson(`https://api.ashbyhq.com/posting-api/job-board/${token}`, { fetcher });
    rows = data.jobs;
  } else if (provider === 'lever') {
    rows = [];
    for (let page = 0; page < 10; page++) {
      const batch = await readJson(`https://api.lever.co/v0/postings/${token}?mode=json&limit=100&skip=${page * 100}`, { fetcher });
      if (!Array.isArray(batch)) throw new Error('Invalid Lever response');
      rows.push(...batch);
      if (batch.length < 100) break;
      if (page === 9) complete = false;
    }
  } else {
    throw new Error('Unsupported employer board');
  }
  if (!Array.isArray(rows)) throw new Error('Invalid jobs response');
  const jobs = new Map();
  for (const row of rows) {
    if (!row || row.isListed === false) continue;
    const fields = provider === 'greenhouse' ? {
      url: row.absolute_url, title: row.title, location: row.location?.name,
      description: text(row.content), posted: row.first_published, expires: row.application_deadline,
    } : provider === 'ashby' ? {
      url: row.jobUrl, title: row.title,
      location: [row.location, ...(row.secondaryLocations ?? []).map(item => item.location)].filter(Boolean).join(' / '),
      description: row.descriptionHtml ?? row.descriptionPlain, posted: row.publishedAt,
      kind: row.employmentType, workplace: row.workplaceType,
    } : {
      url: row.hostedUrl, title: row.text,
      location: row.categories?.allLocations?.join(' / ') || row.categories?.location,
      description: [row.descriptionPlain ?? row.description, ...(row.lists ?? []).map(item => item.content)].filter(Boolean).join('\n'),
      posted: row.createdAt, kind: row.categories?.commitment, workplace: row.workplaceType,
    };
    const job = jobFrom({ ...fields, employer, source: providers[provider] });
    if (job) jobs.set(job.id, job);
  }
  if (rows.length && !jobs.size && rows.some(row => row?.isListed !== false)) throw new Error('No usable records in a nonempty feed');
  return { jobs: [...jobs.values()], complete };
}

async function fetchIcims({ token, employer }, fetcher) {
  const host = `${token}.icims.com`;
  const jobs = new Map();
  const classIs = name => node => (node.attribs?.class ?? '').split(/\s+/).includes(name);
  const find = (nodes, predicate) => DomUtils.findOne(predicate, nodes);
  const contents = node => node ? DomUtils.textContent(node).trim() : '';
  let complete = false;
  for (let page = 0; page < 4; page++) {
    const board = new URL(`https://${host}/jobs/search?ss=1&in_iframe=1&pr=${page}`);
    const document = parseDocument(await readBody(board, { fetcher, accept: 'text/html' }));
    const cards = DomUtils.findAll(classIs('iCIMS_JobCardItem'), document.children);
    if (!cards.length) {
      if (page === 0 && !find(document.children, classIs('iCIMS_NoJobs'))) throw new Error('No readable iCIMS board');
      complete = true;
      break;
    }
    for (const card of cards) {
      const anchor = find(card.children, node => node.name === 'a' && classIs('iCIMS_Anchor')(node));
      if (!anchor?.attribs?.href) continue;
      const url = URL.parse(anchor.attribs.href, board);
      if (!url || url.hostname !== host || !/^\/jobs\/\d+\/[^/]+\/job\/?$/.test(url.pathname)) continue;
      url.search = '';
      const hints = DomUtils.findAll(classIs('field-label'), card.children);
      const value = label => {
        const hint = hints.find(node => contents(node) === label);
        return hint ? DomUtils.nextElementSibling(hint) : null;
      };
      const country = contents(value('Location : Country'));
      const place = contents(value('Location : Location'));
      const date = (value('Posted Date')?.attribs?.title ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})\b/);
      const title = contents(find(anchor.children, node => /^h[2-4]$/.test(node.name)));
      const job = jobFrom({ title, employer, url: url.href,
        location: [place, country === 'IN' ? 'India' : country].filter(Boolean).join(', '),
        description: contents(find(card.children, classIs('description'))),
        posted: date && country === 'IN' ? indiaDate(`${date[3]}-${date[2]}-${date[1]}`) : null,
        source: 'iCIMS' });
      if (job) jobs.set(job.id, job);
    }
  }
  return { jobs: [...jobs.values()], complete };
}

async function fetchSpeedrun(fetcher) {
  const candidates = new Map();
  let complete = false;
  for (let page = 0; page < 6; page++) {
    const data = await readJson(`https://speedrun-talent-network.com/api/v1/jobs?page=${page}`, { fetcher });
    if (!Array.isArray(data.jobs)) throw new Error('Invalid Speedrun feed');
    for (const row of data.jobs) {
      if (!row || !indiaLocation.test(row.location ?? '') || row.stealth) continue;
      const destination = cleanUrl(row.url);
      if (destination?.hostname !== 'speedrun-talent-network.com' ||
          !/^\/jobs\/[a-z0-9-]+\/?$/i.test(destination.pathname)) continue;
      if (!/^[a-f\d-]{36}$/i.test(row.id ?? '')) continue;
      candidates.set(row.id, row);
    }
    if (data.has_more === false || !data.jobs.length) {
      complete = true;
      break;
    }
  }
  const jobs = new Map();
  let pending = 20;
  for (const job of await collectDetails([...candidates.values()], async row => {
    const detail = pending-- > 0
      ? await publicDetail(`https://speedrun-talent-network.com/api/v1/jobs/${row.id}`, fetcher) : {};
    if (!detail || (detail.job?.status && detail.job.status !== 'open')) return null;
    const original = detail.job?.apply?.kind === 'external' ? cleanUrl(detail.job.apply.url) : null;
    // Speedrun publishes an index timestamp. Employer posting dates are unknown here.
    return jobFrom({ title: row.title, employer: row.company, location: row.location,
      url: original?.href ?? row.url, kind: row.employment_type, description: detail.job?.description_text,
      workplace: row.workplace_type, source: 'a16z Speedrun' });
  })) if (job) jobs.set(job.id, job);
  return { jobs: [...jobs.values()], complete };
}

async function fetchIndiaEmployer({ provider, employer }, fetcher) {
  const jobs = new Map();
  const honeywell = provider === 'honeywell';
  const limit = honeywell ? 15 : 20;
  let complete = false;
  for (let offset = 0; offset < limit * 5; offset += limit) {
    const url = honeywell
      ? new URL('https://ibqbjb.fa.ocs.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions')
      : new URL('https://www.amazon.jobs/en/search.json');
    url.search = new URLSearchParams(honeywell ? {
      onlyData: 'true',
      fields: 'requisitionList:Id,Title,PrimaryLocation,PostedDate,PostingEndDate,ShortDescriptionStr,ExternalQualificationsStr,ExternalResponsibilitiesStr',
      finder: `findReqs;siteNumber=CX_1,locationId=300000000469485,limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC`,
    } : { country: 'IND', result_limit: String(limit), offset: String(offset), sort: 'recent' });
    let rows;
    try {
      const data = await readJson(url, { fetcher, timeout: 12000 });
      rows = honeywell ? data.items?.[0]?.requisitionList : data.jobs;
      if (!Array.isArray(rows)) throw new Error('Invalid employer feed');
    } catch (error) {
      if (!offset) throw error;
      break;
    }
    for (const row of rows) {
      if (!row) continue;
      let job;
      if (honeywell) {
        if (!/^\d+$/.test(row.Id ?? '')) continue;
        job = jobFrom({ title: row.Title, employer, location: row.PrimaryLocation,
          url: `https://careers.honeywell.com/en/sites/Honeywell/job/${row.Id}`,
          description: [row.ShortDescriptionStr, row.ExternalQualificationsStr, row.ExternalResponsibilitiesStr].filter(Boolean).join('\n'),
          posted: indiaDate(row.PostedDate), expires: indiaDate(row.PostingEndDate, true),
          source: 'Honeywell' });
      } else {
        if (row.country_code !== 'IND' || !/^\/en\/jobs\/\d+(?:\/[^?#\\]*)?$/.test(row.job_path ?? '')) continue;
        const date = typeof row.posted_date === 'string' && /^[a-z]+ \d{1,2}, \d{4}$/i.test(row.posted_date)
          ? amazonDate(row.posted_date)
          : indiaDate(row.posted_date);
        job = jobFrom({ title: row.title, employer, location: row.normalized_location || row.location,
          url: `https://www.amazon.jobs${row.job_path}`, posted: date,
          description: [row.description, row.basic_qualifications, row.preferred_qualifications].filter(Boolean).join('\n'),
          kind: row.is_intern ? 'Internship' : '', source: 'Amazon Jobs' });
      }
      if (job) jobs.set(job.id, job);
    }
    if (rows.length < limit) {
      complete = true;
      break;
    }
  }
  return { jobs: [...jobs.values()], complete };
}

function amazonDate(value) {
  const date = new Date(`${value} 00:00:00 GMT+0530`);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

async function fetchWidgetBoard({ token, employer, provider }, fetcher) {
  const endpoint = {
    workable: `https://apply.workable.com/api/v1/widget/accounts/${token}`,
    recruitee: `https://${token}.recruitee.com/api/offers/`,
    bamboohr: `https://${token}.bamboohr.com/careers/list`,
  }[provider];
  const data = await readJson(endpoint, { fetcher });
  const rows = { workable: data?.jobs, recruitee: data?.offers, bamboohr: data?.result }[provider];
  if (!Array.isArray(rows)) throw new Error('Invalid widget feed');
  const jobs = new Map();
  for (const row of rows) {
    if (!row || row.status === 'closed' || row.isInternal === true) continue;
    const location = typeof row.location === 'string' ? row.location : [
      row.location?.city, row.location?.state, row.location?.country,
    ].filter(Boolean).join(', ');
    const place = [location, row.city, row.state, row.country, row.remote === true || row.isRemote === true ? 'Remote' : '']
      .filter(value => typeof value === 'string' && value.trim()).join(', ');
    const id = /^\d+$/.test(row.id ?? '') ? row.id : null;
    const url = provider === 'bamboohr' ? (id && `https://${token}.bamboohr.com/careers/${id}`)
      : row.url ?? row.careers_url ?? (provider === 'workable' && /^[a-z0-9]+$/i.test(row.shortcode ?? '')
        ? `https://apply.workable.com/${token}/j/${row.shortcode}/` : null);
    const job = jobFrom({ title: row.title ?? row.jobOpeningName, employer, location: place,
      url, description: row.description, source: providers[provider],
      posted: row.published_at ?? row.date_posted, kind: row.employment_type,
      workplace: row.remote === true || row.isRemote === true ? 'Remote' : undefined });
    if (job) jobs.set(job.id, job);
  }
  if (rows.length > 0 && jobs.size === 0) throw new Error('No usable widget listings');
  return { jobs: [...jobs.values()], complete: !data.next && !data.nextPage && !data.next_page };
}

function requestWorkday(session, address, { headers, method = 'GET', body, signal }) {
  const url = new URL(address);
  return new Promise((resolve, reject) => {
    const stream = session.request({ ...headers, ':method': method, ':path': url.pathname + url.search }, { signal });
    stream.once('error', reject);
    stream.once('response', received => {
      const status = received[':status'];
      resolve({ status, ok: status >= 200 && status < 300, body: Readable.toWeb(stream) });
    });
    stream.end(body);
  });
}

async function collectDetails(rows, fetchDetail) {
  const results = [];
  for (let i = 0; i < rows.length; i += 3) {
    results.push(...await Promise.all(rows.slice(i, i + 3).map(fetchDetail)));
  }
  return results;
}

async function publicDetail(url, fetcher) {
  try {
    return await readJson(url, { fetcher, timeout: 7000 });
  } catch (error) {
    // An advertised listing may have closed between the list and detail requests.
    return ['HTTP 404', 'HTTP 410'].includes(error.message) ? null : {};
  }
}

async function fetchSmartRecruiters({ token, employer }, fetcher) {
  const endpoint = `https://api.smartrecruiters.com/v1/companies/${token}/postings`;
  const rows = new Map();
  let complete = false;
  for (let offset = 0; offset < 400; offset += 100) {
    const data = await readJson(`${endpoint}?destination=PUBLIC&country=in&limit=100&offset=${offset}`, { fetcher });
    if (!Array.isArray(data.content)) throw new Error('Invalid SmartRecruiters feed');
    for (const row of data.content) {
      if (/^\d+$/.test(row?.id ?? '') && (row.location?.country ?? '').toLowerCase() === 'in') rows.set(row.id, row);
    }
    if (data.content.length < 100 || offset + 100 >= data.totalFound) {
      complete = true;
      break;
    }
  }
  let pendingDetails = 24;
  const jobs = await collectDetails([...rows.values()], async row => {
    const detail = pendingDetails-- > 0 ? await publicDetail(`${endpoint}/${row.id}`, fetcher) : {};
    if (!detail) return null;
    const location = [row.location.city, row.location.region, 'India'].filter(Boolean).join(', ');
    const slug = (row.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const sections = detail.jobAd?.sections;
    const description = [sections?.jobDescription?.text, sections?.qualifications?.text,
      sections?.additionalInformation?.text].filter(Boolean).join('\n');
    const job = jobFrom({ title: row.name, employer, location, description, posted: row.releasedDate,
      kind: row.typeOfEmployment?.label, workplace: row.location.remote ? 'Remote' : row.location.type,
      url: `https://jobs.smartrecruiters.com/${token}/${row.id}${slug ? `-${slug}` : ''}`,
      source: providers.smartrecruiters });
    if (job && !sections) job.detailPending = true;
    return job;
  });
  return { jobs: jobs.filter(Boolean), complete };
}

async function fetchWorkday({ token, employer }, fetcher) {
  const board = new URL(token);
  const tenant = board.hostname.split('.')[0];
  const endpoint = `${board.origin}/wday/cxs/${tenant}${board.pathname}`;
  const rows = new Map();
  let complete = false;
  for (let offset = 0; offset < 100; offset += 20) {
    const data = await readJson(`${endpoint}/jobs`, { fetcher,
      payload: { appliedFacets: {}, searchText: 'India', limit: 20, offset } });
    if (!Array.isArray(data.jobPostings)) throw new Error('Invalid Workday feed');
    for (const row of data.jobPostings) {
      const path = row?.externalPath;
      if (typeof path === 'string' && /^\/job\/[^?#\\]+$/.test(path) && !path.includes('..') &&
          !/%(?:2e|2f|5c)/i.test(path)) rows.set(path, row);
    }
    if (data.jobPostings.length < 20 || offset + 20 >= data.total) {
      complete = true;
      break;
    }
  }
  const candidates = [...rows.values()].filter(row => indiaLocation.test(row.locationsText ?? '') ||
    !row.locationsText || /^\d+ locations$/i.test(row.locationsText) || row.locationsCount > 1);
  let pendingDetails = 18;
  const jobs = await collectDetails(candidates, async row => {
    const detail = pendingDetails-- > 0 ? await publicDetail(`${endpoint}${row.externalPath}`, fetcher) : {};
    if (!detail) return null;
    const info = detail.jobPostingInfo;
    const extraLocations = Array.isArray(info?.additionalLocations) ? info.additionalLocations : [];
    const locations = [info?.location ?? row.locationsText, ...extraLocations]
      .filter(value => typeof value === 'string' && indiaLocation.test(value));
    const job = jobFrom({ title: row.title, employer, location: [...new Set(locations)].join(' / '),
      description: info?.jobDescription, posted: indiaDate(info?.startDate),
      expires: indiaDate(info?.endDate, true), kind: info?.timeType,
      url: `${token}${row.externalPath}`, source: providers.workday });
    if (job && !info) job.detailPending = true;
    return job;
  });
  // The keyword search is bounded. A truncated response never deletes prior rows.
  return { jobs: jobs.filter(Boolean), complete };
}

export async function fetchLicensed(key, fetcher = fetch) {
  const jobs = new Map();
  for (let offset = 0; offset < 400; offset += 100) {
    if (offset) await new Promise(resolve => setTimeout(resolve, 500));
    const url = new URL('https://freehire.me/api/v1/agent/jobs/search');
    url.search = new URLSearchParams({ countries: 'IN', posted_within_days: '7',
      category: 'software_engineering,backend,frontend,fullstack,mobile,data_analytics',
      sort: 'posted_at', order: 'desc', limit: '100', ...(offset && { offset: String(offset) }) });
    const data = await readJson(url, { fetcher, key });
    if (!Array.isArray(data.data)) throw new Error('Invalid licensed feed response');
    for (const item of data.data) {
      if (item.closed_at) continue;
      const job = jobFrom({ url: item.url, title: item.title, employer: item.company, location: item.location,
        description: item.description, posted: item.posted_at, source: 'Licensed job index',
        years: item.enrichment?.experience_years_min, kind: item.enrichment?.employment_type,
        workplace: item.work_mode });
      if (job) jobs.set(job.id, job);
    }
    if (data.data.length < 100) return { jobs: [...jobs.values()], complete: true };
  }
  return { jobs: [...jobs.values()], complete: true };
}
