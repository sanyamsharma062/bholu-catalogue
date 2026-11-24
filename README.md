# Bholu shared job catalogue

The worker refreshes employer feeds once per interval. PostgreSQL stores the last usable rows for each source. The API serves one combined search with deduplicated jobs and counts for 24 hours, 3 days, and 7 days. Failed refreshes retain previously fetched rows for up to 36 hours and report delayed coverage. The catalogue stores job data. The Android client sends only derived roles, skills and search settings.

## Local development

Use Node 22 or newer and a PostgreSQL database, with `DATABASE_URL` or the standard `PG*` connection variables set. The worker and API create the schema at startup.

```sh
npm ci
npm run refresh
npm start
```

`GET /health` returns 200 after at least one source has refreshed. Use `npm run refresh -- --watch` for periodic refreshes. Set `BHOLU_BOARDS_FILE` to point the worker at a JSON array of `[provider, boardToken, employer]` rows. The seed list supports Greenhouse, Ashby, Lever, SmartRecruiters, and Workday. Use a full public Workday board URL as its token. For a deployment with Compose, set `POSTGRES_PASSWORD` in the environment, then run `docker compose up -d --build`. Compose publishes the API on loopback and keeps PostgreSQL on its internal network.

SmartRecruiters and Workday imports focus on India and fetch a bounded set of descriptions per employer each refresh. SmartRecruiters supplies the release timestamp. Workday's detail page supplies the posting date where available. A day without a time is interpreted conservatively from the start of the India calendar day. Jobs with unknown dates stay out of the recent counts. This expansion uses public employer feeds and does not require a search API key. [SmartRecruiters posting feed](https://developers.smartrecruiters.com/reference/v1listpostings) · [Career Ops discovery reference](https://github.com/career-ops-hq/career-ops/blob/main/docs/SCRIPTS.md#scanfull)

```sh
curl -sS http://127.0.0.1:8788/v1/job-search \
  -H 'Content-Type: application/json' \
  -d '{"roles":["Java","Software Engineer"],"cities":["Bengaluru"],"maxExperience":0,"internships":true,"days":7}'
```

## Employer coverage

`GET /v1/sources` reports provider, last check, last success, and current, delayed, or unavailable status for each indexed source. It uses the same visibility rules as job search.

