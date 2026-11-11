-- Who started what, and what it cost. This is what the abuse limits count.
-- One row each time someone starts an agent run or a purchase. Unlike the ledger, old rows can be deleted.

create table admissions (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null check (kind in ('agent_run', 'purchase')),
  -- The caller's network address, as a bucket (an IPv6 address counts as its whole /64).
  ip_key text not null,
  user_id uuid references users(id),
  -- Worst-case cost set aside when the run starts, in millionths of a US dollar.
  reserved_micro_usd bigint not null default 0 check (reserved_micro_usd >= 0),
  -- What it really cost. Null until it finishes, or if it crashed (then the reservation counts).
  actual_micro_usd bigint check (actual_micro_usd >= 0),
  settled boolean not null default false,
  settled_at timestamptz
);
create index admissions_ip on admissions (kind, ip_key, at);
create index admissions_user on admissions (kind, user_id, at);
create index admissions_at on admissions (at);
