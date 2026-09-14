-- Separate copy review is a persisted stage with its own runtime receipt.
alter table agent_post_runs drop constraint agent_post_runs_status_check;
alter table agent_post_runs add constraint agent_post_runs_status_check check(status in ('queued','researching','writing','reviewing-copy','generating','awaiting-image','composing','drafting','ready','blocked','failed','uncertain'));
alter table agent_run_ledger drop constraint agent_run_ledger_feature_check;
alter table agent_run_ledger add constraint agent_run_ledger_feature_check check(feature in ('draft_assist','copy_review'));
