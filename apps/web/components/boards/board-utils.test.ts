import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BoardDetailPanel } from "./boards-workspace";
import { parseBoard, parseBoardHermes, parseBoardRuns, parseBoards } from "./board-utils";

const verifiedIsolation = { verified: true, profileScoped: true, memoryScoped: true, skillsScoped: true, stateScoped: true, externalSkillsBlocked: true, unsafeToolsBlocked: true, filesystemSandbox: false as const };

describe("board API view parsing", () => {
  it("keeps provider internals and raw memory out of the browser view", () => {
    const board = parseBoard({ id: "board-1", version: 2, name: "Mumbai events", purpose: "City coverage", status: "ready", hermesProfile: "secret-profile", filesystemPath: "/private/board", apiKey: "secret" });
    const plugin = parseBoardHermes({ configured: true, healthy: true, pending: true, profile: "secret-profile", apiKey: "secret", memory: { enabled: true, writeApproval: true, content: "private memory text", path: "/private/memory.md" }, isolation: { ...verifiedIsolation, filesystemSandbox: true, path: "/private/profile" }, approvals: { skills: true }, skills: [{ name: "source-check", enabled: true, applied: false, content: "raw skill instructions" }] });
    expect(board).toEqual({ id: "board-1", version: 2, name: "Mumbai events", purpose: "City coverage", status: "ready" });
    expect(plugin).toEqual({ configured: true, healthy: true, modelReady: false, memoryEnabled: true, memoryWriteApproval: true, skillWriteApproval: true, isolation: verifiedIsolation, pending: true, decisionPending: false, pendingManagementAvailable: false, pendingWrites: [], skills: [{ id: "source-check", label: "Source Check", enabled: true, applied: false }] });
    expect(JSON.stringify({ board, plugin })).not.toMatch(/secret-profile|private memory|private\/|apiKey|raw skill/);
  });

  it("accepts wrapped board collections and rejects malformed rows", () => {
    expect(parseBoards({ boards: [{ id: "one", name: "One", status: "ready" }, { id: "broken" }] })).toEqual([{ id: "one", version: 1, name: "One", purpose: "", status: "ready" }]);
  });

  it("does not invent approval protection when live plugin state is absent", () => {
    expect(parseBoardHermes({ configured: false, healthy: false })).toMatchObject({ memoryEnabled: false, memoryWriteApproval: false, skillWriteApproval: false, pending: false });
  });

  it("does not promote a saved ready status over explicit live plugin failure", () => {
    expect(parseBoardHermes({ configured: true, healthy: false, status: "ready" }).healthy).toBe(false);
  });

  it("accepts only bounded pending-write metadata from the Board API", () => {
    const parsed = parseBoardHermes({ pendingManagementAvailable: true, pendingWrites: [{ id: "a1b2c3d4", subsystem: "memory", action: "add", summary: "Remember Mumbai", origin: "background_review", createdAt: 1_788_000_000, sha256: "a".repeat(64), detail: "not accepted in list" }, { id: "../../bad", subsystem: "skills", createdAt: 1, sha256: "x" }] });
    expect(parsed.pendingManagementAvailable).toBe(true);
    expect(parsed.pendingWrites).toEqual([{ id: "a1b2c3d4", subsystem: "memory", action: "add", summary: "Remember Mumbai", origin: "background_review", createdAt: 1_788_000_000, sha256: "a".repeat(64) }]);
    expect(JSON.stringify(parsed)).not.toContain("not accepted in list");
  });

  it("parses only the hash-only Board activity ledger", () => {
    const runs = parseBoardRuns({ runs: [{ id: "run-1", status: "succeeded", model: "hermes-agent", requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), inputTokens: 12, outputTokens: 4, latencyMs: 250, createdAt: "2026-09-09T10:00:00.000Z", prompt: "private prompt", text: "private response", workspaceId: "private-workspace" }] });
    expect(runs).toEqual([{ id: "run-1", status: "succeeded", model: "hermes-agent", requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), inputTokens: 12, outputTokens: 4, latencyMs: 250, createdAt: "2026-09-09T10:00:00.000Z" }]);
    expect(JSON.stringify(runs)).not.toMatch(/private prompt|private response|private-workspace/);
  });
});

