import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { can, createCreativeProject, createCreativeRender, createCreativeRevision, DomainError, type Actor, type AuditEvent, type CreativeProject, type CreativeRender, type CreativeSpec } from "@originpost/domain";
import { randomUUID } from "node:crypto";
import { resolveActiveBrand, resolveBrandFilter } from "../common/brand-context.js";
import { INFRASTRUCTURE } from "../common/tokens.js";
import type { OriginPostInfrastructure } from "../infrastructure/infrastructure.types.js";
import type { AddCreativeRevisionDto, CreateCreativeProjectDto } from "./creative-studio.dto.js";
import { CreativeRenderCoordinator } from "./creative-render.coordinator.js";
import { CREATIVE_FONT_VERSION, CREATIVE_RENDERER_VERSION, CREATIVE_TEMPLATE_VERSION } from "./creative-renderer.js";

const templates = [
  { id: "headline", name: "Headline", layout: "headline", description: "Full-bleed image with a protected lower text field." },
  { id: "editorial", name: "Photo-led editorial", layout: "editorial", description: "Image-led story with a calm side panel for exact copy." },
  { id: "quote", name: "Quote", layout: "quote", description: "A focused statement card with a strong central panel." },
] as const;

function publicAsset<T extends { objectKey: string }>(asset: T) { const { objectKey: _objectKey, ...visible } = asset; return visible }

@Injectable()
export class CreativeStudioService {
  constructor(
    @Inject(INFRASTRUCTURE) private readonly infrastructure: OriginPostInfrastructure,
    private readonly coordinator: CreativeRenderCoordinator,
  ) {}

  templates(actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view creative templates.");
    return templates;
  }

  async list(workspaceId: string, brandId: string | undefined, limit: number, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view Creative Studio.");
    const resolved = await resolveBrandFilter(this.infrastructure.organizationRepository, workspaceId, brandId);
    if (!resolved) return [];
    return this.infrastructure.creativeStudioRepository.listProjects(workspaceId, resolved, limit);
  }

  async detail(workspaceId: string, projectId: string, actor: Actor) {
    if (!can(actor.role, "content:read")) throw new ForbiddenException("You cannot view Creative Studio.");
    const project = await this.project(workspaceId, projectId);
    const revisions = await this.infrastructure.creativeStudioRepository.listRevisions(workspaceId, project.id, 100);
    const currentRevision = revisions.find((revision) => revision.id === project.currentRevisionId);
    if (!currentRevision) throw new ConflictException("This creative project's current revision is unavailable.");
    const renders = await this.infrastructure.creativeStudioRepository.listRenders(workspaceId, project.id, 100);
    const outputAsset = project.outputMediaId ? await this.infrastructure.mediaRepository.get(workspaceId, project.outputMediaId) : null;
    return { project, currentRevision, revisions, renders: renders.map(this.publicRender), ...(outputAsset ? { outputAsset: publicAsset(outputAsset) } : {}) };
  }

  async create(workspaceId: string, dto: CreateCreativeProjectDto, actor: Actor) {
    this.editable(actor);
    const brandId = await resolveActiveBrand(this.infrastructure.organizationRepository, workspaceId, dto.brandId);
    const spec = await this.authoritativeSpec(workspaceId, brandId, dto.spec);
    const initial = createCreativeProject({ workspaceId, brandId, name: dto.name, spec, actorId: actor.id });
    await this.infrastructure.creativeStudioRepository.createProject(initial, this.audit(initial.project, actor, "creative.project-created", { revisionId: initial.revision.id, revisionNumber: 1, specSha256: initial.revision.specSha256 }, spec));
    return this.detail(workspaceId, initial.project.id, actor);
  }

  async addRevision(workspaceId: string, projectId: string, expectedVersion: number | undefined, dto: AddCreativeRevisionDto, actor: Actor) {
    this.editable(actor);
    if (!expectedVersion) throw new DomainError("Use If-Match with the current Creative Studio project version.", "version_required", 428);
    const project = await this.project(workspaceId, projectId);
    if (project.version !== expectedVersion) throw new DomainError("This visual project changed. Refresh and try again.", "version_conflict", 409);
    const current = await this.infrastructure.creativeStudioRepository.getRevision(workspaceId, project.id, project.currentRevisionId);
    if (!current) throw new ConflictException("This creative project's current revision is unavailable.");
    const spec = await this.authoritativeSpec(workspaceId, project.brandId, dto.spec);
    const revision = createCreativeRevision(project, { spec, actorId: actor.id }, current.revisionNumber);
    const saved = await this.infrastructure.creativeStudioRepository.addRevision({
      workspaceId,
      projectId,
      expectedVersion,
      revision,
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      updatedBy: actor.id,
      updatedAt: revision.createdAt,
      event: this.audit(project, actor, "creative.revision-created", { revisionId: revision.id, revisionNumber: revision.revisionNumber, specSha256: revision.specSha256 }, spec),
    });
    if (!saved) throw new DomainError("This visual project changed. Refresh and try again.", "version_conflict", 409);
    return this.detail(workspaceId, projectId, actor);
  }

