-- The shops each person has allowed. The Shops screen edits this, and the guard enforces it.
-- A shop with no row here counts as unknown, and unknown shops are refused.

create table user_shops (
  user_id uuid not null references users(id),
  shop_id text not null references shops(id),
  status text not null check (status in ('allowed', 'ask_every_time', 'blocked')),
  updated_at timestamptz not null default now(),
  primary key (user_id, shop_id)
);
