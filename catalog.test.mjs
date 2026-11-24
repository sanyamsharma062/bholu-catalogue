import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { database, migrate, replaceFeed, recordFailure } from './database.mjs';
import { boardsFrom, configuredGlassdoor, fetchBoard, fetchGlassdoor, glassdoorFeed } from './feeds.mjs';
import { catalogServer } from './server.mjs';
import { discoverBoards } from './directory.mjs';
import { fetchWorkableIndex } from './workable-index.mjs';

test('Paylocity uses visible India locations and original dates and drops closed or internal jobs', async () => {
  const [board] = boardsFrom([['paylocity', 'a432d829-f701-4cf3-9108-56ef703b2ac5', 'Example']]);
  const row = (id, country, flags = {}) => ({ JobId: id, JobTitle: 'Graduate Engineer',
    JobLocation: { Country: country, City: 'Pune' }, LocationName: 'Hybrid',
    PublishedDate: '2026-11-23T13:35:16-05:00', ...flags });
  const result = await fetchBoard(board, async url => {
    const path = new URL(url).pathname;
    if (path.includes('/All/')) return new Response('<script>window.pageData = ' + JSON.stringify({
      ModuleTitle: 'Example', Jobs: [row(12, 'IND'), row(13, 'IND'), row(14, 'IND', { IsInternal: true }),
        row(15, 'IND', { ShouldDisplayLocation: false })],
    }) + ';</script>');
    if (path.endsWith('/13')) return new Response('', {status: 404});
    return new Response('<script type="application/ld+json">' + JSON.stringify({
      '@type': 'JobPosting', description: '<p>Build Java APIs.</p>', employmentType: 'FULL_TIME',
    }) + '</script>');
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].posted, '2026-11-23T18:35:16.000Z');
  assert.equal(result.jobs[0].description, 'Build Java APIs.');
  assert.equal(result.jobs[0].location, 'Hybrid, Pune, India');
  assert.equal(result.jobs[0].url, 'https://recruiting.paylocity.com/Recruiting/Jobs/Details/12');
});

test('JOIN paginates India boards and takes the employer publication date from structured detail', async () => {
  const [board] = boardsFrom([['join', 'team', 'Example']]);
  const row = (id, title) => ({ id, idParam: id + '-job', title, createdAt: '2026-11-21T00:00:00Z',
    city: { cityName: id === 1 ? 'London' : 'Bengaluru', countryName: id === 1 ? 'United Kingdom' : 'India' },
    workplaceType: 'HYBRID' });
  const employerPage = (page, items) => '<script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify({ props: { pageProps: { pageData: { company: { name: 'Example' },
      jobs: { pagination: { page, pageCount: 2 }, items } } } } }) + '</script>';
  const calls = [];
  const result = await fetchBoard(board, async url => {
    const path = new URL(url);
    calls.push(path.pathname + path.search);
    if (path.pathname.endsWith('/team')) {
      return new Response(path.search ? employerPage(2, [row(2, 'Graduate Engineer'), row(3, 'Intern')])
        : employerPage(1, [row(1, 'Overseas Engineer')]));
    }
    if (path.pathname.endsWith('3-job')) return new Response('', { status: 410 });
    return new Response('<script type="application/ld+json">' + JSON.stringify({
      '@type': 'JobPosting', title: 'Graduate Engineer', description: '<p>Build Java APIs.</p>',
      datePosted: '2026-11-24T14:00:00Z', employmentType: 'FULL_TIME',
    }) + '</script>');
  });
  assert.deepEqual(calls, ['/companies/team', '/companies/team?page=2',
    '/companies/team/2-job', '/companies/team/3-job']);
  assert.equal(result.complete, true);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].posted, '2026-11-24T14:00:00.000Z');
  assert.equal(result.jobs[0].description, 'Build Java APIs.');
  assert.equal(result.jobs[0].kind, 'Full-time');
  assert.equal(result.jobs[0].source, 'JOIN');
});

