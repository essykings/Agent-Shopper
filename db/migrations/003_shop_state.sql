-- State for the simulated demo shops: price changes, and what each shop has received and shipped.

create table shop_state (
  shop_id text primary key references shops(id),
  -- Whole percent added to every listed price. -15 means 15% off. Used to simulate price drops and rises.
  price_adjust_pct integer not null default 0 check (price_adjust_pct between -90 and 200),
  updated_at timestamptz not null default now()
);

-- One row per order a demo shop has received.
create table shop_orders (
  order_id uuid primary key references orders(id),
  shop_id text not null references shops(id),
  item_key text not null,
  promised_by date not null,
  status text not null default 'received' check (status in ('received', 'shipped', 'delivered')),
  -- What was really in the box when it differs from the listing. Never shown on the shop's own
  -- pages: a shop would not admit it. The demo uses it to make "what arrived" for the case.
  shipped_item text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shop_orders_shop on shop_orders (shop_id, created_at);
