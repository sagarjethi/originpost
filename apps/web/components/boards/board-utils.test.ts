import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BoardDetailPanel } from "./boards-workspace";
import { boardTaskHandoffRequestBody, hasActiveBoardTaskExecution, parseBoard, parseBoardHermes, parseBoardRuns, parseBoards, parseBoardTaskComments, parseBoardTaskExecutions, parseBoardTaskHandoff, parseBoardTasks } from "./board-utils";

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

  it("parses Board-owned tasks and comments without internal idempotency or actor identifiers", () => {
    const id = "agent_board_task_11111111-1111-4111-8111-111111111111";
    const tasks = parseBoardTasks({ tasks: [{ id, boardId: "board-1", version: 2, title: "Verify Mumbai event", description: "Official source", status: "triage", priority: "high", assignee: "board-agent", parentTaskIds: [], createdAt: "2026-09-13T08:00:00.000Z", updatedAt: "2026-09-13T08:00:00.000Z", idempotencyKeySha256: "a".repeat(64), createFingerprint: "b".repeat(64), workspaceId: "private" }] });
    const comments = parseBoardTaskComments({ comments: [{ id: "comment-1", body: "Source confirmed", authorName: "Editor", authorId: "private-user", createdAt: "2026-09-13T08:10:00.000Z" }] });
    expect(tasks).toEqual([expect.objectContaining({ id, title: "Verify Mumbai event", status: "triage" })]);
    expect(comments).toEqual([{ id: "comment-1", body: "Source confirmed", authorName: "Editor", createdAt: "2026-09-13T08:10:00.000Z" }]);
    expect(JSON.stringify({ tasks, comments })).not.toMatch(/idempotency|fingerprint|private-user|workspaceId/iu);
  });

  it("parses bounded task execution results without leaking worker internals", () => {
    const executions = parseBoardTaskExecutions({ executions: [{ id: "execution-1", taskId: "agent_board_task_11111111-1111-4111-8111-111111111111", status: "running", model: "Hermes 0.21", resultText: "Draft result", contentItemId: "content-1", createdAt: "2026-09-13T08:00:00.000Z", updatedAt: "2026-09-13T08:01:00.000Z", workspaceId: "private", requestPayload: "private prompt" }, { id: "bad", taskId: "task", status: "invented", createdAt: "not-a-date", updatedAt: "not-a-date" }] });
    expect(executions).toEqual([{ id: "execution-1", taskId: "agent_board_task_11111111-1111-4111-8111-111111111111", status: "running", model: "Hermes 0.21", resultText: "Draft result", contentItemId: "content-1", createdAt: "2026-09-13T08:00:00.000Z", updatedAt: "2026-09-13T08:01:00.000Z" }]);
    expect(hasActiveBoardTaskExecution(executions)).toBe(true);
    expect(hasActiveBoardTaskExecution([{ ...executions[0]!, status: "succeeded" }])).toBe(false);
    expect(JSON.stringify(executions)).not.toMatch(/private prompt|workspaceId|requestPayload/iu);
  });

  it("accepts a handoff only when the response links the expected execution and content item", () => {
    expect(parseBoardTaskHandoff({ contentItem: { id: "content-1", status: "inbox", privateNotes: "hidden" }, handoff: { executionId: "execution-1", contentItemId: "content-1", internalActorId: "hidden" } }, "execution-1")).toEqual({ executionId: "execution-1", contentItemId: "content-1" });
    expect(parseBoardTaskHandoff({ contentItem: { id: "content-2" }, handoff: { executionId: "execution-other", contentItemId: "content-2" } }, "execution-1")).toBeNull();
    expect(parseBoardTaskHandoff({ contentItem: { id: "content-2" }, handoff: { executionId: "execution-1", contentItemId: "different" } }, "execution-1")).toBeNull();
    expect(boardTaskHandoffRequestBody("workspace-1", "brand-1", "execution-1")).toEqual({ workspaceId: "workspace-1", brandId: "brand-1", executionId: "execution-1" });
  });
});

