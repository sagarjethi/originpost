import {
  creativeSpecSha256,
  DomainError,
  validateCreativeSpec,
  type AddCreativeRevisionInput,
  type CompleteCreativeRenderInput,
  type CreativeProject,
  type CreativeProjectWithRevision,
  type CreativeRender,
  type CreativeRenderStart,
  type CreativeRevision,
  type CreativeStudioRepository,
  type FailCreativeRenderInput,
  type StartCreativeRenderInput,
  type AuditEvent,
} from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type ProjectRow = {
  id: string; workspace_id: string; brand_id: string; version: number; name: string; current_revision_id: string;
  status: CreativeProject["status"]; latest_render_id: string | null; output_media_id: string | null; last_error: string | null;
  created_by: string; updated_by: string; created_at: Date | string; updated_at: Date | string;
};
type RevisionRow = {
  id: string; workspace_id: string; brand_id: string; project_id: string; revision_number: number;
  spec: CreativeRevision["specSnapshot"]; spec_sha256: string; created_by: string; created_at: Date | string;
};
type RenderRow = {
  id: string; workspace_id: string; brand_id: string; project_id: string; revision_id: string;
  spec: CreativeRender["specSnapshot"]; spec_sha256: string; renderer_version: string; render_manifest_sha256: string;
  status: CreativeRender["status"]; output_media_id: string | null; output_sha256: string | null; error: string | null;
  lease_owner: string | null; lease_expires_at: Date | string | null; attempt_count: number;
  created_by: string; created_at: Date | string; finished_at: Date | string | null;
};
type RenderLookupRow = RenderRow & { lease_active: boolean };

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const projectFromRow = (row: ProjectRow): CreativeProject => ({
  id: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, version: row.version, name: row.name,
  currentRevisionId: row.current_revision_id, status: row.status, ...(row.latest_render_id ? { latestRenderId: row.latest_render_id } : {}),
  ...(row.output_media_id ? { outputMediaId: row.output_media_id } : {}), ...(row.last_error ? { lastError: row.last_error } : {}),
  createdBy: row.created_by, updatedBy: row.updated_by, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});
const revisionFromRow = (row: RevisionRow): CreativeRevision => ({
  id: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, projectId: row.project_id, revisionNumber: row.revision_number,
  specSnapshot: row.spec, specSha256: row.spec_sha256, createdBy: row.created_by, createdAt: iso(row.created_at),
});
const renderFromRow = (row: RenderRow): CreativeRender => ({
  id: row.id, workspaceId: row.workspace_id, brandId: row.brand_id, projectId: row.project_id, revisionId: row.revision_id,
  specSnapshot: row.spec, specSha256: row.spec_sha256, rendererVersion: row.renderer_version, renderManifestSha256: row.render_manifest_sha256,
  status: row.status, ...(row.output_media_id ? { outputMediaId: row.output_media_id } : {}), ...(row.output_sha256 ? { outputSha256: row.output_sha256 } : {}),
  ...(row.error ? { error: row.error } : {}), ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}), ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
  attemptCount: row.attempt_count, createdBy: row.created_by, createdAt: iso(row.created_at), ...(row.finished_at ? { finishedAt: iso(row.finished_at) } : {}),
});

async function audit(sql: Sql | TransactionSql, event: AuditEvent, workspaceId: string, contentItemId?: string): Promise<void> {
  if (event.workspaceId !== workspaceId || event.contentItemId && event.contentItemId !== contentItemId) throw new DomainError("Creative audit event lineage is invalid.", "creative_audit_mismatch", 409);
  await sql`insert into audit_events(id,workspace_id,content_item_id,actor_id,actor_type,action,detail,created_at) values(${event.id},${workspaceId},${event.contentItemId ?? contentItemId ?? null},${event.actorId},${event.actorType},${event.action},${sql.json(event.detail as never)},${event.createdAt})`;
}

function cleanProjectName(value: string): string {
  const cleaned = value.normalize("NFC").replace(/\u0000/gu, "").trim();
  if (!cleaned || cleaned.length > 120) throw new DomainError("Creative project name must contain 1–120 characters.", "creative_project_invalid");
  return cleaned;
}

function validateRevision(project: CreativeProject, revision: CreativeRevision, expectedNumber: number): void {
  if (revision.workspaceId !== project.workspaceId || revision.brandId !== project.brandId || revision.projectId !== project.id || revision.revisionNumber !== expectedNumber || revision.specSha256 !== creativeSpecSha256(revision.specSnapshot)) {
    throw new DomainError("Creative revision lineage is invalid.", "creative_revision_mismatch", 409);
  }
}

