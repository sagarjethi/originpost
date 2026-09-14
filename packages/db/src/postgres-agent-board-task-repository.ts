import {
  agentBoardTaskContentHandoffFingerprint,
  agentBoardTaskExecutionFingerprint,
  claimAgentBoardTaskExecution,
  DomainError,
  expireAgentBoardTaskExecution,
  type AgentBoardTask,
  type AgentBoardTaskComment,
  type AgentBoardTaskContentHandoff,
  type AgentBoardTaskExecution,
  type AgentBoardTaskRepository,
  type AuditEvent,
  type ContentItem,
  type OutboxMessageInput,
} from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type TaskRow = { payload: AgentBoardTask };
type DependencyRow = { id: string; status: string; completed_at: string | null };
type CommentRow = { payload: AgentBoardTaskComment };
type ExecutionRow = { payload: AgentBoardTaskExecution; now?: Date };
type ContentHandoffRow = { payload: AgentBoardTaskContentHandoff };
type BoardScope = { workspaceId: string; brandId: string; boardId: string };

async function audit(sql: Sql | TransactionSql, event: AuditEvent) {
  await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at) values(${event.id},${event.workspaceId},${event.contentItemId ?? null},${event.actorId},${event.actorType},${event.action},${sql.json(event.detail as never)},${event.createdAt}) on conflict(id) do nothing`;
}

async function outbox(sql: Sql | TransactionSql, value: OutboxMessageInput) {
  const rows = await sql<{ id: string }[]>`insert into outbox_events(id,workspace_id,topic,dedupe_key,payload,available_at,created_at) values(${value.id},${value.workspaceId},${value.topic},${value.dedupeKey},${sql.json(value.payload as never)},${value.availableAt},${value.createdAt}) returning id`;
  if (!rows[0]) throw new Error("Board task execution outbox command was not persisted.");
}

async function lockBoard(sql: TransactionSql, task: BoardScope) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([task.workspaceId, task.brandId, task.boardId])},0))`;
}

async function assertBoardWritable(sql: TransactionSql, scope: BoardScope) {
  const rows = await sql<{ status: string }[]>`select status from agent_boards where workspace_id=${scope.workspaceId} and brand_id=${scope.brandId} and id=${scope.boardId} for update`;
  if (!rows[0]) throw new DomainError("Board not found.", "agent_board_not_found", 404);
  if (rows[0].status === "archived") throw new DomainError("Archived Boards are read-only.", "agent_board_archived", 409);
}

async function dependencyRows(sql: TransactionSql, task: AgentBoardTask): Promise<DependencyRow[]> {
  if (task.parentTaskIds.length === 0) return [];
  return sql<DependencyRow[]>`select id,status,completed_at from agent_board_tasks where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and id=any(${task.parentTaskIds}) order by id for update`;
}

function assertDependenciesExist(task: AgentBoardTask, parents: DependencyRow[]) {
  if (task.parentTaskIds.includes(task.id) || parents.length !== task.parentTaskIds.length) {
    throw new DomainError("A Board task dependency does not exist in this Board.", "agent_board_task_dependencies_invalid", 409);
  }
}

function assertDependenciesComplete(task: AgentBoardTask, parents: DependencyRow[]) {
  if (["ready", "running", "review", "done"].includes(task.status) && parents.some((parent) => !parent.completed_at || !["done", "archived"].includes(parent.status))) {
    throw new DomainError("Finish this task's dependencies before moving it forward.", "agent_board_task_dependencies_open", 409);
  }
}