test('Workable index streams India listings with original links, dates, and clean descriptions', async () => {
  const job = (country, code, date) => `<job><title>Junior Developer</title><date>${date}</date>
    <url><![CDATA[https://apply.workable.com/example/j/${code}/?utm_source=original]]></url>
    <company>Example</company><city>Pune</city><country>${country}</country><remote>true</remote>
    <description><![CDATA[<p>Build Java services &amp; tools.</p>]]></description><jobtype>Full-time</jobtype></job>`;
  const xml = '<source>' + job('IN', 'abc12', 'Sun, 29 Dec 2019 11:02:25 UTC') +
    job('US', 'def12', '') + job('IN', 'undated', 'yesterday') + '</source>';
  const response = text => new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < text.length; index += 11) {
        controller.enqueue(new TextEncoder().encode(text.slice(index, index + 11)));
      }
      controller.close();
    },
  }));
  const result = await fetchWorkableIndex(async (url, options) => {
    assert.equal(url, 'https://www.workable.com/boards/workable.xml');
    assert.equal(options.headers['Accept-Encoding'], 'gzip');
    return response(xml);
  });
  assert.equal(result.complete, true);
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs[0].id, 'workable:abc12');
  assert.equal(result.jobs[0].url, 'https://apply.workable.com/example/j/abc12/?utm_source=original');
  assert.equal(result.jobs[0].description, 'Build Java services & tools.');
  assert.equal(result.jobs[0].posted, '2019-12-29T11:02:25.000Z');
  assert.equal(result.jobs[1].posted, null);
  await assert.rejects(fetchWorkableIndex(async () => response(xml.slice(0, -9))), /Incomplete/);
});

test('Workable employer widgets preserve public dates, secondary India locations and plain-text details', async () => {
  const [board] = boardsFrom([['workable', 'team', 'Example']]);
  const result = await fetchBoard(board, async url => {
    assert.equal(url, 'https://apply.workable.com/api/v1/widget/accounts/team?details=true');
    return Response.json({ jobs: [{
      shortcode: 'EX123', title: 'Graduate Engineer', published_on: '2026-11-24',
      created_at: '2026-11-12', description: '<p>Build Java APIs.</p>', telecommuting: true,
      locations: [{ city: 'London', country: 'United Kingdom' },
        { city: 'Bengaluru', region: 'Karnataka', countryCode: 'IN' },
        { city: 'Private', hidden: true }],
    }] });
  });
  assert.equal(result.jobs[0].posted, '2026-11-23T18:30:00.000Z');
  assert.match(result.jobs[0].location, /Bengaluru, Karnataka, India/);
  assert.doesNotMatch(result.jobs[0].location, /Private/);
  assert.equal(result.jobs[0].description, 'Build Java APIs.');
  assert.equal(result.jobs[0].workplace, 'Remote');
});

test('directory probes different providers, skips recent failures, and survives one source failing', async () => {
  const database = {
    query: async () => ({ rows: [
      { id: 'ashby:active', live_india: true, checked_at: new Date() },
      { id: 'greenhouse:recent', live_india: false, checked_at: new Date() },
    ] }),
  };
  const directory = [
    ...Array.from({ length: 20 }, (_, index) => ({ platform: 'greenhouse', slug: 'company' + index, name: 'Company ' + index })),
    { platform: 'greenhouse', slug: 'recent', name: 'Recent' },
    { platform: 'ashby', slug: 'active', name: 'Active' },
    { platform: 'lever', slug: 'new', name: 'New' },
  ];
  const workday = ['phreesia|wd1|phreesiaindia', 'badhost|wd1|../india'];
  const fetcher = async url => {
    if (url.includes('workday_companies')) return Response.json(workday);
    if (url.endsWith('/companies.json')) return Response.json(directory);
    return new Response('', { status: 503 });
  };
  const boards = await discoverBoards(database, [], fetcher);
  assert.deepEqual(boards.slice(0, 4).map(board => board.provider), ['ashby', 'greenhouse', 'lever', 'workday']);
  assert.equal(boards.filter(board => board.provider === 'greenhouse').length, 6);
  assert.equal(boards.some(board => board.id === 'greenhouse:recent'), false);
  assert.equal(boards.some(board => board.token.startsWith('https://badhost')), false);
  const fallback = await discoverBoards(database, [], async url =>
    url.endsWith('/companies.json') ? Response.json(directory) : new Response('', { status: 503 }));
  assert.ok(fallback.length > 0);
  assert.equal(fallback.some(board => board.provider === 'workday'), false);
});

