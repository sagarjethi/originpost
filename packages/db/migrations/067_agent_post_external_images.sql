-- Explicit editor handoff; waiting rows are excluded from worker polling.
alter table agent_post_runs drop constraint agent_post_runs_status_check;
alter table agent_post_runs add constraint agent_post_runs_status_check check(status in ('queued','researching','writing','generating','awaiting-image','composing','drafting','ready','blocked','failed','uncertain'));
