import { readFile } from 'node:fs/promises';
import pg from 'pg';

const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');

export function database(connectionString = process.env.DATABASE_URL) {
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 12000 });
}

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('bholu.catalog.schema'))");
    await client.query('CREATE TABLE IF NOT EXISTS catalog_migrations (version int PRIMARY KEY)');
    const installed = await client.query('SELECT 1 FROM catalog_migrations WHERE version=1');
    if (!installed.rowCount) {
      const { rows: [existing] } = await client.query("SELECT to_regclass('catalog_feeds') AS feeds");
      // Refresh transactions always write the feed before writing its postings.
      if (existing.feeds) await client.query('LOCK TABLE catalog_feeds IN ACCESS EXCLUSIVE MODE');
      await client.query(schema);
      await client.query('INSERT INTO catalog_migrations (version) VALUES (1)');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceFeed(pool, feed, jobs, { complete = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const snapshot = new Date().toISOString();
    await client.query(`INSERT INTO catalog_feeds (id, employer, checked_at, succeeded_at, failure, live_india)
      VALUES ($1, $2, $3, $3, null, $4)
      ON CONFLICT (id) DO UPDATE SET checked_at=excluded.checked_at,
        succeeded_at=excluded.succeeded_at, failure=null,
        live_india=excluded.live_india`, [feed.id, feed.employer, snapshot, feed.discovered === true && jobs.length > 0]);
    for (let start = 0; start < jobs.length; start += 200) {
      await client.query(`WITH batch AS (
        SELECT item, item->>'id' AS id FROM jsonb_array_elements($3::jsonb) item
      ), remembered AS (
        INSERT INTO catalog_posting_history (canonical_id, first_seen_at)
        SELECT batch.id, coalesce(posting.first_seen_at, $2::timestamptz)
        FROM batch LEFT JOIN catalog_postings posting
          ON posting.feed_id = $1 AND posting.canonical_id = batch.id
        ON CONFLICT (canonical_id) DO UPDATE SET first_seen_at =
          least(catalog_posting_history.first_seen_at, excluded.first_seen_at)
        RETURNING canonical_id, first_seen_at
      ) INSERT INTO catalog_postings
        (feed_id, canonical_id, job, posted_at, valid_through, observed_at, first_seen_at)
        SELECT $1, batch.id, item, (item->>'posted')::timestamptz,
          (item->>'validThrough')::timestamptz, $2, remembered.first_seen_at
        FROM batch JOIN remembered ON remembered.canonical_id = batch.id
        ON CONFLICT (feed_id, canonical_id) DO UPDATE SET
          job=CASE WHEN excluded.job->>'detailPending' = 'true' THEN excluded.job ||
            jsonb_build_object('description', catalog_postings.job->>'description',
              'minimumExperience', catalog_postings.job->'minimumExperience',
              'posted', coalesce(excluded.job->>'posted', catalog_postings.job->>'posted'),
              'validThrough', coalesce(excluded.job->>'validThrough', catalog_postings.job->>'validThrough'))
            ELSE excluded.job END,
          posted_at=CASE WHEN excluded.job->>'detailPending' = 'true'
            THEN coalesce(excluded.posted_at, catalog_postings.posted_at) ELSE excluded.posted_at END,
          valid_through=CASE WHEN excluded.job->>'detailPending' = 'true'
            THEN coalesce(excluded.valid_through, catalog_postings.valid_through) ELSE excluded.valid_through END,
          observed_at=excluded.observed_at, first_seen_at=excluded.first_seen_at`,
      [feed.id, snapshot, JSON.stringify(jobs.slice(start, start + 200))]);
    }
    if (complete) {
      await client.query('DELETE FROM catalog_postings WHERE feed_id=$1 AND observed_at < $2', [feed.id, snapshot]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recordFailure(pool, feed, failure) {
  await pool.query(`INSERT INTO catalog_feeds (id, employer, checked_at, failure)
    VALUES ($1, $2, now(), $3)
    ON CONFLICT (id) DO UPDATE SET checked_at=excluded.checked_at, failure=excluded.failure`,
  [feed.id, feed.employer, failure]);
}

export async function coverage(pool, hiddenFeeds) {
  const { rows: [summary] } = await pool.query(`SELECT count(*)::int AS feeds,
    count(*) FILTER (WHERE succeeded_at >= now() - interval '36 hours')::int AS usable,
    count(*) FILTER (WHERE failure IS NOT NULL OR succeeded_at IS NULL
      OR succeeded_at < now() - interval '36 hours')::int AS delayed,
    max(succeeded_at) AS "indexedAt"
    FROM catalog_feeds WHERE id <> ALL($1::text[])`, [hiddenFeeds]);
  return summary;
}

export async function sourceHealth(pool, hiddenFeeds) {
  const { rows } = await pool.query(`SELECT employer, split_part(id, ':', 1) AS provider,
    checked_at AS "lastChecked", succeeded_at AS "lastSuccess",
    CASE WHEN succeeded_at IS NULL OR succeeded_at < now() - interval '36 hours'
      THEN 'unavailable' WHEN failure IS NOT NULL THEN 'delayed' ELSE 'current' END AS status
    FROM catalog_feeds WHERE id <> ALL($1::text[])
    ORDER BY lower(employer), id LIMIT 1000`, [hiddenFeeds]);
  return rows;
}

const aliases = {
  bengaluru: ['bengaluru', 'bangalore', 'blr'], bangalore: ['bengaluru', 'bangalore', 'blr'],
  gurugram: ['gurugram', 'gurgaon'], gurgaon: ['gurugram', 'gurgaon'],
};
const india = ['india', 'bengaluru', 'bangalore', 'pune', 'hyderabad', 'mumbai', 'delhi',
  'ncr', 'chennai', 'kolkata', 'noida', 'gurgaon', 'gurugram', 'kochi', 'ahmedabad',
  'bhubaneswar', 'vadodara', 'coimbatore', 'remote india'];

export async function search(pool, query, hiddenFeeds) {
  const cities = [...new Set(query.cities.flatMap(city => aliases[city] ?? [city]))];
  const places = cities.length && !cities.includes('india') ? cities : [...new Set([...cities, ...india])];
  const recent = query.days ? query.days : null;
  const { rows: [answer] } = await pool.query(`WITH matching AS (
      SELECT DISTINCT ON (canonical_id) canonical_id,
        job || jsonb_build_object('firstSeenAt', first_seen_at, 'lastSeenAt', observed_at) AS job, posted_at,
        (SELECT count(*) FROM unnest($1::text[]) AS term
          WHERE to_tsvector('simple', job->>'title') @@ plainto_tsquery('simple', term)) +
        3 * (SELECT count(*) FROM unnest($15::text[]) AS term
          WHERE to_tsvector('simple', job->>'title') @@ plainto_tsquery('simple', term)) AS relevance
      FROM catalog_postings
      CROSS JOIN LATERAL (SELECT coalesce((job->>'minimumExperience')::int,
        CASE WHEN $13 AND job->>'title' ~* '\\m(fresher|entry.level|new.grad|graduate|trainee|intern|internship)\\M'
          THEN 0 END) AS years) experience
      WHERE feed_id <> ALL($2::text[])
        AND observed_at >= now() - interval '36 hours'
        AND (valid_through IS NULL OR valid_through >= now())
        AND (posted_at IS NULL OR posted_at <= now())
        AND (EXISTS (SELECT 1 FROM unnest($3::text[]) AS city
          WHERE (' ' || regexp_replace(lower(job->>'location'), '[^a-z0-9]+', ' ', 'g') || ' ')
            LIKE ('% ' || city || ' %'))
          OR ($4 AND lower(job->>'location') LIKE '%remote%' AND lower(job->>'location') LIKE '%india%'))
        AND (cardinality($1::text[]) = 0 OR EXISTS (SELECT 1 FROM unnest($1::text[]) AS term
          WHERE document @@ plainto_tsquery('simple', term)))
        AND ($5 OR (NOT lower(job->>'title') ~ '\\m(senior|sr|staff|principal|director|manager|mgr|architect|lead|advanced)\\M'))
        AND ($7::int IS DISTINCT FROM 0 OR NOT lower(job->>'title') ~ '\\m(engineer|developer|swe|sde) (iii|iv|v)\\M')
        AND ($6 OR (job->>'kind' <> 'Internship' AND NOT lower(job->>'title') ~ '\\m(intern|internship)\\M'))
        AND ($14 = '' OR lower(job->>'company') = lower($14))
        AND ($16 = '' OR coalesce(nullif(job->>'workplace', ''), CASE
          WHEN job->>'location' ~* '\\mhybrid\\M' THEN 'Hybrid'
          WHEN job->>'location' ~* '\\mremote\\M' THEN 'Remote'
          WHEN job->>'location' ~* '\\mon[ -]?site\\M' THEN 'Onsite' END) = $16)
        AND ($17 = '' OR coalesce(nullif(job->>'kind', ''), CASE
          WHEN job->>'title' ~* '\\m(intern|internship|co-op)\\M' THEN 'Internship' END) = $17)
        AND ((($12::int IS NULL OR experience.years >= $12) AND
              ($7::int IS NULL OR experience.years <= $7) AND experience.years IS NOT NULL)
          OR ($13 AND experience.years IS NULL))
      ORDER BY canonical_id, (posted_at IS NULL), (feed_id LIKE 'licensed:%'), observed_at DESC
    ), windowed AS (
      SELECT * FROM matching WHERE $8::int IS NULL OR posted_at >= now() - make_interval(days => $8)
    )
    SELECT (SELECT count(*)::int FROM windowed) AS total,
      (SELECT json_build_object('1', count(*) FILTER (WHERE posted_at >= now() - interval '24 hours'),
        '3', count(*) FILTER (WHERE posted_at >= now() - interval '3 days'),
        '7', count(*) FILTER (WHERE posted_at >= now() - interval '7 days')) FROM matching) AS counts,
      (SELECT coalesce(json_agg(page.job), '[]') FROM (SELECT job FROM windowed
        ORDER BY CASE WHEN $9 THEN relevance ELSE 0 END DESC,
          posted_at DESC NULLS LAST, canonical_id LIMIT $10 OFFSET $11) page) AS jobs`,
  [query.terms, hiddenFeeds, places, query.remote, query.senior, query.internships,
    query.maxExperience, recent, query.bestMatch, query.limit, query.offset,
    query.minExperience, query.includeUnknownExperience, query.company, query.roles,
    query.workplace, query.kind]);
  return { ...answer, coverage: await coverage(pool, hiddenFeeds) };
}
