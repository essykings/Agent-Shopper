-- People can connect their own PayPal sandbox account instead of the shared demo buyer.

-- Where each account's money comes from: the shared demo buyer, the person's own account, or nothing yet.
alter table users add column paypal_source text not null default 'demo' check (paypal_source in ('demo', 'own', 'none'));
-- The connected account's email, if PayPal tells us. Shown to the owner so they know which account it is.
alter table users add column paypal_email text;

-- A connection that was started and not finished yet. One per person: starting again replaces it.
create table pending_vault_setups (
  user_id uuid primary key references users(id),
  setup_token_id text not null,
  created_at timestamptz not null default now()
);

-- Starting a connection calls PayPal, so it is limited per address like everything else that costs something.
alter table admissions drop constraint admissions_kind_check;
alter table admissions add constraint admissions_kind_check check (kind in ('agent_run', 'purchase', 'signup', 'connect'));
