import { DomainError, type AuditEvent, type Brand, type CreateWorkspaceOrganizationInput, type OrganizationRepository, type Workspace } from "@originpost/domain";
import type { Sql, TransactionSql } from "postgres";

type WorkspaceRow = { id: string; name: string; slug: string; created_at: Date; updated_at: Date };
type BrandRow = { id: string; workspace_id: string; name: string; slug: string; description: string | null; primary_language: string; timezone: string; status: Brand["status"]; created_by: string; created_at: Date; updated_at: Date };

function workspace(row: WorkspaceRow): Workspace {
  return { id: row.id, name: row.name, slug: row.slug, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

function brand(row: BrandRow): Brand {
  return {
    id: row.id, workspaceId: row.workspace_id, name: row.name, slug: row.slug,
    ...(row.description ? { description: row.description } : {}),
    primaryLanguage: row.primary_language, timezone: row.timezone, status: row.status,
    createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

async function writeAudit(sql: Sql | TransactionSql, event: AuditEvent): Promise<void> {
  await sql`insert into audit_events (id, workspace_id, content_item_id, actor_id, actor_type, action, detail, created_at)
    values (${event.id}, ${event.workspaceId}, null, ${event.actorId}, ${event.actorType}, ${event.action}, ${sql.json(event.detail as never)}, ${event.createdAt})
    on conflict (id) do nothing`;
}

export class PostgresOrganizationRepository implements OrganizationRepository {
  constructor(private readonly sql: Sql) {}

  async listWorkspaces(userId?: string): Promise<Workspace[]> {
    const rows = userId
      ? await this.sql<WorkspaceRow[]>`select w.* from workspaces w join workspace_members m on m.workspace_id = w.id where m.user_id = ${userId} order by w.name`
      : await this.sql<WorkspaceRow[]>`select * from workspaces order by name`;
    return rows.map(workspace);
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const rows = await this.sql<WorkspaceRow[]>`select * from workspaces where id = ${id} limit 1`;
    return rows[0] ? workspace(rows[0]) : null;
  }

  async createWorkspace(input: CreateWorkspaceOrganizationInput): Promise<{ workspace: Workspace; defaultBrand: Brand }> {
    try {
      await this.sql.begin(async (sql) => {
        await sql`insert into workspaces (id, name, slug, created_at, updated_at) values (${input.workspace.id}, ${input.workspace.name}, ${input.workspace.slug}, ${input.workspace.createdAt}, ${input.workspace.updatedAt})`;
        await sql`insert into workspace_members (workspace_id, user_id, display_name, role, created_at, updated_at) values (${input.workspace.id}, ${input.ownerUserId}, ${input.ownerDisplayName}, 'owner', ${input.workspace.createdAt}, ${input.workspace.updatedAt})`;
        await sql`insert into brands (id, workspace_id, name, slug, description, primary_language, timezone, status, created_by, created_at, updated_at)
          values (${input.defaultBrand.id}, ${input.defaultBrand.workspaceId}, ${input.defaultBrand.name}, ${input.defaultBrand.slug}, ${input.defaultBrand.description ?? null}, ${input.defaultBrand.primaryLanguage}, ${input.defaultBrand.timezone}, ${input.defaultBrand.status}, ${input.defaultBrand.createdBy}, ${input.defaultBrand.createdAt}, ${input.defaultBrand.updatedAt})`;
        await writeAudit(sql, input.event);
      });
      return { workspace: input.workspace, defaultBrand: input.defaultBrand };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DomainError("This workspace slug is already used.", "workspace_slug_exists", 409);
      throw error;
    }
  }

  async updateWorkspace(value: Workspace, event: AuditEvent): Promise<Workspace> {
    try {
      await this.sql.begin(async (sql) => {
        const rows = await sql<WorkspaceRow[]>`update workspaces set name = ${value.name}, slug = ${value.slug}, updated_at = ${value.updatedAt} where id = ${value.id} returning *`;
        if (!rows.length) throw new DomainError("Workspace not found.", "workspace_not_found", 404);
        await writeAudit(sql, event);
      });
      return value;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DomainError("This workspace slug is already used.", "workspace_slug_exists", 409);
      throw error;
    }
  }

  async listBrands(workspaceId: string, includeArchived = false): Promise<Brand[]> {
    const rows = await this.sql<BrandRow[]>`select * from brands where workspace_id = ${workspaceId} and (${includeArchived} or status = 'active') order by name`;
    return rows.map(brand);
  }

  async getBrand(workspaceId: string, id: string): Promise<Brand | null> {
    const rows = await this.sql<BrandRow[]>`select * from brands where workspace_id = ${workspaceId} and id = ${id} limit 1`;
    return rows[0] ? brand(rows[0]) : null;
  }

  async saveBrand(value: Brand, event: AuditEvent): Promise<Brand> {
    try {
      await this.sql.begin(async (sql) => {
        await sql`insert into brands (id, workspace_id, name, slug, description, primary_language, timezone, status, created_by, created_at, updated_at)
          values (${value.id}, ${value.workspaceId}, ${value.name}, ${value.slug}, ${value.description ?? null}, ${value.primaryLanguage}, ${value.timezone}, ${value.status}, ${value.createdBy}, ${value.createdAt}, ${value.updatedAt})
          on conflict (id) do update set name = excluded.name, slug = excluded.slug, description = excluded.description, primary_language = excluded.primary_language, timezone = excluded.timezone, status = excluded.status, updated_at = excluded.updated_at
          where brands.workspace_id = excluded.workspace_id`;
        await writeAudit(sql, event);
      });
      return value;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new DomainError("This brand slug is already used in the workspace.", "brand_slug_exists", 409);
      throw error;
    }
  }
}
