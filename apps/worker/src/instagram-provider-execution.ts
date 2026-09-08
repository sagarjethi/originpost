import type { ProviderPublishOperation, ProviderPublishOperationRepository } from "@originpost/domain";

export class ProviderExecutionClaimLostError extends Error {
  constructor(readonly providerOperationId: string) {
    super("The provider publication execution lease was lost. Reconcile the provider result before retrying.");
  }
}

export async function saveClaimedProviderOperation(
  repository: ProviderPublishOperationRepository,
  operation: ProviderPublishOperation,
  owner: string,
): Promise<void> {
  if (!await repository.saveClaimed(operation, owner)) throw new ProviderExecutionClaimLostError(operation.id);
}

export function instagramProviderClaimRetry(operation: ProviderPublishOperation, nowMs = Date.now()): { jobId: string; delayMs: number; retryAt: string } {
  const storedExpiry = operation.claimExpiresAt ? Date.parse(operation.claimExpiresAt) : Number.NaN;
  const retryAtMs = Number.isFinite(storedExpiry) && storedExpiry > nowMs
    ? storedExpiry + 1_000
    : nowMs + 60_000;
  return {
    // The observation bucket deduplicates concurrent recovery jobs while still
    // letting an unexpectedly early delayed job enqueue a later successor.
    jobId: `${operation.targetId}-provider-claim-${retryAtMs}-${Math.floor(nowMs / 30_000)}`,
    delayMs: Math.max(1_000, retryAtMs - nowMs),
    retryAt: new Date(retryAtMs).toISOString(),
  };
}

export async function beginInstagramProviderOperation(input: {
  repository: ProviderPublishOperationRepository;
  seed: ProviderPublishOperation & { platform: "instagram"; status: "creating" };
  owner: string;
  createOperation: () => Promise<{ containerId: string; childContainerIds: string[]; collaboratorInviteProof?: ProviderPublishOperation["collaboratorInviteProof"] }>;
}): Promise<
  | { kind: "busy"; operation: ProviderPublishOperation }
  | { kind: "manual-reconcile"; operation: ProviderPublishOperation }
  | { kind: "claimed"; created: boolean; operation: ProviderPublishOperation }
> {
  const claim = await input.repository.claimExecution(input.seed, input.owner);
  if (!claim.claimed) return { kind: "busy", operation: claim.operation };
  if (claim.operation.platform !== "instagram") throw new Error("The saved provider operation belongs to another platform.");

  if (!claim.created && claim.operation.status === "creating") {
    const uncertain = {
      ...claim.operation,
      status: "uncertain" as const,
      lastError: "A previous worker stopped after recording the Instagram create intent. The container request may have reached Meta; verify the account before retrying.",
      updatedAt: new Date().toISOString(),
    };
    await saveClaimedProviderOperation(input.repository, uncertain, input.owner);
    return { kind: "manual-reconcile", operation: uncertain };
  }

  if (!claim.created) return { kind: "claimed", created: false, operation: claim.operation };

  try {
    const created = await input.createOperation();
    const processing = {
      ...claim.operation,
      status: "processing" as const,
      containerId: created.containerId,
      childContainerIds: created.childContainerIds,
      collaboratorInviteProof: created.collaboratorInviteProof,
      updatedAt: new Date().toISOString(),
    };
    await saveClaimedProviderOperation(input.repository, processing, input.owner);
    return { kind: "claimed", created: true, operation: processing };
  } catch (error) {
    if (error instanceof ProviderExecutionClaimLostError) throw error;
    const uncertain = {
      ...claim.operation,
      status: "uncertain" as const,
      lastError: error instanceof Error ? error.message : "Instagram did not confirm whether the media container was created.",
      updatedAt: new Date().toISOString(),
    };
    await saveClaimedProviderOperation(input.repository, uncertain, input.owner);
    return { kind: "manual-reconcile", operation: uncertain };
  }
}
