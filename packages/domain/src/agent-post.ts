import { z } from "zod";
import { DomainError } from "./errors.js";
import type { CreativeSpec } from "./creative-studio.js";

const color = z.string().regex(/^#[a-f0-9]{6}$/i);
export const agentPostTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    language: z.string().trim().min(2).max(40),
    format: z.enum(["square", "portrait", "story"]),
    layout: z.enum(["headline", "editorial", "quote"]),
    palette: z.tuple([color, color, color, color, color]),
    logoMediaId: z.string().min(1).max(200),
    logoBackground: color.default("#FFFFFF"),
    logoCrop: z
      .enum(["full", "top-left", "top-right", "bottom-left", "bottom-right"])
      .default("full"),
    logoPosition: z.enum(["top-left", "top-right"]),
    logoWidth: z.number().int().min(8).max(25),
    logoMargin: z.number().int().min(2).max(6),
    referenceMediaIds: z.array(z.string().min(1).max(200)).max(3),
    styleInstructions: z.string().trim().max(2000),
    footer: z.string().trim().max(100),
  })
  .strict();
export type AgentPostTemplateInput = z.infer<typeof agentPostTemplateSchema>;
export type AgentPostAsset = { mediaId: string; sha256: string };
export type AgentPostTemplate = AgentPostTemplateInput & {
  id: string;
  workspaceId: string;
  brandId: string;
  createdBy: string;
  createdAt: string;
  logo: AgentPostAsset;
  references: AgentPostAsset[];
};
export const agentPostCopySchema = z
  .object({
    headline: z.string().trim().min(1).max(150),
    caption: z.string().trim().min(1).max(4000),
    visualDirection: z.string().trim().min(1).max(2500),
  })
  .strict();
export type AgentPostCopy = z.infer<typeof agentPostCopySchema>;
export const agentPostStages = [
  "queued",
  "researching",
  "writing",
  "generating",
  "composing",
  "drafting",
  "ready",
  "blocked",
  "failed",
  "uncertain",
] as const;
export type AgentPostStage = (typeof agentPostStages)[number];
export type AgentPostRun = {
  id: string;
  workspaceId: string;
  brandId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  fingerprint: string;
  input: string;
  template: AgentPostTemplate;
  status: AgentPostStage;
  contentItemId: string;
  researchRunId?: string;
  generationId?: string;
  projectId?: string;
  outputMediaId?: string;
  draftId?: string;
  copy?: AgentPostCopy;
  evidenceHash?: string;
  error?: string;
  inFlightUntil?: string;
};
export const postRunTerminal = (status: AgentPostStage) =>
  ["ready", "blocked", "failed", "uncertain"].includes(status);
export interface AgentPostRepository {
  referencesAsset(workspaceId: string, mediaId: string): Promise<boolean>;
  saveTemplate(template: AgentPostTemplate): Promise<void>;
  templates(workspaceId: string, brandId: string): Promise<AgentPostTemplate[]>;
  template(workspaceId: string, id: string): Promise<AgentPostTemplate | null>;
  create(run: AgentPostRun): Promise<AgentPostRun>;
  get(workspaceId: string, id: string): Promise<AgentPostRun | null>;
  list(workspaceId: string, brandId: string): Promise<AgentPostRun[]>;
  pending(): Promise<AgentPostRun[]>;
  replace(run: AgentPostRun, expectedVersion: number): Promise<boolean>;
}
export class InMemoryAgentPostRepository implements AgentPostRepository {
  private readonly savedTemplates = new Map<string, AgentPostTemplate>();
  private readonly runs = new Map<string, AgentPostRun>();
  async referencesAsset(w: string, id: string) {
    return [...this.savedTemplates.values()].some(
      (t) =>
        t.workspaceId === w &&
        [t.logo, ...t.references].some((a) => a.mediaId === id),
    );
  }
  async saveTemplate(t: AgentPostTemplate) {
    this.savedTemplates.set(t.id, structuredClone(t));
  }
  async templates(w: string, b: string) {
    return structuredClone(
      [...this.savedTemplates.values()]
        .filter((t) => t.workspaceId === w && t.brandId === b)
        .reverse()
        .slice(0, 100),
    );
  }
  async template(w: string, id: string) {
    const t = this.savedTemplates.get(id);
    return t?.workspaceId === w ? structuredClone(t) : null;
  }
  async create(r: AgentPostRun) {
    const old = this.runs.get(r.id);
    if (
      old &&
      (old.workspaceId !== r.workspaceId || old.fingerprint !== r.fingerprint)
    )
      throw new DomainError(
        "This request key was used for different content.",
        "idempotency_conflict",
        409,
      );
    if (!old) this.runs.set(r.id, structuredClone(r));
    return structuredClone(old ?? r);
  }
  async get(w: string, id: string) {
    const r = this.runs.get(id);
    return r?.workspaceId === w ? structuredClone(r) : null;
  }
  async list(w: string, b: string) {
    return structuredClone(
      [...this.runs.values()]
        .filter((r) => r.workspaceId === w && r.brandId === b)
        .reverse()
        .slice(0, 100),
    );
  }
  async pending() {
    return structuredClone(
      [...this.runs.values()]
        .filter((r) => !postRunTerminal(r.status))
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .slice(0, 100),
    );
  }
  async replace(r: AgentPostRun, v: number) {
    const old = this.runs.get(r.id);
    if (!old || old.workspaceId !== r.workspaceId || old.version !== v)
      return false;
    this.runs.set(r.id, structuredClone(r));
    return true;
  }
}
export function agentPostCreativeSpec(
  run: AgentPostRun,
  source: AgentPostAsset,
): CreativeSpec {
  if (!run.copy) throw new Error("Copy is required before composition.");
  const t = run.template;
  return {
    format: t.format,
    layout: t.layout,
    sourceMediaId: source.mediaId,
    sourceMediaSha256: source.sha256,
    contentItemId: run.contentItemId,
    headline: run.copy.headline,
    footer: t.footer,
    kicker: "",
    subtitle: "",
    font: "manrope",
    textAlign: "left",
    focalPoint: { x: 50, y: 50 },
    zoom: 1,
    palette: t.palette,
    logo: {
      ...t.logo,
      position: t.logoPosition,
      widthPercent: t.logoWidth,
      marginPercent: t.logoMargin,
      background: t.logoBackground,
      crop: t.logoCrop,
    },
    disclosure: "AI illustration",
  };
}
