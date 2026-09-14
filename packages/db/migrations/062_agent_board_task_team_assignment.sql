update agent_board_tasks
set assignee='team', payload=jsonb_set(payload,'{assignee}','"team"'::jsonb,true), updated_at=now()
where assignee='board-agent';

alter table agent_board_tasks drop constraint if exists agent_board_tasks_assignee_check;
alter table agent_board_tasks add constraint agent_board_tasks_assignee_check check (assignee = 'team');
