import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "./errors.js";
import type { AuditEvent } from "./types.js";

export const creativeFormats = ["square", "portrait", "story"] as const;
export const creativeLayouts = ["editorial", "headline", "headline-top", "quote"] as const;
export const creativeFonts = ["manrope", "newsreader"] as const;
export const creativeTextAlignments = ["left", "center"] as const;
export const creativeProjectStatuses = ["draft", "rendering", "ready", "failed"] as const;
export const creativeRenderStatuses = ["rendering", "ready", "failed"] as const;

export type CreativeFormat = (typeof creativeFormats)[number];
export type CreativeLayout = (typeof creativeLayouts)[number];
export type CreativeFont = (typeof creativeFonts)[number];
export type CreativeTextAlign = (typeof creativeTextAlignments)[number];
export type CreativeProjectStatus = (typeof creativeProjectStatuses)[number];
export type CreativeRenderStatus = (typeof creativeRenderStatuses)[number];

export const creativeDimensions: Record<CreativeFormat, Readonly<{ width: number; height: number }>> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
};

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256");
const nonEmptyIdSchema = z.string().min(1).max(200);
const invalidRendererControlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const creativeTextSchema = (maximum: number, required = false) => z.string()
  .refine((value) => !invalidRendererControlCharacters.test(value), "contains a control character that cannot be rendered")
  .transform((value) => value.normalize("NFC").replace(/\r\n?/gu, "\n").trim())
  .pipe(required ? z.string().min(1).max(maximum) : z.string().max(maximum));
