import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntimeService } from "../src/agent-runtimes/agent-runtime.service.js";
import type { OriginPostInfrastructure } from "../src/infrastructure/infrastructure.types.js";

describe("separate reviewer session", () => {
  it("never reuses writer history or another review session with a stateful runtime", async () => {
    const run = vi.fn(async () => ({
      text: "result",
      model: "fixture",
      provider: "fixture",
    }));
    const infrastructure = {
      agentRuntimeRepository: { getAssignment: vi.fn(async () => null) },
      hermes: { run },
    } as unknown as OriginPostInfrastructure;
    const service = new AgentRuntimeService(
      infrastructure,
      new ConfigService(),
    );
    const input = {
      workspaceId: "w",
      brandId: "b",
      contentItemId: "c",
      actor: { id: "owner", name: "Owner", role: "owner" as const },
      messages: [
        { role: "user" as const, content: "Frozen evidence and copy" },
      ],
    };
    await service.runDraft(input);
    await service.runCopyReview(input);
    await service.runCopyReview(input);
    const requests = run.mock.calls as unknown as [
      { sessionKey: string; messages: unknown },
    ][];
    expect(requests[0]![0].sessionKey).toBe("originpost:w:c");
    expect(requests[1]![0].sessionKey).toMatch(/^originpost:w:c:review:/);
    expect(new Set(requests.map(([request]) => request.sessionKey)).size).toBe(
      3,
    );
    expect(requests[1]![0].messages).toEqual(input.messages);
  });
  it("does not send image review to a text-only Hermes fallback", async () => {
    const run = vi.fn();
    const infrastructure = {
      agentRuntimeRepository: { getAssignment: async () => null },
      hermes: { run },
    } as unknown as OriginPostInfrastructure;
    const service = new AgentRuntimeService(
      infrastructure,
      new ConfigService(),
    );
    await expect(
      service.runImageReview({
        workspaceId: "w",
        brandId: "b",
        contentItemId: "c",
        actor: { id: "owner", name: "Owner", role: "owner" },
        messages: [{ role: "user", content: "Inspect" }],
        imageInputs: [
          { dataUrl: "data:image/png;base64,aW1hZ2U=", detail: "high" },
        ],
      }),
    ).rejects.toThrow(/tested vision model/);
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses a runtime changed between assignment lookup and execution", async () => {
    const infrastructure = {
      agentRuntimeRepository: {
        getAssignment: async () => ({ profileId: "profile" }),
        getExecutionContext: async () => ({
          profile: { id: "profile", version: 2, visionModel: "vision" },
        }),
        getProfileExecutionContext: async () => ({
          profile: { id: "profile", version: 3 },
          credential: null,
        }),
      },
    } as unknown as OriginPostInfrastructure;
    const service = new AgentRuntimeService(
      infrastructure,
      new ConfigService(),
    );
    await expect(
      service.runImageReview({
        workspaceId: "w",
        brandId: "b",
        contentItemId: "c",
        actor: { id: "owner", name: "Owner", role: "owner" },
        messages: [{ role: "user", content: "Inspect" }],
        imageInputs: [
          { dataUrl: "data:image/png;base64,aW1hZ2U=", detail: "high" },
        ],
      }),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });
});