The base registry contains 204 configured feeds, including Honeywell and Amazon India, Nortal’s iCIMS board, and the a16z Speedrun public job index. This is a feed count, independent of how many employers respond or have listings in India. Of the 127 enabled rows in the Career Ops portal template reviewed for this import, 88 matched a supported public board. Some were already configured. The template also contains 69 disabled entries. The seed registry includes compatible public board identifiers from the [Career Ops portal template](https://github.com/career-ops-hq/career-ops/blob/main/templates/portals.example.yml) and [open-jobs-data company directory](https://github.com/ConorsCode/open-jobs-data/blob/main/companies.json), with adaptations for Bholu. Career Ops licenses its code under MIT and its employer data under CC BY 4.0. [Career Ops licence](https://github.com/career-ops-hq/career-ops#license--trademark) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

The worker can also discover employer endpoints from the open-jobs-data directory. Each refresh probes up to 12 candidates whose last attempt was at least 24 hours ago, and revisits up to 24 previously discovered boards with India jobs. An employer is promoted to regular refresh after its official feed returns matching India locations. `DISCOVER_EMPLOYERS=false` disables directory discovery. A custom `BHOLU_BOARDS_FILE` uses its own curated list.

Search applies posting dates, location, experience ranges, company, work arrangement, and job type before pagination when those filters are supplied. Provider date fields and local observation timestamps travel independently. Jobs with unknown dates are eligible under **Any date**. Historical jobs present before the first-seen migration use their earliest known observation at migration time.

## Public deployment

For a server with Docker Compose and a DNS hostname pointing to it, use the HTTPS override. Set `BHOLU_PUBLIC_HOST` to the hostname and `POSTGRES_PASSWORD` to a unique password through the server's environment. Allow incoming HTTPS and HTTP for certificate issuance. Caddy provisions and renews the certificate. The catalogue API listens on loopback at the host level and PostgreSQL stays on the Compose network. [Caddy HTTPS requirements](https://caddyserver.com/docs/automatic-https#hostname-requirements)

```sh
docker compose -f compose.yaml -f compose.https.yaml up -d --build
curl -fsS "https://${BHOLU_PUBLIC_HOST}/health"
```

On Android 2.1.13 or later, open **Jobs → Company careers → Shared job catalogue** and enter the HTTPS base address. **Check and save** verifies the address and refreshes jobs. Clear the field to restore the sources that ship with the APK. A public build can include the same address as the built-in default so users can start searching immediately.

Run the API and worker with the same production database behind a rate-limiting HTTPS reverse proxy. Keep `DATABASE_URL` and any provider keys in server secrets. Point the Android build at the public HTTPS base URL with `--dart-define=BHOLU_CATALOG_URL=https://your-catalog-host`. For the unsigned Gradle build, pass the Base64 encoding of `BHOLU_CATALOG_URL=https://your-catalog-host` as `-Pdart-defines=...` to `:app:assembleRelease`. The client falls back to employer feeds if the catalogue is temporarily unavailable.

The broad index is optional. Set `FREEHIRE_LICENSED=true` and `FREEHIRE_API_KEY` on the API and worker only when an active plan permits app display. This source refreshes a recent India software sample of up to 400 postings per run. Remove the flag or key to stop serving it. Never put the secret in the APK or enable personal-index mode for public distribution. [Data licence](https://freehire.me/terms#data-licence-for-api-plans)

## Glassdoor results

The Glassdoor browser entry is separate from shared search. To show Glassdoor listings in shared results, obtain a feed whose agreement covers indexing and displaying jobs in Bholu, including its attribution requirements. [Glassdoor API terms](https://www.glassdoor.com/crs/api/glassdoor-public-api-terms.pdf)

Set `GLASSDOOR_LICENSED=true` and `GLASSDOOR_FEED_URL` on the API and worker. Set `GLASSDOOR_FEED_TOKEN` as a server secret. The URL must be an HTTPS endpoint that supplies the Bholu snapshot format below. Adapt the provider payload to this format when setting up the feed. The worker requests it with bearer authentication.

```json
{
  "complete": true,
  "jobs": [
    {
      "title": "Junior Java Engineer",
      "company": "Example Employer",
      "location": "Bengaluru, India",
      "applyUrl": "https://example.com/jobs/42",
      "description": "Build Java services.",
      "postedAt": "2026-11-24T09:00:00Z"
    }
  ]
}
```

Each refresh expects a complete snapshot of the open listings within the agreed scope. The worker preserves the supplied posting date for recency filters. The feed can also provide `validThrough`, `employmentType`, `workplace`, `minimumExperience`, or `closed`. Disabling the source and restarting the API hides its indexed listings from search and job details. Glassdoor’s Android browser entry alone supplies no listings to the catalogue.

## Checks

`npm test` checks feed parsing. Set `BHOLU_CATALOG_TEST_DATABASE` to a dedicated test database connection string to also exercise real PostgreSQL and the HTTP endpoints. Tests insert temporary rows and clean them up after the run.

## Web job links

Set the server-side secret `SERPAPI_KEY` on the API service to enable `POST /v1/web-job-search`. The app sends search terms derived from selected roles, recognised skills and filters. It does not transmit résumé text as part of this feature. Users can also open the prepared query on Google without a catalogue connection.

Search is restricted to recognised employer posting URLs. Google’s date filter refers to web search recency and does not establish the employer’s posting date or whether the role is still open. Results are links with snippets, and tapping one opens the employer’s page. The endpoint caches searches for 15 minutes. Set `WEB_SEARCH_DAILY_LIMIT` to control the upstream request budget per API instance and rate-limit the route at the public reverse proxy. [SerpApi Google Search documentation](https://serpapi.com/search-api)

## No-card hosting with GitHub Actions and Cloudflare Workers Free

The personal deployment publishes a read-only catalogue of supported public India listings. The scheduled workflow runs the existing scanner every three hours, uses an ephemeral database, and deploys the resulting catalogue as static assets. It preserves recent feed state between successful runs when GitHub's cache is available. Android matches and filters the listings locally. If the snapshot is unavailable or older than 36 hours, Bholu falls back to employer feeds. The deployment excludes licensed feeds and requires no domain purchase.

1. Use a separate GitHub repository with the catalogue deployment bundle at the repository root. A public repository can use free standard GitHub-hosted runners. Keep the Android app, résumés, local credentials, and live database out of this repository.
2. Open **Workers & Pages** in Cloudflare and set up the free `workers.dev` subdomain. Create a Cloudflare **Edit Cloudflare Workers** API token scoped to this account.
3. In GitHub, open **Settings → Secrets and variables → Actions**. Add the token as repository secret `CLOUDFLARE_API_TOKEN` and your Cloudflare account ID as repository variable `CLOUDFLARE_ACCOUNT_ID`.
4. Open **Actions → Refresh public Bholu jobs → Run workflow**. After the first successful run, open `https://bholu-catalogue.YOUR-SUBDOMAIN.workers.dev/v1/public-catalogue/manifest.json` to check that it reports jobs and usable feeds.
5. In the updated Bholu APK, open **Jobs → Company careers → Shared job catalogue**. Enter `https://bholu-catalogue.YOUR-SUBDOMAIN.workers.dev/v1/public-catalogue` and tap **Check and save**. This same address can be set as `BHOLU_CATALOG_URL` at build time.

Scheduled runs can start late. GitHub can disable scheduled runs in an inactive public repository after 60 days. Check the Actions run history if the app falls back to direct boards. [Cloudflare setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) · [GitHub scheduling](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
