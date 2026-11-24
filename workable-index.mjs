import { Parser } from 'htmlparser2';
import { jobFrom } from './feeds.mjs';

const address = 'https://www.workable.com/boards/workable.xml';
const supported = new Set(['title', 'date', 'url', 'company', 'city', 'state', 'country', 'remote', 'description', 'jobtype']);
export const workableIndex = { id: 'workable:public-index', employer: 'Jobs by Workable' };

export async function fetchWorkableIndex(fetcher = fetch) {
  const response = await fetcher(address, {
    headers: { Accept: 'application/xml, text/xml', 'Accept-Encoding': 'gzip', 'User-Agent': 'Bholu Job Catalogue' },
    signal: AbortSignal.timeout(150000),
    redirect: 'error',
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const jobs = new Map();
  const tags = [];
  let fields;
  let seen = 0;
  let closed = false;
  let malformed = false;
  const parser = new Parser({
    onopentag(name) {
      tags.push(name);
      if (tags.length === 1 && (name !== 'source' || closed)) malformed = true;
      if (tags.length === 2 && name === 'job') fields = Object.create(null);
    },
    ontext(value) {
      const field = tags[2];
      if (fields && tags.length === 3 && supported.has(field)) {
        const limit = field === 'description' ? 90000 : 3000;
        fields[field] = ((fields[field] ?? '') + value).slice(0, limit);
      }
    },
    onclosetag(name, implied) {
      if (tags.pop() !== name || (implied && ['source', 'job'].includes(name))) malformed = true;
      if (name === 'source' && tags.length === 0) closed = true;
      if (name !== 'job' || tags.length !== 1 || !fields) return;
      seen++;
      const row = fields;
      fields = undefined;
      if (row.country?.trim().toUpperCase() !== 'IN') return;
      const url = row.url?.trim();
      if (!url || !/^https:\/\/apply\.workable\.com\/(?:[a-z0-9_-]+\/)?j\/[a-z0-9]+(?:\/apply)?\/?(?:\?[^#]*)?$/i.test(url)) return;
      const remote = row.remote?.trim().toLowerCase() === 'true';
      const date = row.date?.trim() ?? '';
      const posted = /(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i.test(date) ? Date.parse(date) : NaN;
      const job = jobFrom({
        url, title: row.title, employer: row.company,
        location: [...new Set([remote ? 'Remote' : '', row.city?.trim(), row.state?.trim(), 'India'].filter(Boolean))].join(', '),
        description: row.description, posted, kind: row.jobtype,
        workplace: remote ? 'Remote' : '', source: 'Workable',
      });
      if (job) jobs.set(job.id, { ...job, url });
      if (jobs.size > 6000) throw new Error('Workable India feed exceeds listing limit');
    },
  }, { xmlMode: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1536 * 1024 * 1024) throw new Error('Workable feed exceeds size limit');
    parser.write(decoder.decode(chunk, { stream: true }));
  }
  parser.end(decoder.decode());
  if (!closed || malformed || tags.length || !seen) throw new Error('Incomplete Workable feed');
  return { jobs: [...jobs.values()], complete: true };
}
