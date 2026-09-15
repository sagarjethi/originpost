import { decodeCredentialEncryptionKey } from "@originpost/connectors";
import {
  LocalCodexSourcingProvider,
  openAgentRuntimeCredential,
  type SourcingProvider,
} from "@originpost/agents";
import {
  canUseLocalCodex,
  type AuthRepository,
  type AgentRuntimeRepository,
} from "@originpost/domain";

export async function selectBrandSourcing(input: {
  workspaceId: string;
  actorId: string;
  authRepository: Pick<AuthRepository, "getUser" | "getMembership">;
  ownerWorkspaceId?: string | undefined;
  ownerUserId?: string | undefined;
  brandId: string;
  repository: AgentRuntimeRepository;
  fallback: SourcingProvider;
  enabled: boolean;
  authMode: string;
  baseUrl?: string | undefined;
  encryptionKey?: string | undefined;
}): Promise<SourcingProvider> {
  if (!input.enabled) return input.fallback;
  const assignment = await input.repository.getAssignment(
    input.workspaceId,
    input.brandId,
  );
  if (!assignment) return input.fallback;
  const profile = await input.repository.getProfile(
    input.workspaceId,
    assignment.profileId,
  );
  if (profile?.preset !== "codex-local") return input.fallback;
  if (input.authMode !== "single-user") {
    const [user, membership] = await Promise.all([
      input.authRepository.getUser(input.actorId),
      input.authRepository.getMembership(input.workspaceId, input.actorId),
    ]);
    if (
      user?.status !== "active" ||
      !membership ||
      profile.createdBy !== input.actorId ||
      !canUseLocalCodex({
        authMode: input.authMode,
        workspaceId: input.workspaceId,
        ownerWorkspaceId: input.ownerWorkspaceId,
        ownerUserId: input.ownerUserId,
        actor: { id: input.actorId, role: membership.role, actorType: "human" },
      })
    )
      throw new Error(
        "Personal Codex research requires single-owner access or its configured active session owner and workspace.",
      );
  }
  const context = await input.repository.getExecutionContext(
    input.workspaceId,
    input.brandId,
  );
  if (!context || context.profile.id !== profile.id || !context.credential)
    throw new Error("The assigned local research runtime is not ready.");
  let endpoint: URL;
  try {
    endpoint = new URL(input.baseUrl ?? "");
  } catch {
    throw new Error("Configure the local Codex research endpoint.");
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "host.docker.internal"].includes(endpoint.hostname) ||
    endpoint.pathname.replace(/\/$/, "") !== "/v1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "Local research must use its server-owned bridge endpoint.",
    );
  let key: string;
  try {
    key = openAgentRuntimeCredential(
      input.workspaceId,
      profile.id,
      context.credential,
      decodeCredentialEncryptionKey(input.encryptionKey) ?? Buffer.alloc(0),
    );
  } catch {
    throw new Error(
      "The local research bridge credential could not be opened.",
    );
  }
  return new LocalCodexSourcingProvider({
    baseUrl: endpoint.origin,
    apiKey: key,
    model: context.profile.textModel,
    timeoutMs: 200000,
  });
}

/** Legacy or differently edited schedules cannot impersonate the configured owner. */
export function monitorResearchActor(
  authMode: string,
  monitor: { createdBy: string; updatedBy?: string | undefined },
  job: { trigger?: string | undefined; requestedBy?: string | undefined },
): string {
  if (authMode === "single-user")
    return job.requestedBy ?? monitor.updatedBy ?? monitor.createdBy;
  if (job.trigger === "manual")
    return job.requestedBy && job.requestedBy === monitor.updatedBy
      ? job.requestedBy
      : "";
  return monitor.updatedBy ?? "";
}