function mapConstraint(error: unknown): never {
  const value = error as { code?: string; constraint_name?: string; constraint?: string };
  const constraint = value.constraint_name ?? value.constraint;
  if (constraint === "agent_board_tasks_idempotency_unique") throw new DomainError("This Board task Idempotency-Key already exists.", "idempotency_key_conflict", 409);
  if (constraint === "agent_board_task_comments_idempotency_unique") throw new DomainError("This Board task comment Idempotency-Key already exists.", "idempotency_key_conflict", 409);
  if (constraint === "agent_board_task_comments_pkey") throw new DomainError("Board task comment already exists.", "agent_board_task_comment_exists", 409);
  if (constraint === "board_task_executions_idempotency_unique") throw new DomainError("This Board task release Idempotency-Key already exists.", "idempotency_key_conflict", 409);
  if (constraint === "board_task_executions_pkey") throw new DomainError("Board task execution already exists.", "agent_board_task_execution_exists", 409);
  if (constraint === "board_task_content_handoffs_idempotency_unique") throw new DomainError("This Board-to-Content Idempotency-Key already exists.", "idempotency_key_conflict", 409);
  if (constraint === "board_task_content_handoffs_execution_unique" || constraint === "board_task_content_handoffs_content_unique") throw new DomainError("This Board execution already has a Content handoff.", "agent_board_task_execution_handoff_exists", 409);
  if (constraint === "board_task_content_handoffs_pkey" || constraint === "content_items_pkey") throw new DomainError("This Board-to-Content handoff already exists.", "agent_board_task_execution_handoff_exists", 409);
  if (constraint === "agent_board_tasks_pkey" || constraint === "agent_board_tasks_scope_unique") throw new DomainError("Board task already exists.", "agent_board_task_exists", 409);
  if (value.code === "23503") throw new DomainError("A Board task dependency does not exist in this Board.", "agent_board_task_dependencies_invalid", 409);
  throw error;
}

function sameTaskIdentity(next: AgentBoardTask, current: AgentBoardTask): boolean {
  return next.id === current.id
    && next.workspaceId === current.workspaceId
    && next.brandId === current.brandId
    && next.boardId === current.boardId
    && next.idempotencyKeySha256 === current.idempotencyKeySha256
    && next.createFingerprint === current.createFingerprint
    && next.createdBy === current.createdBy
    && next.createdAt === current.createdAt;
}

function sameExecutionIdentity(next: AgentBoardTaskExecution, current: AgentBoardTaskExecution): boolean {
  return next.id === current.id
    && next.workspaceId === current.workspaceId
    && next.brandId === current.brandId
    && next.boardId === current.boardId
    && next.taskId === current.taskId
    && next.configurationEpoch === current.configurationEpoch
    && next.capabilityEpoch === current.capabilityEpoch
    && next.taskVersion === current.taskVersion
    && next.idempotencyKeySha256 === current.idempotencyKeySha256
    && next.createFingerprint === current.createFingerprint
    && next.requestSha256 === current.requestSha256
    && next.createdBy === current.createdBy
    && next.createdAt === current.createdAt;
}