describe("Boards detail UI", () => {
  it("renders Tasks as a Board-level surface even when Hermes is unavailable", () => {
    const markup = renderToStaticMarkup(createElement(BoardDetailPanel, { board: { id: "board-1", version: 1, name: "Mumbai events", purpose: "City event coverage", status: "setup_required" }, plugin: { configured: false, healthy: false, modelReady: false, memoryEnabled: false, memoryWriteApproval: false, skillWriteApproval: false, isolation: { ...verifiedIsolation, verified: false }, pending: false, decisionPending: false, pendingManagementAvailable: false, pendingWrites: [], skills: [] }, panel: "tasks", isOwner: true, canManageTasks: true, canApproveTasks: true, busy: "", pendingDetail: null, tasks: [{ id: "agent_board_task_11111111-1111-4111-8111-111111111111", boardId: "board-1", version: 1, title: "Verify Mumbai event", description: "Official source", status: "triage", priority: "high", assignee: "team", parentTaskIds: [], createdAt: "2026-09-13T08:00:00.000Z", updatedAt: "2026-09-13T08:00:00.000Z" }], onPanelChange: vi.fn(), onTest: vi.fn(), onReconcile: vi.fn(), onToggleSkill: vi.fn(), onReviewPending: vi.fn(), onPendingDecision: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn() }));
    expect(markup).toContain("Board tasks");
    expect(markup).toContain("Tasks remain usable even when Hermes is unavailable");
    expect(markup).toContain("Verify Mumbai event");
    expect(markup).not.toContain("BUILT-IN INTERNAL PLUGIN");
    expect(markup).not.toContain("Restricted Board runtime");
    expect(markup).not.toContain("Setup required");
    expect(markup).not.toContain("Last connection check");
    expect(markup).toContain("Tasks are stored in this Board and do not require Hermes");
  });
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

  it("keeps Board-agent release and human approval as separate task actions", () => {
    const task = { id: "agent_board_task_11111111-1111-4111-8111-111111111111", boardId: "board-1", version: 3, title: "Research Mumbai event", description: "Use official sources", status: "ready" as const, priority: "high" as const, assignee: "board-agent" as const, parentTaskIds: [], createdAt: "2026-09-13T08:00:00.000Z", updatedAt: "2026-09-13T08:10:00.000Z" };
    const markup = renderToStaticMarkup(createElement(BoardDetailPanel, { board: { id: "board-1", version: 1, name: "Mumbai events", purpose: "City event coverage", status: "ready" }, plugin: { configured: true, healthy: true, modelReady: true, memoryEnabled: true, memoryWriteApproval: true, skillWriteApproval: true, isolation: verifiedIsolation, pending: false, decisionPending: false, pendingManagementAvailable: false, pendingWrites: [], skills: [] }, panel: "tasks", isOwner: false, canManageTasks: true, canApproveTasks: true, busy: "", pendingDetail: null, tasks: [task], selectedTaskId: task.id, taskExecutions: [{ id: "execution-1", taskId: task.id, status: "succeeded", model: "Hermes 0.21", resultText: "Source-backed result", createdAt: "2026-09-13T08:11:00.000Z", updatedAt: "2026-09-13T08:12:00.000Z" }], onPanelChange: vi.fn(), onReleaseTask: vi.fn(), onTest: vi.fn(), onReconcile: vi.fn(), onToggleSkill: vi.fn(), onReviewPending: vi.fn(), onPendingDecision: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn() }));
    expect(markup).toContain("Release to Hermes");
    expect(markup).toContain("Ready for review");
    expect(markup).toContain("Source-backed result");
    expect(markup).toContain("Human approval is still required");
    expect(markup).not.toContain(">In progress</option>");
  });

  it("offers a review-first Content Inbox handoff for the latest successful execution", () => {
    const task = { id: "agent_board_task_11111111-1111-4111-8111-111111111111", boardId: "board-1", version: 4, title: "Research Mumbai event", description: "Use official sources", status: "review" as const, priority: "high" as const, assignee: "board-agent" as const, parentTaskIds: [], resultSummary: "Source-backed result", createdAt: "2026-09-13T08:00:00.000Z", updatedAt: "2026-09-13T08:12:00.000Z" };
    const execution = { id: "execution-1", taskId: task.id, status: "succeeded" as const, model: "Hermes 0.21", resultText: "Source-backed result", createdAt: "2026-09-13T08:11:00.000Z", updatedAt: "2026-09-13T08:12:00.000Z" };
    const props = { board: { id: "board-1", version: 1, name: "Mumbai events", purpose: "City event coverage", status: "ready" as const }, plugin: { configured: true, healthy: true, modelReady: true, memoryEnabled: true, memoryWriteApproval: true, skillWriteApproval: true, isolation: verifiedIsolation, pending: false, decisionPending: false, pendingManagementAvailable: false, pendingWrites: [], skills: [] }, panel: "tasks" as const, isOwner: false, canManageTasks: true, canApproveTasks: true, busy: "", pendingDetail: null, tasks: [task], selectedTaskId: task.id, taskExecutions: [execution], onPanelChange: vi.fn(), onHandoffTask: vi.fn(), onOpenContent: vi.fn(), onTest: vi.fn(), onReconcile: vi.fn(), onToggleSkill: vi.fn(), onReviewPending: vi.fn(), onPendingDecision: vi.fn(), onEdit: vi.fn(), onArchive: vi.fn() };
    const createMarkup = renderToStaticMarkup(createElement(BoardDetailPanel, props));
    expect(createMarkup).toContain("Continue in Content Inbox");
    expect(createMarkup).toContain("Create &amp; open review item");
    expect(createMarkup).toContain("Create an unapproved Content item");
    expect(createMarkup).toContain("Nothing is published");
    expect(createMarkup).toContain('aria-label="Create review Content Inbox item from Research Mumbai event"');

    const openMarkup = renderToStaticMarkup(createElement(BoardDetailPanel, { ...props, taskExecutions: [{ ...execution, contentItemId: "content-1" }] }));
    expect(openMarkup).toContain("Open Content item");
    expect(openMarkup).not.toContain("Create &amp; open review item");
  });
});
