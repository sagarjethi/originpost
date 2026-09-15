import { decodeCredentialEncryptionKey } from "@originpost/connectors";
import {
  LocalCodexSourcingProvider,
  openAgentRuntimeCredential,
  type SourcingProvider,
} from "@originpost/agents";
import type { AgentRuntimeRepository } from "@originpost/domain";

export async function selectBrandSourcing(input: {
  workspaceId: string;
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
  if (input.authMode !== "single-user")
    throw new Error(
      "Personal Codex research requires a single-owner deployment.",
    );
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
