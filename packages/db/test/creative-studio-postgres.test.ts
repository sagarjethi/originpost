import { createCreativeProject, createCreativeRender, type AuditEvent, type CreativeSpec } from "@originpost/domain";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCreativeStudioRepository } from "../src/postgres-creative-studio-repository.js";
import { PostgresMediaRepository } from "../src/postgres-media-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const workspaceId = "workspace-creative-integration";
const brandId = "brand-creative-integration";
const sourceMediaId = "media-creative-source";
const outputMediaId = "media-creative-output";
const at = "2026-09-01T10:00:00.000Z";
const audit = (id: string): AuditEvent => ({ id, workspaceId, actorId: "creative-user", actorType: "human", action: id, detail: {}, createdAt: at });
const spec: CreativeSpec = { format: "portrait", sourceMediaId, sourceMediaSha256: "a".repeat(64), headline: "Postgres creative", layout: "editorial", font: "manrope", textAlign: "left", focalPoint: { x: 50, y: 50 }, zoom: 1, palette: ["#001122", "#334455", "#667788", "#99AABB", "#CCDDEE"] };

suite("Postgres Creative Studio repository", () => {
  const sql = postgres(databaseUrl!);
  const repository = new PostgresCreativeStudioRepository(sql);
  const mediaRepository = new PostgresMediaRepository(sql);

  beforeAll(async () => {
    await sql`insert into workspaces(id,name,slug,created_at,updated_at) values(${workspaceId},'Creative integration','creative-integration',${at},${at}) on conflict(id) do nothing`;
    await sql`insert into brands(id,workspace_id,name,slug,primary_language,timezone,status,created_by,created_at,updated_at) values(${brandId},${workspaceId},'Creative brand','creative','English','UTC','active','creative-user',${at},${at}) on conflict(id) do nothing`;
    for (const [id, sha] of [[sourceMediaId, "a".repeat(64)], [outputMediaId, "b".repeat(64)]]) {
      await sql`insert into media_assets(id,workspace_id,brand_id,kind,purpose,file_name,content_type,size_bytes,sha256,object_key,status,rights_state,created_by,created_at,ready_at,payload,upload_expires_at,inspection_status,width_pixels,height_pixels) values(${id},${workspaceId},${brandId},'image','creative',${`${id}.png`},'image/png',100,${sha},${`creative/${id}.png`},'ready','owned','creative-user',${at},${at},${sql.json({} as never)},'2026-09-02T10:00:00.000Z','ready',1080,1350) on conflict(id) do nothing`;
    }
  });

  afterAll(async () => {
    await sql`delete from creative_projects where workspace_id=${workspaceId}`;
    await sql`delete from media_assets where workspace_id=${workspaceId}`;
    await sql`delete from workspaces where id=${workspaceId}`;
    await sql.end();
  });

  it("persists audited immutable lineage, scopes reads, and idempotently retries a failed manifest", async () => {
    const initial = createCreativeProject({ id: "creative-postgres", revisionId: "creative-revision-postgres", workspaceId, brandId, name: "Postgres", spec, actorId: "creative-user", now: at });
    await repository.createProject(initial, audit("creative-postgres-created"));
    expect(await repository.getProject("another-workspace", initial.project.id)).toBeNull();
    const render = createCreativeRender({ id: "creative-render-postgres", project: initial.project, revision: initial.revision, rendererVersion: "renderer-1", templateVersion: "template-1", fontVersion: "font-1", leaseOwner: "worker-a", leaseExpiresAt: "2099-09-01T10:05:00.000Z", actorId: "creative-user", now: at });
    const started = await repository.startRender({ workspaceId, projectId: initial.project.id, expectedVersion: 1, render, updatedBy: "creative-user", updatedAt: at, leaseOwner: "worker-a", leaseExpiresAt: render.leaseExpiresAt!, event: audit("creative-postgres-started") });
    expect(started).toMatchObject({ started: true, render: { attemptCount: 1 } });
    expect(await repository.startRender({ workspaceId, projectId: initial.project.id, expectedVersion: 1, render, updatedBy: "creative-user", updatedAt: at, leaseOwner: "worker-a", leaseExpiresAt: render.leaseExpiresAt!, event: audit("creative-postgres-duplicate") })).toMatchObject({ started: false });
    const failed = await repository.failRender({ workspaceId, projectId: initial.project.id, renderId: render.id, error: "failed", finishedAt: "2026-09-01T10:01:00.000Z", updatedBy: "creative-user", leaseOwner: "worker-a", event: audit("creative-postgres-failed") });
    const retried = await repository.startRender({ workspaceId, projectId: initial.project.id, expectedVersion: failed!.project.version, render: { ...render, leaseOwner: "worker-b", leaseExpiresAt: "2099-09-01T10:10:00.000Z" }, updatedBy: "creative-user", updatedAt: "2026-09-01T10:02:00.000Z", leaseOwner: "worker-b", leaseExpiresAt: "2099-09-01T10:10:00.000Z", event: audit("creative-postgres-retried") });
    expect(retried).toMatchObject({ started: true, render: { id: render.id, attemptCount: 2, leaseOwner: "worker-b" } });
    const ready = await repository.completeRender({ workspaceId, projectId: initial.project.id, renderId: render.id, outputMediaId, outputSha256: "b".repeat(64), finishedAt: "2026-09-01T10:03:00.000Z", updatedBy: "creative-user", leaseOwner: "worker-b", event: audit("creative-postgres-ready") });
    expect(ready).toMatchObject({ project: { status: "ready", outputMediaId }, render: { status: "ready", attemptCount: 2 } });
    expect(await mediaRepository.references(workspaceId, outputMediaId)).toMatchObject({ creativeProjectIds: [initial.project.id], creativeRenderIds: [render.id] });
    expect(await sql<{ count: number }[]>`select count(*)::int as count from audit_events where id in ('creative-postgres-created','creative-postgres-started','creative-postgres-failed','creative-postgres-retried','creative-postgres-ready')`).toEqual([{ count: 5 }]);
  });
  it("stores top-headline logo/disclosure snapshots and rejects unknown or malformed fields", async () => {
    const branded: CreativeSpec = {...spec,layout:"headline-top",disclosure:"AI દ્વારા બનાવેલ પ્રતીકાત્મક તસવીર",logo:{mediaId:sourceMediaId,sha256:"a".repeat(64),position:"top-left",widthPercent:25,marginPercent:4,background:"#001122",crop:"full"}};
    const initial = createCreativeProject({id:"creative-logo-postgres",revisionId:"creative-logo-revision-postgres",workspaceId,brandId,name:"Logo and disclosure",spec:branded,actorId:"creative-user",now:at});
    await repository.createProject(initial,audit("creative-logo-created"));
    const rows = await sql`select spec from creative_revisions where id=${initial.revision.id}`;
    expect(rows[0]!.spec).toMatchObject({layout:"headline-top",disclosure:branded.disclosure,logo:branded.logo});
    for (const invalid of [{...branded,unexpected:true},{...branded,logo:{...branded.logo,sha256:"invalid"}},{...branded,disclosure:"X".repeat(61)}]) {
      await expect(sql`update creative_revisions set spec=${sql.json(invalid as never)} where id=${initial.revision.id}`).rejects.toMatchObject({code:"23514"});
    }
  });
});
