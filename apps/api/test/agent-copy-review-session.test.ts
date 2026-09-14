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
});
