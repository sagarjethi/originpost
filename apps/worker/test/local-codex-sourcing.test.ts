import { createCipheriv, randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import type {
  AuthRepository,
  AgentRuntimeRepository,
} from "@originpost/domain";
import { MockSourcingProvider } from "@originpost/agents";
import {
  monitorResearchActor,
  selectBrandSourcing,
} from "../src/local-codex-sourcing.js";
function fixture() {
  const encryptionKey = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(Buffer.from("workspace:profile:agent-runtime:v1"));
  const ciphertext = Buffer.concat([
    cipher.update("private-bridge-token"),
    cipher.final(),
  ]);
  const profile = {
    id: "profile",
    createdBy: "owner",
    preset: "codex-local",
    textModel: "gpt-6-astra",
  };
  const context = {
    profile,
    credential: {
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
  };
  const getExecutionContext = vi.fn().mockResolvedValue(context);
  const repository = {
    getAssignment: vi.fn().mockResolvedValue({ profileId: "profile" }),
    getProfile: vi.fn().mockResolvedValue(profile),
    getExecutionContext,
  } as unknown as AgentRuntimeRepository;
  return {
    workspaceId: "workspace",
    actorId: "owner",
    authRepository: {
      getUser: vi.fn().mockResolvedValue({ id: "owner", status: "active" }),
      getMembership: vi.fn().mockResolvedValue({ role: "owner" }),
    } as unknown as Pick<AuthRepository, "getUser" | "getMembership">,
    brandId: "brand",
    repository,
    fallback: new MockSourcingProvider(),
    enabled: true,
    authMode: "single-user",
    baseUrl: "http://127.0.0.1:8765/v1",
    encryptionKey: encryptionKey.toString("base64"),
    getExecutionContext,
  };
}
it("uses only the assigned healthy local profile and its workspace-bound credential", async () => {
  const input = fixture();
  expect((await selectBrandSourcing(input)).id).toBe("codex-local");
  expect(input.getExecutionContext).toHaveBeenCalledWith("workspace", "brand");
  expect(
    (
      await selectBrandSourcing({
        ...input,
        encryptionKey: Buffer.from(input.encryptionKey, "base64").toString(
          "hex",
        ),
      })
    ).id,
  ).toBe("codex-local");
  await expect(
    selectBrandSourcing({ ...input, workspaceId: "other" }),
  ).rejects.toThrow("credential could not be opened");
});
it("does not silently fall back when an assigned local runtime is unhealthy", async () => {
  const input = fixture();
  input.getExecutionContext.mockResolvedValue(null);
  await expect(selectBrandSourcing(input)).rejects.toThrow("not ready");
  expect(await selectBrandSourcing({ ...input, enabled: false })).toBe(
    input.fallback,
  );
});
it("rejects shared-account execution and arbitrary bridge endpoints", async () => {
  const input = fixture();
  await expect(
    selectBrandSourcing({ ...input, authMode: "sessions" }),
  ).rejects.toThrow("single-owner");
  for (const baseUrl of [
    "http://10.0.0.1/v1",
    "https://example.org/v1",
    "http://127.0.0.1:8765/v1?secret=yes",
    "http://127.0.0.1:8765/admin",
  ]) {
    await expect(selectBrandSourcing({ ...input, baseUrl })).rejects.toThrow(
      "server-owned",
    );
  }
});

it("allows only the explicitly configured active session owner and checks membership at execution", async () => {
  const input = {
    ...fixture(),
    authMode: "sessions",
    ownerUserId: "owner",
    ownerWorkspaceId: "workspace",
  };
  expect((await selectBrandSourcing(input)).id).toBe("codex-local");
  for (const change of [
    { actorId: "other-owner" },
    { workspaceId: "other" },
    { ownerUserId: "" },
    { ownerWorkspaceId: "" },
  ])
    await expect(selectBrandSourcing({ ...input, ...change })).rejects.toThrow(
      "configured active session owner",
    );
  vi.mocked(input.authRepository.getMembership).mockResolvedValue({
    role: "creator",
  } as never);
  await expect(selectBrandSourcing(input)).rejects.toThrow(
    "configured active session owner",
  );
  vi.mocked(input.authRepository.getMembership).mockResolvedValue({
    role: "owner",
  } as never);
  vi.mocked(input.authRepository.getUser).mockResolvedValue({
    status: "disabled",
  } as never);
  await expect(selectBrandSourcing(input)).rejects.toThrow(
    "configured active session owner",
  );
});

it("binds personal monitor execution to the current editor and manual requester", () => {
  expect(
    monitorResearchActor(
      "sessions",
      { createdBy: "owner" },
      { trigger: "scheduled" },
    ),
  ).toBe("");
  expect(
    monitorResearchActor(
      "sessions",
      { createdBy: "owner", updatedBy: "owner" },
      { trigger: "scheduled" },
    ),
  ).toBe("owner");
  expect(
    monitorResearchActor(
      "sessions",
      { createdBy: "owner", updatedBy: "editor" },
      { trigger: "manual", requestedBy: "owner" },
    ),
  ).toBe("");
  expect(
    monitorResearchActor(
      "sessions",
      { createdBy: "owner", updatedBy: "owner" },
      { trigger: "manual", requestedBy: "other" },
    ),
  ).toBe("");
  expect(
    monitorResearchActor(
      "sessions",
      { createdBy: "owner", updatedBy: "owner" },
      { trigger: "manual", requestedBy: "owner" },
    ),
  ).toBe("owner");
  expect(
    monitorResearchActor(
      "single-user",
      { createdBy: "owner" },
      { trigger: "scheduled" },
    ),
  ).toBe("owner");
});
