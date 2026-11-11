-- What the shopper agent saw, and what it proposed.

-- A saved copy of a page, kept so quotes can be checked later and so a wrong delivery can be
-- compared against what the listing said at the time of purchase.
create table snapshots (
  id uuid primary key default gen_random_uuid(),
  mandate_id uuid not null references mandates(id),
  shop_id text references shops(id),
  url text not null,
  title text not null default '',
  text text not null,
  -- sha256 of the text, so a later change to the page is detectable.
  fingerprint text not null,
  fetched_at timestamptz not null default now()
);
create index snapshots_mandate on snapshots (mandate_id, fetched_at);

create table proposals (
  id text primary key,
  mandate_id uuid not null references mandates(id),
  snapshot_id uuid not null references snapshots(id),
  shop_id text not null references shops(id),
  item_key text not null,
  category text not null,
  total_cents integer not null check (total_cents > 0),
  delivery_by date,
  claims jsonb not null,
  seller_score integer,
  reasoning text not null default '',
  -- What the guard said when the proposal was made. The payment service asks again before paying.
  decision text not null check (decision in ('allow', 'ask', 'deny')),
  checks jsonb not null,
  created_at timestamptz not null default now()
);
create index proposals_mandate on proposals (mandate_id, created_at);