describe("Boards detail UI", () => {
  it("keeps memory and skills inside the Hermes plugin panel without leaking internals", () => {
    const markup = renderToStaticMarkup(createElement(BoardDetailPanel, { board: { id: "board-1", version: 1, name: "Mumbai events", purpose: "City event coverage", status: "ready" }, plugin: { configured: true, healthy: true, modelReady: true, memoryEnabled: true, memoryWriteApproval: true, skillWriteApproval: true, isolation: verifiedIsolation, pending: false, decisionPending: false, pendingManagementAvailable: false, pendingWrites: [], skills: [{ id: "secret-provider-id", label: "Event Research", enabled: true, applied: true }] }, panel: "memory", isOwner: true, busy: "", pendingDetail: null, onPanelChange: vi.fn(), onTest: vi.fn(), onReconcile: vi.fn(), onToggleSkill: vi.fn(), onReviewPending: vi.fn(), onPendingDecision: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn() }));
    expect(markup).toContain("BUILT-IN INTERNAL PLUGIN");
    expect(markup).toContain("Memory controls");
    expect(markup).toContain("Profile scope verified");
    expect(markup).toContain("Verified Board state boundary");
    expect(markup).toContain("No proposal is auto-approved");
    expect(markup).toContain("Existing Board memory remains private");
    expect(markup).not.toContain("secret-provider-id");
    expect(markup).not.toContain("/private/");
  });

  it("renders Board work separately from the internal plugin controls", () => {
    const markup = renderToStaticMarkup(createElement(BoardDetailPanel, { board: { id: "board-1", version: 1, name: "Mumbai events", purpose: "City event coverage", status: "ready" }, plugin: { configured: true, healthy: true, modelReady: true, memoryEnabled: true, memoryWriteApproval: true, skillWriteApproval: true, isolation: verifiedIsolation, pending: false, decisionPending: false, pendingManagementAvailable: false, pendingWrites: [], skills: [] }, panel: "work", isOwner: false, canRun: true, busy: "", pendingDetail: null, runPrompt: "Find a public event", runResult: { runId: "run-1234567890", model: "Hermes 0.21", text: "Source-backed draft" }, runs: [{ id: "run-1", status: "succeeded", model: "Hermes 0.21", requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), latencyMs: 120, createdAt: "2026-09-09T10:00:00.000Z" }], onPanelChange: vi.fn(), onRunPromptChange: vi.fn(), onRun: vi.fn(), onHandoff: vi.fn(), onTest: vi.fn(), onReconcile: vi.fn(), onToggleSkill: vi.fn(), onReviewPending: vi.fn(), onPendingDecision: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn() }));
    expect(markup).toContain("Work with this Board");
    expect(markup).toContain("Send to Content Inbox");
    expect(markup).toContain("Activity ledger");
    expect(markup).toContain("EPHEMERAL RESULT");
    expect(markup).not.toContain("Memory controls");
  });

  it("does not present or enable Board work when state isolation is unverified", () => {
    const markup = renderToStaticMarkup(createElement(BoardDetailPanel, { board: { id: "board-1", version: 1, name: "Mumbai events", purpose: "City event coverage", status: "ready" }, plugin: { configured: true, healthy: true, modelReady: true, memoryEnabled: true, memoryWriteApproval: true, skillWriteApproval: true, isolation: { ...verifiedIsolation, verified: false, skillsScoped: false }, pending: false, decisionPending: false, pendingManagementAvailable: false, pendingWrites: [], skills: [] }, panel: "work", isOwner: false, canRun: true, busy: "", pendingDetail: null, runPrompt: "Find an event", onPanelChange: vi.fn(), onRunPromptChange: vi.fn(), onRun: vi.fn(), onHandoff: vi.fn(), onTest: vi.fn(), onReconcile: vi.fn(), onToggleSkill: vi.fn(), onReviewPending: vi.fn(), onPendingDecision: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn() }));
    expect(markup).toContain("Restricted Board runtime");
    expect(markup).toContain("Work remains unavailable until the internal check passes");
    expect(markup).toContain("Finish Hermes setup before running this Board");
    expect(markup).toMatch(/<textarea[^>]*disabled=""/u);
  });
});
