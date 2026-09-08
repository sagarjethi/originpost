import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { deriveBoardRuntimeSecrets, HermesBoardPlugin, HermesBoardPluginError } from "../src/hermes-board-plugin.js";

const binding = {
  workspaceId: "workspace-a", brandId: "brand-a", boardId: "agent_board_a",
  profile: "opb_0123456789abcdef01234567", capabilityEpoch: 2,
  ...deriveBoardRuntimeSecrets("x".repeat(32), { workspaceId: "workspace-a", brandId: "brand-a", boardId: "agent_board_a", capabilityEpoch: 2 }),
};

const purpose = "Mumbai desk.";
const profileDescription = (enabledSkills: string[] = [], configurationEpoch = 2) => {
  const policyDigest = createHash("sha256").update(JSON.stringify({ capabilityEpoch: 2, configurationEpoch, purpose, enabledSkills, toolsets: ["memory", "skills", "no_mcp"], maxOutputTokens: 4000 })).digest("hex");
  return `OriginPost Board runtime; owner=${binding.ownershipMarker}; policy_sha256=${policyDigest}.`;
};

const plugin = () => new HermesBoardPlugin({ dashboardBaseUrl: "http://127.0.0.1:9119", dashboardSessionToken: "dashboard-secret", executionBaseUrl: "http://127.0.0.1:8642", approvedSkills: ["news-research"], primaryProvider: "openai-codex", primaryModel: "gpt-5.5" });
const essentialSkill = { name: "hermes-agent", description: "Hermes runtime instructions", category: "system", enabled: true, provenance: "bundled" };
const compliantConfig = {
  memory: { memory_enabled: true, user_profile_enabled: true, write_approval: true, provider: "" },
  skills: { write_approval: true },
  model: { provider: "openai-codex", default: "gpt-5.5", openai_runtime: "codex_app_server", max_tokens: 4000 },
  context: { engine: "compressor" },
  fallback_providers: [],
  fallback_model: [],
  platform_toolsets: { api_server: ["memory", "skills", "no_mcp"] },
};
const detailedReadiness = { status: "ok", platform: "hermes-agent", version: "0.21.0", readiness: { status: "ok", checks: { model: { status: "ok" } } } };
const effectiveToolsets = (extra: Array<{ name: string; tools: string[] }> = []) => ({
  object: "list", platform: "api_server", data: [
    { name: "memory", enabled: true, tools: ["memory"] },
    { name: "skills", enabled: true, tools: ["skills_list", "skill_view", "skill_manage"] },
    ...extra.map((toolset) => ({ ...toolset, enabled: true })),
  ],
});

afterEach(() => vi.restoreAllMocks());