function validateRender(project: CreativeProject, revision: CreativeRevision, render: CreativeRender): void {
  if (render.workspaceId !== project.workspaceId || render.brandId !== project.brandId || render.projectId !== project.id || render.revisionId !== revision.id || render.specSha256 !== revision.specSha256 || creativeSpecSha256(render.specSnapshot) !== revision.specSha256 || render.status !== "rendering" || !/^[a-f0-9]{64}$/u.test(render.renderManifestSha256) || render.outputMediaId || render.outputSha256 || render.error || render.finishedAt) {
    throw new DomainError("Creative render lineage is invalid.", "creative_render_mismatch", 409);
  }
}

export class PostgresCreativeStudioRepository implements CreativeStudioRepository {
  constructor(private readonly sql: Sql) {}

  async listProjects(workspaceId: string, brandId?: string, limit = 100): Promise<CreativeProject[]> {
    const bounded = Math.max(1, Math.min(limit, 200));
    const rows = brandId
      ? await this.sql<ProjectRow[]>`select * from creative_projects where workspace_id=${workspaceId} and brand_id=${brandId} order by updated_at desc,id desc limit ${bounded}`
      : await this.sql<ProjectRow[]>`select * from creative_projects where workspace_id=${workspaceId} order by updated_at desc,id desc limit ${bounded}`;
    return rows.map(projectFromRow);
  }

  async getProject(workspaceId: string, id: string): Promise<CreativeProject | null> {
    const rows = await this.sql<ProjectRow[]>`select * from creative_projects where workspace_id=${workspaceId} and id=${id} limit 1`;
    return rows[0] ? projectFromRow(rows[0]) : null;
  }

  async createProject(initial: CreativeProjectWithRevision, event: AuditEvent): Promise<CreativeProjectWithRevision> {
    const { project, revision } = initial;
    if (project.version !== 1 || project.currentRevisionId !== revision.id || project.status !== "draft") throw new DomainError("Initial creative project state is invalid.", "creative_project_invalid");
    validateRevision(project, revision, 1);
    return this.sql.begin(async (sql) => {
      const projects = await sql<ProjectRow[]>`insert into creative_projects(id,workspace_id,brand_id,version,name,current_revision_id,status,latest_render_id,output_media_id,last_error,created_by,updated_by,created_at,updated_at) values(${project.id},${project.workspaceId},${project.brandId},1,${project.name},${revision.id},'draft',null,null,null,${project.createdBy},${project.updatedBy},${project.createdAt},${project.updatedAt}) on conflict do nothing returning *`;
      if (!projects[0]) throw new DomainError("Creative project already exists.", "creative_project_exists", 409);
      const spec = validateCreativeSpec(revision.specSnapshot);
      const revisions = await sql<RevisionRow[]>`insert into creative_revisions(id,workspace_id,brand_id,project_id,revision_number,source_media_id,source_media_sha256,content_item_id,spec,spec_sha256,created_by,created_at) values(${revision.id},${revision.workspaceId},${revision.brandId},${revision.projectId},1,${spec.sourceMediaId},${spec.sourceMediaSha256},${spec.contentItemId ?? null},${sql.json(spec as never)},${revision.specSha256},${revision.createdBy},${revision.createdAt}) returning *`;
      await audit(sql, event, project.workspaceId, spec.contentItemId);
      return { project: projectFromRow(projects[0]), revision: revisionFromRow(revisions[0]!) };
    });
  }

  async addRevision(input: AddCreativeRevisionInput): Promise<CreativeProjectWithRevision | null> {
    return this.sql.begin(async (sql) => {
      const projects = await sql<ProjectRow[]>`select * from creative_projects where workspace_id=${input.workspaceId} and id=${input.projectId} and version=${input.expectedVersion} for update`;
      if (!projects[0]) return null;
      const current = projectFromRow(projects[0]);
      const currentRows = await sql<RevisionRow[]>`select * from creative_revisions where workspace_id=${input.workspaceId} and project_id=${input.projectId} and id=${current.currentRevisionId} limit 1`;
      if (!currentRows[0]) throw new Error("Creative project's current revision is missing.");
      validateRevision(current, input.revision, currentRows[0].revision_number + 1);
      const spec = validateCreativeSpec(input.revision.specSnapshot);
      const revisions = await sql<RevisionRow[]>`insert into creative_revisions(id,workspace_id,brand_id,project_id,revision_number,source_media_id,source_media_sha256,content_item_id,spec,spec_sha256,created_by,created_at) values(${input.revision.id},${input.revision.workspaceId},${input.revision.brandId},${input.revision.projectId},${input.revision.revisionNumber},${spec.sourceMediaId},${spec.sourceMediaSha256},${spec.contentItemId ?? null},${sql.json(spec as never)},${input.revision.specSha256},${input.revision.createdBy},${input.revision.createdAt}) returning *`;
      const changed = await sql<ProjectRow[]>`update creative_projects set version=version+1,name=${input.name === undefined ? current.name : cleanProjectName(input.name)},current_revision_id=${input.revision.id},status='draft',latest_render_id=null,output_media_id=null,last_error=null,updated_by=${input.updatedBy},updated_at=${input.updatedAt} where workspace_id=${input.workspaceId} and id=${input.projectId} and version=${input.expectedVersion} returning *`;
      if (!changed[0]) return null;
      await audit(sql, input.event, current.workspaceId, spec.contentItemId);
      return { project: projectFromRow(changed[0]), revision: revisionFromRow(revisions[0]!) };
    });
  }

