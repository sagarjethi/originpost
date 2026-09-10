import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { deriveBoardRuntimeSecrets, HermesBoardPlugin, HermesBoardPluginError, validateHermesBoardPluginConfig } from "../src/hermes-board-plugin.js";

const binding = {
  workspaceId: "workspace-a", brandId: "brand-a", boardId: "agent_board_a",
  profile: "opb_0123456789abcdef01234567", capabilityEpoch: 2,
  ...deriveBoardRuntimeSecrets("x".repeat(32), { workspaceId: "workspace-a", brandId: "brand-a", boardId: "agent_board_a", capabilityEpoch: 2 }),
};

const purpose = "Mumbai desk.";
const toolManifestSha256 = "56a0ae4360b1ac2c139bd8e176ca7d2ee22e073357e8a96fed0201c9240d505c";
const skillManifestSha256 = "b".repeat(64);
const profileDescription = (enabledSkills: string[] = [], configurationEpoch = 2) => {
  const policyDigest = createHash("sha256").update(JSON.stringify({ owner: binding.ownershipMarker, memoryScope: binding.memoryScope, capabilityEpoch: 2, configurationEpoch, purpose, enabledSkills, provider: "openai-codex", model: "gpt-5.5", toolsets: ["memory", "skills", "no_mcp"], maxOutputTokens: 4000 })).digest("hex");
  const skillsDigest = createHash("sha256").update(enabledSkills.join("\n")).digest("hex");
  return `OriginPost Board runtime; owner=${binding.ownershipMarker}; memory=${binding.memoryScope}; policy=${policyDigest}; provider=openai-codex; model=gpt-5.5; skills=${skillsDigest}; skill_manifest=${skillManifestSha256}.`;
};

const plugin = () => new HermesBoardPlugin({ dashboardBaseUrl: "http://127.0.0.1:9119", dashboardSessionToken: "dashboard-secret".repeat(2), executionBaseUrl: "http://127.0.0.1:8642", approvedSkills: ["news-research"], primaryProvider: "openai-codex", primaryModel: "gpt-5.5" });
const essentialSkill = { name: "hermes-agent", description: "Hermes runtime instructions", category: "system", enabled: true, provenance: "bundled" };
const compliantConfig = {
  memory: { memory_enabled: true, user_profile_enabled: true, write_approval: true, provider: "" },
  skills: { write_approval: true, external_dirs: [], create_dir: "", project_discovery: false, trusted_project_dirs: [], inline_shell: false },
  model: { provider: "openai-codex", default: "gpt-5.5", openai_runtime: "auto", max_tokens: 4000 },
  context: { engine: "compressor" },
  fallback_providers: [],
  fallback_model: [],
  platform_toolsets: { api_server: ["memory", "skills", "no_mcp"] },
  plugins: { enabled: [], entries: {} },
};
const detailedReadiness = { status: "ok", platform: "hermes-agent", version: "0.21.1", readiness: { status: "ok", checks: { model: { status: "ok" } } } };
const isolationAttestation = { schemaVersion: 1, profileScoped: true, memoryScoped: true, skillsScoped: true, stateScoped: true };
const runtimeAttestation = { schemaVersion: 2, ready: true, provider: "openai-codex", model: "gpt-5.5", toolManifestSha256, skillManifestSha256 };
const policy = { configurationEpoch: 2, purpose, enabledSkills: [] as string[] };
const effectiveToolsets = (extra: Array<{ name: string; tools: string[] }> = []) => ({
  object: "list", platform: "api_server", data: [
    { name: "memory", enabled: true, tools: ["memory"] },
    { name: "skills", enabled: true, tools: ["skills_list", "skill_view", "skill_manage"] },
    ...extra.map((toolset) => ({ ...toolset, enabled: true })),
  ],
});

afterEach(() => vi.restoreAllMocks());

