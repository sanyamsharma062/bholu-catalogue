import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createWebJobSearch, webJobInput } from './web-jobs.mjs';
import { catalogServer } from './server.mjs';

test('Google search returns only eligible direct links and caches its upstream request', async () => {
  let requests = 0;
  const search = createWebJobSearch({ key: 'fake-test-key', maximum: 1, fetcher: async endpoint => {
    requests++;
    assert.match(endpoint.searchParams.get('q'), /"Java" \(site:careers.ibm.com\)/);
    assert.equal(endpoint.searchParams.get('tbs'), 'qdr:d3');
    return Response.json({
      search_metadata: { status: 'Success' },
      organic_results: [
        { title: 'IBM jobs homepage', link: 'https://careers.ibm.com/en_US/careers/SearchJobs' },
        { title: 'IBM Junior Java Engineer', link: 'https://careers.ibm.com/en_US/careers/JobDetail/123?utm_source=google' },
        { title: 'Unrelated', link: 'https://example.com/careers/JobDetail/555' },
      ],
    });
  } });
  const input = webJobInput({ scope: 'ibm', q: '"Java"', days: 3 });
  assert.deepEqual(await search(input), [
    { title: 'IBM Junior Java Engineer', link: 'https://careers.ibm.com/en_US/careers/JobDetail/123', snippet: '' },
  ]);
  await search(input);
  assert.equal(requests, 1);
  await assert.rejects(search({ ...input, q: 'Kotlin' }), /Daily search limit/);
  assert.throws(() => webJobInput({ scope: 'ibm', q: 'site:example.com', days: 3 }), /Invalid web search/);
});

test('web-job search serves current TCS posting URLs through the catalogue endpoint', async t => {
  const url = 'https://ibegin.tcsapps.com/candidate/next/en-IN/jobs/434715J';
  const search = createWebJobSearch({ key: 'fake-test-key', fetcher: async () => Response.json({
    search_metadata: { status: 'Success' },
    organic_results: [{ title: 'Java Backend Developer', link: url }, {
      title: 'TCS All India NQT Hiring',
      link: 'https://www.tcs.com/careers/india/tcs-all-india-nqt-hiring',
      snippet: 'Registration status: Closed',
    }],
  }) });
  const server = catalogServer(null, { webSearch: search });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/web-job-search`, {
    method: 'POST', body: JSON.stringify({ scope: 'tcs', q: '"Java Backend Developer"', days: 1 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results.map(result => result.link), [url]);
});