  async getRevision(workspaceId: string, projectId: string, revisionId: string): Promise<CreativeRevision | null> {
    const rows = await this.sql<RevisionRow[]>`select * from creative_revisions where workspace_id=${workspaceId} and project_id=${projectId} and id=${revisionId} limit 1`;
    return rows[0] ? revisionFromRow(rows[0]) : null;
  }

  async listRevisions(workspaceId: string, projectId: string, limit = 100): Promise<CreativeRevision[]> {
    const rows = await this.sql<RevisionRow[]>`select * from creative_revisions where workspace_id=${workspaceId} and project_id=${projectId} order by revision_number desc limit ${Math.max(1, Math.min(limit, 200))}`;
    return rows.map(revisionFromRow);
  }

  async startRender(input: StartCreativeRenderInput): Promise<CreativeRenderStart | null> {
    return this.sql.begin(async (sql) => {
      const projectRows = await sql<ProjectRow[]>`select * from creative_projects where workspace_id=${input.workspaceId} and id=${input.projectId} for update`;
      if (!projectRows[0]) return null;
      const current = projectFromRow(projectRows[0]);
      if (current.currentRevisionId !== input.render.revisionId) return null;
      const revisionRows = await sql<RevisionRow[]>`select * from creative_revisions where workspace_id=${input.workspaceId} and project_id=${input.projectId} and id=${input.render.revisionId} limit 1`;
      if (!revisionRows[0]) return null;
      const revision = revisionFromRow(revisionRows[0]);
      validateRender(current, revision, input.render);
      if (input.render.leaseOwner !== input.leaseOwner || input.render.leaseExpiresAt !== input.leaseExpiresAt) throw new DomainError("Creative render lease does not match the start request.", "creative_render_lease_mismatch", 409);
      const existingRows = await sql<RenderLookupRow[]>`select creative_renders.*, (status='rendering' and lease_expires_at>clock_timestamp()) as lease_active from creative_renders where revision_id=${revision.id} and spec_sha256=${revision.specSha256} limit 1`;
      if (existingRows[0]) {
        const existing = renderFromRow(existingRows[0]);
        if (existing.renderManifestSha256 !== input.render.renderManifestSha256) throw new DomainError("This revision was already rendered with a different renderer manifest. Create a new revision before rendering again.", "creative_render_manifest_conflict", 409);
        if (existing.status === "ready" || existingRows[0].lease_active) return { project: current, render: existing, started: false };
        if (current.version !== input.expectedVersion) return null;
        const reclaimedRows = await sql<RenderRow[]>`update creative_renders set status='rendering',output_media_id=null,output_sha256=null,error=null,lease_owner=${input.leaseOwner},lease_expires_at=${input.leaseExpiresAt},attempt_count=attempt_count+1,finished_at=null where id=${existing.id} and ${input.leaseExpiresAt}::timestamptz>clock_timestamp() and (status='failed' or (status='rendering' and lease_expires_at<=clock_timestamp())) returning *`;
        if (!reclaimedRows[0]) return null;
        const reclaimedProjects = await sql<ProjectRow[]>`update creative_projects set version=version+1,status='rendering',latest_render_id=${existing.id},output_media_id=null,last_error=null,updated_by=${input.updatedBy},updated_at=${input.updatedAt} where workspace_id=${input.workspaceId} and id=${input.projectId} and version=${input.expectedVersion} returning *`;
        if (!reclaimedProjects[0]) return null;
        await audit(sql, input.event, current.workspaceId, revision.specSnapshot.contentItemId);
        return { project: projectFromRow(reclaimedProjects[0]), render: renderFromRow(reclaimedRows[0]), started: true };
      }
      if (current.version !== input.expectedVersion) return null;
      const renderRows = await sql<RenderRow[]>`insert into creative_renders(id,workspace_id,brand_id,project_id,revision_id,spec,spec_sha256,renderer_version,render_manifest_sha256,status,output_media_id,output_sha256,error,lease_owner,lease_expires_at,attempt_count,created_by,created_at,finished_at) select ${input.render.id},${input.render.workspaceId},${input.render.brandId},${input.render.projectId},${input.render.revisionId},${sql.json(input.render.specSnapshot as never)},${input.render.specSha256},${input.render.rendererVersion},${input.render.renderManifestSha256},'rendering',null,null,null,${input.leaseOwner},${input.leaseExpiresAt},${input.render.attemptCount},${input.render.createdBy},${input.render.createdAt},null where ${input.leaseExpiresAt}::timestamptz>clock_timestamp() returning *`;
      if (!renderRows[0]) throw new DomainError("Creative render lease is already expired.", "creative_render_lease_invalid", 409);
      const changed = await sql<ProjectRow[]>`update creative_projects set version=version+1,status='rendering',latest_render_id=${input.render.id},output_media_id=null,last_error=null,updated_by=${input.updatedBy},updated_at=${input.updatedAt} where workspace_id=${input.workspaceId} and id=${input.projectId} and version=${input.expectedVersion} returning *`;
      if (!changed[0]) return null;
      await audit(sql, input.event, current.workspaceId, revision.specSnapshot.contentItemId);
      return { project: projectFromRow(changed[0]), render: renderFromRow(renderRows[0]!), started: true };
    });
  }

