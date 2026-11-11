-- Demo accounts are created on demand, so creating one is limited per network address too.
alter table admissions drop constraint admissions_kind_check;
alter table admissions add constraint admissions_kind_check check (kind in ('agent_run', 'purchase', 'signup'));
