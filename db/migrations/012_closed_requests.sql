-- A request the shopper gave up on is closed (status 'expired') and its held money is freed. What the shopper said is kept,
-- so the request still shows why it was not bought, and the closest option, after the page is reloaded.
alter table mandates add column closed_outcome jsonb;
