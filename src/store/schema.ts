export const SCHEMA_VERSION = 1

export const SCHEMA = `
create table meta (key text primary key, value text not null);
create table blob (
  oid text primary key,
  language text not null,
  bytes integer not null,
  status text not null,
  parse_errors integer not null,
  indexed_at text not null
);
create table symbol (
  id integer primary key,
  blob_oid text not null references blob(oid) on delete cascade,
  kind text not null,
  name text not null,
  parent_id integer,
  container text,
  start_line integer not null,
  end_line integer not null,
  exported integer not null,
  signature text not null
);
create table import_item (
  blob_oid text not null references blob(oid) on delete cascade,
  module text not null,
  name text,
  alias text,
  kind text not null,
  line integer not null
);
create table export_item (
  blob_oid text not null references blob(oid) on delete cascade,
  name text not null,
  local_name text,
  module text,
  line integer not null
);
create table call_site (
  blob_oid text not null references blob(oid) on delete cascade,
  caller_id integer,
  name text not null,
  qualifier text,
  line integer not null,
  constructs integer not null
);
create table heritage (
  symbol_id integer not null references symbol(id) on delete cascade,
  name text not null,
  relation text not null
);
create table snapshot (
  sha text primary key,
  ref text not null,
  indexed_at text not null,
  duration_ms integer not null,
  seq integer not null
);
create table snapshot_file (
  commit_sha text not null references snapshot(sha) on delete cascade,
  path text not null,
  blob_oid text,
  language text,
  status text not null,
  primary key (commit_sha, path)
);
create index symbol_name on symbol(name);
create index symbol_blob on symbol(blob_oid);
create index call_name on call_site(name);
create index call_blob on call_site(blob_oid);
create index import_blob on import_item(blob_oid);
create index export_blob on export_item(blob_oid);
create index heritage_symbol on heritage(symbol_id);
create index snapshot_file_blob on snapshot_file(blob_oid);
`