export class PostgresAgentBoardTaskRepository implements AgentBoardTaskRepository {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string, brandId: string, boardId: string, includeArchived = false) {
    const rows = await this.sql<TaskRow[]>`select payload from agent_board_tasks where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and (${includeArchived} or status<>'archived') order by updated_at desc,id`;
    return rows.map((row) => row.payload);
  }

  async get(workspaceId: string, brandId: string, boardId: string, taskId: string) {
    const rows = await this.sql<TaskRow[]>`select payload from agent_board_tasks where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and id=${taskId} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async getByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, idempotencyKeySha256: string) {
    const rows = await this.sql<TaskRow[]>`select payload from agent_board_tasks where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and idempotency_key_sha256=${idempotencyKeySha256} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async create(task: AgentBoardTask, event: AuditEvent) {
    try {
      await this.sql.begin(async (sql) => {
        await lockBoard(sql, task);
        await assertBoardWritable(sql, task);
        const parents = await dependencyRows(sql, task);
        assertDependenciesExist(task, parents);
        assertDependenciesComplete(task, parents);
        await sql`insert into agent_board_tasks(id,workspace_id,brand_id,board_id,version,title,status,priority,assignee,idempotency_key_sha256,create_fingerprint,payload,created_by,completed_at,created_at,updated_at) values(${task.id},${task.workspaceId},${task.brandId},${task.boardId},${task.version},${task.title},${task.status},${task.priority},${task.assignee},${task.idempotencyKeySha256},${task.createFingerprint},${sql.json(task as never)},${task.createdBy},${task.completedAt ?? null},${task.createdAt},${task.updatedAt})`;
        for (const parentTaskId of task.parentTaskIds) {
          await sql`insert into agent_board_task_links(workspace_id,brand_id,board_id,parent_task_id,child_task_id,created_at) values(${task.workspaceId},${task.brandId},${task.boardId},${parentTaskId},${task.id},${task.createdAt})`;
        }
        await audit(sql, event);
      });
    } catch (error) {
      mapConstraint(error);
    }
  }

  async update(task: AgentBoardTask, expectedVersion: number, event: AuditEvent) {
    try {
      return await this.sql.begin(async (sql) => {
        await lockBoard(sql, task);
        await assertBoardWritable(sql, task);
        const rows = await sql<TaskRow[]>`select payload from agent_board_tasks where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and id=${task.id} and version=${expectedVersion} for update`;
        const current = rows[0]?.payload;
        if (!current) return null;
        if (task.id !== current.id || task.workspaceId !== current.workspaceId || task.brandId !== current.brandId || task.boardId !== current.boardId || task.idempotencyKeySha256 !== current.idempotencyKeySha256 || task.createFingerprint !== current.createFingerprint) {
          throw new DomainError("A Board task's identity cannot be changed.", "agent_board_task_identity_immutable", 409);
        }

        const dependenciesChanged = task.parentTaskIds.join("\u0000") !== current.parentTaskIds.join("\u0000");
        if (dependenciesChanged && !["triage", "todo", "blocked"].includes(current.status)) {
          throw new DomainError("Dependencies can change only while a Board task is in triage, todo, or blocked.", "agent_board_task_dependencies_locked", 409);
        }
        const parents = await dependencyRows(sql, task);
        assertDependenciesExist(task, parents);
        if (task.parentTaskIds.length > 0) {
          const cycle = await sql<{ id: string }[]>`
            with recursive descendants(id) as (
              select child_task_id from agent_board_task_links
              where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and parent_task_id=${task.id}
              union
              select link.child_task_id from agent_board_task_links link join descendants on link.parent_task_id=descendants.id
              where link.workspace_id=${task.workspaceId} and link.brand_id=${task.brandId} and link.board_id=${task.boardId}
            )
            select id from descendants where id=any(${task.parentTaskIds}) limit 1
          `;
          if (cycle[0]) throw new DomainError("Board task dependencies cannot form a cycle.", "agent_board_task_dependency_cycle", 409);
        }
        assertDependenciesComplete(task, parents);

        if (task.status === "archived" && !current.completedAt) {
          const dependents = await sql<{ id: string }[]>`
            select child.id from agent_board_task_links link
            join agent_board_tasks child on child.workspace_id=link.workspace_id and child.brand_id=link.brand_id and child.board_id=link.board_id and child.id=link.child_task_id
            where link.workspace_id=${task.workspaceId} and link.brand_id=${task.brandId} and link.board_id=${task.boardId} and link.parent_task_id=${task.id}
              and child.status not in ('done','archived') limit 1 for update of child
          `;
          if (dependents[0]) throw new DomainError("Finish or detach active dependent tasks before archiving this unfinished task.", "agent_board_task_dependents_active", 409);
        }

        if (dependenciesChanged) {
          await sql`delete from agent_board_task_links where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and child_task_id=${task.id}`;
          for (const parentTaskId of task.parentTaskIds) {
            await sql`insert into agent_board_task_links(workspace_id,brand_id,board_id,parent_task_id,child_task_id,created_at) values(${task.workspaceId},${task.brandId},${task.boardId},${parentTaskId},${task.id},${task.updatedAt})`;
          }
        }
        const changed = await sql<{ id: string }[]>`update agent_board_tasks set version=${task.version},title=${task.title},status=${task.status},priority=${task.priority},assignee=${task.assignee},completed_at=${task.completedAt ?? null},payload=${sql.json(task as never)},updated_at=${task.updatedAt} where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and id=${task.id} and version=${expectedVersion} returning id`;
        if (!changed[0]) return null;
        await audit(sql, event);
        return task;
      });
    } catch (error) {
      mapConstraint(error);
    }
  }

  async listComments(workspaceId: string, brandId: string, boardId: string, taskId: string, limit = 100) {
    const bounded = Math.max(1, Math.min(500, limit));
    const rows = await this.sql<CommentRow[]>`select payload from (select payload,created_at,id from agent_board_task_comments where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and task_id=${taskId} order by created_at desc,id desc limit ${bounded}) comments order by created_at,id`;
    return rows.map((row) => row.payload);
  }

  async getCommentByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, taskId: string, idempotencyKeySha256: string) {
    const rows = await this.sql<CommentRow[]>`select payload from agent_board_task_comments where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and task_id=${taskId} and idempotency_key_sha256=${idempotencyKeySha256} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async appendComment(comment: AgentBoardTaskComment, expectedTaskVersion: number, event: AuditEvent) {
    try {
      return await this.sql.begin(async (sql) => {
        await lockBoard(sql, comment);
        await assertBoardWritable(sql, comment);
        const rows = await sql<{ status: string }[]>`select status from agent_board_tasks where workspace_id=${comment.workspaceId} and brand_id=${comment.brandId} and board_id=${comment.boardId} and id=${comment.taskId} and version=${expectedTaskVersion} for update`;
        if (!rows[0]) return false;
        if (rows[0].status === "archived") throw new DomainError("Archived Board tasks cannot receive comments.", "agent_board_task_archived", 409);
        await sql`insert into agent_board_task_comments(id,workspace_id,brand_id,board_id,task_id,body,idempotency_key_sha256,create_fingerprint,author_id,author_name,created_at,payload) values(${comment.id},${comment.workspaceId},${comment.brandId},${comment.boardId},${comment.taskId},${comment.body},${comment.idempotencyKeySha256},${comment.createFingerprint},${comment.authorId},${comment.authorName},${comment.createdAt},${sql.json(comment as never)})`;
        await audit(sql, event);
        return true;
      });
    } catch (error) {
      mapConstraint(error);
    }
  }

  async getExecution(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string) {
    const rows = await this.sql<ExecutionRow[]>`select payload from board_task_executions where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and task_id=${taskId} and id=${executionId} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async getExecutionByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, taskId: string, idempotencyKeySha256: string) {
    const rows = await this.sql<ExecutionRow[]>`select payload from board_task_executions where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and task_id=${taskId} and idempotency_key_sha256=${idempotencyKeySha256} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async listExecutions(workspaceId: string, brandId: string, boardId: string, taskId: string, limit = 50) {
    const bounded = Math.max(1, Math.min(100, limit));
    const rows = await this.sql<ExecutionRow[]>`select payload from board_task_executions where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and task_id=${taskId} order by created_at desc,id desc limit ${bounded}`;
    return rows.map((row) => row.payload);
  }

  async releaseToAgent(task: AgentBoardTask, expectedVersion: number, execution: AgentBoardTaskExecution, event: AuditEvent, message: OutboxMessageInput) {
    try {
      return await this.sql.begin(async (sql) => {
        await lockBoard(sql, task);
        await assertBoardWritable(sql, task);
        const rows = await sql<TaskRow[]>`select payload from agent_board_tasks where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and id=${task.id} and version=${expectedVersion} for update`;
        const current = rows[0]?.payload;
        if (!current) return null;
        const parents = await dependencyRows(sql, current);
        assertDependenciesExist(current, parents);
        assertDependenciesComplete({ ...current, status: "running" }, parents);
        const expectedFingerprint = agentBoardTaskExecutionFingerprint({ task: current, configurationEpoch: execution.configurationEpoch, capabilityEpoch: execution.capabilityEpoch });
        const validTask = sameTaskIdentity(task, current)
          && current.status === "ready"
          && current.assignee === "board-agent"
          && !current.activeExecutionId
          && task.version === current.version + 1
          && task.status === "running"
          && task.assignee === "board-agent"
          && task.activeExecutionId === execution.id
          && task.implementedBy === "board-agent"
          && task.title === current.title
          && task.description === current.description
          && task.priority === current.priority
          && task.parentTaskIds.join("\u0000") === current.parentTaskIds.join("\u0000")
          && task.dueAt === current.dueAt
          && task.updatedAt === execution.createdAt;
        const validExecution = execution.workspaceId === task.workspaceId
          && execution.brandId === task.brandId
          && execution.boardId === task.boardId
          && execution.taskId === task.id
          && execution.version === 1
          && execution.status === "queued"
          && execution.taskVersion === task.version
          && execution.createFingerprint === expectedFingerprint
          && execution.requestSha256 === expectedFingerprint
          && !execution.claimId
          && !execution.leaseExpiresAt
          && !execution.startedAt
          && !execution.completedAt
          && execution.updatedAt === execution.createdAt;
        const validMessage = message.workspaceId === task.workspaceId
          && message.topic === "board.task.execute"
          && message.dedupeKey === `board-task-execution:${execution.id}`
          && message.payload.workspaceId === task.workspaceId
          && message.payload.brandId === task.brandId
          && message.payload.boardId === task.boardId
          && message.payload.taskId === task.id
          && message.payload.executionId === execution.id
          && message.payload.taskVersion === task.version
          && message.payload.configurationEpoch === execution.configurationEpoch
          && message.payload.capabilityEpoch === execution.capabilityEpoch;
        if (!validTask || !validExecution || !validMessage) throw new DomainError("This Board task cannot be released to Hermes.", "agent_board_task_not_releasable", 409);

        await sql`insert into board_task_executions(id,workspace_id,brand_id,board_id,task_id,version,status,configuration_epoch,capability_epoch,task_version,idempotency_key_sha256,create_fingerprint,request_sha256,claim_id,lease_expires_at,started_at,completed_at,model,result_text,response_sha256,input_tokens,output_tokens,latency_ms,error_code,error_summary,created_by,created_at,updated_at,payload) values(${execution.id},${execution.workspaceId},${execution.brandId},${execution.boardId},${execution.taskId},${execution.version},${execution.status},${execution.configurationEpoch},${execution.capabilityEpoch},${execution.taskVersion},${execution.idempotencyKeySha256},${execution.createFingerprint},${execution.requestSha256},null,null,null,null,null,null,null,null,null,null,null,null,${execution.createdBy},${execution.createdAt},${execution.updatedAt},${sql.json(execution as never)})`;
        const changed = await sql<{ id: string }[]>`update agent_board_tasks set version=${task.version},title=${task.title},status=${task.status},priority=${task.priority},assignee=${task.assignee},completed_at=${task.completedAt ?? null},payload=${sql.json(task as never)},updated_at=${task.updatedAt} where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and id=${task.id} and version=${expectedVersion} returning id`;
        if (!changed[0]) throw new Error("Released Board execution could not fence its task state.");
        await outbox(sql, message);
        await audit(sql, event);
        return { task, execution };
      });
    } catch (error) {
      mapConstraint(error);
    }
  }

  async claimExecution(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string, claimId: string, leaseSeconds: number) {
    if (!/^[A-Za-z0-9_-]{16,120}$/u.test(claimId) || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
      throw new DomainError("The Board task execution lease is invalid.", "agent_board_task_execution_lease_invalid");
    }
    return this.sql.begin(async (sql) => {
      const executionRows = await sql<ExecutionRow[]>`select payload,clock_timestamp() as now from board_task_executions where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and task_id=${taskId} and id=${executionId} and status='queued' and created_at>clock_timestamp()-interval '15 minutes' for update`;
      const row = executionRows[0];
      if (!row?.now) return null;
      const taskRows = await sql<TaskRow[]>`select payload from agent_board_tasks where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and id=${taskId} for update`;
      const task = taskRows[0]?.payload;
      const current = row.payload;
      if (!task || task.status !== "running" || task.assignee !== "board-agent" || task.activeExecutionId !== executionId || task.version !== current.taskVersion) return null;
      const claimed = claimAgentBoardTaskExecution(current, claimId, leaseSeconds, row.now.toISOString());
      const changed = await sql<{ id: string }[]>`update board_task_executions set version=${claimed.version},status='running',claim_id=${claimed.claimId!},lease_expires_at=${claimed.leaseExpiresAt!},started_at=${claimed.startedAt!},updated_at=${claimed.updatedAt},payload=${sql.json(claimed as never)} where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and task_id=${taskId} and id=${executionId} and version=${current.version} and status='queued' and created_at>clock_timestamp()-interval '15 minutes' returning id`;
      return changed[0] ? { task, execution: claimed } : null;
    });
  }

  async finishExecution(task: AgentBoardTask, expectedTaskVersion: number, execution: AgentBoardTaskExecution, claimId: string, event: AuditEvent) {
    return this.sql.begin(async (sql) => {
      const executionRows = await sql<ExecutionRow[]>`select payload,clock_timestamp() as now from board_task_executions where workspace_id=${execution.workspaceId} and brand_id=${execution.brandId} and board_id=${execution.boardId} and task_id=${execution.taskId} and id=${execution.id} and status='running' for update`;
      const row = executionRows[0];
      if (!row?.now) return false;
      const taskRows = await sql<TaskRow[]>`select payload from agent_board_tasks where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and id=${task.id} and version=${expectedTaskVersion} for update`;
      const currentTask = taskRows[0]?.payload;
      const currentExecution = row.payload;
      if (!currentTask
        || currentExecution.claimId !== claimId
        || !currentExecution.leaseExpiresAt
        || Date.parse(currentExecution.leaseExpiresAt) <= row.now.getTime()
        || currentExecution.version !== execution.version - 1
        || !sameTaskIdentity(task, currentTask)
        || !sameExecutionIdentity(execution, currentExecution)
        || currentTask.status !== "running"
        || currentTask.assignee !== "board-agent"
        || currentTask.activeExecutionId !== currentExecution.id
        || currentTask.version !== currentExecution.taskVersion
        || task.version !== currentTask.version + 1
        || task.activeExecutionId
        || task.lastExecutionId !== execution.id
        || task.assignee !== "board-agent"
        || task.implementedBy !== "board-agent"
        || task.title !== currentTask.title
        || task.description !== currentTask.description
        || task.priority !== currentTask.priority
        || task.parentTaskIds.join("\u0000") !== currentTask.parentTaskIds.join("\u0000")
        || task.dueAt !== currentTask.dueAt
        || task.updatedAt !== execution.updatedAt
        || task.updatedAt !== execution.completedAt
        || (execution.status === "succeeded" ? !execution.resultText || task.status !== "review" || task.resultSummary !== execution.resultText.slice(0, 4_000) : task.status !== "blocked" || task.blockedReason !== execution.errorSummary)
        || !["succeeded", "failed", "uncertain"].includes(execution.status)
        || execution.claimId
        || execution.leaseExpiresAt) return false;

      const executionChanged = await sql<{ id: string }[]>`update board_task_executions set version=${execution.version},status=${execution.status},claim_id=null,lease_expires_at=null,completed_at=${execution.completedAt!},model=${execution.model ?? null},result_text=${execution.resultText ?? null},response_sha256=${execution.responseSha256 ?? null},input_tokens=${execution.inputTokens ?? null},output_tokens=${execution.outputTokens ?? null},latency_ms=${execution.latencyMs ?? null},error_code=${execution.errorCode ?? null},error_summary=${execution.errorSummary ?? null},updated_at=${execution.updatedAt},payload=${sql.json(execution as never)} where workspace_id=${execution.workspaceId} and brand_id=${execution.brandId} and board_id=${execution.boardId} and task_id=${execution.taskId} and id=${execution.id} and version=${currentExecution.version} and status='running' and claim_id=${claimId} and lease_expires_at>clock_timestamp() returning id`;
      if (!executionChanged[0]) return false;
      const taskChanged = await sql<{ id: string }[]>`update agent_board_tasks set version=${task.version},title=${task.title},status=${task.status},priority=${task.priority},assignee=${task.assignee},completed_at=${task.completedAt ?? null},payload=${sql.json(task as never)},updated_at=${task.updatedAt} where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and id=${task.id} and version=${expectedTaskVersion} returning id`;
      if (!taskChanged[0]) throw new Error("Finished Board execution could not fence its task state.");
      await audit(sql, event);
      return true;
    });
  }

  async recoverExpiredExecutions(limit = 100) {
    const bounded = Math.max(1, Math.min(500, limit));
    return this.sql.begin(async (sql) => {
      const expired = await sql<ExecutionRow[]>`select payload,clock_timestamp() as now from board_task_executions where (status='running' and lease_expires_at<=clock_timestamp()) or (status='queued' and created_at<=clock_timestamp()-interval '15 minutes') order by coalesce(lease_expires_at,created_at),id limit ${bounded} for update skip locked`;
      let recovered = 0;
      for (const row of expired) {
        if (!row.now) continue;
        const currentExecution = row.payload;
        const taskRows = await sql<TaskRow[]>`select payload from agent_board_tasks where workspace_id=${currentExecution.workspaceId} and brand_id=${currentExecution.brandId} and board_id=${currentExecution.boardId} and id=${currentExecution.taskId} for update`;
        const currentTask = taskRows[0]?.payload;
        if (!currentTask || currentTask.status !== "running" || currentTask.assignee !== "board-agent" || currentTask.activeExecutionId !== currentExecution.id || currentTask.version !== currentExecution.taskVersion) continue;
        const reason = currentExecution.status === "queued" ? "queue_timeout" : "lease_expired";
        const result = expireAgentBoardTaskExecution({ task: currentTask, execution: currentExecution, reason, now: row.now.toISOString() });
        const executionChanged = await sql<{ id: string }[]>`update board_task_executions set version=${result.execution.version},status='uncertain',claim_id=null,lease_expires_at=null,started_at=${result.execution.startedAt!},completed_at=${result.execution.completedAt!},error_code=${result.execution.errorCode!},error_summary=${result.execution.errorSummary!},updated_at=${result.execution.updatedAt},payload=${sql.json(result.execution as never)} where workspace_id=${currentExecution.workspaceId} and id=${currentExecution.id} and version=${currentExecution.version} and ((status='running' and lease_expires_at<=clock_timestamp()) or (status='queued' and created_at<=clock_timestamp()-interval '15 minutes')) returning id`;
        if (!executionChanged[0]) continue;
        const taskChanged = await sql<{ id: string }[]>`update agent_board_tasks set version=${result.task.version},status='blocked',payload=${sql.json(result.task as never)},updated_at=${result.task.updatedAt} where workspace_id=${currentTask.workspaceId} and brand_id=${currentTask.brandId} and board_id=${currentTask.boardId} and id=${currentTask.id} and version=${currentTask.version} returning id`;
        if (!taskChanged[0]) throw new Error("Recovered Board execution could not fence its task state.");
        await audit(sql, result.event);
        recovered += 1;
      }
      return recovered;
    });
  }

  async getContentHandoffByIdempotencyKey(workspaceId: string, brandId: string, boardId: string, taskId: string, idempotencyKeySha256: string) {
    const rows = await this.sql<ContentHandoffRow[]>`select payload from board_task_content_handoffs where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and task_id=${taskId} and idempotency_key_sha256=${idempotencyKeySha256} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async getContentHandoffByExecution(workspaceId: string, brandId: string, boardId: string, taskId: string, executionId: string) {
    const rows = await this.sql<ContentHandoffRow[]>`select payload from board_task_content_handoffs where workspace_id=${workspaceId} and brand_id=${brandId} and board_id=${boardId} and task_id=${taskId} and execution_id=${executionId} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async createContentHandoff(task: AgentBoardTask, expectedTaskVersion: number, execution: AgentBoardTaskExecution, item: ContentItem, handoff: AgentBoardTaskContentHandoff, event: AuditEvent) {
    try {
      return await this.sql.begin(async (sql) => {
        await lockBoard(sql, task);
        await assertBoardWritable(sql, task);
        const taskRows = await sql<TaskRow[]>`select payload from agent_board_tasks where workspace_id=${task.workspaceId} and brand_id=${task.brandId} and board_id=${task.boardId} and id=${task.id} and version=${expectedTaskVersion} for update`;
        const currentTask = taskRows[0]?.payload;
        if (!currentTask) return false;
        const executionRows = await sql<ExecutionRow[]>`select payload from board_task_executions where workspace_id=${execution.workspaceId} and brand_id=${execution.brandId} and board_id=${execution.boardId} and task_id=${execution.taskId} and id=${execution.id} for share`;
        const currentExecution = executionRows[0]?.payload;
        if (!currentExecution) throw new DomainError("Select a successful execution receipt from this Board task.", "agent_board_task_handoff_execution_invalid", 409);
        const expectedFingerprint = agentBoardTaskContentHandoffFingerprint({ task: currentTask, execution: currentExecution });
        const validSource = sameTaskIdentity(task, currentTask)
          && task.version === expectedTaskVersion
          && task.status === "review"
          && task.assignee === "board-agent"
          && !task.activeExecutionId
          && task.lastExecutionId === execution.id
          && sameExecutionIdentity(execution, currentExecution)
          && execution.version === currentExecution.version
          && execution.status === "succeeded"
          && Boolean(execution.resultText)
          && Boolean(execution.responseSha256);
        const validItem = item.workspaceId === task.workspaceId
          && item.brandId === task.brandId
          && item.version === 1
          && item.status === "inbox"
          && item.title === task.title
          && item.summary === execution.resultText!.slice(0, 2_000)
          && item.researchDepth === "standard"
          && item.riskLevel === "low"
          && item.createdBy === handoff.createdBy
          && item.createdAt === handoff.createdAt
          && item.updatedAt === handoff.createdAt
          && item.tags.length === 0
          && item.sources.length === 0
          && item.claims.length === 0
          && item.researchRuns.length === 0
          && item.drafts.length === 0
          && item.approvals.length === 0
          && item.reviewComments.length === 0
          && item.reviewLinks.length === 0
          && item.targets.length === 0
          && item.publishAttempts.length === 0
          && item.proofs.length === 0;
        const validHandoff = handoff.workspaceId === task.workspaceId
          && handoff.brandId === task.brandId
          && handoff.boardId === task.boardId
          && handoff.taskId === task.id
          && handoff.executionId === execution.id
          && handoff.contentItemId === item.id
          && handoff.taskVersion === expectedTaskVersion
          && handoff.executionVersion === execution.version
          && handoff.responseSha256 === execution.responseSha256
          && handoff.createFingerprint === expectedFingerprint
          && handoff.createdAt === item.createdAt
          && event.workspaceId === item.workspaceId
          && event.contentItemId === item.id
          && event.actorId === handoff.createdBy
          && event.actorType === "human"
          && event.action === "content.created-from-board-task"
          && event.createdAt === handoff.createdAt;
        if (!validSource || !validItem || !validHandoff) throw new DomainError("This Board-to-Content handoff is invalid.", "agent_board_task_handoff_invalid", 409);

        await sql`insert into content_items(id,workspace_id,brand_id,version,title,status,risk_level,payload,created_at,updated_at) values(${item.id},${item.workspaceId},${item.brandId},${item.version},${item.title},${item.status},${item.riskLevel},${sql.json(item as never)},${item.createdAt},${item.updatedAt})`;
        await sql`insert into board_task_content_handoffs(id,workspace_id,brand_id,board_id,task_id,execution_id,content_item_id,task_version,execution_version,response_sha256,idempotency_key_sha256,create_fingerprint,created_by,created_at,payload) values(${handoff.id},${handoff.workspaceId},${handoff.brandId},${handoff.boardId},${handoff.taskId},${handoff.executionId},${handoff.contentItemId},${handoff.taskVersion},${handoff.executionVersion},${handoff.responseSha256},${handoff.idempotencyKeySha256},${handoff.createFingerprint},${handoff.createdBy},${handoff.createdAt},${sql.json(handoff as never)})`;
        await audit(sql, event);
        return true;
      });
    } catch (error) {
      mapConstraint(error);
    }
  }
}
