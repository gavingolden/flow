create table reports (
  id text primary key,
  company text not null,
  status text not null default 'queued',
  created_at timestamptz not null default now()
);

create table sections (
  id text primary key,
  report_id text not null references reports(id),
  name text not null,
  position int not null,
  body text
);
