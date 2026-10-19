export interface HistoryMigration {
  version: number
  sql: string
}

export const HISTORY_MIGRATIONS: readonly HistoryMigration[] = [
  {
    version: 1,
    sql: `
create table watched_repo (
  repo text primary key,
  pulls_etag text,
  baseline_at text,
  checked_at text,
  branch_etag text,
  branch_checked_at text,
  indexed_sha text
);
create table watched_pull (
  repo text not null,
  number integer not null,
  head_sha text not null,
  head_seen_at text not null,
  baseline_sha text,
  eligible integer not null,
  state text not null check (state in ('open', 'gone')),
  primary key (repo, number)
);
create table job (
  id integer primary key,
  repo text not null,
  number integer not null,
  head_sha text not null,
  status text not null
    check (status in ('queued', 'running', 'done', 'failed', 'skipped', 'superseded')),
  attempts integer not null default 0,
  not_before text not null,
  reason text,
  error_kind text,
  error text,
  created_at text not null,
  started_at text,
  finished_at text
);
create index job_by_status on job (status, not_before);
create index job_by_commit on job (repo, number, head_sha);
create table run (
  id integer primary key,
  job_id integer references job (id),
  source text not null check (source in ('watch', 'manual')),
  repo text not null,
  number integer not null,
  head_sha text not null,
  started_at text not null,
  finished_at text not null,
  status text not null
    check (status in ('published', 'dry-run', 'not-published', 'superseded', 'skipped', 'nothing', 'failed')),
  ai_called integer not null,
  provider text,
  model text,
  score real,
  findings integer,
  url text,
  reason text,
  error_kind text,
  error text,
  result_json text
);
create index run_by_source on run (source, started_at);
create table watch_state (key text primary key, value text not null);
`,
  },
]
