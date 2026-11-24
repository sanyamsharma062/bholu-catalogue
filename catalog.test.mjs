import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { database, migrate, replaceFeed, recordFailure } from './database.mjs';
import { boardsFrom, configuredGlassdoor, fetchBoard, fetchGlassdoor, glassdoorFeed } from './feeds.mjs';
import { catalogServer } from './server.mjs';
import { discoverBoards } from './directory.mjs';

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
  const workday = ['phreesia|wd1|phreesiaindia', 'badhost|wd1|india'];
  const fetcher = async url => Response.json(url.includes('workday_companies') ? workday : directory);
  const boards = await discoverBoards(database, [], fetcher);
  assert.deepEqual(boards.slice(0, 4).map(board => board.provider), ['ashby', 'greenhouse', 'lever', 'workday']);
  assert.equal(boards.filter(board => board.provider === 'greenhouse').length, 6);
  assert.equal(boards.some(board => board.id === 'greenhouse:recent'), false);
  assert.equal(boards.some(board => board.token.startsWith('https://badhost')), false);
  const fallback = await discoverBoards(database, [], async url =>
    url.includes('workday_companies') ? new Response('', { status: 503 }) : Response.json(directory));
  assert.ok(fallback.length > 0);
  assert.equal(fallback.some(board => board.provider === 'workday'), false);
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