test('reverse sweep rotates eight directories and excludes unsafe or recently checked boards', async () => {
  const database = { query: async () => ({ rows: [
    { id: 'ashby:ashby-0', checked_at: new Date(), live_india: false },
  ] }) };
  const knownBoard = boardsFrom([['greenhouse', 'greenhouse-0', 'Configured']]);
  const boards = await discoverBoards(database, knownBoard, async url => {
    if (url.endsWith('/companies.json')) return Response.json([]);
    if (url.endsWith('/sitemap.xml')) {
      return new Response('<loc>https://join.com/companies/reverse-join</loc>' +
        '<loc>https://join.com/companies/reverse-join/job</loc>' +
        '<loc>https://join.com.example/companies/unsafe</loc>');
    }
    if (url.includes('workday_companies')) return Response.json(['global|wd3|External']);
    if (url.includes('paylocity_companies')) return Response.json([
      { guid: '73b6525a-3273-48b3-b9d8-d6479233c61c', name: 'Paylocity Example' },
      { guid: 'bad/token', name: 'Invalid' },
    ]);
    const provider = /\/([a-z]+)_companies/.exec(url)[1];
    return Response.json(['unsafe/token', ...Array.from({ length: 13 }, (_, index) => provider + '-' + index),
      provider + '-bengaluru', provider + '-india', provider + '-pune']);
  });
  assert.equal(boards.length, 33);
  assert.equal(new Set(boards.slice(0, 8).map(board => board.provider)).size, 8);
  assert.equal(boards.filter(board => board.provider === 'greenhouse').length, 6);
  assert.ok(boards.every(board => board.discovered && board.fromSweep && !board.token.includes('unsafe')));
  assert.ok(!boards.some(board => ['ashby:ashby-0', 'greenhouse:greenhouse-0'].includes(board.id)));
  const greenhouse = boards.filter(board => board.provider === 'greenhouse').map(board => board.token);
  assert.deepEqual(greenhouse, ['greenhouse-bengaluru', 'greenhouse-india',
    'greenhouse-1', 'greenhouse-2', 'greenhouse-3', 'greenhouse-4']);
});

test('Greenhouse maps the published date and cleans description and apply URL', async () => {
  const [board] = boardsFrom([['greenhouse', 'example', 'Example']]);
  const published = '2026-11-23T11:00:00Z';
  const { jobs, complete } = await fetchBoard(board, async () => new Response(JSON.stringify({
    jobs: [{ id: 42, title: 'Junior Engineer', location: { name: 'Bengaluru' },
      first_published: published, updated_at: '2026-11-24T12:00:00Z',
      absolute_url: 'https://job-boards.greenhouse.io/example/jobs/42?utm_source=portal',
      content: '&lt;p&gt;Build Java services.&lt;/p&gt;' }], meta: { total: 1 },
  })));
  assert.equal(complete, true);
  assert.equal(jobs[0].posted, new Date(published).toISOString());
  assert.equal(jobs[0].description, 'Build Java services.');
  assert.equal(jobs[0].url, 'https://job-boards.greenhouse.io/example/jobs/42');
});

