-- 0007_search: full-text search over the free text of tasks, handoffs, blockers and
-- progress notes. Each table gets a generated `tsv` column (the name every later phase
-- uses) built with the 'simple' configuration, so no language-specific stemming, and a GIN
-- index. Queries use websearch_to_tsquery('simple', ...). The columns are maintained by
-- Postgres and are not part of the Drizzle schema; core reads them with raw SQL only.
-- search() in context.ts concatenates the same columns for ts_headline; change them together.

ALTER TABLE tasks ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, title || ' ' || coalesce(description, ''))
) STORED;
CREATE INDEX tasks_tsv_idx ON tasks USING GIN (tsv);

ALTER TABLE handoffs ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig,
    delivered || ' ' || required_action || ' ' || coalesce(known_limits, '') || ' ' || coalesce(response_note, ''))
) STORED;
CREATE INDEX handoffs_tsv_idx ON handoffs USING GIN (tsv);

ALTER TABLE blockers ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, observed || ' ' || coalesce(cause, '') || ' ' || coalesce(resolution, ''))
) STORED;
CREATE INDEX blockers_tsv_idx ON blockers USING GIN (tsv);

ALTER TABLE progress_notes ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('simple'::regconfig, note)
) STORED;
CREATE INDEX progress_notes_tsv_idx ON progress_notes USING GIN (tsv);

-- getByRef looks evidence up by exact URL within a project.
CREATE INDEX evidence_project_url_idx ON evidence (project_id, url);