  async completeRender(input: CompleteCreativeRenderInput): Promise<{ project: CreativeProject; render: CreativeRender } | null> {
    if (!/^[a-f0-9]{64}$/u.test(input.outputSha256)) throw new DomainError("Creative output hash must be a lowercase SHA-256.", "creative_render_output_invalid");
    return this.sql.begin(async (sql) => {
      const renderRows = await sql<RenderRow[]>`update creative_renders set status='ready',output_media_id=${input.outputMediaId},output_sha256=${input.outputSha256},error=null,lease_owner=null,lease_expires_at=null,finished_at=${input.finishedAt} where workspace_id=${input.workspaceId} and project_id=${input.projectId} and id=${input.renderId} and status='rendering' and lease_owner=${input.leaseOwner} returning *`;
      if (!renderRows[0]) return null;
      const projectRows = await sql<ProjectRow[]>`update creative_projects set version=version+1,status='ready',output_media_id=${input.outputMediaId},last_error=null,updated_by=${input.updatedBy},updated_at=${input.finishedAt} where workspace_id=${input.workspaceId} and id=${input.projectId} and latest_render_id=${input.renderId} and status='rendering' returning *`;
      if (!projectRows[0]) throw new DomainError("Creative render is no longer the project's active render.", "creative_render_stale", 409);
      await audit(sql, input.event, input.workspaceId, renderFromRow(renderRows[0]).specSnapshot.contentItemId);
      return { project: projectFromRow(projectRows[0]), render: renderFromRow(renderRows[0]) };
    });
  }

  async failRender(input: FailCreativeRenderInput): Promise<{ project: CreativeProject; render: CreativeRender } | null> {
    const error = input.error.normalize("NFC").replace(/\u0000/gu, "").trim().slice(0, 2_000);
    if (!error) throw new DomainError("Render error must not be empty.", "creative_render_error_invalid");
    return this.sql.begin(async (sql) => {
      const renderRows = await sql<RenderRow[]>`update creative_renders set status='failed',output_media_id=null,output_sha256=null,error=${error},lease_owner=null,lease_expires_at=null,finished_at=${input.finishedAt} where workspace_id=${input.workspaceId} and project_id=${input.projectId} and id=${input.renderId} and status='rendering' and lease_owner=${input.leaseOwner} returning *`;
      if (!renderRows[0]) return null;
      const projectRows = await sql<ProjectRow[]>`update creative_projects set version=version+1,status='failed',output_media_id=null,last_error=${error},updated_by=${input.updatedBy},updated_at=${input.finishedAt} where workspace_id=${input.workspaceId} and id=${input.projectId} and latest_render_id=${input.renderId} and status='rendering' returning *`;
      if (!projectRows[0]) throw new DomainError("Creative render is no longer the project's active render.", "creative_render_stale", 409);
      await audit(sql, input.event, input.workspaceId, renderFromRow(renderRows[0]).specSnapshot.contentItemId);
      return { project: projectFromRow(projectRows[0]), render: renderFromRow(renderRows[0]) };
    });
  }

  async listRenders(workspaceId: string, projectId: string, limit = 100): Promise<CreativeRender[]> {
    const rows = await this.sql<RenderRow[]>`select * from creative_renders where workspace_id=${workspaceId} and project_id=${projectId} order by created_at desc,id desc limit ${Math.max(1, Math.min(limit, 200))}`;
    return rows.map(renderFromRow);
  }
}
