import type { ContentFormat, ContentItem, PublishProof, PublishTarget } from "./types.js";
import type { InstagramPublishSettings } from "./instagram-collaboration.js";

export const instagramGridLimit = 60 as const;

export type InstagramGridTileStatus = Extract<PublishTarget["status"], "queued" | "publishing" | "published" | "action_required" | "acknowledged">;

export interface InstagramGridTile {
  id: string;
  contentItemId: string;
  contentVersion: number;
  targetId: string;
  accountId: string;
  draftId: string;
  title: string;
  caption: string;
  format: Extract<ContentFormat, "image" | "carousel" | "reel">;
  targetStatus: InstagramGridTileStatus;
  scheduledFor: string;
  effectiveAt: string;
  previewMediaId?: string | undefined;
  proofId?: string | undefined;
  publishedAt?: string | undefined;
  liveUrl?: string | undefined;
  proofState: "not_yet_published" | "verified" | "missing";
}

const visibleTargetStatuses = new Set<PublishTarget["status"]>(["queued", "publishing", "published", "action_required", "acknowledged"]);

function matchingProof(item: ContentItem, target: PublishTarget): PublishProof | undefined {
  return item.proofs
    .filter((proof) => proof.platform === "instagram" && proof.accountId === target.accountId && proof.draftId === target.draftId)
    .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0];
}

function reelAppearsInFeed(target: PublishTarget): boolean {
  if (target.platform !== "instagram" || !target.settings) return true;
  return target.settings.shareToFeed !== false;
}

function previewMediaId(target: PublishTarget, mediaIds: readonly string[]): string | undefined {
  const settings = target.platform === "instagram" && target.settings && "collaborators" in target.settings ? target.settings as InstagramPublishSettings : undefined;
  if (settings?.reelCover?.mode === "custom_image") return settings.reelCover.mediaId;
  return mediaIds[0];
}

export function projectInstagramGrid(items: readonly ContentItem[], accountId: string, requestedLimit = 30): InstagramGridTile[] {
  const limit = Math.min(instagramGridLimit, Math.max(1, Math.trunc(requestedLimit || 30)));
  const tiles: InstagramGridTile[] = [];
  for (const item of items) {
    for (const target of item.targets) {
      if (target.platform !== "instagram" || target.accountId !== accountId || !visibleTargetStatuses.has(target.status)) continue;
      const draft = item.drafts.find((entry) => entry.id === target.draftId);
      if (!draft || draft.platform !== "instagram" || (draft.format !== "image" && draft.format !== "carousel" && draft.format !== "reel")) continue;
      if (draft.format === "reel" && !reelAppearsInFeed(target)) continue;
      const proof = matchingProof(item, target);
      const published = target.status === "published";
      tiles.push({
        id: `${item.id}:${target.id}`,
        contentItemId: item.id,
        contentVersion: item.version,
        targetId: target.id,
        accountId,
        draftId: draft.id,
        title: item.title,
        caption: draft.caption,
        format: draft.format,
        targetStatus: target.status as InstagramGridTileStatus,
        scheduledFor: target.scheduledFor,
        effectiveAt: proof?.publishedAt ?? target.scheduledFor,
        ...(previewMediaId(target, draft.mediaIds) ? { previewMediaId: previewMediaId(target, draft.mediaIds) } : {}),
        ...(proof ? { proofId: proof.id, publishedAt: proof.publishedAt, liveUrl: proof.liveUrl } : {}),
        proofState: proof ? "verified" : published ? "missing" : "not_yet_published",
      });
    }
  }
  return tiles.sort((left, right) => right.effectiveAt.localeCompare(left.effectiveAt) || right.id.localeCompare(left.id)).slice(0, limit);
}
