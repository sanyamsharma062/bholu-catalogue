CREATE TABLE IF NOT EXISTS catalog_feeds (
  id text PRIMARY KEY,
  employer text NOT NULL,
  checked_at timestamptz NOT NULL,
  succeeded_at timestamptz,
  failure text
);

CREATE TABLE IF NOT EXISTS catalog_postings (
  feed_id text NOT NULL REFERENCES catalog_feeds(id),
  canonical_id text NOT NULL,
  job jsonb NOT NULL,
  posted_at timestamptz,
  valid_through timestamptz,
  observed_at timestamptz NOT NULL,
  document tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(job->>'title', '') || ' ' ||
      coalesce(job->>'description', ''))
  ) STORED,
  PRIMARY KEY (feed_id, canonical_id)
);

CREATE INDEX IF NOT EXISTS catalog_postings_document_idx ON catalog_postings USING gin(document);
CREATE INDEX IF NOT EXISTS catalog_postings_date_idx ON catalog_postings (posted_at DESC);

ALTER TABLE catalog_postings ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;
UPDATE catalog_postings SET first_seen_at=observed_at WHERE first_seen_at IS NULL;
ALTER TABLE catalog_postings ALTER COLUMN first_seen_at SET DEFAULT now();

ALTER TABLE catalog_feeds ADD COLUMN IF NOT EXISTS live_india boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS catalog_posting_history (
  canonical_id text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL
);