const colorSchema = z.string().regex(/^#[A-Fa-f0-9]{6}$/u, "must be a #RRGGBB color").transform((value) => value.toUpperCase());

export const creativeSpecSchema = z.object({
  format: z.enum(creativeFormats),
  sourceMediaId: nonEmptyIdSchema,
  sourceMediaSha256: sha256Schema,
  contentItemId: nonEmptyIdSchema.optional(),
  kicker: creativeTextSchema(80).optional(),
  headline: creativeTextSchema(180, true),
  subtitle: creativeTextSchema(280).optional(),
  footer: creativeTextSchema(120).optional(),
  layout: z.enum(creativeLayouts),
  font: z.enum(creativeFonts),
  textAlign: z.enum(creativeTextAlignments),
  focalPoint: z.object({ x: z.number().finite().min(0).max(100), y: z.number().finite().min(0).max(100) }).strict(),
  zoom: z.number().finite().min(1).max(2),
  logo: z.object({
    mediaId: nonEmptyIdSchema, sha256: sha256Schema,
    position: z.enum(["top-left", "top-right"]),
    widthPercent: z.number().min(8).max(25), marginPercent: z.number().min(2).max(6),
    background: colorSchema.default("#FFFFFF"),
    crop: z.enum(["full", "top-left", "top-right", "bottom-left", "bottom-right"]).default("full"),
  }).strict().optional(),
  disclosure: creativeTextSchema(60).optional(),
  palette: z.tuple([colorSchema, colorSchema, colorSchema, colorSchema, colorSchema]),
}).strict();

export type CreativeSpec = z.infer<typeof creativeSpecSchema>;

export interface CreativeProject {
  id: string;
  workspaceId: string;
  brandId: string;
  version: number;
  name: string;
  currentRevisionId: string;
  status: CreativeProjectStatus;
  latestRenderId?: string;
  outputMediaId?: string;
  lastError?: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreativeRevision {
  id: string;
  workspaceId: string;
  brandId: string;
  projectId: string;
  revisionNumber: number;
  specSnapshot: CreativeSpec;
  specSha256: string;
  createdBy: string;
  createdAt: string;
}

export interface CreativeRender {
  id: string;
  workspaceId: string;
  brandId: string;
  projectId: string;
  revisionId: string;
  specSnapshot: CreativeSpec;
  specSha256: string;
  rendererVersion: string;
  renderManifestSha256: string;
  status: CreativeRenderStatus;
  outputMediaId?: string;
  outputSha256?: string;
  error?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  attemptCount: number;
  createdBy: string;
  createdAt: string;
  finishedAt?: string;
}

export interface CreativeProjectWithRevision {
  project: CreativeProject;
  revision: CreativeRevision;
}

export interface CreativeRenderStart {
  project: CreativeProject;
  render: CreativeRender;
  started: boolean;
}

export interface AddCreativeRevisionInput {
  workspaceId: string;
  projectId: string;
  expectedVersion: number;
  revision: CreativeRevision;
  name?: string;
  updatedBy: string;
  updatedAt: string;
  event: AuditEvent;
}

export interface StartCreativeRenderInput {
  workspaceId: string;
  projectId: string;
  expectedVersion: number;
  render: CreativeRender;
  updatedBy: string;
  updatedAt: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  event: AuditEvent;
}

export interface CompleteCreativeRenderInput {
  workspaceId: string;
  projectId: string;
  renderId: string;
  outputMediaId: string;
  outputSha256: string;
  finishedAt: string;
  updatedBy: string;
  leaseOwner: string;
  event: AuditEvent;
}

export interface FailCreativeRenderInput {
  workspaceId: string;
  projectId: string;
  renderId: string;
  error: string;
  finishedAt: string;
  updatedBy: string;
  leaseOwner: string;
  event: AuditEvent;
}

export interface CreativeStudioRepository {
  listProjects(workspaceId: string, brandId?: string, limit?: number): Promise<CreativeProject[]>;
  getProject(workspaceId: string, id: string): Promise<CreativeProject | null>;
  createProject(initial: CreativeProjectWithRevision, event: AuditEvent): Promise<CreativeProjectWithRevision>;
  addRevision(input: AddCreativeRevisionInput): Promise<CreativeProjectWithRevision | null>;
  getRevision(workspaceId: string, projectId: string, revisionId: string): Promise<CreativeRevision | null>;
  listRevisions(workspaceId: string, projectId: string, limit?: number): Promise<CreativeRevision[]>;
  startRender(input: StartCreativeRenderInput): Promise<CreativeRenderStart | null>;
  completeRender(input: CompleteCreativeRenderInput): Promise<{ project: CreativeProject; render: CreativeRender } | null>;
  failRender(input: FailCreativeRenderInput): Promise<{ project: CreativeProject; render: CreativeRender } | null>;
  listRenders(workspaceId: string, projectId: string, limit?: number): Promise<CreativeRender[]>;
}

function cleanRequired(value: string, maximum: number, field: string): string {
  const cleaned = value.normalize("NFC").replace(/\u0000/gu, "").trim();
  if (!cleaned || cleaned.length > maximum) throw new DomainError(`${field} must contain 1–${maximum} characters.`, "creative_project_invalid");
  return cleaned;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateCreativeSpec(input: unknown): CreativeSpec {
  const result = creativeSpecSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.length ? issue.path.join(".") : "spec";
    throw new DomainError(`Creative spec ${location} ${issue?.message ?? "is invalid"}.`, "creative_spec_invalid");
  }
  return structuredClone(result.data);
}

export function creativeSpecSha256(input: unknown): string {
  return createHash("sha256").update(canonicalJson(validateCreativeSpec(input)), "utf8").digest("hex");
}

export interface CreativeRenderManifest {
  specSha256: string;
  rendererVersion: string;
  templateVersion: string;
  fontVersion: string;
}

export function creativeRenderManifestSha256(input: CreativeRenderManifest): string {
  const parsed = z.object({
    specSha256: sha256Schema,
    rendererVersion: z.string().min(1).max(120),
    templateVersion: z.string().min(1).max(120),
    fontVersion: z.string().min(1).max(120),
  }).strict().safeParse(input);
  if (!parsed.success) throw new DomainError("Creative render manifest is invalid.", "creative_render_manifest_invalid");
  return createHash("sha256").update(canonicalJson(parsed.data), "utf8").digest("hex");
}

export function createCreativeProject(input: {
  id?: string;
  revisionId?: string;
  workspaceId: string;
  brandId: string;
  name: string;
  spec: unknown;
  actorId: string;
  now?: string;
}): CreativeProjectWithRevision {
  const now = input.now ?? new Date().toISOString();
  const specSnapshot = validateCreativeSpec(input.spec);
  const projectId = input.id ?? `creative_project_${randomUUID()}`;
  const revisionId = input.revisionId ?? `creative_revision_${randomUUID()}`;
  const workspaceId = cleanRequired(input.workspaceId, 200, "Workspace ID");
  const brandId = cleanRequired(input.brandId, 200, "Brand ID");
  const actorId = cleanRequired(input.actorId, 200, "Actor ID");
  const revision: CreativeRevision = {
    id: revisionId,
    workspaceId,
    brandId,
    projectId,
    revisionNumber: 1,
    specSnapshot,
    specSha256: creativeSpecSha256(specSnapshot),
    createdBy: actorId,
    createdAt: now,
  };
  return {
    project: {
      id: projectId,
      workspaceId,
      brandId,
      version: 1,
      name: cleanRequired(input.name, 120, "Creative project name"),
      currentRevisionId: revision.id,
      status: "draft",
      createdBy: actorId,
      updatedBy: actorId,
      createdAt: now,
      updatedAt: now,
    },
    revision,
  };
}

export function createCreativeRevision(current: CreativeProject, input: { id?: string; spec: unknown; actorId: string; now?: string }, currentRevisionNumber: number): CreativeRevision {
  if (!Number.isInteger(currentRevisionNumber) || currentRevisionNumber < 1) throw new DomainError("Current creative revision number is invalid.", "creative_revision_invalid");
  const specSnapshot = validateCreativeSpec(input.spec);
  return {
    id: input.id ?? `creative_revision_${randomUUID()}`,
    workspaceId: current.workspaceId,
    brandId: current.brandId,
    projectId: current.id,
    revisionNumber: currentRevisionNumber + 1,
    specSnapshot,
    specSha256: creativeSpecSha256(specSnapshot),
    createdBy: cleanRequired(input.actorId, 200, "Actor ID"),
    createdAt: input.now ?? new Date().toISOString(),
  };
}

export function createCreativeRender(input: {
  id?: string;
  project: CreativeProject;
  revision: CreativeRevision;
  rendererVersion: string;
  templateVersion: string;
  fontVersion: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  actorId: string;
  now?: string;
}): CreativeRender {
  if (input.project.currentRevisionId !== input.revision.id || input.revision.projectId !== input.project.id || input.revision.workspaceId !== input.project.workspaceId || input.revision.brandId !== input.project.brandId) {
    throw new DomainError("Creative revision does not belong to the project's current composition.", "creative_revision_mismatch", 409);
  }
  if (creativeSpecSha256(input.revision.specSnapshot) !== input.revision.specSha256) throw new DomainError("Creative revision hash does not match its spec.", "creative_revision_hash_mismatch", 409);
  const rendererVersion = cleanRequired(input.rendererVersion, 120, "Renderer version");
  const createdAt = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(input.leaseExpiresAt)) || Date.parse(input.leaseExpiresAt) <= Date.parse(createdAt)) throw new DomainError("Creative render lease must expire after the render starts.", "creative_render_lease_invalid");
  return {
    id: input.id ?? `creative_render_${randomUUID()}`,
    workspaceId: input.project.workspaceId,
    brandId: input.project.brandId,
    projectId: input.project.id,
    revisionId: input.revision.id,
    specSnapshot: structuredClone(input.revision.specSnapshot),
    specSha256: input.revision.specSha256,
    rendererVersion,
    renderManifestSha256: creativeRenderManifestSha256({ specSha256: input.revision.specSha256, rendererVersion, templateVersion: input.templateVersion, fontVersion: input.fontVersion }),
    status: "rendering",
    leaseOwner: cleanRequired(input.leaseOwner, 200, "Render lease owner"),
    leaseExpiresAt: input.leaseExpiresAt,
    attemptCount: 1,
    createdBy: cleanRequired(input.actorId, 200, "Actor ID"),
    createdAt,
  };
}

