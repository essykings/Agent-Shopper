-- Core tables: people, their allowance, their requests (mandates), and the append-only ledger.
-- All money is whole cents.

create table users (
  id uuid primary key default gen_random_uuid(),
  paypal_payer_id text unique,
  email text,
  name text,
  created_at timestamptz not null default now()
);

create table accounts (
  user_id uuid primary key references users(id),
  monthly_allowance_cents integer not null check (monthly_allowance_cents >= 0),
  paused boolean not null default false,
  updated_at timestamptz not null default now()
);

-- A request you confirmed once. These are the rules the guard enforces.
create table mandates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  item text not null,
  condition text not null check (condition in ('new', 'any')),
  max_price_cents integer not null check (max_price_cents > 0),
  ask_above_cents integer not null check (ask_above_cents > 0),
  deadline date not null,
  seller_min_score integer not null check (seller_min_score between 0 and 100),
  never_buy text[] not null default '{}',
  -- Bookkeeping only: how much of the allowance this request may use. No money moves.
  set_aside_cents integer not null check (set_aside_cents >= max_price_cents),
  status text not null default 'active' check (status in ('active', 'paused', 'fulfilled', 'expired', 'cancelled')),
  created_at timestamptz not null default now(),
  check (ask_above_cents <= max_price_cents)
);
create index mandates_user_status on mandates (user_id, status);

-- The ledger. Rows are only ever added. Nothing can edit or delete them.
create table ledger_entries (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid not null references users(id),
  mandate_id uuid references mandates(id),
  kind text not null check (kind in (
    'allowance_set', 'set_aside', 'set_aside_release',
    'guard_allow', 'guard_ask', 'guard_deny', 'owner_approved', 'owner_declined',
    'payment_captured', 'payout_sent', 'refund_received',
    'dispute_opened', 'note'
  )),
  amount_cents bigint not null default 0,
  -- A retry or a repeated webhook with the same key is stored once.
  idempotency_key text unique,
  detail jsonb not null default '{}'::jsonb
);
create index ledger_user_at on ledger_entries (user_id, at);
create index ledger_mandate on ledger_entries (mandate_id);

create function ledger_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger entries cannot be changed or deleted';
end;
$$;

create trigger ledger_no_update_delete
  before update or delete on ledger_entries
  for each row execute function ledger_is_append_only();

create trigger ledger_no_truncate
  before truncate on ledger_entries
  for each statement execute function ledger_is_append_only();