test('Glassdoor consumes a complete licensed snapshot with original dates and apply links', async () => {
  const config = {
    GLASSDOOR_FEED_URL: 'https://feed.example.com/jobs',
    GLASSDOOR_FEED_TOKEN: 'test-token',
  };
  assert.equal(configuredGlassdoor(config), null);
  config.GLASSDOOR_LICENSED = 'true';
  const listing = {
    title: 'Junior Java Engineer', company: 'Example', location: 'Bengaluru, India',
    applyUrl: 'https://example.com/jobs/42', description: '<p>Build Java services.</p>',
    postedAt: '2026-11-24T09:00:00Z', minimumExperience: 0,
  };
  const { jobs, complete } = await fetchGlassdoor(configuredGlassdoor(config), async (url, options) => {
    assert.equal(url.href, config.GLASSDOOR_FEED_URL);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    return Response.json({ complete: true, jobs: [listing, { closed: true }] });
  });
  assert.equal(complete, true);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, 'Glassdoor');
  assert.equal(jobs[0].description, 'Build Java services.');
  assert.equal(jobs[0].posted, '2026-11-24T09:00:00.000Z');
  assert.equal(jobs[0].url, listing.applyUrl);
  await assert.rejects(fetchGlassdoor(configuredGlassdoor(config),
    async () => Response.json({ complete: false, jobs: [listing] })), /complete Glassdoor feed snapshot/);
});

test('Workday reads India detail dates and ignores relative estimates and expired links', async () => {
  const [board] = boardsFrom([['workday', 'https://example.wd1.myworkdayjobs.com/External', 'Example']]);
  const { jobs, complete } = await fetchBoard(board, async (url, options) => {
    if (url.endsWith('/jobs')) {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).searchText, 'India');
      return Response.json({ total: 4, jobPostings: [
        { title: 'Engineer', externalPath: '/job/Pune/J1', locationsText: 'Pune' },
        { title: 'Intern', externalPath: '/job/Pune/J2', locationsText: 'Pune', postedOn: 'Posted Today' },
        { title: 'Closed', externalPath: '/job/Pune/J3', locationsText: 'Pune' },
        { title: 'Outside India', externalPath: '/job/Paris/J4', locationsText: 'Paris' },
      ] });
    }
    if (url.endsWith('/J1')) return Response.json({ jobPostingInfo: {
      startDate: '2026-11-24', endDate: '2026-12-01', location: 'Pune',
      jobDescription: '<p>Work with Java.</p>',
    } });
    return new Response('', { status: url.endsWith('/J2') ? 503 : 404 });
  });
  assert.equal(complete, true);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].description, 'Work with Java.');
  assert.equal(jobs[0].posted, '2026-11-23T18:30:00.000Z');
  assert.equal(jobs[0].validThrough, '2026-12-01T18:29:59.999Z');
  assert.equal(jobs[1].posted, null);
  assert.equal(jobs[1].detailPending, true);
  assert.throws(() => boardsFrom([['workday', 'https://unrelated.example.com/External', 'Example']]));
});

test('SmartRecruiters keeps India postings and their release timestamp', async () => {
  const [board] = boardsFrom([['smartrecruiters', 'Example', 'Example']]);
  const { jobs } = await fetchBoard(board, async url => {
    if (url.includes('?')) {
      assert.match(url, /destination=PUBLIC&country=in/);
      return Response.json({ totalFound: 2, content: [
        { id: '101', name: 'Junior Engineer', location: { country: 'in', city: 'Bengaluru' },
          releasedDate: '2026-11-24T10:00:00Z' },
        { id: '102', name: 'Junior Engineer', location: { country: 'us', city: 'New York' } },
      ] });
    }
    assert.match(url, /\/101$/);
    return Response.json({ jobAd: { sections: { qualifications: { text: '<p>No experience required</p>' } } } });
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].posted, '2026-11-24T10:00:00.000Z');
  assert.equal(jobs[0].minimumExperience, 0);
  assert.equal(jobs[0].url, 'https://jobs.smartrecruiters.com/Example/101-junior-engineer');
});

