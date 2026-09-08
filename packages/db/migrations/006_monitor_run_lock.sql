create unique index if not exists monitor_runs_one_active_per_monitor_idx
  on monitor_runs (workspace_id, monitor_id)
  where status = 'running';
