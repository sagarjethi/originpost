alter table monitor_runs drop constraint if exists monitor_runs_status_check;

alter table monitor_runs
  add constraint monitor_runs_status_check
  check (status in ('running', 'completed', 'failed', 'skipped'));

create index if not exists monitor_runs_workspace_status_started_idx
  on monitor_runs (workspace_id, status, started_at desc);