function validateRevision(project: CreativeProject, revision: CreativeRevision, expectedRevisionNumber: number): void {
  if (revision.workspaceId !== project.workspaceId || revision.brandId !== project.brandId || revision.projectId !== project.id || revision.revisionNumber !== expectedRevisionNumber) {
    throw new DomainError("Creative revision lineage is invalid.", "creative_revision_mismatch", 409);
  }
  if (!/^[a-f0-9]{64}$/u.test(revision.specSha256) || creativeSpecSha256(revision.specSnapshot) !== revision.specSha256) {
    throw new DomainError("Creative revision hash does not match its spec.", "creative_revision_hash_mismatch", 409);
  }
}

function validateNewRender(project: CreativeProject, revision: CreativeRevision, render: CreativeRender): void {
  if (render.workspaceId !== project.workspaceId || render.brandId !== project.brandId || render.projectId !== project.id || render.revisionId !== revision.id || render.specSha256 !== revision.specSha256 || creativeSpecSha256(render.specSnapshot) !== revision.specSha256) {
    throw new DomainError("Creative render lineage is invalid.", "creative_render_mismatch", 409);
  }
  if (render.status !== "rendering" || render.outputMediaId || render.outputSha256 || render.error || render.finishedAt || !render.leaseOwner || !render.leaseExpiresAt || !Number.isInteger(render.attemptCount) || render.attemptCount !== 1 || !/^[a-f0-9]{64}$/u.test(render.renderManifestSha256)) {
    throw new DomainError("A new creative render must contain a valid rendering manifest and no result fields.", "creative_render_invalid", 409);
  }
}

