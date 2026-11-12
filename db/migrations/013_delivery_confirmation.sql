-- Once an order is delivered, the owner is asked to confirm it arrived as ordered. What they answered is kept here:
--   'arrived'  it arrived as ordered
--   'problem'  there is a problem with it (a refund follows only if the shop's own record backs that up)
alter table orders add column delivery_answer text check (delivery_answer in ('arrived', 'problem'));
alter table orders add column delivery_answered_at timestamptz;
