-- Shops we can pay, the saved PayPal on each user, and one row per purchase.

alter table users add column paypal_vault_id text;

create table shops (
  id text primary key,
  name text not null,
  -- Where Payouts sends the money for this shop (a sandbox business account for now).
  payout_email text not null,
  created_at timestamptz not null default now()
);

-- Order life:  authorizing -> authorized -> captured -> paid_out
--   payout_pending / payout_failed: the buyer was charged but the shop is not paid yet.
--   cancelled: authorized, then stopped (nothing charged).   failed: PayPal refused it.
create table orders (
  id uuid primary key,
  user_id uuid not null references users(id),
  mandate_id uuid not null references mandates(id),
  shop_id text not null references shops(id),
  proposal_id text not null,
  total_cents integer not null check (total_cents > 0),
  status text not null check (status in (
    'authorizing', 'authorized', 'captured', 'paid_out',
    'payout_pending', 'payout_failed', 'cancelled', 'failed'
  )),
  paypal_order_id text,
  paypal_authorization_id text,
  paypal_capture_id text,
  payout_batch_id text,
  payout_attempts integer not null default 0,
  failure text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A request can have only one live order. This is what stops a double purchase,
-- even if two buys start at the same moment.
create unique index orders_one_live_per_mandate on orders (mandate_id)
  where status not in ('cancelled', 'failed');
create index orders_user on orders (user_id, created_at);