test('Speedrun uses the original apply page and keeps index dates out of recent results', async () => {
  const [board] = boardsFrom([['speedrun', 'speedrun', 'Speedrun']]);
  const id = '014e94e9-6d67-47f4-aa89-5661cab5ee56';
  const direct = `https://jobs.ashbyhq.com/example/${id}/application`;
  const { jobs } = await fetchBoard(board, async url =>
    Response.json(url.includes('?page=') ? {
      has_more: false,
      jobs: [{ id, title: 'Java Engineer', company: 'Example', location: 'Pune, India',
        url: 'https://speedrun-talent-network.com/jobs/java-engineer-014e94e9',
        published_at: '2026-11-24T07:19:45.250+00:00' }],
    } : {
      job: { status: 'open', apply: { kind: 'external', url: direct }, description_text: 'Develop Java services.' },
    }));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, direct);
  assert.equal(jobs[0].posted, null);
  assert.equal(jobs[0].description, 'Develop Java services.');
});

test('iCIMS reads job details from public cards and retains real dates for India', async () => {
  const [board] = boardsFrom([['icims', 'careers-example', 'Example']]);
  const { jobs } = await fetchBoard(board, async url => new Response(
    url.searchParams.get('pr') === '0' ? `
      <li class="iCIMS_JobCardItem">
        <span class="field-label">Location : Country</span><span>IN</span>
        <span class="field-label">Location : Location</span><span>Pune</span>
        <span class="field-label">Posted Date</span><span title="24/11/2026 09:30">Today</span>
        <a class="iCIMS_Anchor" href="/jobs/123/java-engineer/job?in_iframe=1"><h3>Java Engineer</h3></a>
        <div class="description">Develop Java services.</div>
      </li>` : '<div class="iCIMS_NoJobs"></div>'));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, 'https://careers-example.icims.com/jobs/123/java-engineer/job');
  assert.equal(jobs[0].posted, '2026-11-23T18:30:00.000Z');
});

