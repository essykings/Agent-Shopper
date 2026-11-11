-- Gift requests: a goal ("a Christmas gift for Dad who likes hiking") instead of one named item.
-- The shopper proposes up to three picks, kept together by run_id, and the owner chooses one.

alter table mandates
  add column kind text not null default 'item' check (kind in ('item', 'gift')),
  add column goal jsonb;

alter table proposals add column run_id text;
create index proposals_run on proposals (mandate_id, run_id);
