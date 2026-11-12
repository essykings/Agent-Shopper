-- Automatic aftercare: scripted demo events on a demo order, automatic refunds, and the notifications that tell the owner.

-- A price cut the shop applies to one order only (the demo's scripted price drop). It is on the shop's own order record,
-- so nothing about it changes what other people see on the shop's pages.
alter table shop_orders add column price_cut_pct integer not null default 0 check (price_cut_pct between 0 and 90);
-- Which scripted event this order got: 'price_drop', 'wrong_item', or null when none has been decided.
alter table shop_orders add column demo_event text;

-- Automatic refunds try a few times, a while apart, and then leave the case for the owner.
alter table cases add column auto_attempts integer not null default 0;
alter table cases add column auto_attempt_at timestamptz;

-- What the owner is told: a purchase, a refund, a problem. One row per thing that happened (dedupe_key says which).
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  kind text not null,
  text text not null,
  href text,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, dedupe_key)
);
create index notifications_user on notifications (user_id, created_at desc);