export class InMemoryCreativeStudioRepository implements CreativeStudioRepository {
  private readonly projects = new Map<string, CreativeProject>();
  private readonly revisions = new Map<string, CreativeRevision>();
  private readonly renders = new Map<string, CreativeRender>();
  private readonly events: AuditEvent[] = [];

  async listProjects(workspaceId: string, brandId?: string, limit = 100): Promise<CreativeProject[]> {
    return [...this.projects.values()].filter((project) => project.workspaceId === workspaceId && (!brandId || project.brandId === brandId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(0, Math.max(1, Math.min(limit, 200))).map((project) => structuredClone(project));
  }

  async getProject(workspaceId: string, id: string): Promise<CreativeProject | null> {
    const project = this.projects.get(id);
    return project?.workspaceId === workspaceId ? structuredClone(project) : null;
  }

  async createProject(initial: CreativeProjectWithRevision, event: AuditEvent): Promise<CreativeProjectWithRevision> {
    const { project, revision } = structuredClone(initial);
    if (this.projects.has(project.id) || this.revisions.has(revision.id)) throw new DomainError("Creative project already exists.", "creative_project_exists", 409);
    if (project.version !== 1 || project.currentRevisionId !== revision.id || project.status !== "draft" || project.latestRenderId || project.outputMediaId || project.lastError) throw new DomainError("Initial creative project state is invalid.", "creative_project_invalid");
    validateRevision(project, revision, 1);
    this.recordEvent(event, project.workspaceId, revision.specSnapshot);
    this.projects.set(project.id, project);
    this.revisions.set(revision.id, revision);
    return structuredClone({ project, revision });
  }

  async addRevision(input: AddCreativeRevisionInput): Promise<CreativeProjectWithRevision | null> {
    const current = this.projects.get(input.projectId);
    if (!current || current.workspaceId !== input.workspaceId || current.version !== input.expectedVersion) return null;
    const currentRevision = this.revisions.get(current.currentRevisionId);
    if (!currentRevision) throw new Error("Creative project's current revision is missing.");
    validateRevision(current, input.revision, currentRevision.revisionNumber + 1);
    if (this.revisions.has(input.revision.id)) throw new DomainError("Creative revision already exists.", "creative_revision_exists", 409);
    const next: CreativeProject = {
      ...current,
      version: current.version + 1,
      name: input.name === undefined ? current.name : cleanRequired(input.name, 120, "Creative project name"),
      currentRevisionId: input.revision.id,
      status: "draft",
      updatedBy: cleanRequired(input.updatedBy, 200, "Actor ID"),
      updatedAt: input.updatedAt,
    };
    delete next.latestRenderId;
    delete next.outputMediaId;
    delete next.lastError;
    this.recordEvent(input.event, current.workspaceId, input.revision.specSnapshot);
    this.revisions.set(input.revision.id, structuredClone(input.revision));
    this.projects.set(current.id, structuredClone(next));
    return structuredClone({ project: next, revision: input.revision });
  }

  async getRevision(workspaceId: string, projectId: string, revisionId: string): Promise<CreativeRevision | null> {
    const revision = this.revisions.get(revisionId);
    return revision?.workspaceId === workspaceId && revision.projectId === projectId ? structuredClone(revision) : null;
  }

  async listRevisions(workspaceId: string, projectId: string, limit = 100): Promise<CreativeRevision[]> {
    return [...this.revisions.values()].filter((revision) => revision.workspaceId === workspaceId && revision.projectId === projectId).sort((a, b) => b.revisionNumber - a.revisionNumber).slice(0, Math.max(1, Math.min(limit, 200))).map((revision) => structuredClone(revision));
  }

  async startRender(input: StartCreativeRenderInput): Promise<CreativeRenderStart | null> {
    const current = this.projects.get(input.projectId);
    if (!current || current.workspaceId !== input.workspaceId || current.currentRevisionId !== input.render.revisionId) return null;
    const revision = this.revisions.get(input.render.revisionId);
    if (!revision) return null;
    validateNewRender(current, revision, input.render);
    if (input.render.leaseOwner !== input.leaseOwner || input.render.leaseExpiresAt !== input.leaseExpiresAt) throw new DomainError("Creative render lease does not match the start request.", "creative_render_lease_mismatch", 409);
    if (!Number.isFinite(Date.parse(input.leaseExpiresAt)) || Date.parse(input.leaseExpiresAt) <= Date.parse(input.updatedAt)) throw new DomainError("Creative render lease is already expired.", "creative_render_lease_invalid", 409);
    const existing = [...this.renders.values()].find((render) => render.revisionId === revision.id && render.specSha256 === revision.specSha256);
    if (existing) {
      if (existing.renderManifestSha256 !== input.render.renderManifestSha256) throw new DomainError("This revision was already rendered with a different renderer manifest. Create a new revision before rendering again.", "creative_render_manifest_conflict", 409);
      if (existing.status === "ready" || existing.status === "rendering" && Date.parse(existing.leaseExpiresAt ?? "") > Date.parse(input.updatedAt)) return { project: structuredClone(current), render: structuredClone(existing), started: false };
      if (current.version !== input.expectedVersion) return null;
      const reclaimed: CreativeRender = { ...existing, status: "rendering", leaseOwner: cleanRequired(input.leaseOwner, 200, "Render lease owner"), leaseExpiresAt: input.leaseExpiresAt, attemptCount: existing.attemptCount + 1 };
      delete reclaimed.outputMediaId;
      delete reclaimed.outputSha256;
      delete reclaimed.error;
      delete reclaimed.finishedAt;
      const next: CreativeProject = { ...current, version: current.version + 1, status: "rendering", latestRenderId: reclaimed.id, updatedBy: cleanRequired(input.updatedBy, 200, "Actor ID"), updatedAt: input.updatedAt };
      delete next.outputMediaId;
      delete next.lastError;
      this.recordEvent(input.event, current.workspaceId, revision.specSnapshot);
      this.renders.set(reclaimed.id, structuredClone(reclaimed));
      this.projects.set(next.id, structuredClone(next));
      return { project: structuredClone(next), render: structuredClone(reclaimed), started: true };
    }
    if (current.version !== input.expectedVersion) return null;
    const next: CreativeProject = { ...current, version: current.version + 1, status: "rendering", latestRenderId: input.render.id, updatedBy: cleanRequired(input.updatedBy, 200, "Actor ID"), updatedAt: input.updatedAt };
    delete next.outputMediaId;
    delete next.lastError;
    this.recordEvent(input.event, current.workspaceId, revision.specSnapshot);
    this.renders.set(input.render.id, structuredClone(input.render));
    this.projects.set(current.id, structuredClone(next));
    return { project: structuredClone(next), render: structuredClone(input.render), started: true };
  }

  async completeRender(input: CompleteCreativeRenderInput): Promise<{ project: CreativeProject; render: CreativeRender } | null> {
    const current = this.projects.get(input.projectId);
    const currentRender = this.renders.get(input.renderId);
    if (!current || current.workspaceId !== input.workspaceId || current.latestRenderId !== input.renderId || current.status !== "rendering" || !currentRender || currentRender.workspaceId !== input.workspaceId || currentRender.status !== "rendering" || currentRender.leaseOwner !== input.leaseOwner) return null;
    if (!/^[a-f0-9]{64}$/u.test(input.outputSha256)) throw new DomainError("Creative output hash must be a lowercase SHA-256.", "creative_render_output_invalid");
    const render: CreativeRender = { ...currentRender, status: "ready", outputMediaId: cleanRequired(input.outputMediaId, 200, "Output media ID"), outputSha256: input.outputSha256, finishedAt: input.finishedAt };
    delete render.leaseOwner;
    delete render.leaseExpiresAt;
    const project: CreativeProject = { ...current, version: current.version + 1, status: "ready", outputMediaId: render.outputMediaId!, updatedBy: cleanRequired(input.updatedBy, 200, "Actor ID"), updatedAt: input.finishedAt };
    delete project.lastError;
    this.recordEvent(input.event, current.workspaceId, currentRender.specSnapshot);
    this.renders.set(render.id, structuredClone(render));
    this.projects.set(project.id, structuredClone(project));
    return structuredClone({ project, render });
  }

  async failRender(input: FailCreativeRenderInput): Promise<{ project: CreativeProject; render: CreativeRender } | null> {
    const current = this.projects.get(input.projectId);
    const currentRender = this.renders.get(input.renderId);
    if (!current || current.workspaceId !== input.workspaceId || current.latestRenderId !== input.renderId || current.status !== "rendering" || !currentRender || currentRender.workspaceId !== input.workspaceId || currentRender.status !== "rendering" || currentRender.leaseOwner !== input.leaseOwner) return null;
    const error = cleanRequired(input.error, 2_000, "Render error");
    const render: CreativeRender = { ...currentRender, status: "failed", error, finishedAt: input.finishedAt };
    delete render.leaseOwner;
    delete render.leaseExpiresAt;
    const project: CreativeProject = { ...current, version: current.version + 1, status: "failed", lastError: error, updatedBy: cleanRequired(input.updatedBy, 200, "Actor ID"), updatedAt: input.finishedAt };
    delete project.outputMediaId;
    this.recordEvent(input.event, current.workspaceId, currentRender.specSnapshot);
    this.renders.set(render.id, structuredClone(render));
    this.projects.set(project.id, structuredClone(project));
    return structuredClone({ project, render });
  }

  async listRenders(workspaceId: string, projectId: string, limit = 100): Promise<CreativeRender[]> {
    return [...this.renders.values()].filter((render) => render.workspaceId === workspaceId && render.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).slice(0, Math.max(1, Math.min(limit, 200))).map((render) => structuredClone(render));
  }

  private recordEvent(event: AuditEvent, workspaceId: string, spec: CreativeSpec): void {
    if (event.workspaceId !== workspaceId || event.contentItemId && event.contentItemId !== spec.contentItemId) throw new DomainError("Creative audit event lineage is invalid.", "creative_audit_mismatch", 409);
    if (this.events.some((existing) => existing.id === event.id)) throw new DomainError("Creative audit event already exists.", "creative_audit_exists", 409);
    this.events.push(structuredClone({ ...event, ...(event.contentItemId || !spec.contentItemId ? {} : { contentItemId: spec.contentItemId }) }));
  }
}
