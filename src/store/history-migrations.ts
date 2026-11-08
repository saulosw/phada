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
  {
    version: 5,
    rebuildsTables: true,
    sql: `
create table run_rebuilt (
  id integer primary key,
  job_id integer references job (id),
  source text not null check (source in ('watch', 'manual', 'replay')),
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
  result_json text,
  verdict text check (verdict in ('clean', 'comments', 'blocking', 'failed', 'skipped')),
  request_source text
    check (request_source in ('watch', 'enqueue', 'mcp', 'pr-command', 'slack'))
);
insert into run_rebuilt (id, job_id, source, repo, number, head_sha, started_at, finished_at,
  status, ai_called, provider, model, score, findings, url, reason, error_kind, error,
  result_json, verdict, request_source)
  select id, job_id, source, repo, number, head_sha, started_at, finished_at, status, ai_called,
    provider, model, score, findings, url, reason, error_kind, error, result_json, verdict,
    request_source from run;
drop table run;
alter table run_rebuilt rename to run;
create index run_by_source on run (source, started_at);
create index run_by_job on run (job_id);
create table miss (
  id integer primary key,
  repo text not null,
  number integer not null,
  reviewed_sha text not null,
  commit_sha text,
  thread_id text not null unique,
  thread_url text,
  file text not null,
  start_line integer,
  line integer,
  author text not null,
  role text not null
    check (role in ('owner', 'member', 'collaborator', 'contributor', 'external')),
  body text not null,
  created_at text,
  harvested_at text not null,
  state text not null default 'open' check (state in ('open', 'dismissed'))
);
create index miss_by_pull on miss (repo, number);
create table miss_replay (
  miss_id integer not null references miss (id) on delete cascade,
  version text not null,
  run_id integer references run (id) on delete set null,
  outcome text not null check (outcome in ('caught', 'missed')),
  replayed_at text not null,
  primary key (miss_id, version)
);
`,
  },
  {
    version: 6,
    rebuildsTables: true,
    sql: `
create table miss_rebuilt (
  id integer primary key,
  key text not null unique,
  origin text not null check (origin in ('person', 'bot', 'phada')),
  seen text not null check (seen in ('missed-live', 'not-reviewed')),
  repo text not null,
  number integer not null,
  reviewed_sha text,
  commit_sha text,
  thread_id text,
  thread_url text,
  file text not null,
  start_line integer,
  line integer,
  author text not null,
  role text
    check (role in ('owner', 'member', 'collaborator', 'contributor', 'external')),
  body text not null,
  created_at text,
  harvested_at text not null,
  state text not null default 'open' check (state in ('open', 'dismissed'))
);
insert into miss_rebuilt (id, key, origin, seen, repo, number, reviewed_sha, commit_sha,
  thread_id, thread_url, file, start_line, line, author, role, body, created_at, harvested_at,
  state)
  select id, thread_id, 'person', 'missed-live', repo, number, reviewed_sha, commit_sha,
    thread_id, thread_url, file, start_line, line, author, role, body, created_at, harvested_at,
    state from miss;
drop table miss;
alter table miss_rebuilt rename to miss;
create index miss_by_pull on miss (repo, number);
`,
  },
  {
    version: 7,
    sql: `
create table lesson (
  id integer primary key,
  repo text not null,
  rule text not null,
  scope text not null,
  state text not null default 'pending' check (state in ('pending', 'accepted', 'discarded')),
  provider text,
  model text,
  created_at text not null,
  decided_at text
);
create index lesson_by_repo on lesson (repo, state);
create table lesson_miss (
  lesson_id integer not null references lesson (id) on delete cascade,
  miss_id integer not null references miss (id) on delete cascade,
  primary key (lesson_id, miss_id)
);
create index lesson_miss_by_miss on lesson_miss (miss_id);
`,
  },
  {
    version: 8,
    rebuildsTables: true,
    sql: `
create table run_rebuilt (
  id integer primary key,
  job_id integer references job (id),
  source text not null check (source in ('watch', 'manual', 'replay', 'local')),
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
  result_json text,
  verdict text check (verdict in ('clean', 'comments', 'blocking', 'failed', 'skipped')),
  request_source text
    check (request_source in ('watch', 'enqueue', 'mcp', 'pr-command', 'slack')),
  branch text,
  dirty integer
);
insert into run_rebuilt (id, job_id, source, repo, number, head_sha, started_at, finished_at,
  status, ai_called, provider, model, score, findings, url, reason, error_kind, error,
  result_json, verdict, request_source)
  select id, job_id, source, repo, number, head_sha, started_at, finished_at, status, ai_called,
    provider, model, score, findings, url, reason, error_kind, error, result_json, verdict,
    request_source from run;
drop table run;
alter table run_rebuilt rename to run;
create index run_by_source on run (source, started_at);
create index run_by_job on run (job_id);
`,
  },
]
