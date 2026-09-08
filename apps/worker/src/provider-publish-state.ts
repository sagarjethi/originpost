import type { ContentItem, PlatformDraft, ProviderPublishOperation, PublishTarget } from "@originpost/domain";

export type OfficialPublishNextStep = "create" | "wait" | "finalize" | "complete" | "manual-reconcile" | "failed";

export function officialPublishNextStep(operation: ProviderPublishOperation | null): OfficialPublishNextStep {
  if (!operation) return "create";
  switch (operation.status) {
    case "creating": return "manual-reconcile";
    case "processing": return "wait";
    case "ready": return "finalize";
    case "published": return "complete";
    case "finalizing":
    case "uncertain": return "manual-reconcile";
    case "failed": return "failed";
  }
}

export function hasCompletePublishProof(item: ContentItem, target: PublishTarget, draft: PlatformDraft): boolean {
  return item.proofs.some((proof) => proof.draftId === draft.id && proof.platform === target.platform && proof.accountId === target.accountId);
}
