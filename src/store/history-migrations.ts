export interface HistoryMigration {
  version: number
  sql: string
  rebuildsTables?: boolean
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
  {
    version: 2,
    sql: `
create table feedback_pull (
  repo text not null,
  number integer not null,
  observed_at text not null,
  pull_state text not null check (pull_state in ('open', 'closed', 'merged')),
  primary key (repo, number)
);
create table finding (
  id integer primary key,
  repo text not null,
  number integer not null,
  commit_sha text,
  fingerprint text not null,
  file text not null,
  line integer,
  title text not null,
  severity text check (severity in ('P0', 'P1', 'P2')),
  confidence integer,
  rule text,
  run_id integer references run (id) on delete set null,
  thread_id text unique,
  thread_url text,
  outdated integer not null default 0,
  published_at text not null
);
create index finding_by_pull on finding (repo, number);
create table signal (
  id integer primary key,
  finding_id integer not null references finding (id) on delete cascade,
  kind text not null
    check (kind in ('fixed', 'dismissed', 'ignored', 'negative-reaction', 'human-reply')),
  source text not null check (source in ('watch', 'manual', 'refresh')),
  observed_at text not null,
  cleared_at text
);
create index signal_by_finding on signal (finding_id, kind);
`,
  },
  {
    version: 3,
    sql: `
alter table job add column publish text check (publish in ('pr', 'none'));
create table review_request (
  id integer primary key,
  job_id integer not null references job (id) on delete cascade,
  source text not null check (source in ('watch', 'enqueue', 'mcp', 'pr-command', 'slack')),
  publish text not null check (publish in ('pr', 'none')),
  data text,
  created_at text not null
);
create index request_by_job on review_request (job_id);
create index job_by_created on job (created_at);
alter table run add column verdict text
  check (verdict in ('clean', 'comments', 'blocking', 'failed', 'skipped'));
create index run_by_job on run (job_id);
alter table run add column request_source text
  check (request_source in ('watch', 'enqueue', 'mcp', 'pr-command', 'slack'));
alter table watched_repo add column comments_since text;
alter table watched_repo add column comments_etag text;
alter table watched_repo add column comments_last_id integer;
`,
  },
  {
    version: 4,
    rebuildsTables: true,
    sql: `
create table job_rebuilt (
  id integer primary key,
  repo text not null,
  number integer not null,
  head_sha text not null,
  status text not null
    check (status in ('queued', 'waiting', 'running', 'done', 'failed', 'skipped', 'superseded')),
  attempts integer not null default 0,
  not_before text not null,
  reason text,
  error_kind text,
  error text,
  created_at text not null,
  started_at text,
  finished_at text,
  publish text check (publish in ('pr', 'none')),
  ci_deadline text,
  ci_pending text,
  ci_failing text,
  ci_checked_at text,
  ci_since text
);
insert into job_rebuilt (id, repo, number, head_sha, status, attempts, not_before, reason,
  error_kind, error, created_at, started_at, finished_at, publish)
  select id, repo, number, head_sha, status, attempts, not_before, reason, error_kind, error,
    created_at, started_at, finished_at, publish from job;
drop table job;
alter table job_rebuilt rename to job;
create index job_by_status on job (status, not_before);
create index job_by_commit on job (repo, number, head_sha);
create index job_by_created on job (created_at);
`,
  },
]
