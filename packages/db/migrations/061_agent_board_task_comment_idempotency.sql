alter table agent_board_task_comments add column if not exists idempotency_key_sha256 text;
alter table agent_board_task_comments add column if not exists create_fingerprint text;

update agent_board_task_comments
set idempotency_key_sha256 = encode(sha256(convert_to(id || ':legacy-key', 'UTF8')), 'hex')
where idempotency_key_sha256 is null;

update agent_board_task_comments
set create_fingerprint = encode(sha256(convert_to(id || ':legacy-comment', 'UTF8')), 'hex')
where create_fingerprint is null;

alter table agent_board_task_comments alter column idempotency_key_sha256 set not null;
alter table agent_board_task_comments alter column create_fingerprint set not null;

alter table agent_board_task_comments drop constraint if exists agent_board_task_comments_idempotency_key_sha256_check;
alter table agent_board_task_comments add constraint agent_board_task_comments_idempotency_key_sha256_check check (idempotency_key_sha256 ~ '^[a-f0-9]{64}$');
alter table agent_board_task_comments drop constraint if exists agent_board_task_comments_create_fingerprint_check;
alter table agent_board_task_comments add constraint agent_board_task_comments_create_fingerprint_check check (create_fingerprint ~ '^[a-f0-9]{64}$');

create unique index if not exists agent_board_task_comments_idempotency_unique
on agent_board_task_comments(workspace_id,brand_id,board_id,task_id,idempotency_key_sha256);