  async render(workspaceId: string, projectId: string, revisionId: string, expectedVersion: number | undefined, actor: Actor) {
    this.editable(actor);
    if (!expectedVersion) throw new DomainError("Use If-Match with the current Creative Studio project version.", "version_required", 428);
    const project = await this.project(workspaceId, projectId);
    const revision = await this.infrastructure.creativeStudioRepository.getRevision(workspaceId, project.id, revisionId);
    if (!revision) throw new NotFoundException("Creative revision not found.");
    if (project.currentRevisionId !== revision.id) throw new ConflictException("Only the current immutable revision can be rendered. Select it or create a new revision.");
    await this.authoritativeSpec(workspaceId, project.brandId, revision.specSnapshot);
    const now = new Date();
    const leaseOwner = `creative-${randomUUID()}`;
    const leaseExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const render = createCreativeRender({ project, revision, rendererVersion: CREATIVE_RENDERER_VERSION, templateVersion: CREATIVE_TEMPLATE_VERSION, fontVersion: CREATIVE_FONT_VERSION, leaseOwner, leaseExpiresAt, actorId: actor.id, now: now.toISOString() });
    const started = await this.infrastructure.creativeStudioRepository.startRender({
      workspaceId,
      projectId,
      expectedVersion,
      render,
      updatedBy: actor.id,
      updatedAt: now.toISOString(),
      leaseOwner,
      leaseExpiresAt,
      event: this.audit(project, actor, "creative.render-requested", { revisionId, renderId: render.id, renderManifestSha256: render.renderManifestSha256 }, revision.specSnapshot),
    });
    if (!started) throw new DomainError("This visual project changed. Refresh and try again.", "version_conflict", 409);
    if (started.started) await this.coordinator.enqueue(started.render);
    const latestProject = await this.infrastructure.creativeStudioRepository.getProject(workspaceId, projectId) ?? started.project;
    const latestRender = (await this.infrastructure.creativeStudioRepository.listRenders(workspaceId, projectId, 50)).find((entry) => entry.id === started.render.id) ?? started.render;
    const outputAsset = latestProject.outputMediaId ? await this.infrastructure.mediaRepository.get(workspaceId, latestProject.outputMediaId) : null;
    return { project: latestProject, render: this.publicRender(latestRender), ...(outputAsset ? { outputAsset: publicAsset(outputAsset) } : {}) };
  }

  private editable(actor: Actor) {
    if ((actor.actorType && actor.actorType !== "human") || !can(actor.role, "content:edit")) throw new ForbiddenException("Only a human editor can change Creative Studio projects.");
  }

  private async project(workspaceId: string, projectId: string): Promise<CreativeProject> {
    const project = await this.infrastructure.creativeStudioRepository.getProject(workspaceId, projectId);
    if (!project) throw new NotFoundException("Creative project not found.");
    return project;
  }

  private async authoritativeSpec(workspaceId: string, brandId: string, input: Record<string, unknown> | CreativeSpec): Promise<Record<string, unknown>> {
    const sourceMediaId = typeof input.sourceMediaId === "string" ? input.sourceMediaId : "";
    const source = sourceMediaId ? await this.infrastructure.mediaRepository.get(workspaceId, sourceMediaId) : null;
    if (!source || source.brandId !== brandId || source.kind !== "image" || source.status !== "ready" || source.inspectionStatus !== "ready" || !["owned", "cleared"].includes(source.rights)) {
      throw new DomainError("Choose a ready, server-inspected image with owned or cleared rights from this brand's Library.", "creative_source_not_ready", 409);
    }
    if (input.sourceMediaSha256 !== source.sha256) throw new DomainError("The source image changed. Re-select it before saving this revision.", "creative_source_hash_mismatch", 409);
    if (input.contentItemId) {
      const item = await this.infrastructure.repository.get(workspaceId, String(input.contentItemId));
      if (!item || item.brandId !== brandId) throw new NotFoundException("Content item not found in this brand.");
    }
    return { ...input, sourceMediaId: source.id, sourceMediaSha256: source.sha256 };
  }

  private publicRender(render: CreativeRender) {
    const { leaseOwner: _owner, leaseExpiresAt: _expires, ...visible } = render;
    return visible;
  }

  private audit(project: CreativeProject, actor: Actor, action: string, detail: Record<string, unknown>, spec: { contentItemId?: string | undefined }): AuditEvent {
    return { id: `audit_${randomUUID()}`, workspaceId: project.workspaceId, ...(spec.contentItemId ? { contentItemId: spec.contentItemId } : {}), actorId: actor.id, actorType: actor.actorType ?? "human", action, detail: { projectId: project.id, brandId: project.brandId, ...detail }, createdAt: new Date().toISOString() };
  }
}