test('live PostgreSQL and HTTP preserve healthy results, deduplicate, and count all date windows',
  { skip: !process.env.BHOLU_CATALOG_TEST_DATABASE }, async t => {
    const pool = database(process.env.BHOLU_CATALOG_TEST_DATABASE);
    await migrate(pool);
    const stamp = Date.now().toString(36);
    const board = { id: `test:${stamp}`, employer: 'Test Employer' };
    const duplicate = { id: `${board.id}:duplicate`, employer: board.employer };
    const job = (suffix, days, location = 'Bangalore, India') => ({
      id: `${board.id}:${suffix}`, title: 'Junior Java Engineer', company: board.employer,
      description: 'Develop Java services. No professional blockers.', location,
      url: `https://example.com/${suffix}`, source: 'Greenhouse', kind: '', minimumExperience: 0,
      posted: new Date(Date.now() - days * 86400000).toISOString(), validThrough: null,
    });
    const today = job('today', .15);
    await replaceFeed(pool, board, [today, job('three', 2), job('seven', 5), job('other', .1, 'Paris, France')]);
    await replaceFeed(pool, board, [{ ...today, description: '', posted: null, detailPending: true }],
      { complete: false });
    const { rows: [retained] } = await pool.query(
      'SELECT job FROM catalog_postings WHERE feed_id=$1 AND canonical_id=$2', [board.id, today.id]);
    assert.equal(retained.job.description, today.description);
    assert.equal(retained.job.posted, today.posted);
    await replaceFeed(pool, duplicate, [today]);
    await recordFailure(pool, board, 'HTTP 503');
    const server = catalogServer(pool);
    t.after(async () => {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      try {
        await pool.query('DELETE FROM catalog_postings WHERE feed_id=ANY($1)', [[board.id, duplicate.id]]);
        await pool.query('DELETE FROM catalog_feeds WHERE id=ANY($1)', [[board.id, duplicate.id]]);
      } finally {
        await pool.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const result = await fetch(`${base}/v1/job-search`, { method: 'POST',
      body: JSON.stringify({ roles: ['java'], cities: ['bengaluru'], maxExperience: 0, limit: 1 }) });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.deepEqual(body.counts, { '1': 1, '3': 2, '7': 3 });
    assert.equal(body.total, 3);
    assert.equal(body.nextOffset, 1);
    assert.equal(body.coverage.delayed, 1);
    const sources = await fetch(`${base}/v1/sources`).then(response => response.json());
    assert.ok(sources.sources.some(source => source.employer === board.employer &&
      source.status === 'delayed' && source.lastSuccess));
    assert.ok(body.jobs[0].firstSeenAt);
    assert.equal((await fetch(`${base}/v1/jobs/${encodeURIComponent(today.id)}`)).status, 200);
    await replaceFeed(pool, board, [
      { ...job('senior', .1), minimumExperience: 4 },
      { ...job('unknown', .1), minimumExperience: null, title: 'Java Engineer' },
    ], { complete: false });
    const filtered = await fetch(`${base}/v1/job-search`, { method: 'POST',
      body: JSON.stringify({ roles: ['Java Developer'], cities: ['Pune', 'Bengaluru'],
        experience: '3–5 years', includeUnknownExperience: false, days: 1 }) });
    assert.equal(filtered.status, 200);
    assert.deepEqual((await filtered.json()).jobs.map(row => row.id), [job('senior', .1).id]);
    await replaceFeed(pool, board, []);
    assert.equal((await fetch(`${base}/v1/jobs/${encodeURIComponent(job('three', 2).id)}`)).status, 404);
    await replaceFeed(pool, board, [today]);
    const { rows: [reopened] } = await pool.query(
      'SELECT first_seen_at FROM catalog_postings WHERE feed_id=$1 AND canonical_id=$2', [board.id, today.id]);
    assert.equal(reopened.first_seen_at.toISOString(), new Date(body.jobs[0].firstSeenAt).toISOString());
  });

test('licensed Glassdoor jobs enter normal results and disappear when the feed is disabled',
  { skip: !process.env.BHOLU_CATALOG_TEST_DATABASE }, async t => {
    const pool = database(process.env.BHOLU_CATALOG_TEST_DATABASE);
    await migrate(pool);
    assert.equal((await pool.query('SELECT 1 FROM catalog_feeds WHERE id=$1', [glassdoorFeed.id])).rowCount, 0);
    const enabled = catalogServer(pool, { glassdoor: true });
    const disabled = catalogServer(pool);
    t.after(async () => {
      await Promise.all([enabled, disabled].filter(server => server.listening)
        .map(server => new Promise(resolve => server.close(resolve))));
      try {
        await pool.query('DELETE FROM catalog_postings WHERE feed_id=$1', [glassdoorFeed.id]);
        await pool.query('DELETE FROM catalog_feeds WHERE id=$1', [glassdoorFeed.id]);
      } finally {
        await pool.end();
      }
    });
    const config = { url: 'https://feed.example.com/jobs', key: 'test-token' };
    const { jobs } = await fetchGlassdoor(config, async () => Response.json({ complete: true, jobs: [{
      company: 'Example', title: 'Junior GlassdoorIntegration Engineer', location: 'Bengaluru, India',
      applyUrl: 'https://example.com/glassdoor-integration', postedAt: new Date().toISOString(),
    }] }));
    await replaceFeed(pool, glassdoorFeed, jobs);
    const [on, off] = await Promise.all([enabled, disabled].map(async server => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return `http://127.0.0.1:${server.address().port}`;
    }));
    const searchForJob = base => fetch(`${base}/v1/job-search`, {
      method: 'POST', body: JSON.stringify({ roles: ['GlassdoorIntegration'], cities: ['Bengaluru'], days: 1 }),
    });
    const detail = `/v1/jobs/${encodeURIComponent(jobs[0].id)}`;
    assert.equal((await (await searchForJob(on)).json()).jobs[0].source, 'Glassdoor');
    assert.equal((await fetch(on + detail)).status, 200);
    assert.equal((await fetch(off + detail)).status, 404);
    const withoutFeed = await searchForJob(off);
    assert.ok(withoutFeed.status === 503 || (await withoutFeed.json()).jobs.length === 0);
  });
