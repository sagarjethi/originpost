import { z } from "zod";
import { DomainError } from "./errors.js";
import type { SourceEvidence } from "./types.js";
import type { CreativeSpec } from "./creative-studio.js";

export const agentPostSkills = [
  {
    id: "clear-language",
    label: "Clear language",
    description: "Short sentences, familiar words",
    instruction:
      "Write in clear everyday language. Prefer short sentences and one idea per line.",
  },
  {
    id: "local-angle",
    label: "Local angle",
    description: "Explain why this matters nearby",
    instruction:
      "Use a local angle only when the verified facts support it. Explain the practical impact without inventing locations or effects.",
  },
  {
    id: "source-first",
    label: "Source first",
    description: "Keep facts and attribution visible",
    instruction:
      "Preserve source attribution and uncertainty. Distinguish confirmed facts from allegations. Do not strengthen claims for engagement.",
  },
  {
    id: "social-copy",
    label: "Social copy",
    description: "A concise hook and neutral question",
    instruction:
      "Open with a specific factual hook. Keep the caption concise, include one neutral story-related question, and use a few relevant hashtags. Avoid clickbait.",
  },
] as const;
export const agentPostSkillIds = [
  "clear-language",
  "local-angle",
  "source-first",
  "social-copy",
] as const;
export function agentPostSkillInstructions(ids: readonly string[] = []) {
  return agentPostSkills
    .filter((skill) => ids.includes(skill.id))
    .map((skill) => skill.instruction);
}
const color = z.string().regex(/^#[a-f0-9]{6}$/i);
export const agentPostTemplateSchema = z
  .object({
    boardId: z.string().max(200).optional(),
    skills: z.array(z.enum(agentPostSkillIds)).max(4).optional(),
    exampleCaption: z.string().trim().max(1500).optional(),
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
export const agentPostCopyReviewSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            category: z.enum([
              "facts",
              "attribution",
              "language",
              "visual-direction",
            ]),
            verdict: z.enum(["pass", "needs-changes"]),
            explanation: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .length(4),
  })
  .strict()
  .refine(
    (value) => new Set(value.checks.map((check) => check.category)).size === 4,
    "Every review category must appear exactly once.",
  );
export type AgentPostCopyReview = z.infer<typeof agentPostCopyReviewSchema> & {
  status: "passed" | "needs-changes";
  inputHash: string;
  evidenceHash: string;
  copyHash: string;
  reviewedAt: string;
  model: string;
  provider: string;
};
export const agentPostImageReviewSchema = z
  .object({
    observedHeadline: z.string().max(1000),
    observedFooter: z.string().max(500),
    observedDisclosure: z.string().max(200),
    checks: z
      .array(
        z
          .object({
            category: z.enum([
              "legibility",
              "branding",
              "visual-integrity",
              "disclosure",
            ]),
            verdict: z.enum(["pass", "needs-changes"]),
            explanation: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .length(4),
  })
  .strict()
  .refine(
    (value) => new Set(value.checks.map((check) => check.category)).size === 4,
    "Every image review category must appear exactly once.",
  );
export type AgentPostImageReview = z.infer<
  typeof agentPostImageReviewSchema
> & {
  status: "passed" | "needs-changes";
  image: AgentPostAsset;
  logo: AgentPostAsset;
  inputHash: string;
  evidenceHash: string;
  copyHash: string;
  reviewedAt: string;
  model: string;
  provider: string;
  textMatches: { headline: boolean; footer: boolean; disclosure: boolean };
};
export const normalizeImageReviewText = (text: string) =>
  text.normalize("NFC").replace(/\s+/gu, " ").trim();
export const agentPostStages = [
  "queued",
  "researching",
  "writing",
  "reviewing-copy",
  "generating",
  "awaiting-image",
  "composing",
  "reviewing-image",
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
  sourceLead?: {
    id: string;
    version: number;
    title: string;
    summary: string;
    capturedAt: string;
    sources: SourceEvidence[];
  };
  conversationId?: string;
  parentRunId?: string;
  requestMessage?: string;
  template: AgentPostTemplate;
  status: AgentPostStage;
  contentItemId: string;
  researchRunId?: string;
  generationId?: string;
  imageMode?: "server" | "codex-upload";
  externalImage?: AgentPostAsset & {
    importedAt: string;
    importedBy: string;
    briefHash: string;
  };
  resumedAt?: string;
  projectId?: string;
  outputMediaId?: string;
  draftId?: string;
  copy?: AgentPostCopy;
  copyReview?: AgentPostCopyReview;
  imageReview?: AgentPostImageReview;
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
    return (
      [...this.runs.values()].some(
        (r) => r.workspaceId === w && r.externalImage?.mediaId === id,
      ) ||
      [...this.savedTemplates.values()].some(
        (t) =>
          t.workspaceId === w &&
          [t.logo, ...t.references].some((a) => a.mediaId === id),
      )
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
        .filter(
          (r) => !postRunTerminal(r.status) && r.status !== "awaiting-image",
        )
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
