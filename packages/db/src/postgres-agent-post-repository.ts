import {
  DomainError,
  type AgentPostRepository,
  type AgentPostRun,
  type AgentPostTemplate,
} from "@originpost/domain";
import type { Sql } from "postgres";
export class PostgresAgentPostRepository implements AgentPostRepository {
  constructor(private readonly sql: Sql) {}
  async referencesAsset(w: string, id: string) {
    const rows = await this
      .sql`select id from agent_post_templates where workspace_id=${w} and (payload->'logo'->>'mediaId'=${id} or payload->'referenceMediaIds' ? ${id}) limit 1`;
    if (rows.length > 0) return true;
    const runs = await this
      .sql`select id from agent_post_runs where workspace_id=${w} and payload->'externalImage'->>'mediaId'=${id} limit 1`;
    return runs.length > 0;
  }
  async saveTemplate(t: AgentPostTemplate) {
    await this
      .sql`insert into agent_post_templates(id,workspace_id,brand_id,payload) values(${t.id},${t.workspaceId},${t.brandId},${this.sql.json(t as never)})`;
  }
  async templates(w: string, b: string) {
    const rows = await this.sql<
      { payload: AgentPostTemplate }[]
    >`select payload from agent_post_templates where workspace_id=${w} and brand_id=${b} order by created_at desc limit 100`;
    return rows.map((r) => r.payload);
  }
  async template(w: string, id: string) {
    const rows = await this.sql<
      { payload: AgentPostTemplate }[]
    >`select payload from agent_post_templates where workspace_id=${w} and id=${id}`;
    return rows[0]?.payload ?? null;
  }
  async create(r: AgentPostRun) {
    await this
      .sql`insert into agent_post_runs(id,workspace_id,brand_id,version,status,payload) values(${r.id},${r.workspaceId},${r.brandId},${r.version},${r.status},${this.sql.json(r as never)}) on conflict(id) do nothing`;
    const old = await this.get(r.workspaceId, r.id);
    if (!old || old.fingerprint !== r.fingerprint)
      throw new DomainError(
        "This request key was used for different content.",
        "idempotency_conflict",
        409,
      );
    return old;
  }
  async get(w: string, id: string) {
    const rows = await this.sql<
      { payload: AgentPostRun }[]
    >`select payload from agent_post_runs where workspace_id=${w} and id=${id}`;
    return rows[0]?.payload ?? null;
  }
  async list(w: string, b: string) {
    const rows = await this.sql<
      { payload: AgentPostRun }[]
    >`select payload from agent_post_runs where workspace_id=${w} and brand_id=${b} order by created_at desc limit 100`;
    return rows.map((r) => r.payload);
  }
  async pending() {
    const rows = await this.sql<
      { payload: AgentPostRun }[]
    >`select payload from agent_post_runs where status in ('queued','researching','writing','reviewing-copy','generating','composing','reviewing-image','drafting') order by updated_at asc limit 100`;
    return rows.map((r) => r.payload);
  }
  async replace(r: AgentPostRun, v: number) {
    const rows = await this
      .sql`update agent_post_runs set version=${r.version},status=${r.status},payload=${this.sql.json(r as never)},updated_at=now() where id=${r.id} and workspace_id=${r.workspaceId} and version=${v} returning id`;
    return rows.length === 1;
  }
}