describe("Hermes Board internal plugin", () => {
  it("validates the complete endpoint and secret policy at the runtime seam", () => {
    const base = { dashboardBaseUrl: "http://127.0.0.1:9119", dashboardSessionToken: "x".repeat(32), executionBaseUrl: "https://hermes.example.com", approvedSkills: ["news-research"], primaryProvider: "openai-codex", primaryModel: "gpt-5.5" };
    expect(() => validateHermesBoardPluginConfig(base)).not.toThrow();
    expect(() => validateHermesBoardPluginConfig({ ...base, dashboardBaseUrl: "http://token@example.com" })).toThrow(/origin-only/u);
    expect(() => validateHermesBoardPluginConfig({ ...base, executionBaseUrl: "http://10.0.0.8:8642" })).toThrow(/HTTPS/u);
    expect(() => validateHermesBoardPluginConfig({ ...base, executionBaseUrl: "http://10.0.0.8:8642", allowPrivateEndpoints: true })).not.toThrow();
    expect(() => validateHermesBoardPluginConfig({ ...base, dashboardSessionToken: "too-short" })).toThrow(/32 bytes/u);
  });

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
      if (url.endsWith("/api/health")) return Response.json({ ok: true, version: "0.21.1" });
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
      if (url.includes("/seal/")) return Response.json({ schemaVersion: 2, sealed: true, toolManifestSha256, skillManifestSha256 });
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      if (url.includes("/v1/capabilities")) return Response.json({ object: "hermes.api_server.capabilities", model: "hermes-agent", features: { responses_api: true } });
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      return Response.json({ ok: true });
    });
    const result = await plugin().reconcile(binding, { configurationEpoch: 2, purpose, enabledSkills: ["news-research"] });
    expect(result).toMatchObject({ configured: true, healthy: true, policyCompliant: true, version: "0.21.1", isolation: { verified: true, profileScoped: true, memoryScoped: true, skillsScoped: true, stateScoped: true, externalSkillsBlocked: true, unsafeToolsBlocked: true, filesystemSandbox: false } });
    const bodies = calls.filter((call) => call.init?.body).map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);
    expect(bodies).toContainEqual(expect.objectContaining({ key: "API_SERVER_KEY", profile: binding.profile }));
    expect(bodies).toContainEqual(expect.objectContaining({ name: "shell-anything", enabled: false, profile: binding.profile }));
    expect(JSON.stringify(bodies)).toContain('"write_approval":true');
    expect(JSON.stringify(bodies)).toContain('"api_server":["memory","skills","no_mcp"]');
    expect(JSON.stringify(bodies)).toContain('"provider":""');
    expect(JSON.stringify(bodies)).toContain('"engine":"compressor"');
    expect(JSON.stringify(bodies)).toContain('"model":{"provider":"openai-codex","default":"gpt-5.5","max_tokens":4000,"openai_runtime":"auto"}');
    expect(JSON.stringify(bodies)).toContain('"fallback_providers":[]');
    expect(JSON.stringify(bodies)).toContain('"external_dirs":[]');
    expect(JSON.stringify(bodies)).toContain('"create_dir":""');
    expect(JSON.stringify(bodies)).toContain('"project_discovery":false');
    expect(JSON.stringify(bodies)).toContain('"trusted_project_dirs":[]');
    expect(JSON.stringify(bodies)).toContain('"inline_shell":false');
    expect(JSON.stringify(bodies)).toContain('"known_plugin_toolsets":{"api_server":["browser","memory","skills"]}');
    expect(JSON.stringify(bodies)).toContain(binding.profile);
  });

  it("refuses an unapproved skill before changing Hermes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(plugin().reconcile(binding, { configurationEpoch: 2, purpose, enabledSkills: ["shell-anything"] })).rejects.toMatchObject({ code: "policy_rejected" } satisfies Partial<HermesBoardPluginError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses Python-compatible bytewise ordering for the sealed skill-name digest", async () => {
    const names = ["a_skill", "B", "a-skill", "a"];
    let sealBody: Record<string, unknown> | undefined;
    const mixedPlugin = new HermesBoardPlugin({ dashboardBaseUrl: "http://127.0.0.1:9119", dashboardSessionToken: "dashboard-secret".repeat(2), executionBaseUrl: "http://127.0.0.1:8642", approvedSkills: names, primaryProvider: "openai-codex", primaryModel: "gpt-5.5" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles") && init?.method !== "POST") return Response.json({ profiles: [] });
      if (url.includes("/api/tools/toolsets?")) return Response.json([{ name: "memory" }, { name: "skills" }]);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill, ...names.map((name) => ({ name, enabled: true, provenance: "bundled" }))]);
      if (url.includes("/seal/")) {
        sealBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({}, { status: 409 });
      }
      return Response.json({ ok: true });
    });
    await expect(mixedPlugin.reconcile(binding, { ...policy, enabledSkills: names })).rejects.toMatchObject({ code: "control_unavailable" });
    expect(sealBody?.enabledSkillsSha256).toBe(createHash("sha256").update(["B", "a", "a-skill", "a_skill"].join("\n")).digest("hex"));
  });

  it("never adopts or mutates a pre-existing profile without this Board's ownership marker", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      return Response.json({ profiles: [{ name: binding.profile, description: "Unrelated Hermes profile" }] });
    });
    await expect(plugin().reconcile(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).rejects.toMatchObject({ code: "profile_ownership_mismatch" });
    expect(calls.filter((call) => call.init?.method === "PUT" || call.init?.method === "POST")).toHaveLength(0);
  });

  it("rejects an impostor profile that merely embeds this Board's ownership marker", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      return Response.json({ profiles: [{ name: binding.profile, description: `Unrelated profile; owner=${binding.ownershipMarker};` }] });
    });
    await expect(plugin().reconcile(binding, policy)).rejects.toMatchObject({ code: "profile_ownership_mismatch" });
    expect(calls.filter((call) => call.init?.method === "PUT" || call.init?.method === "POST")).toHaveLength(0);
  });

  it("deactivates an archived Board without deleting its isolated memory", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
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
    await expect(plugin().listPendingWrites(binding, policy)).resolves.toEqual([pending]);
    await expect(plugin().pendingWriteDetail(binding, policy, "memory", pending.id)).resolves.toMatchObject({ ...pending, detailTruncated: false });
    await expect(plugin().decidePendingWrite(binding, policy, { subsystem: "memory", pendingId: pending.id, decision: "approve", expectedSha256: pending.sha256, idempotencyKey: "test-test-test-test" })).resolves.toEqual({ ok: true, replayed: false });
    expect(calls.every((call) => call.url.includes("/api/plugins/originpost-board-approvals/pending/"))).toBe(true);
    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toEqual({ decision: "approve", expectedSha256: pending.sha256, idempotencyKey: "test-test-test-test" });
  });

  it("runs only through the Board profile route with isolated headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      if (url.includes("/v1/capabilities")) return Response.json({ object: "hermes.api_server.capabilities", model: "hermes-agent", features: { responses_api: true } });
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/run/")) return Response.json({ schemaVersion: 2, id: "opbrun_1", model: "gpt-5.5", text: "Board answer", toolManifestSha256, skillManifestSha256, usage: { inputTokens: 8, outputTokens: 3 } });
      return Response.json({ ok: true });
    });
    const result = await plugin().run(binding, { prompt: "Summarize", purpose, configurationEpoch: 2, capabilityEpoch: 2, enabledSkills: [] });
    expect(result.text).toBe("Board answer");
    expect(result.model).toBe("gpt-5.5");
    const [url, init] = fetchMock.mock.calls.find(([request]) => String(request).includes("/originpost-board-approvals/run/"))!;
    expect(String(url)).toContain(`/run/${binding.profile}`);
    const headers = init?.headers as Record<string, string>;
    const parsedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(headers["x-hermes-session-token"]).toBe("dashboard-secret".repeat(2));
    expect(parsedBody).toMatchObject({ prompt: "Summarize", sessionKey: binding.memoryScope, skillManifestSha256 });
    expect(headers["x-originpost-signature"]).toMatch(/^[a-f0-9]{64}$/u);
    const bodySha256 = createHash("sha256").update(String(init?.body)).digest("hex");
    const canonical = ["POST", `/run/${binding.profile}`, bodySha256, headers["x-originpost-timestamp"], headers["x-originpost-nonce"], headers["x-originpost-board-owner"], headers["x-originpost-memory-scope"], headers["x-originpost-policy-sha256"]].join("\n");
    expect(headers["x-originpost-signature"]).toBe(createHmac("sha256", binding.apiKey).update(canonical).digest("hex"));
    const swappedRoute = canonical.replace(`/run/${binding.profile}`, "/run/opb_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(headers["x-originpost-signature"]).not.toBe(createHmac("sha256", binding.apiKey).update(swappedRoute).digest("hex"));
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("store");
  });

  it("rejects every mismatched capability epoch before contacting Hermes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(plugin().run(binding, { prompt: "Summarize", purpose, configurationEpoch: 2, capabilityEpoch: 3, enabledSkills: [] })).rejects.toMatchObject({ code: "policy_rejected" } satisfies Partial<HermesBoardPluginError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the live profile drifts from memory and toolset policy", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription(["news-research"]) }] });
      if (url.includes("/api/config?")) return Response.json({ ...compliantConfig, memory: { ...compliantConfig.memory, write_approval: false }, platform_toolsets: { api_server: ["memory", "skills", "no_mcp", "terminal"] } });
      if (url.includes("/api/skills?")) return Response.json([essentialSkill, { name: "news-research", enabled: true, provenance: "bundled" }]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets([{ name: "terminal", tools: ["process", "terminal"] }]));
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: ["news-research"] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, restartRequired: false, memory: { writeApproval: false }, safeToolsets: ["memory", "skills", "terminal"] });
  });

  it("fails closed when an approved desired skill is missing from the live profile", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription(["news-research"]) }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: ["news-research"] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, restartRequired: false });
  });

  it("does not confuse a newer reconciliation epoch with the capability epoch", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription([], 3) }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 3, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: true, policyCompliant: true });
  });

  it("rejects malformed live skill entries instead of filtering them out", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      return Response.json([{ name: "news-research", enabled: "yes", provenance: "bundled" }]);
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).rejects.toMatchObject({ code: "response_invalid" } satisfies Partial<HermesBoardPluginError>);
  });

  it("fails closed when Hermes implicitly expands an unapproved runtime toolset", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets([{ name: "browser", tools: ["browser_navigate"] }]));
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, safeToolsets: ["browser", "memory", "skills"] });
  });

  it("fails closed when the constructed execution-plane agent has an injected tool", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json({ ...runtimeAttestation, toolManifestSha256: "c".repeat(64) });
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, safeToolsets: ["memory", "skills"], isolation: { verified: false, unsafeToolsBlocked: false } });
  });

  it("fails closed when the live Board skill tree drifts from the sealed profile manifest", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json({ ...runtimeAttestation, skillManifestSha256: "c".repeat(64) });
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, isolation: { verified: false, unsafeToolsBlocked: false } });
  });

  it("fails closed when the Board profile switches to the bypassing Codex app-server runtime", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json({ ...compliantConfig, model: { ...compliantConfig.model, openai_runtime: "codex_app_server" } });
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: false });
  });

  it("fails closed when profile paths cannot be attested or external skill sources drift", async () => {
    let config: Record<string, unknown> = compliantConfig;
    let attestation = { ...isolationAttestation, skillsScoped: false };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(config);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(attestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, isolation: { verified: false, skillsScoped: false, externalSkillsBlocked: true } });
    attestation = isolationAttestation;
    config = { ...compliantConfig, skills: { ...compliantConfig.skills, external_dirs: ["/shared/skills"] } };
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: false, isolation: { verified: false, skillsScoped: true, externalSkillsBlocked: false } });
  });

  it("treats a missing hidden isolation extension as unavailable and never runs", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input); urls.push(url);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return new Response(null, { status: 404 });
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().run(binding, { prompt: "Summarize", purpose, configurationEpoch: 2, capabilityEpoch: 2, enabledSkills: [] })).rejects.toMatchObject({ code: "policy_rejected" });
    expect(urls.some((url) => url.endsWith("/v1/responses"))).toBe(false);
  });

  it("blocks execution when the immediate pre-run tool attestation drifts", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input); urls.push(url);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
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
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/tools/toolsets?")) return Response.json([{ name: "memory" }, { name: "skills" }]);
      if (url.includes(`/api/config?profile=${binding.profile}`)) return Response.json(compliantConfig);
      if (url.includes("/api/config?profile=default")) return Response.json({ gateway: { multiplex_profile_allowlist: [] } });
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/seal/")) return Response.json({ schemaVersion: 2, sealed: true, toolManifestSha256, skillManifestSha256 });
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
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
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([{ ...essentialSkill, enabled: false }]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(detailedReadiness);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: false });
  });

  it("does not mark a profile ready until Hermes reports a configured primary model", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
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
      if (url.endsWith("/api/health")) return Response.json({ version: "0.21.1" });
      if (url.endsWith("/api/profiles")) return Response.json({ profiles: [{ name: binding.profile, description: profileDescription() }] });
      if (url.includes("/api/config?")) return Response.json(compliantConfig);
      if (url.includes("/api/skills?")) return Response.json([essentialSkill]);
      if (url.includes("/isolation/")) return Response.json(isolationAttestation);
      if (url.includes("/runtime/")) return Response.json(runtimeAttestation);
      if (url.includes("/v1/toolsets")) return Response.json(effectiveToolsets());
      if (url.includes("/health/detailed")) return Response.json(details);
      return Response.json({ object: "hermes.api_server.capabilities", features: { responses_api: true } });
    });
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: true });
    details = { ...detailedReadiness, status: "degraded", readiness: { status: "degraded", checks: { model: { status: "ok" }, state_db: { status: "degraded" } } } };
    await expect(plugin().inspect(binding, { configurationEpoch: 2, purpose, enabledSkills: [] })).resolves.toMatchObject({ healthy: false, policyCompliant: true, modelReady: true });
  });
});
