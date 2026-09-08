import { describe, expect, it } from "vitest";
import {
  createCreativeProject,
  createCreativeRender,
  createCreativeRevision,
  creativeDimensions,
  creativeSpecSha256,
  InMemoryCreativeStudioRepository,
  validateCreativeSpec,
  type AuditEvent,
  type CreativeSpec,
} from "../src/index.js";

const at = "2026-09-01T10:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const spec = (overrides: Partial<CreativeSpec> = {}): CreativeSpec => ({
  format: "portrait",
  sourceMediaId: "media-source",
  sourceMediaSha256: "a".repeat(64),
  headline: "A deterministic headline",
  layout: "editorial",
  font: "manrope",
  textAlign: "left",
  focalPoint: { x: 50, y: 45 },
  zoom: 1.2,
  palette: ["#001122", "#334455", "#667788", "#99AABB", "#CCDDEE"],
  ...overrides,
});
const event = (id: string, workspaceId = "workspace-1"): AuditEvent => ({ id, workspaceId, actorId: "user-1", actorType: "human", action: id, detail: {}, createdAt: at });

describe("Creative Studio domain", () => {
  it("defines the fixed output dimensions and hashes canonical validated specs", () => {
    expect(creativeDimensions).toEqual({ square: { width: 1080, height: 1080 }, portrait: { width: 1080, height: 1350 }, story: { width: 1080, height: 1920 } });
    const first = spec();
    const reordered = { palette: first.palette, zoom: first.zoom, focalPoint: { y: 45, x: 50 }, textAlign: first.textAlign, font: first.font, layout: first.layout, headline: first.headline, sourceMediaSha256: first.sourceMediaSha256, sourceMediaId: first.sourceMediaId, format: first.format };
    expect(creativeSpecSha256(first)).toBe(creativeSpecSha256(reordered));
    expect(creativeSpecSha256(first)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("normalizes render text and colors while rejecting overposting and renderer-unsafe controls", () => {
    const normalized = validateCreativeSpec({ ...spec(), headline: "  Cafe\u0301\r\nNews  ", palette: ["#aabbcc", "#334455", "#667788", "#99aabb", "#ccddee"] });
    expect(normalized.headline).toBe("Café\nNews");
    expect(normalized.palette).toEqual(["#AABBCC", "#334455", "#667788", "#99AABB", "#CCDDEE"]);
    expect(() => validateCreativeSpec({ ...spec(), unexpected: true })).toThrow(/unrecognized key/i);
    expect(() => validateCreativeSpec({ ...spec(), focalPoint: { x: 10, y: 20, z: 30 } })).toThrow(/unrecognized key/i);
    expect(() => validateCreativeSpec({ ...spec(), headline: "unsafe\u0000headline" })).toThrow(/control character/i);
    expect(() => validateCreativeSpec({ ...spec(), headline: "   " })).toThrow(/too small/i);
  });

  it("creates immutable revisions and rejects stale optimistic updates", async () => {
    const repository = new InMemoryCreativeStudioRepository();
    const initial = createCreativeProject({ id: "project-1", revisionId: "revision-1", workspaceId: "workspace-1", brandId: "brand-1", name: "Launch", spec: spec(), actorId: "user-1", now: at });
    await repository.createProject(initial, event("creative.created"));
    const revision = createCreativeRevision(initial.project, { id: "revision-2", spec: spec({ headline: "Revised headline" }), actorId: "user-2", now: later(1) }, 1);
    const changed = await repository.addRevision({ workspaceId: "workspace-1", projectId: "project-1", expectedVersion: 1, revision, updatedBy: "user-2", updatedAt: later(1), event: event("creative.revised") });
    expect(changed?.project).toMatchObject({ version: 2, currentRevisionId: "revision-2", status: "draft" });
    expect((await repository.getRevision("workspace-1", "project-1", "revision-1"))?.specSnapshot.headline).toBe("A deterministic headline");
    expect(await repository.addRevision({ workspaceId: "workspace-1", projectId: "project-1", expectedVersion: 1, revision: { ...revision, id: "revision-stale" }, updatedBy: "user-2", updatedAt: later(2), event: event("creative.stale") })).toBeNull();
  });

  it("idempotently returns active and ready renders and reclaims failed renders", async () => {
    const repository = new InMemoryCreativeStudioRepository();
    const initial = createCreativeProject({ id: "project-render", revisionId: "revision-render", workspaceId: "workspace-1", brandId: "brand-1", name: "Render", spec: spec(), actorId: "user-1", now: at });
    await repository.createProject(initial, event("creative.created"));
    const render = createCreativeRender({ id: "render-1", project: initial.project, revision: initial.revision, rendererVersion: "renderer-1", templateVersion: "template-1", fontVersion: "fonts-1", leaseOwner: "worker-a", leaseExpiresAt: later(5), actorId: "user-1", now: at });
    const startInput = { workspaceId: "workspace-1", projectId: initial.project.id, expectedVersion: 1, render, updatedBy: "user-1", updatedAt: at, leaseOwner: "worker-a", leaseExpiresAt: later(5), event: event("creative.render.started") };
    const started = await repository.startRender(startInput);
    expect(started).toMatchObject({ started: true, project: { version: 2, status: "rendering" }, render: { attemptCount: 1 } });
    expect(await repository.startRender(startInput)).toMatchObject({ started: false, render: { id: "render-1", status: "rendering" } });
    const failed = await repository.failRender({ workspaceId: "workspace-1", projectId: initial.project.id, renderId: render.id, error: "renderer crashed", finishedAt: later(1), updatedBy: "user-1", leaseOwner: "worker-a", event: event("creative.render.failed") });
    const retried = await repository.startRender({ ...startInput, expectedVersion: failed!.project.version, updatedAt: later(2), leaseOwner: "worker-b", leaseExpiresAt: later(7), render: { ...render, leaseOwner: "worker-b", leaseExpiresAt: later(7) }, event: event("creative.render.retried") });
    expect(retried).toMatchObject({ started: true, render: { id: "render-1", status: "rendering", attemptCount: 2, leaseOwner: "worker-b" } });
    const ready = await repository.completeRender({ workspaceId: "workspace-1", projectId: initial.project.id, renderId: render.id, outputMediaId: "media-output", outputSha256: "b".repeat(64), finishedAt: later(3), updatedBy: "user-1", leaseOwner: "worker-b", event: event("creative.render.ready") });
    expect(ready).toMatchObject({ project: { status: "ready", outputMediaId: "media-output" }, render: { status: "ready", outputSha256: "b".repeat(64), attemptCount: 2 } });
    expect(ready!.render).not.toHaveProperty("leaseOwner");
    expect(await repository.startRender({ ...startInput, expectedVersion: ready!.project.version, updatedAt: later(4), event: event("creative.render.duplicate") })).toMatchObject({ started: false, render: { status: "ready" } });
  });

  it("never exposes or mutates a project across workspace scope", async () => {
    const repository = new InMemoryCreativeStudioRepository();
    const initial = createCreativeProject({ id: "project-private", revisionId: "revision-private", workspaceId: "workspace-1", brandId: "brand-1", name: "Private", spec: spec(), actorId: "user-1", now: at });
    await repository.createProject(initial, event("creative.created"));
    expect(await repository.getProject("workspace-2", initial.project.id)).toBeNull();
    expect(await repository.getRevision("workspace-2", initial.project.id, initial.revision.id)).toBeNull();
    expect(await repository.listRevisions("workspace-2", initial.project.id)).toEqual([]);
    expect(await repository.listRenders("workspace-2", initial.project.id)).toEqual([]);
    const render = createCreativeRender({ project: initial.project, revision: initial.revision, rendererVersion: "renderer-1", templateVersion: "template-1", fontVersion: "fonts-1", leaseOwner: "worker-a", leaseExpiresAt: later(5), actorId: "user-1", now: at });
    expect(await repository.startRender({ workspaceId: "workspace-2", projectId: initial.project.id, expectedVersion: 1, render, updatedBy: "user-1", updatedAt: at, leaseOwner: "worker-a", leaseExpiresAt: later(5), event: event("creative.cross-workspace", "workspace-2") })).toBeNull();
  });
});
