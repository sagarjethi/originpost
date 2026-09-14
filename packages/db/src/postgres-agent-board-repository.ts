import { DomainError, type AgentBoard, type AgentBoardRepository, type AgentBoardRunLedgerEntry, type AuditEvent, type OutboxMessageInput } from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type BoardRow = { payload: AgentBoard };
type RunRow = { payload: AgentBoardRunLedgerEntry };

async function audit(sql: Sql | TransactionSql, event: AuditEvent) {
  await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at) values(${event.id},${event.workspaceId},null,${event.actorId},${event.actorType},${event.action},${sql.json(event.detail as never)},${event.createdAt}) on conflict(id) do nothing`;
}

async function outbox(sql: Sql | TransactionSql, value?: OutboxMessageInput) {
  if (!value) return;
  await sql`insert into outbox_events(id,workspace_id,topic,dedupe_key,payload,available_at,created_at) values(${value.id},${value.workspaceId},${value.topic},${value.dedupeKey},${sql.json(value.payload as never)},${value.availableAt},${value.createdAt}) on conflict(workspace_id,dedupe_key) do nothing`;
}

async function plugin(sql: Sql | TransactionSql, board: AgentBoard) {
  await sql`insert into board_hermes_plugins(board_id,workspace_id,brand_id,plugin_id,profile_ref,kanban_ref,state,desired_configuration_epoch,observed_configuration_epoch,capability_epoch,memory_isolation,memory_write_approval,skill_write_approval,last_checked_at,last_error_code,updated_at)
    values(${board.id},${board.workspaceId},${board.brandId},${board.pluginId},${board.hermesProfile},${board.hermesBoardRef},${board.status},${board.configurationEpoch},${board.observedConfigurationEpoch},${board.capabilityEpoch},${board.memoryIsolation},${board.memoryWriteApproval},${board.skillWriteApproval},${board.lastCheckedAt??null},${board.lastError??null},${board.updatedAt})
    on conflict(board_id) do update set state=excluded.state,desired_configuration_epoch=excluded.desired_configuration_epoch,observed_configuration_epoch=excluded.observed_configuration_epoch,capability_epoch=excluded.capability_epoch,last_checked_at=excluded.last_checked_at,last_error_code=excluded.last_error_code,updated_at=excluded.updated_at`;
  const names = [...new Set([...board.desiredSkills, ...board.observedSkills])];
  await sql`delete from board_hermes_skill_grants where workspace_id=${board.workspaceId} and board_id=${board.id}`;
  for (const name of names) await sql`insert into board_hermes_skill_grants(board_id,workspace_id,brand_id,skill_name,desired_enabled,observed_enabled,trust,updated_at) values(${board.id},${board.workspaceId},${board.brandId},${name},${board.desiredSkills.includes(name)},${board.observedSkills.includes(name)},'operator-approved',${board.updatedAt})`;
}

export class PostgresAgentBoardRepository implements AgentBoardRepository {
  constructor(private readonly sql: Sql) {}

  async list(workspaceId: string, brandId: string, includeArchived = false) {
    const rows = await this.sql<BoardRow[]>`select payload from agent_boards where workspace_id=${workspaceId} and brand_id=${brandId} and (${includeArchived} or status<>'archived') order by updated_at desc,id`;
    return rows.map((row) => row.payload);
  }

  async get(workspaceId: string, id: string) {
    const rows = await this.sql<BoardRow[]>`select payload from agent_boards where workspace_id=${workspaceId} and id=${id} limit 1`;
    return rows[0]?.payload ?? null;
  }

  async create(board: AgentBoard, event: AuditEvent, message?: OutboxMessageInput) {
    try {
      await this.sql.begin(async (sql) => {
        const saved = await sql<{ id: string }[]>`insert into agent_boards(id,workspace_id,brand_id,version,name,slug,purpose,status,plugin_id,payload,created_by,created_at,updated_at) values(${board.id},${board.workspaceId},${board.brandId},${board.version},${board.name},${board.slug},${board.purpose},${board.status},${board.pluginId},${sql.json(board as never)},${board.createdBy},${board.createdAt},${board.updatedAt}) on conflict do nothing returning id`;
        if (!saved[0]) throw new DomainError("Agent board already exists.", "agent_board_exists", 409);
        await plugin(sql, board); await audit(sql, event); await outbox(sql, message);
      });
    } catch (error) {
      const constraint = (error as { constraint_name?: string; constraint?: string }).constraint_name ?? (error as { constraint?: string }).constraint;
      if (constraint === "board_hermes_plugins_profile_ref_unique") throw new DomainError("This Board runtime profile is already assigned.", "agent_board_profile_exists", 409);
      if (constraint === "board_hermes_plugins_kanban_ref_unique") throw new DomainError("This Board Kanban runtime is already assigned.", "agent_board_kanban_exists", 409);
      if ((error as { code?: string }).code === "23505") throw new DomainError("This brand already has a board with that name.", "agent_board_slug_exists", 409);
      throw error;
    }
  }

  async update(board: AgentBoard, expectedVersion: number, event: AuditEvent, message?: OutboxMessageInput) {
    try {
      return await this.sql.begin(async (sql) => {
        const rows = await sql<BoardRow[]>`select payload from agent_boards where workspace_id=${board.workspaceId} and id=${board.id} and version=${expectedVersion} for update`;
        if (!rows[0]) return null;
        const current = rows[0].payload;
        if (board.id !== current.id || board.workspaceId !== current.workspaceId || board.brandId !== current.brandId || board.pluginId !== current.pluginId || board.hermesProfile !== current.hermesProfile || board.hermesBoardRef !== current.hermesBoardRef) throw new DomainError("A Board's runtime identity cannot be changed.", "agent_board_identity_immutable", 409);
        const changed = await sql<{ id: string }[]>`update agent_boards set version=${board.version},name=${board.name},purpose=${board.purpose},status=${board.status},payload=${sql.json(board as never)},updated_at=${board.updatedAt} where workspace_id=${board.workspaceId} and id=${board.id} and version=${expectedVersion} returning id`;
        if (!changed[0]) return null;
        await plugin(sql, board); await audit(sql, event); await outbox(sql, message);
        return board;
      });
    } catch (error) {
      const constraint = (error as { constraint_name?: string; constraint?: string }).constraint_name ?? (error as { constraint?: string }).constraint;
      if (constraint === "board_hermes_plugins_profile_ref_unique") throw new DomainError("This Board runtime profile is already assigned.", "agent_board_profile_exists", 409);
      if (constraint === "board_hermes_plugins_kanban_ref_unique") throw new DomainError("This Board Kanban runtime is already assigned.", "agent_board_kanban_exists", 409);
      if ((error as { code?: string }).code === "23505") throw new DomainError("This brand already has a board with that name.", "agent_board_slug_exists", 409);
      throw error;
    }
  }

  async recordRun(run: AgentBoardRunLedgerEntry, event: AuditEvent, expected?: { configurationEpoch: number; capabilityEpoch: number }) {
    return this.sql.begin(async (sql) => {
      const boards = await sql<BoardRow[]>`select payload from agent_boards where workspace_id=${run.workspaceId} and brand_id=${run.brandId} and id=${run.boardId} for update`;
      const board = boards[0]?.payload;
      if (!board) throw new DomainError("Agent board not found.", "agent_board_not_found", 404);
      if (expected && (board.status !== "ready" || board.pendingPluginDecision !== undefined || board.configurationEpoch !== expected.configurationEpoch || board.observedConfigurationEpoch !== expected.configurationEpoch || board.capabilityEpoch !== expected.capabilityEpoch)) return false;
      await sql`insert into board_agent_run_ledger(id,workspace_id,brand_id,board_id,configuration_epoch,model,status,request_sha256,response_sha256,input_tokens,output_tokens,latency_ms,error_code,created_by,created_at,payload) values(${run.id},${run.workspaceId},${run.brandId},${run.boardId},${run.configurationEpoch},${run.model},${run.status},${run.requestSha256},${run.responseSha256??null},${run.inputTokens??null},${run.outputTokens??null},${run.latencyMs},${run.errorCode??null},${run.createdBy},${run.createdAt},${sql.json(run as never)})`;
      await audit(sql, event);
      return true;
    });
  }

  async listRuns(workspaceId: string, boardId: string, limit = 50) {
    const rows = await this.sql<RunRow[]>`select payload from board_agent_run_ledger where workspace_id=${workspaceId} and board_id=${boardId} order by created_at desc limit ${Math.max(1,Math.min(200,limit))}`;
    return rows.map((row) => row.payload);
  }
}