describe("Hermes Board internal plugin", () => {
  it("derives different opaque credentials and memory scopes per Board", () => {
    const a = deriveBoardRuntimeSecrets("x".repeat(32), { workspaceId: "w", brandId: "b", boardId: "a", capabilityEpoch: 1 });
    const b = deriveBoardRuntimeSecrets("x".repeat(32), { workspaceId: "w", brandId: "b", boardId: "b", capabilityEpoch: 1 });
    expect(a.apiKey).not.toBe(b.apiKey);
    expect(a.memoryScope).not.toBe(b.memoryScope);
    expect(a.memoryScope).toMatch(/^opb_mem_[a-f0-9]{40}$/u);
    expect(a.ownershipMarker).toMatch(/^opb_owner_[a-f0-9]{40}$/u);
    const rotated = deriveBoardRuntimeSecrets("x".repeat(32), { workspaceId: "w", brandId: "b", boardId: "a", capabilityEpoch: 2 });
    expect(rotated.apiKey).not.toBe(a.apiKey);
    expect(rotated.memoryScope).toBe(a.memoryScope);
    expect(rotated.ownershipMarker).toBe(a.ownershipMarker);
  });

  it("provisions one profile, gates writes, disables unselected skills, and allowlists the profile", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let profileCreated = false;
    let unsafeEnabled = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/api/health")) return Response.json({ ok: true, version: "0.21.0" });
      if (url.endsWith("/api/profiles")) {
        if (init?.method === "POST") { profileCreated = true; return Response.json({ ok: true, name: binding.profile }); }
        return Response.json({ profiles: profileCreated ? [{ name: binding.profile, description: profileDescription(["news-research"]) }] : [] });
      }
      if (url.includes("/api/skills?")) return Response.json([
        essentialSkill,
        { name: "news-research", description: "Research", category: "news", enabled: true, provenance: "bundled" },
        { name: "shell-anything", description: "Unsafe", category: "dev", enabled: unsafeEnabled, provenance: "hub" },
      ]);
      if (url.endsWith("/api/skills/toggle")) { unsafeEnabled = false; return Response.json({ ok: true }); }
      if (url.includes("/api/tools/toolsets?")) return Response.json([{ name: "memory" }, { name: "skills" }, { name: "browser" }]);
      if (url.includes("/api/config?profile=default")) return Response.json({ gateway: { multiplex_profile_allowlist: ["existing"] } });
      if (url.includes(`/api/config?profile=${binding.profile}`)) return Response.json(compliantConfig);
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      if (url.includes("/v1/capabilities")) return Response.json({ object: "hermes.api_server.capabilities", model: "hermes-agent", features: { responses_api: true } });
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      return Response.json({ ok: true });
    });
    const result = await plugin().reconcile(binding, { configurationEpoch: 2, purpose, enabledSkills: ["news-research"] });
    expect(result).toMatchObject({ configured: true, healthy: true, policyCompliant: true, version: "0.21.0" });
    const bodies = calls.filter((call) => call.init?.body).map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);
    expect(bodies).toContainEqual(expect.objectContaining({ key: "API_SERVER_KEY", profile: binding.profile }));
    expect(bodies).toContainEqual(expect.objectContaining({ name: "shell-anything", enabled: false, profile: binding.profile }));
    expect(JSON.stringify(bodies)).toContain('"write_approval":true');
    expect(JSON.stringify(bodies)).toContain('"api_server":["memory","skills","no_mcp"]');
    expect(JSON.stringify(bodies)).toContain('"provider":""');
    expect(JSON.stringify(bodies)).toContain('"engine":"compressor"');
    expect(JSON.stringify(bodies)).toContain('"model":{"provider":"openai-codex","default":"gpt-5.5","max_tokens":4000,"openai_runtime":"codex_app_server"}');
    expect(JSON.stringify(bodies)).toContain('"fallback_providers":[]');
    expect(JSON.stringify(bodies)).toContain('"known_plugin_toolsets":{"api_server":["browser","memory","skills"]}');
    expect(JSON.stringify(bodies)).toContain(binding.profile);
  });

  it("refuses an unapproved skill before changing Hermes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(plugin().reconcile(binding, { configurationEpoch: 2, purpose, enabledSkills: ["shell-anything"] })).rejects.toMatchObject({ code: "policy_rejected" } satisfies Partial<HermesBoardPluginError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never adopts or mutates a pre-existing profile without this Board's ownership marker", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      return Response.json({ profiles: [{ name: binding.profile, description: "Unrelated Hermes profile" }] });
    });
    await expect(plugin().reconcile(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).rejects.toMatchObject({ code: "profile_ownership_mismatch" });
    expect(calls.filter((call) => call.init?.method === "PUT" || call.init?.method === "POST")).toHaveLength(0);
  });

  it("deactivates an archived Board without deleting its isolated memory", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?profile=default")) return Response.json({ gateway: { multiplex_profile_allowlist: ["existing", binding.profile] } });
      return Response.json({ ok: true });
    });
    await expect(plugin().deactivate(binding)).resolves.toBeUndefined();
    const bodies = calls.filter((call) => call.init?.body).map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);
    expect(bodies).toContainEqual(expect.objectContaining({ key: "API_SERVER_KEY", profile: binding.profile, value: binding.apiKey }));
    expect(JSON.stringify(bodies)).toContain('"api_server":[]');
    expect(JSON.stringify(bodies)).toContain('"multiplex_profile_allowlist":["existing"]');
    expect(calls.some((call) => call.init?.method === "DELETE")).toBe(false);
  });

  it("uses only the hidden profile-scoped approval extension for pending writes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const pending = { id: "a1b2c3d4", subsystem: "memory", action: "add", summary: "Remember Mumbai", origin: "foreground", createdAt: 1_788_000_000, sha256: "a".repeat(64) };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith(`/pending/${binding.profile}/memory`)) return Response.json({ pending: [pending] });
      if (url.endsWith(`/pending/${binding.profile}/skills`)) return Response.json({ pending: [] });
      if (url.endsWith(`/pending/${binding.profile}/memory/${pending.id}`)) return Response.json({ ...pending, detail: '{"content":"Mumbai"}', detailTruncated: false });
      return Response.json({ ok: true, replayed: false });
    });
    await expect(plugin().listPendingWrites(binding)).resolves.toEqual([pending]);
    await expect(plugin().pendingWriteDetail(binding, "memory", pending.id)).resolves.toMatchObject({ ...pending, detailTruncated: false });
    await expect(plugin().decidePendingWrite(binding, { subsystem: "memory", pendingId: pending.id, decision: "approve", expectedSha256: pending.sha256, idempotencyKey: "test-test-test-test" })).resolves.toEqual({ ok: true, replayed: false });
    expect(calls.every((call) => call.url.includes("/api/plugins/originpost-board-approvals/pending/"))).toBe(true);
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ decision: "approve", expectedSha256: pending.sha256, idempotencyKey: "test-test-test-test" });
  });

  it("runs only through the Board profile route with isolated headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      if (url.includes("/v1/capabilities")) return Response.json({ object: "hermes.api_server.capabilities", model: "hermes-agent", features: { responses_api: true } });
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      return Response.json({ id: "resp-1", model: "hermes-agent", output: [{ type: "message", content: [{ type: "output_text", text: "Board answer" }] }], usage: { input_tokens: 8, output_tokens: 3 } });
    });
    const result = await plugin().run(binding, { prompt: "Summarize", purpose, configurationEpoch: 2, capabilityEpoch: 2, enabledSkills: [] });
    expect(result.text).toBe("Board answer");
    expect(result.model).toBe("gpt-5.5");
    const [url, init] = fetchMock.mock.calls.find(([request]) => String(request).endsWith("/v1/responses"))!;
    expect(String(url)).toContain(`/p/${binding.profile}/v1/responses`);
    expect((init?.headers as Record<string, string>)["x-hermes-session-key"]).toBe(binding.memoryScope);
    expect(JSON.parse(String(init?.body))).toMatchObject({ store: false });
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("conversation");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("max_output_tokens");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("model");
  });

  it("rejects every mismatched capability epoch before contacting Hermes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(plugin().run(binding, { prompt: "Summarize", purpose, configurationEpoch: 2, capabilityEpoch: 3, enabledSkills: [] })).rejects.toMatchObject({ code: "policy_rejected" } satisfies Partial<HermesBoardPluginError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the live profile drifts from memory and toolset policy", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription(["news-research"]) }] });
      if (url.includes("/api/config?")) return Response.json({ ...compliantConfig, memory: { ...compliantConfig.memory, write_approval: false }, platform_toolsets: { api_server: ["memory", "skills", "no_mcp", "terminal"] } });
      if (url.includes("/api/skills?")) return Response.json([essentialSkill, { name: "news-research", enabled: true, provenance: "bundled" }]);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets([{ name: "terminal", tools: ["process", "terminal"] }]));
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: ["news-research"] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, restartRequired: false, memory: { writeApproval: false }, safeToolsets: ["memory", "skills", "terminal"] });
  });

  it("fails closed when an approved desired skill is missing from the live profile", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription(["news-research"]) }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: ["news-research"] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, restartRequired: false });
  });

  it("does not confuse a newer reconciliation epoch with the capability epoch", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription([], 3) }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 3, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: true, policyCompliant: true });
  });

  it("rejects malformed live skill entries instead of filtering them out", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      return Response.json([{ name: "news-research", enabled: "yes", provenance: "bundled" }]);
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).rejects.toMatchObject({ code: "response_invalid" } satisfies Partial<HermesBoardPluginError>);
  });

  it("fails closed when Hermes implicitly expands an unapproved runtime toolset", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets([{ name: "browser", tools: ["browser_navigate"] }]));
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, safeToolsets: ["browser", "memory", "skills"] });
  });

  it("blocks execution when the immediate pre-run tool attestation drifts", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input); urls.push(url);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets([{ name: "browser", tools: ["browser_navigate"] }]));
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().run(binding, { prompt: "Summarize", purpose, configurationEpoch: 2, capabilityEpoch: 2, enabledSkills: [] })).rejects.toMatchObject({ code: "policy_rejected" } satisfies Partial<HermesBoardPluginError>);
    expect(urls.some((url) => url.endsWith("/v1/responses"))).toBe(false);
  });

  it("attests Hermes' required skill separately and never toggles or exposes it as Board-managed", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/tools/toolsets?")) return Response.json([{ name: "memory" }, { name: "skills" }]);
      if (url.includes(`/api/config?profile=${binding.profile}`)) return Response.json(compliantConfig);
      if (url.includes("/api/config?profile=default")) return Response.json({ gateway: { multiplex_profile_allowlist: [] } });
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      if (url.includes("/v1/capabilities")) return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      return Response.json({ ok: true });
    });
    const observed = await plugin().reconcile(binding, { configurationEpoch: 2, purpose, enabledSkills: [] });
    expect(observed).toMatchObject({ healthy: true, policyCompliant: true, skills: [expect.objectContaining({ name: "hermes-agent", enabled: true, approved: true, userManageable: false })] });
    expect(calls.filter((call) => call.url.endsWith("/api/skills/toggle"))).toHaveLength(0);
    await expect(plugin().reconcile(binding, { configurationEpoch: 2, purpose, enabledSkills: ["hermes-agent"] })).rejects.toMatchObject({ code: "policy_rejected" });
  });

  it("fails closed if Hermes' required skill is absent or disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([{ ...essentialSkill, enabled: false }]);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: false });
  });

  it("does not mark a profile ready until Hermes reports a configured primary model", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json({ status: "degraded", readiness: { status: "degraded", checks: { model: { status: "degraded" } } } });
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, configured: true, policyCompliant: true, modelReady: false, restartRequired: false });
  });

  it("fails readiness on execution-version mismatch or aggregate runtime degradation", async () => {
    let details: Record<string, unknown> = { ...detailedReadiness, version: "0.22.0" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.0" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(details);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: true });
    details = { ...detailedReadiness, status: "degraded", readiness: { status: "degraded", checks: { model: { status: "ok" }, state_db: { status: "degraded" } } } };
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: true, modelReady: true });
  });
});
