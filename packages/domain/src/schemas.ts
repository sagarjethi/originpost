import { z } from "zod";
import { facebookPageDraftContractIssue } from "./facebook-page.js";
import { approveInstagramPublishSettings } from "./instagram-collaboration.js";
import { contentStatuses } from "./types.js";

export const createContentItemSchema = z.object({
  contentId: z.string().min(8).max(100).optional(),
  workspaceId: z.string().min(1).default("default"),
  brandId: z.string().min(1).optional(),
  title: z.string().min(1).max(180),
  summary: z.string().max(2000).optional(),
  researchDepth: z.enum(["quick", "standard", "deep"]).default("standard"),
  riskLevel: z.enum(["low", "medium", "high", "sensitive"]).default("low"),
});

export const addSourceSchema = z.object({
  kind: z.enum(["url", "note", "image", "video", "document", "voice", "screenshot"]),
  title: z.string().min(1).max(240),
  url: z.url().optional(),
  publisher: z.string().max(120).optional(),
  publishedAt: z.iso.datetime().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  rights: z.enum(["unknown", "reference-only", "cleared", "owned"]).default("unknown"),
  confidence: z.number().min(0).max(100).default(50),
  notes: z.string().max(2000).optional(),
});

export const transitionSchema = z.object({
  to: z.enum(contentStatuses),
  reason: z.string().max(500).optional(),
});

export const addDraftSchema = z.object({
  platform: z.enum(["instagram", "facebook", "youtube"]),
  format: z.enum(["image", "carousel", "reel", "story", "short", "text"]),
  title: z.string().min(1).max(180),
  caption: z.string().min(1).max(10000),
  mediaIds: z.array(z.string()).default([]),
  scheduledFor: z.iso.datetime().optional(),
}).superRefine((draft, context) => {
  const issue = facebookPageDraftContractIssue(draft);
  if (!issue) return;
  context.addIssue({
    code: "custom",
    message: issue.message,
    path: [issue.path],
    params: { domainCode: issue.code },
  });
});

export const approvalSchema = z.object({
  decision: z.enum(["approved", "changes-requested", "rejected"]),
  draftId: z.string().min(1).optional(),
  note: z.string().max(1000).optional(),
});

const scheduleBaseSchema = {
  targetId: z.string().min(8).max(100).optional(),
  accountId: z.string().min(1),
  draftId: z.string().min(1),
  scheduledFor: z.iso.datetime(),
  timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, "Use a valid IANA time zone, such as Asia/Kolkata.").optional(),
  deliveryMode: z.enum(["auto_publish", "manual_handoff"]).default("auto_publish"),
  notifyDestinationId: z.string().trim().min(1).max(200).optional(),
};

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export const youtubePublishSettingsSchema = z.object({
  title: z.string().trim().min(1).max(100).regex(/^[^<>]+$/u, "YouTube titles cannot contain < or >."),
  description: z.string()
    .regex(/^[^<>]*$/u, "YouTube descriptions cannot contain < or >.")
    .refine((value) => new TextEncoder().encode(value).byteLength <= 5000, "YouTube descriptions cannot exceed 5,000 UTF-8 bytes."),
  privacyStatus: z.enum(["private", "unlisted", "public"]).default("private"),
  madeForKids: z.boolean(),
  containsSyntheticMedia: z.boolean(),
  notifySubscribers: z.boolean().default(false),
  categoryId: z.string().trim().regex(/^\d+$/, "YouTube category ID must contain digits only.").max(20).optional(),
  defaultLanguage: z.string().trim().regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/, "Use a valid language tag, such as en, hi, or gu-IN.").max(35).optional(),
  timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, "Use a valid IANA time zone, such as Asia/Kolkata.").optional(),
}).strict();

export const instagramPublishSettingsSchema = z.object({
  collaborators: z.array(z.string().trim().min(1).max(31)).max(3).default([]),
  shareToFeed: z.boolean().default(true),
  isAiGenerated: z.boolean().default(false),
  reelCover: z.union([
    z.object({ mode: z.literal("instagram_default") }).strict(),
    z.object({ mode: z.literal("video_frame"), offsetMs: z.number().int().nonnegative() }).strict(),
    z.object({ mode: z.literal("custom_image"), mediaId: z.string().trim().min(1).max(200), mediaSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict(),
  ]).optional(),
}).strict().transform((settings, context) => {
  try {
    return approveInstagramPublishSettings(settings);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Instagram collaborator settings are invalid.",
      path: ["collaborators"],
    });
    return z.NEVER;
  }
});

export const scheduleSchema = z.discriminatedUnion("platform", [
  z.object({ ...scheduleBaseSchema, platform: z.literal("instagram"), settings: instagramPublishSettingsSchema.optional() }).strict(),
  z.object({ ...scheduleBaseSchema, platform: z.literal("facebook"), settings: z.undefined().optional() }).strict(),
  z.object({ ...scheduleBaseSchema, platform: z.literal("youtube"), settings: youtubePublishSettingsSchema }).strict(),
]);

export const rescheduleTargetSchema = z.object({
  scheduledFor: z.iso.datetime(),
  timezone: z.string().trim().min(1).max(100).refine(isValidTimeZone, "Use a valid IANA time zone, such as Asia/Kolkata.").optional(),
}).strict();

export const startResearchSchema = z.object({
  query: z.string().min(3).max(500).optional(),
  depth: z.enum(["quick", "standard", "deep"]).optional(),
  languages: z.array(z.string().min(2).max(40)).min(1).max(4).default(["English"]),
  region: z.string().min(2).max(100).optional(),
  sourceLimit: z.number().int().min(2).max(20).default(6),
  freshnessHours: z.number().int().min(1).max(8760).optional(),
});

export const createMonitorSchema = z.object({
  workspaceId: z.string().min(1).default("default"),
  brandId: z.string().min(1).optional(),
  name: z.string().min(2).max(120),
  query: z.string().min(3).max(500),
  intervalMinutes: z.number().int().min(10).max(1440).default(15),
  depth: z.enum(["quick", "standard", "deep"]).default("standard"),
  languages: z.array(z.string().min(2).max(40)).min(1).max(4).default(["English"]),
  region: z.string().min(2).max(100).optional(),
  sourceLimit: z.number().int().min(2).max(20).default(8),
  freshnessHours: z.number().int().min(1).max(8760).default(24),
  enabled: z.boolean().default(true),
  notifyDestinationId: z.string().min(1).max(200).optional(),
});

export const updateMonitorSchema = createMonitorSchema.omit({ workspaceId: true }).partial();
