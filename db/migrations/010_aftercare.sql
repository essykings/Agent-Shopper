-- Aftercare: what happens after a purchase. Refunds, and the cases that lead to them.

-- How much of an order has been refunded. The database itself refuses to refund more than was paid.
alter table orders add column refunded_cents integer not null default 0
  check (refunded_cents >= 0 and refunded_cents <= total_cents);

-- A case is a problem found with an order, with the evidence for it and what was done.
--   price_drop:  the shop's price fell inside its price-protection window
--   wrong_item:  what the shop shipped is not what was listed
--   dispute:     a dispute PayPal told us about
create table cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  order_id uuid not null references orders(id),
  kind text not null check (kind in ('price_drop', 'wrong_item', 'dispute')),
  status text not null default 'open' check (status in ('open', 'refunded', 'expired', 'declined', 'closed')),
  -- What the rules say to refund. Worked out by code, never taken from a screen or a model.
  amount_cents integer not null default 0 check (amount_cents >= 0),
  summary text not null default '',
  evidence jsonb not null default '{}'::jsonb,
  -- A message the shopper drafted from the evidence. Words for a person to read, never used to decide anything.
  draft text,
  refund_id text,
  failure text,
  -- For disputes: PayPal's own id for it.
  external_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One price-drop case and one wrong-item case per order. Disputes are told apart by PayPal's id.
create unique index cases_one_per_order_kind on cases (order_id, kind) where kind <> 'dispute';
create unique index cases_external on cases (external_id) where external_id is not null;
create index cases_user on cases (user_id, created_at);

-- Every webhook PayPal sent that passed the signature check, so a repeat is recognised and ignored.
create table webhook_events (
  id text primary key,
  event_type text not null,
  outcome text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
