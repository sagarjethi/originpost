"use client";

import { Activity, Archive, Bot, Brain, Check, CheckCircle2, ChevronRight, Columns3, FilePlus2, Hash, ListTodo, Loader2, LockKeyhole, MessageSquare, Plus, RefreshCw, Send, ShieldCheck, Sparkles, ToggleLeft, ToggleRight, TriangleAlert, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import { BOARD_TASK_STATUSES, boardTaskHandoffRequestBody, boardTaskNextStatuses, formatBoardStamp, hasActiveBoardTaskExecution, parseBoard, parseBoardHermes, parseBoardRuns, parseBoards, parseBoardTask, parseBoardTaskComments, parseBoardTaskExecutions, parseBoardTaskHandoff, parseBoardTasks, type BoardHermesView, type BoardPendingWriteDetailView, type BoardPendingWriteView, type BoardRunView, type BoardSkillView, type BoardTaskCommentView, type BoardTaskExecutionStatus, type BoardTaskExecutionView, type BoardTaskStatus, type BoardTaskView, type BoardView } from "./board-utils";
import styles from "./boards-workspace.module.css";

type BoardPanel = "tasks" | "work" | "overview" | "memory" | "skills";
type BoardRunResult = { runId: string; model: string; text: string; usage?: { inputTokens?: number; outputTokens?: number } };

const emptyPlugin: BoardHermesView = { configured: false, healthy: false, modelReady: false, memoryEnabled: false, memoryWriteApproval: false, skillWriteApproval: false, isolation: { verified: false, profileScoped: false, memoryScoped: false, skillsScoped: false, stateScoped: false, externalSkillsBlocked: false, unsafeToolsBlocked: false, filesystemSandbox: false }, pending: false, decisionPending: false, pendingManagementAvailable: false, pendingWrites: [], skills: [] };

function membershipRole(auth: AuthView, workspaceId: string) {
  return auth.memberships.find((membership) => membership.workspaceId === workspaceId)?.role ?? auth.memberships[0]?.role;
}

function safeRequestMessage(fallback: string) {
  // Provider responses can contain endpoints, profile names, and paths. Keep the browser copy deliberately generic.
  return fallback;
}

function pluginState(board: BoardView, plugin: BoardHermesView, unavailable = false) {
  if (unavailable) return { label: "Could not verify", className: styles.attention };
  if (board.status === "provisioning") return { label: "Setting up", className: styles.pending };
  if (board.status === "attention") return { label: "Needs attention", className: styles.attention };
  if (plugin.configured && plugin.healthy && board.status === "ready") return { label: "Ready", className: styles.ready };
  return { label: "Setup required", className: styles.pending };
}

function BoardWork({ board, runtimeReady, canRun, busy, prompt, result, runs, onPrompt, onRun, onHandoff }: { board: BoardView; runtimeReady: boolean; canRun: boolean; busy: string; prompt: string; result: BoardRunResult | null; runs: BoardRunView[]; onPrompt: (value: string) => void; onRun: (event: FormEvent<HTMLFormElement>) => void; onHandoff: () => void }) {
  const ready = board.status === "ready" && runtimeReady;
  return <div className={styles.workPanel}>
    <div className={styles.panelLead}><span><Sparkles size={20} /></span><div><strong>Work with this Board</strong><p>The prompt uses only this Board’s purpose, memory, and owner-approved skills.</p></div></div>
    <form className={styles.runComposer} onSubmit={onRun}>
      <label htmlFor={`board-prompt-${board.id}`}>What should this Board work on?</label>
      <textarea id={`board-prompt-${board.id}`} value={prompt} onChange={(event) => onPrompt(event.target.value)} minLength={1} maxLength={12_000} rows={5} placeholder="Research the next verified Mumbai event opportunity and outline a source-backed post." disabled={!canRun || !ready || Boolean(busy)} />
      <footer><p><LockKeyhole size={13} />The saved ledger keeps hashes and usage—not prompt or response text.</p><button type="submit" disabled={!canRun || !ready || !prompt.trim() || Boolean(busy)}>{busy === "run" ? <Loader2 className={styles.spin} size={14} /> : <Send size={14} />}Run Board</button></footer>
    </form>
    {!ready ? <p className={styles.workWarning}><TriangleAlert size={14} />Finish Hermes setup before running this Board.</p> : !canRun ? <p className={styles.workWarning}><LockKeyhole size={14} />Your workspace role can view Board activity but cannot run Board actions.</p> : null}
    {result ? <article className={styles.runResult}><header><div><small>EPHEMERAL RESULT</small><strong>{result.model}</strong></div><button type="button" onClick={onHandoff} disabled={Boolean(busy)}>{busy === "handoff" ? <Loader2 className={styles.spin} size={13} /> : <FilePlus2 size={13} />}Send to Content Inbox</button></header><pre>{result.text}</pre><footer>Run {result.runId.slice(0, 12)} · This response is not stored in Board history.</footer></article> : null}
    <section className={styles.runLedger}><header><div><strong>Activity ledger</strong><p>Recent executions for this Board, without prompt or response content.</p></div><Hash size={17} /></header>{runs.length ? runs.map((run) => <article key={run.id}><span className={run.status === "succeeded" ? styles.runSucceeded : styles.runFailed}>{run.status === "succeeded" ? <CheckCircle2 size={13} /> : <TriangleAlert size={13} />}{run.status === "succeeded" ? "Completed" : "Failed"}</span><div><strong>{run.model}</strong><small>{formatBoardStamp(run.createdAt)} · {Math.round(run.latencyMs)} ms{run.outputTokens !== undefined ? ` · ${run.outputTokens} output tokens` : ""}</small></div><code title={run.requestSha256}>Request {run.requestSha256.slice(0, 10)}</code></article>) : <div className={styles.emptyInner}><Activity size={21} /><strong>No Board runs yet</strong><p>Run a task to create the first hash-only activity record.</p></div>}</section>
  </div>;
}

type BoardTaskCreateInput = { title: string; description?: string; priority: "low" | "normal" | "high" | "urgent"; assignee: "team" | "board-agent"; parentTaskIds: string[] };
type BoardTaskPatch = { status?: BoardTaskStatus; assignee?: "team" | "board-agent"; parentTaskIds?: string[]; blockedReason?: string; resultSummary?: string };

function taskStatusLabel(status: BoardTaskStatus) {
  if (status === "todo") return "To do";
  if (status === "running") return "In progress";
  return status[0]!.toUpperCase() + status.slice(1);
}

function executionStatusLabel(status: BoardTaskExecutionStatus) {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "succeeded") return "Ready for review";
  if (status === "uncertain") return "Needs verification";
  return "Failed";
}

function BoardTasks({ board, tasks, comments, executions, handoffContentItemIds, selectedTaskId, includeArchived, canManage, canApprove, busy, onSelect, onIncludeArchived, onCreate, onUpdate, onComment, onRelease, onHandoff, onOpenContent }: {
  board: BoardView;
  tasks: BoardTaskView[];
  comments: BoardTaskCommentView[];
  executions: BoardTaskExecutionView[];
  handoffContentItemIds: Record<string, string>;
  selectedTaskId: string;
  includeArchived: boolean;
  canManage: boolean;
  canApprove: boolean;
  busy: string;
  onSelect: (taskId: string) => void;
  onIncludeArchived: (value: boolean) => void;
  onCreate: (input: BoardTaskCreateInput) => Promise<boolean>;
  onUpdate: (task: BoardTaskView, patch: BoardTaskPatch) => Promise<boolean>;
  onComment: (task: BoardTaskView, body: string) => Promise<boolean>;
  onRelease: (task: BoardTaskView) => Promise<boolean>;
  onHandoff: (task: BoardTaskView, execution: BoardTaskExecutionView) => Promise<boolean>;
  onOpenContent: (contentItemId: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const selected = tasks.find((task) => task.id === selectedTaskId);
  const columns = includeArchived ? BOARD_TASK_STATUSES : BOARD_TASK_STATUSES.filter((status) => status !== "archived");
  const editableDependencies = selected && ["triage", "todo", "blocked"].includes(selected.status);
  const editableAssignment = selected && ["triage", "todo"].includes(selected.status);
  const latestExecution = executions.reduce<BoardTaskExecutionView | undefined>((latest, execution) => !latest || Date.parse(execution.updatedAt) > Date.parse(latest.updatedAt) ? execution : latest, undefined);
  const reviewExecution = selected?.status === "review" && latestExecution?.status === "succeeded" ? latestExecution : undefined;

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const priority = String(data.get("priority"));
    const description = String(data.get("description") ?? "").trim();
    const saved = await onCreate({
      title: String(data.get("title") ?? "").trim(),
      ...(description ? { description } : {}),
      priority: priority === "low" || priority === "high" || priority === "urgent" ? priority : "normal",
      assignee: data.get("assignee") === "board-agent" ? "board-agent" : "team",
      parentTaskIds: data.getAll("parentTaskIds").map(String),
    });
    if (saved) { form.reset(); setCreating(false); }
  }

  return <section className={styles.tasksSurface} aria-label="Board tasks">
    <header className={styles.tasksHead}>
      <div><span><ListTodo size={19} /></span><div><strong>Board tasks</strong><p>Plan the work, assign owners, and review results.</p></div></div>
      <div><label><input type="checkbox" checked={includeArchived} onChange={(event) => onIncludeArchived(event.target.checked)} />Show archived</label>{canManage && board.status !== "archived" ? <button type="button" onClick={() => setCreating((value) => !value)}><Plus size={13} />New task</button> : null}</div>
    </header>

    {creating ? <form className={styles.taskForm} onSubmit={(event) => void createTask(event)}>
      <label>Task title<input name="title" required minLength={1} maxLength={180} placeholder="Verify the Luma Mumbai event" /></label>
      <label>Description<textarea name="description" rows={3} maxLength={8_000} placeholder="Capture the official organizer page and prepare a source-backed brief." /></label>
      <div><label>Priority<select name="priority" defaultValue="normal"><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Execution owner<select name="assignee" defaultValue="team" aria-label="Task execution owner"><option value="team">Team</option><option value="board-agent">Board agent (Hermes)</option></select></label></div>
      {tasks.filter((task) => task.status !== "archived").length ? <fieldset><legend>Dependencies</legend>{tasks.filter((task) => task.status !== "archived").map((task) => <label key={task.id}><input type="checkbox" name="parentTaskIds" value={task.id} />{task.title}<small>{taskStatusLabel(task.status)}</small></label>)}</fieldset> : null}
      <footer><button type="button" onClick={() => setCreating(false)}>Cancel</button><button type="submit" disabled={Boolean(busy)}>{busy === "task:create" ? <Loader2 className={styles.spin} size={13} /> : <Plus size={13} />}Create in triage</button></footer>
    </form> : null}

    <div className={styles.taskBoard}>
      {columns.map((status) => {
        const rows = tasks.filter((task) => task.status === status);
        return <section key={status} className={styles.taskColumn} aria-label={taskStatusLabel(status) + " tasks"}>
          <header><strong>{taskStatusLabel(status)}</strong><span>{rows.length}</span></header>
          <div>{rows.map((task) => <article key={task.id} className={selectedTaskId === task.id ? styles.selectedTask : ""}>
            <button type="button" onClick={() => onSelect(task.id)}><strong>{task.title}</strong><span>{task.priority} · {task.assignee === "board-agent" ? "Board agent" : "Team"}</span>{task.parentTaskIds.length ? <small>{task.parentTaskIds.length} {task.parentTaskIds.length === 1 ? "dependency" : "dependencies"}</small> : null}</button>
            {canManage && board.status !== "archived" && task.status !== "archived" && boardTaskNextStatuses(task.status).filter((next) => (next !== "done" || canApprove) && !(task.assignee === "board-agent" && task.status === "ready" && next === "running")).length ? <label><span>Move</span><select aria-label={"Move " + task.title} value={task.status} disabled={Boolean(busy)} onChange={(event) => void onUpdate(task, { status: event.target.value as BoardTaskStatus })}><option value={task.status}>{taskStatusLabel(task.status)}</option>{boardTaskNextStatuses(task.status).filter((next) => (next !== "done" || canApprove) && !(task.assignee === "board-agent" && task.status === "ready" && next === "running")).map((next) => <option key={next} value={next}>{taskStatusLabel(next)}</option>)}</select></label> : null}
          </article>)}
          {!rows.length ? <p>No tasks</p> : null}</div>
        </section>;
      })}
    </div>

    {selected ? <aside className={styles.taskDetail} aria-label="Selected task details">
      <header><div><small>{taskStatusLabel(selected.status)} · v{selected.version}</small><h3>{selected.title}</h3><p>{selected.description || "No description yet."}</p></div><button type="button" onClick={() => onSelect("")} aria-label="Close task details"><X size={15} /></button></header>
      {selected.blockedReason ? <p className={styles.taskCallout}><TriangleAlert size={14} />{selected.blockedReason}</p> : null}
      {selected.resultSummary ? <p className={styles.taskCallout}><CheckCircle2 size={14} />{selected.resultSummary}</p> : null}
      <section className={styles.taskAssignment}><h4>Execution owner</h4>{editableAssignment && canManage && board.status !== "archived" ? <label><span>Who performs this task?</span><select aria-label="Execution owner" value={selected.assignee} disabled={Boolean(busy)} onChange={(event) => void onUpdate(selected, { assignee: event.target.value === "board-agent" ? "board-agent" : "team" })}><option value="team">Team</option><option value="board-agent">Board agent (Hermes)</option></select></label> : <p>{selected.assignee === "board-agent" ? "Board agent (Hermes)" : "Team"}</p>}<small>The execution owner can only be changed before work begins.</small></section>
      {selected.assignee === "board-agent" || executions.length ? <section className={styles.taskExecutions} aria-label="Hermes execution history">
        <header><div><h4>Hermes execution</h4><p>Release starts Board-scoped work. A manager or owner must review the result separately before marking the task done.</p></div>{latestExecution ? <em role="status" aria-live="polite">{hasActiveBoardTaskExecution(executions) ? <><Loader2 className={styles.spin} size={12} />Refreshing</> : `Latest: ${executionStatusLabel(latestExecution.status)}`}</em> : null}</header>
        {selected.assignee === "board-agent" && selected.status === "ready" ? <div className={styles.releaseTask}><div><strong>Ready to release</strong><p>Hermes will use only this Board’s approved memory and skills.</p></div>{canApprove ? <button type="button" onClick={() => void onRelease(selected)} disabled={Boolean(busy) || board.status !== "ready"}>{busy === "task:release" ? <Loader2 className={styles.spin} size={13} /> : <Send size={13} />}Release to Hermes</button> : <span><LockKeyhole size={13} />Manager or owner required</span>}{board.status !== "ready" ? <small>Finish this Board’s Hermes setup before release.</small> : null}</div> : null}
        <div className={styles.executionList}>{executions.map((execution) => <article key={execution.id}>
          <header><strong>{executionStatusLabel(execution.status)}</strong><time dateTime={execution.updatedAt}>{formatBoardStamp(execution.updatedAt)}</time></header>
          {execution.model ? <small>{execution.model}</small> : null}
          {execution.resultText ? <pre>{execution.resultText}</pre> : null}
          {execution.errorSummary ? <p className={styles.executionError}><TriangleAlert size={13} />{execution.errorSummary}</p> : null}
          {execution.status === "succeeded" ? <p><ShieldCheck size={13} />Execution finished. Human approval is still required to complete this task.</p> : null}
          {reviewExecution?.id === execution.id ? <div className={styles.taskHandoff}>
            <div><strong>Continue in Content Inbox</strong><p>Create an unapproved Content item with this Board, task, and execution recorded as provenance. Source checks, drafting, and editorial approval still happen there. Nothing is published by this action.</p></div>
            {execution.contentItemId || handoffContentItemIds[execution.id] ? <button type="button" aria-label={`Open Content Inbox item for ${selected.title}`} onClick={() => onOpenContent((execution.contentItemId || handoffContentItemIds[execution.id])!)}><FilePlus2 size={13} />Open Content item</button> : canApprove ? <button type="button" aria-label={`Create review Content Inbox item from ${selected.title}`} onClick={() => void onHandoff(selected, execution)} disabled={Boolean(busy)}>{busy === `task:handoff:${execution.id}` ? <Loader2 className={styles.spin} size={13} /> : <FilePlus2 size={13} />}Create &amp; open review item</button> : <span><LockKeyhole size={13} />Manager or owner required</span>}
          </div> : null}
        </article>)}{!executions.length ? <p>No Hermes execution has been released for this task.</p> : null}</div>
      </section> : null}
      <section><h4>Dependencies</h4>{editableDependencies && canManage && board.status !== "archived" ? <form key={selected.id + ":" + selected.version} className={styles.dependencyForm} onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void onUpdate(selected, { parentTaskIds: data.getAll("parentTaskIds").map(String) }); }}>{tasks.filter((task) => task.id !== selected.id && task.status !== "archived").map((task) => <label key={task.id}><input type="checkbox" name="parentTaskIds" value={task.id} defaultChecked={selected.parentTaskIds.includes(task.id)} />{task.title}<small>{taskStatusLabel(task.status)}</small></label>)}<button type="submit" disabled={Boolean(busy)}>Save dependencies</button></form> : selected.parentTaskIds.length ? <ul>{selected.parentTaskIds.map((id) => <li key={id}>{tasks.find((task) => task.id === id)?.title ?? "Completed task"}</li>)}</ul> : <p>No dependencies.</p>}</section>
      <section><h4>Comments</h4><div className={styles.taskComments}>{comments.map((comment) => <article key={comment.id}><strong>{comment.authorName}</strong><time dateTime={comment.createdAt}>{formatBoardStamp(comment.createdAt)}</time><p>{comment.body}</p></article>)}{!comments.length ? <p>No comments yet.</p> : null}</div>{canManage && board.status !== "archived" && selected.status !== "archived" ? <form className={styles.commentForm} onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const body = String(new FormData(form).get("body") ?? "").trim(); if (body) void onComment(selected, body).then((saved) => { if (saved) form.reset(); }); }}><label htmlFor={"task-comment-" + selected.id}>Add a comment</label><textarea id={"task-comment-" + selected.id} name="body" required maxLength={4_000} rows={2} /><button type="submit" disabled={Boolean(busy)}><MessageSquare size={13} />Comment</button></form> : null}</section>
    </aside> : null}
  </section>;
}

function skillState(skill: BoardSkillView) {
  if (skill.enabled && skill.applied) return "Allowed";
  if (skill.enabled) return "Approved · applying";
  if (skill.applied) return "Removal approved · applying";
  return "Not allowed";
}

function PendingWrites({ subsystem, plugin, detail, busy, isOwner, onReview, onDecision }: { subsystem: "memory" | "skills"; plugin: BoardHermesView; detail: BoardPendingWriteDetailView | null; busy: string; isOwner: boolean; onReview: (write: BoardPendingWriteView) => void; onDecision: (decision: "approve" | "reject") => void }) {
  const writes = plugin.pendingWrites.filter((write) => write.subsystem === subsystem);
  if (!isOwner) return <p className={styles.privacyNote}><LockKeyhole size={14} /> Pending proposals are visible only to a workspace owner. No proposal is auto-approved.</p>;
  if (!plugin.pendingManagementAvailable) return <p className={styles.privacyNote}><LockKeyhole size={14} /> Pending-write review needs the hidden Hermes 0.21 OriginPost approvals extension. No proposal is auto-approved.</p>;
  if (plugin.decisionPending) return <p className={styles.privacyNote}><Loader2 className={styles.spin} size={14} /> A reviewed decision is queued. OriginPost is waiting for Hermes to apply its durable receipt.</p>;
  if (!writes.length) return <p className={styles.privacyNote}><CheckCircle2 size={14} /> No pending {subsystem === "memory" ? "memory" : "skill"} writes.</p>;
  return <div className={styles.pendingWrites} aria-label={`Pending ${subsystem} writes`}>
    <h4>Pending approval</h4>
    {writes.map((write) => <article key={`${subsystem}:${write.id}`}>
      <div><strong>{write.summary || `${write.action} proposal`}</strong><small>{write.origin === "background_review" ? "Suggested automatically" : "Suggested during Board work"}</small></div>
      <button type="button" onClick={() => onReview(write)} disabled={Boolean(busy)}>Review</button>
      {detail?.id === write.id && detail.subsystem === subsystem ? <div className={styles.pendingDetail}><pre>{detail.detail}</pre>{detail.detailTruncated ? <small>Preview truncated. Use Hermes CLI for the complete diff before deciding.</small> : null}{isOwner ? <footer><button type="button" onClick={() => onDecision("reject")} disabled={Boolean(busy)}>Reject</button><button type="button" onClick={() => onDecision("approve")} disabled={Boolean(busy)}>{busy === `pending:${write.id}` ? <Loader2 className={styles.spin} size={13} /> : null}Approve</button></footer> : null}</div> : null}
    </article>)}
  </div>;
}

export function BoardDetailPanel({ board, plugin, pluginUnavailable = false, panel, isOwner, canRun = false, canManageTasks = false, canApproveTasks = false, busy, pendingDetail, runPrompt = "", runResult = null, runs = [], tasks = [], taskComments = [], taskExecutions = [], taskHandoffContentItemIds = {}, selectedTaskId = "", includeArchivedTasks = false, onPanelChange, onRunPromptChange = () => undefined, onRun = () => undefined, onHandoff = () => undefined, onSelectTask = () => undefined, onIncludeArchivedTasks = () => undefined, onCreateTask = async () => false, onUpdateTask = async () => false, onCommentTask = async () => false, onReleaseTask = async () => false, onHandoffTask = async () => false, onOpenContent = () => undefined, onTest, onReconcile, onToggleSkill, onReviewPending, onPendingDecision, onEdit, onArchive }: {
  board: BoardView;
  plugin: BoardHermesView;
  pluginUnavailable?: boolean;
  panel: BoardPanel;
  isOwner: boolean;
  canRun?: boolean;
  canManageTasks?: boolean;
  canApproveTasks?: boolean;
  busy: string;
  pendingDetail: BoardPendingWriteDetailView | null;
  runPrompt?: string;
  runResult?: BoardRunResult | null;
  runs?: BoardRunView[];
  tasks?: BoardTaskView[];
  taskComments?: BoardTaskCommentView[];
  taskExecutions?: BoardTaskExecutionView[];
  taskHandoffContentItemIds?: Record<string, string>;
  selectedTaskId?: string;
  includeArchivedTasks?: boolean;
  onPanelChange: (panel: BoardPanel) => void;
  onRunPromptChange?: (value: string) => void;
  onRun?: (event: FormEvent<HTMLFormElement>) => void;
  onHandoff?: () => void;
  onSelectTask?: (taskId: string) => void;
  onIncludeArchivedTasks?: (value: boolean) => void;
  onCreateTask?: (input: BoardTaskCreateInput) => Promise<boolean>;
  onUpdateTask?: (task: BoardTaskView, patch: BoardTaskPatch) => Promise<boolean>;
  onCommentTask?: (task: BoardTaskView, body: string) => Promise<boolean>;
  onReleaseTask?: (task: BoardTaskView) => Promise<boolean>;
  onHandoffTask?: (task: BoardTaskView, execution: BoardTaskExecutionView) => Promise<boolean>;
  onOpenContent?: (contentItemId: string) => void;
  onTest: () => void;
  onReconcile: () => void;
  onToggleSkill: (skill: BoardSkillView) => void;
  onReviewPending: (write: BoardPendingWriteView) => void;
  onPendingDecision: (decision: "approve" | "reject") => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const state = pluginState(board, plugin, pluginUnavailable);
  const boardState = board.status === "archived" ? { label: "Archived", className: styles.attention } : { label: "Active", className: styles.ready };
  return <section className={styles.detail} aria-labelledby="board-detail-title">
    <header className={styles.detailHead}>
      <div><p>BOARD</p><h2 id="board-detail-title">{board.name}</h2><span>{board.purpose || "A dedicated working context for this brand."}</span></div>
      <div className={styles.detailActions}>{isOwner && board.status !== "archived" ? <button onClick={onEdit}>Edit board</button> : null}<em className={(panel === "tasks" ? boardState : state).className}>{(panel === "tasks" ? boardState : state).label}</em></div>
    </header>

    <nav className={styles.boardTabs} aria-label="Board areas">
      <button className={panel === "tasks" ? styles.activeBoardTab : ""} onClick={() => onPanelChange("tasks")} aria-current={panel === "tasks" ? "page" : undefined}><ListTodo size={15} />Tasks</button>
      <button className={panel === "work" ? styles.activeBoardTab : ""} onClick={() => onPanelChange("work")} aria-current={panel === "work" ? "page" : undefined}><Send size={15} />Work</button>
      <button className={["overview", "memory", "skills"].includes(panel) ? styles.activeBoardTab : ""} onClick={() => onPanelChange("overview")} aria-current={["overview", "memory", "skills"].includes(panel) ? "page" : undefined}><Bot size={15} />Hermes settings</button>
    </nav>

    {panel === "tasks" ? <BoardTasks board={board} tasks={tasks} comments={taskComments} executions={taskExecutions} handoffContentItemIds={taskHandoffContentItemIds} selectedTaskId={selectedTaskId} includeArchived={includeArchivedTasks} canManage={canManageTasks} canApprove={canApproveTasks} busy={busy} onSelect={onSelectTask} onIncludeArchived={onIncludeArchivedTasks} onCreate={onCreateTask} onUpdate={onUpdateTask} onComment={onCommentTask} onRelease={onReleaseTask} onHandoff={onHandoffTask} onOpenContent={onOpenContent} /> : null}

    {panel === "work" ? <article className={styles.boardSurface}><BoardWork board={board} runtimeReady={!pluginUnavailable && plugin.configured && plugin.healthy && plugin.modelReady && plugin.isolation.verified} canRun={canRun} busy={busy} prompt={runPrompt} result={runResult} runs={runs} onPrompt={onRunPromptChange} onRun={onRun} onHandoff={onHandoff} /></article> : null}

    {panel !== "tasks" ? <div className={styles.boundary}>
      <span><LockKeyhole size={19} /></span>
      <div><strong>{plugin.isolation.verified ? "Verified Board state boundary" : "Restricted Board runtime"}</strong><p>{plugin.isolation.verified ? "Memory, skills, and runtime state are attested to this Board’s dedicated profile. Filesystem tools stay disabled; a Hermes Profile is not an operating-system sandbox." : "OriginPost has not verified this Board’s profile-scoped state. Work remains unavailable until the internal check passes."}</p></div>
    </div> : null}

    {panel !== "tasks" && panel !== "work" ? <article className={styles.plugin}>
      <header className={styles.pluginHead}>
        <span className={styles.pluginIcon}><Bot size={21} /></span>
        <div><small>BUILT-IN INTERNAL PLUGIN</small><h3>Hermes</h3><p>Board intelligence, managed inside this board.</p></div>
        <div className={styles.pluginHealth}><em className={state.className}>{state.label}</em>{isOwner && board.status !== "archived" ? board.status === "attention" || board.status === "setup_required" ? <button onClick={onReconcile} disabled={Boolean(busy)}>{busy === "reconcile" ? <Loader2 className={styles.spin} size={13} /> : <RefreshCw size={13} />}Retry setup</button> : <button onClick={onTest} disabled={Boolean(busy)}>{busy === "test" ? <Loader2 className={styles.spin} size={13} /> : <Activity size={13} />}Check status</button> : null}</div>
      </header>

      {plugin.pending ? <div className={styles.applyingBanner}><Loader2 className={styles.spin} size={14} /><div><strong>Approved changes are applying</strong><p>This Board stays unavailable until Hermes matches the exact Board policy.</p></div></div> : null}
      {pluginUnavailable ? <div className={styles.applyingBanner}><TriangleAlert size={14} /><div><strong>Plugin status could not be verified</strong><p>The saved Board setup was not changed. Retry the connection check when the service is available.</p></div></div> : null}

      <nav className={styles.pluginTabs} aria-label="Hermes plugin settings">
        {(["overview", "memory", "skills"] as const).map((value) => <button key={value} className={panel === value ? styles.activeTab : ""} onClick={() => onPanelChange(value)} aria-current={panel === value ? "page" : undefined}>{value === "overview" ? <Sparkles size={14} /> : value === "memory" ? <Brain size={14} /> : <ToggleRight size={14} />}{value[0]!.toUpperCase() + value.slice(1)}</button>)}
      </nav>

      {panel === "overview" ? <div className={styles.overview}>
        <div><span><Brain size={17} /></span><strong>Profile-scoped memory</strong><p>{plugin.isolation.memoryScoped ? "The memory tree is contained in this Board’s dedicated profile." : "Memory path attestation is required before work can run."}</p></div>
        <div><span><ToggleRight size={17} /></span><strong>Profile-scoped skills</strong><p>{plugin.isolation.skillsScoped && plugin.isolation.externalSkillsBlocked ? "Choose installed capabilities; external and project skill sources stay blocked." : "Skill path and external-source checks need attention."}</p></div>
        <div><span><Activity size={17} /></span><strong>Execution model</strong><p>{plugin.modelReady ? "The Board profile has a configured primary model." : "Configure a primary model in this Board’s Hermes profile."}</p></div>
        <div><span><ShieldCheck size={17} /></span><strong>Approval protected</strong><p>Memory writes require approval. Skill access is approved by an owner here.</p></div>
      </div> : null}

      {panel === "memory" ? <div className={styles.memoryPanel}>
        <div className={styles.panelLead}><span><Brain size={20} /></span><div><strong>Memory controls</strong><p>Manage how this board can learn without exposing or mixing its private memory.</p></div></div>
        <dl>
          <div><dt>State boundary</dt><dd>{plugin.isolation.verified ? <><CheckCircle2 size={14} /> Profile scope verified</> : <><TriangleAlert size={14} /> Could not verify</>}</dd></div>
          <div><dt>Learning</dt><dd>{plugin.memoryEnabled ? <><CheckCircle2 size={14} /> Enabled</> : <><TriangleAlert size={14} /> Not enabled</>}</dd></div>
          <div><dt>Write protection</dt><dd>{plugin.memoryWriteApproval ? <><ShieldCheck size={14} /> Approval required</> : <><TriangleAlert size={14} /> Review configuration</>}</dd></div>
        </dl>
        <PendingWrites subsystem="memory" plugin={plugin} detail={pendingDetail} busy={busy} isOwner={isOwner} onReview={onReviewPending} onDecision={onPendingDecision} />
        <p className={styles.privacyNote}><LockKeyhole size={14} /> Only pending proposals are shown to the Board owner for an exact approve/reject decision. Existing Board memory remains private and is never listed here.</p>
      </div> : null}

      {panel === "skills" ? <div className={styles.skillsPanel}>
        <div className={styles.panelLead}><span><ToggleRight size={20} /></span><div><strong>Allowed skills</strong><p>Only enabled skills can be used in this board. Skill instructions remain internal except when an exact proposed change is opened for owner review.</p></div></div>
        {plugin.skills.length ? <div className={styles.skillList}>{plugin.skills.map((skill) => <div key={skill.id} className={styles.skillRow}><span>{skill.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}</span><div><strong>{skill.label}</strong><small>{skillState(skill)}</small></div>{isOwner && board.status !== "archived" ? <button onClick={() => onToggleSkill(skill)} disabled={Boolean(busy)} aria-label={`${skill.enabled ? "Approve removal of" : "Allow"} ${skill.label}`}>{busy === `skill:${skill.id}` ? <Loader2 className={styles.spin} size={13} /> : skill.enabled ? "Approve removal" : "Allow on this Board"}</button> : <em>{skillState(skill)}</em>}</div>)}</div> : <div className={styles.emptyInner}><ToggleLeft size={22} /><strong>No skills available</strong><p>Finish Hermes setup, then refresh this board.</p></div>}
        <PendingWrites subsystem="skills" plugin={plugin} detail={pendingDetail} busy={busy} isOwner={isOwner} onReview={onReviewPending} onDecision={onPendingDecision} />
        <p className={styles.privacyNote}><ShieldCheck size={14} /> {plugin.skillWriteApproval ? "Skill writes inside Hermes require approval; Board access changes require an owner here." : "Skill approval protection needs attention."} Existing skill instructions stay private; only an exact pending change is shown during owner review.</p>
      </div> : null}
    </article> : null}

    <footer className={styles.detailFoot}>{panel !== "tasks" ? <span>Last connection check: {formatBoardStamp(plugin.lastCheckedAt ?? board.lastCheckedAt)}</span> : <span>Tasks are stored in this Board and do not require Hermes.</span>}{isOwner && board.status !== "archived" ? <button className={styles.archiveButton} onClick={onArchive}><Archive size={13} />Archive board</button> : null}</footer>
  </section>;
}

export function BoardsWorkspace({ auth, workspaceId, brandId, onOpenContent }: { auth: AuthView; workspaceId: string; brandId: string; onOpenContent?: (contentItemId: string) => void }) {
  const [boards, setBoards] = useState<BoardView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [plugin, setPlugin] = useState<BoardHermesView>(emptyPlugin);
  const [pluginUnavailable, setPluginUnavailable] = useState(false);
  const [panel, setPanel] = useState<BoardPanel>("tasks");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingDetail, setPendingDetail] = useState<BoardPendingWriteDetailView | null>(null);
  const [runPrompt, setRunPrompt] = useState("");
  const [runResult, setRunResult] = useState<BoardRunResult | null>(null);
  const [runs, setRuns] = useState<BoardRunView[]>([]);
  const [tasks, setTasks] = useState<BoardTaskView[]>([]);
  const [taskComments, setTaskComments] = useState<BoardTaskCommentView[]>([]);
  const [taskExecutions, setTaskExecutions] = useState<BoardTaskExecutionView[]>([]);
  const [taskHandoffContentItemIds, setTaskHandoffContentItemIds] = useState<Record<string, string>>({});
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [includeArchivedTasks, setIncludeArchivedTasks] = useState(false);
  const detailRequest = useRef(0);
  const commentRequest = useRef(0);
  const executionRequest = useRef(0);
  const pendingCommentKeys = useRef(new Map<string, { body: string; version: number; key: string }>());
  const pendingReleaseKeys = useRef(new Map<string, { version: number; key: string }>());
  const pendingHandoffKeys = useRef(new Map<string, { version: number; key: string }>());
  const role = membershipRole(auth, workspaceId);
  const isOwner = role === "owner";
  const canRun = role !== "viewer";
  const canManageTasks = role !== "viewer";
  const canApproveTasks = role === "owner" || role === "manager";
  const selected = useMemo(() => boards.find((board) => board.id === selectedId) ?? boards.find((board) => board.status !== "archived") ?? boards[0], [boards, selectedId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await apiFetch(`/v1/boards?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) throw new Error();
      const next = parseBoards(await response.json().catch(() => []));
      setBoards(next);
      setSelectedId((current) => next.some((board) => board.id === current) ? current : next.find((board) => board.status !== "archived")?.id ?? next[0]?.id ?? "");
    } catch {
      setError(safeRequestMessage("Could not load boards."));
    } finally {
      setLoading(false);
    }
  }, [auth.csrfToken, brandId, workspaceId]);

  const loadDetail = useCallback(async (boardId: string) => {
    const requestId = ++detailRequest.current;
    setDetailLoading(true);
    setError("");
    try {
      const [boardResponse, tasksResponse, pluginResponse, runsResponse] = await Promise.all([
        apiFetch(`/v1/boards/${encodeURIComponent(boardId)}?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/boards/${encodeURIComponent(boardId)}/tasks?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&includeArchived=${includeArchivedTasks}`, { cache: "no-store" }, auth.csrfToken),
        panel === "tasks" ? Promise.resolve(null) : apiFetch(`/v1/boards/${encodeURIComponent(boardId)}/plugins/hermes?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
        panel === "work" ? apiFetch(`/v1/boards/${encodeURIComponent(boardId)}/runs?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&limit=20`, { cache: "no-store" }, auth.csrfToken) : Promise.resolve(null),
      ]);
      if (detailRequest.current !== requestId) return;
      if (!boardResponse.ok) throw new Error();
      const boardBody = await boardResponse.json().catch(() => ({}));
      const parsedBoard = parseBoard((boardBody as { board?: unknown }).board ?? boardBody);
      if (parsedBoard) setBoards((current) => current.map((board) => board.id === parsedBoard.id ? parsedBoard : board));
      if (pluginResponse?.ok) {
        setPlugin(parseBoardHermes(await pluginResponse.json().catch(() => ({}))));
        setPluginUnavailable(false);
      } else if (pluginResponse) {
        setPlugin(emptyPlugin);
        setPluginUnavailable(true);
        setError(safeRequestMessage("Could not verify this Board’s internal Hermes plugin."));
      } else {
        setPlugin(emptyPlugin);
        setPluginUnavailable(false);
      }
      if (runsResponse?.ok) setRuns(parseBoardRuns(await runsResponse.json().catch(() => ({}))));
      else if (runsResponse) {
        setRuns([]);
        setError((current) => current || safeRequestMessage("Could not load this Board’s recent run ledger."));
      } else setRuns([]);
      if (tasksResponse.ok) {
        const nextTasks = parseBoardTasks(await tasksResponse.json().catch(() => ({}))).filter((task) => task.boardId === boardId);
        setTasks(nextTasks);
        setSelectedTaskId((current) => nextTasks.some((task) => task.id === current) ? current : "");
      } else {
        setTasks([]);
        setError((current) => current || safeRequestMessage("Could not load this Board’s tasks."));
      }
    } catch {
      if (detailRequest.current !== requestId) return;
      setPlugin(emptyPlugin);
      setPluginUnavailable(true);
      setRuns([]);
      setTasks([]);
      setError(safeRequestMessage("Could not load this Board."));
    } finally {
      if (detailRequest.current === requestId) setDetailLoading(false);
    }
  }, [auth.csrfToken, brandId, includeArchivedTasks, panel, workspaceId]);

  const loadTaskExecutions = useCallback(async (boardId: string, taskId: string, quiet = false) => {
    const requestId = ++executionRequest.current;
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}/executions?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) throw new Error();
      const next = parseBoardTaskExecutions(await response.json().catch(() => ({}))).filter((execution) => execution.taskId === taskId);
      if (executionRequest.current === requestId) setTaskExecutions(next);
      return next;
    } catch {
      if (executionRequest.current === requestId && !quiet) {
        setTaskExecutions([]);
        setError(safeRequestMessage("Could not load this task’s Hermes execution history."));
      }
      return null;
    }
  }, [auth.csrfToken, brandId, workspaceId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); else { detailRequest.current += 1; setPlugin(emptyPlugin); setTasks([]); } }, [loadDetail, selectedId]);
  useEffect(() => { setFormMode(null); setPanel("tasks"); setNotice(""); setRunPrompt(""); setRunResult(null); setSelectedTaskId(""); setTaskComments([]); setTaskExecutions([]); setTaskHandoffContentItemIds({}); setIncludeArchivedTasks(false); }, [brandId, workspaceId]);
  useEffect(() => { setPendingDetail(null); }, [selectedId, panel]);
  useEffect(() => { setRunPrompt(""); setRunResult(null); setSelectedTaskId(""); setTaskComments([]); setTaskExecutions([]); }, [selectedId]);
  useEffect(() => {
    const requestId = ++commentRequest.current;
    if (!selectedId || !selectedTaskId) { setTaskComments([]); return; }
    void (async () => {
      try {
        const response = await apiFetch(`/v1/boards/${encodeURIComponent(selectedId)}/tasks/${encodeURIComponent(selectedTaskId)}/comments?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&limit=100`, { cache: "no-store" }, auth.csrfToken);
        if (!response.ok) throw new Error();
        const comments = parseBoardTaskComments(await response.json().catch(() => ({})));
        if (commentRequest.current === requestId) setTaskComments(comments);
      } catch {
        if (commentRequest.current === requestId) { setTaskComments([]); setError(safeRequestMessage("Could not load this task’s comments.")); }
      }
    })();
  }, [auth.csrfToken, brandId, selectedId, selectedTaskId, workspaceId]);
  useEffect(() => {
    executionRequest.current += 1;
    if (!selectedId || !selectedTaskId) { setTaskExecutions([]); return; }
    setTaskExecutions([]);
    void loadTaskExecutions(selectedId, selectedTaskId);
  }, [loadTaskExecutions, selectedId, selectedTaskId]);
  useEffect(() => {
    if (!selectedId || !selectedTaskId || !hasActiveBoardTaskExecution(taskExecutions)) return;
    const timer = window.setInterval(() => { void loadTaskExecutions(selectedId, selectedTaskId, true); }, 2_500);
    return () => window.clearInterval(timer);
  }, [loadTaskExecutions, selectedId, selectedTaskId, taskExecutions]);

  async function createTask(input: BoardTaskCreateInput) {
    if (!selected || !canManageTasks || selected.status === "archived") return false;
    setBusy("task:create"); setError(""); setNotice("");
    try {
      const response = await apiFetch("/v1/boards/" + encodeURIComponent(selected.id) + "/tasks", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ workspaceId, brandId, ...input }),
      }, auth.csrfToken);
      if (!response.ok) throw new Error();
      const body = await response.json().catch(() => ({})) as { task?: unknown };
      const saved = parseBoardTask(body.task);
      setNotice("Task created in triage. Release it through the Board workflow when its scope is clear.");
      await loadDetail(selected.id);
      if (saved?.boardId === selected.id) setSelectedTaskId(saved.id);
      return true;
    } catch {
      setError(safeRequestMessage("Could not create this Board task."));
      return false;
    } finally { setBusy(""); }
  }

  async function updateTask(task: BoardTaskView, patch: BoardTaskPatch) {
    if (!selected || !canManageTasks || task.boardId !== selected.id || selected.status === "archived") return false;
    const next = { ...patch };
    if (patch.status === "blocked") {
      const reason = window.prompt("Why is this task blocked?", task.blockedReason ?? "");
      if (!reason?.trim()) return false;
      next.blockedReason = reason.trim();
    }
    if (patch.status === "review") {
      const result = window.prompt("Add the result or evidence for review:", task.resultSummary ?? "");
      if (!result?.trim()) return false;
      next.resultSummary = result.trim();
    }
    if (patch.status === "done" && !task.resultSummary) {
      const result = window.prompt("Add the verified completion result:", "");
      if (!result?.trim()) return false;
      next.resultSummary = result.trim();
    }
    if (patch.status === "archived" && !window.confirm("Archive this task? It will become read-only.")) return false;
    setBusy("task:update"); setError(""); setNotice("");
    try {
      const response = await apiFetch("/v1/boards/" + encodeURIComponent(selected.id) + "/tasks/" + encodeURIComponent(task.id), {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": String(task.version) },
        body: JSON.stringify({ workspaceId, brandId, ...next }),
      }, auth.csrfToken);
      if (!response.ok) {
        if (response.status === 409) await loadDetail(selected.id);
        throw new Error();
      }
      setNotice("Board task updated.");
      await loadDetail(selected.id);
      setSelectedTaskId(task.id);
      return true;
    } catch {
      setError(safeRequestMessage("Could not update this Board task. It may have changed or a dependency may still be open."));
      return false;
    } finally { setBusy(""); }
  }

  async function releaseTask(task: BoardTaskView) {
    if (!selected || !canApproveTasks || selected.status !== "ready" || task.boardId !== selected.id || task.status !== "ready" || task.assignee !== "board-agent") return false;
    if (!window.confirm(`Release “${task.title}” to this Board’s Hermes agent? This starts execution but does not approve the result.`)) return false;
    setBusy("task:release"); setError(""); setNotice("");
    const pending = pendingReleaseKeys.current.get(task.id);
    const request = pending?.version === task.version ? pending : { version: task.version, key: crypto.randomUUID() };
    pendingReleaseKeys.current.set(task.id, request);
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}/tasks/${encodeURIComponent(task.id)}/release`, {
        method: "POST",
        headers: { "content-type": "application/json", "if-match": String(task.version), "idempotency-key": request.key },
        body: JSON.stringify({ workspaceId, brandId }),
      }, auth.csrfToken);
      if (!response.ok) {
        if (response.status === 409) await loadDetail(selected.id);
        throw new Error();
      }
      pendingReleaseKeys.current.delete(task.id);
      setNotice("Task released to Hermes. Execution status will refresh here; human review remains required.");
      await Promise.all([loadDetail(selected.id), loadTaskExecutions(selected.id, task.id)]);
      setSelectedTaskId(task.id);
      return true;
    } catch {
      setError(safeRequestMessage("Could not release this task to Hermes. Its current Board state was preserved."));
      return false;
    } finally { setBusy(""); }
  }

  async function handoffTask(task: BoardTaskView, execution: BoardTaskExecutionView) {
    if (!selected || !canApproveTasks || selected.status === "archived" || task.boardId !== selected.id || task.status !== "review" || execution.taskId !== task.id || execution.status !== "succeeded") return false;
    const existingContentItemId = taskHandoffContentItemIds[execution.id];
    if (existingContentItemId) {
      onOpenContent?.(existingContentItemId);
      return true;
    }
    if (!window.confirm(`Create a Content Inbox item from “${task.title}”? It will keep this Board and execution as provenance, remain unapproved, and will not be published.`)) return false;
    setBusy(`task:handoff:${execution.id}`); setError(""); setNotice("");
    const request = pendingHandoffKeys.current.get(execution.id) ?? { version: task.version, key: crypto.randomUUID() };
    pendingHandoffKeys.current.set(execution.id, request);
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}/tasks/${encodeURIComponent(task.id)}/handoff`, {
        method: "POST",
        headers: { "content-type": "application/json", "if-match": String(request.version), "idempotency-key": request.key },
        body: JSON.stringify(boardTaskHandoffRequestBody(workspaceId, brandId, execution.id)),
      }, auth.csrfToken);
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) pendingHandoffKeys.current.delete(execution.id);
        if (response.status === 409) await loadDetail(selected.id);
        throw new Error();
      }
      const body = await response.json().catch(() => ({})) as { task?: unknown };
      const handoff = parseBoardTaskHandoff(body, execution.id);
      if (!handoff) throw new Error();
      const savedTask = parseBoardTask(body.task);
      if (savedTask?.boardId === selected.id && savedTask.id === task.id) setTasks((current) => current.map((value) => value.id === savedTask.id ? savedTask : value));
      pendingHandoffKeys.current.delete(execution.id);
      setTaskHandoffContentItemIds((current) => ({ ...current, [execution.id]: handoff.contentItemId }));
      setNotice("Content Inbox item created for source checking and editorial review. It is not approved, scheduled, or published.");
      onOpenContent?.(handoff.contentItemId);
      return true;
    } catch {
      setError(safeRequestMessage("Could not create the Content Inbox handoff. No approval or publishing action was taken."));
      return false;
    } finally { setBusy(""); }
  }

  async function commentTask(task: BoardTaskView, body: string) {
    if (!selected || !canManageTasks || task.boardId !== selected.id || selected.status === "archived") return false;
    setBusy("task:comment"); setError(""); setNotice("");
    const pending = pendingCommentKeys.current.get(task.id);
    const request = pending?.body === body && pending.version === task.version ? pending : { body, version: task.version, key: crypto.randomUUID() };
    pendingCommentKeys.current.set(task.id, request);
    try {
      const response = await apiFetch("/v1/boards/" + encodeURIComponent(selected.id) + "/tasks/" + encodeURIComponent(task.id) + "/comments", {
        method: "POST",
        headers: { "content-type": "application/json", "if-match": String(task.version), "idempotency-key": request.key },
        body: JSON.stringify({ workspaceId, brandId, body }),
      }, auth.csrfToken);
      if (!response.ok) {
        if (response.status === 409) await loadDetail(selected.id);
        throw new Error();
      }
      const commentsResponse = await apiFetch("/v1/boards/" + encodeURIComponent(selected.id) + "/tasks/" + encodeURIComponent(task.id) + "/comments?workspaceId=" + encodeURIComponent(workspaceId) + "&brandId=" + encodeURIComponent(brandId) + "&limit=100", { cache: "no-store" }, auth.csrfToken);
      if (commentsResponse.ok) setTaskComments(parseBoardTaskComments(await commentsResponse.json().catch(() => ({}))));
      setNotice("Comment added to the Board task.");
      pendingCommentKeys.current.delete(task.id);
      return true;
    } catch {
      setError(safeRequestMessage("Could not add this task comment."));
      return false;
    } finally { setBusy(""); }
  }

  async function submitBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isOwner) return;
    const data = new FormData(event.currentTarget);
    const body = { workspaceId, brandId, name: String(data.get("name") ?? "").trim(), purpose: String(data.get("purpose") ?? "").trim() };
    const editing = formMode === "edit" ? selected : undefined;
    setBusy(editing ? "edit" : "create"); setError(""); setNotice("");
    try {
      const response = await apiFetch(editing ? `/v1/boards/${encodeURIComponent(editing.id)}` : "/v1/boards", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json", ...(editing ? { "if-match": String(editing.version) } : {}) },
        body: JSON.stringify(body),
      }, auth.csrfToken);
      if (!response.ok) throw new Error();
      const responseBody = await response.json().catch(() => ({}));
      const saved = parseBoard((responseBody as { board?: unknown }).board ?? responseBody);
      setFormMode(null);
      setNotice(editing ? "Board details updated." : "Board created. Tasks are ready now; optional Hermes work unlocks after its state boundary is verified.");
      await load();
      if (saved) setSelectedId(saved.id);
    } catch {
      setError(safeRequestMessage(editing ? "Could not update this board." : "Could not create this board."));
    } finally { setBusy(""); }
  }

  async function runBoard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !canRun || !runPrompt.trim()) return;
    setBusy("run"); setError(""); setNotice(""); setRunResult(null);
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId, prompt: runPrompt.trim() }) }, auth.csrfToken);
      if (!response.ok) throw new Error();
      const body = await response.json().catch(() => ({})) as Partial<BoardRunResult>;
      if (typeof body.runId !== "string" || typeof body.model !== "string" || typeof body.text !== "string") throw new Error();
      setRunResult({ runId: body.runId, model: body.model.slice(0, 200), text: body.text.slice(0, 100_000), ...(body.usage && typeof body.usage === "object" ? { usage: body.usage } : {}) });
      setNotice("Board run completed. Its response is visible only in this browser session until you send it to the Content Inbox.");
      const runsResponse = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}/runs?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&limit=20`, { cache: "no-store" }, auth.csrfToken);
      if (runsResponse.ok) setRuns(parseBoardRuns(await runsResponse.json().catch(() => ({}))));
    } catch { setError(safeRequestMessage("The Board action could not be completed. No other profile or provider was used.")); }
    finally { setBusy(""); }
  }

  async function handoffRun() {
    if (!selected || !runResult || !canRun) return;
    setBusy("handoff"); setError(""); setNotice("");
    try {
      const response = await apiFetch("/v1/content-items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId, title: `${selected.name} — Board output`.slice(0, 180), summary: runResult.text.slice(0, 2000), researchDepth: "standard", riskLevel: "low" }) }, auth.csrfToken);
      if (!response.ok) throw new Error();
      setNotice("Board output was copied into a new Content Inbox item for source checking and human review.");
    } catch { setError(safeRequestMessage("Could not send this Board result to the Content Inbox.")); }
    finally { setBusy(""); }
  }

  async function testPlugin() {
    if (!selected || !isOwner) return;
    setBusy("test"); setError(""); setNotice("");
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId }) }, auth.csrfToken);
      if (!response.ok) throw new Error();
      setNotice("Hermes connection checked for this board.");
      await Promise.all([load(), loadDetail(selected.id)]);
    } catch { setError(safeRequestMessage("Could not verify this board’s Hermes connection.")); }
    finally { setBusy(""); }
  }

  async function reconcilePlugin() {
    if (!selected || !isOwner) return;
    setBusy("reconcile"); setError(""); setNotice("");
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}/plugins/hermes/reconcile`, { method: "POST", headers: { "content-type": "application/json", "if-match": String(selected.version) }, body: JSON.stringify({ workspaceId, brandId }) }, auth.csrfToken);
      if (!response.ok) throw new Error();
      const responseBody = await response.json().catch(() => ({}));
      const saved = parseBoard((responseBody as { board?: unknown }).board);
      if (saved) setBoards((current) => current.map((board) => board.id === saved.id ? saved : board));
      setNotice("Board setup queued. Hermes is applying the approved policy.");
      await loadDetail(selected.id);
    } catch { setError(safeRequestMessage("Could not retry this Board’s internal plugin setup.")); }
    finally { setBusy(""); }
  }

  async function toggleSkill(skill: BoardSkillView) {
    if (!selected || !isOwner) return;
    setBusy(`skill:${skill.id}`); setError(""); setNotice("");
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}/plugins/hermes/skills`, { method: "PUT", headers: { "content-type": "application/json", "if-match": String(selected.version) }, body: JSON.stringify({ workspaceId, brandId, name: skill.id, enabled: !skill.enabled }) }, auth.csrfToken);
      if (!response.ok) throw new Error();
      const responseBody = await response.json().catch(() => ({}));
      const saved = parseBoard((responseBody as { board?: unknown }).board);
      if (saved) setBoards((current) => current.map((board) => board.id === saved.id ? saved : board));
      setNotice(`${skill.label} ${skill.enabled ? "removal" : "access"} approved; Hermes is applying the change.`);
      await loadDetail(selected.id);
    } catch { setError(safeRequestMessage("Could not change this board’s skill setting.")); }
    finally { setBusy(""); }
  }

  async function reviewPendingWrite(write: BoardPendingWriteView) {
    if (!selected || !isOwner) return;
    setBusy(`review:${write.id}`); setError(""); setNotice("");
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}/plugins/hermes/pending/${write.subsystem}/${write.id}?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) throw new Error();
      const body = await response.json() as { pendingWrite?: unknown };
      const value = body.pendingWrite as Partial<BoardPendingWriteDetailView> | undefined;
      if (!value || value.id !== write.id || value.subsystem !== write.subsystem || value.sha256 !== write.sha256 || typeof value.detail !== "string" || typeof value.detailTruncated !== "boolean") throw new Error();
      setPendingDetail(value as BoardPendingWriteDetailView);
    } catch { setError(safeRequestMessage("Could not safely load this pending proposal.")); }
    finally { setBusy(""); }
  }

  async function decidePendingWrite(decision: "approve" | "reject") {
    if (!selected || !isOwner || !pendingDetail) return;
    setBusy(`pending:${pendingDetail.id}`); setError(""); setNotice("");
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}/plugins/hermes/pending/${pendingDetail.subsystem}/${pendingDetail.id}/decision`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID().replaceAll("-", "_") }, body: JSON.stringify({ workspaceId, brandId, decision, expectedSha256: pendingDetail.sha256 }) }, auth.csrfToken);
      if (!response.ok) throw new Error();
      setNotice(pendingDetail.subsystem === "skills" && decision === "approve" ? "Skill decision queued. OriginPost will apply it and create a fresh capability seal before this Board can run again." : `Pending ${pendingDetail.subsystem === "memory" ? "memory" : "skill"} decision queued for Hermes.`);
      setPendingDetail(null);
      await loadDetail(selected.id);
    } catch { setError(safeRequestMessage("Could not safely apply this pending-write decision.")); }
    finally { setBusy(""); }
  }

  async function archiveBoard() {
    if (!selected || !isOwner || !window.confirm(`Archive ${selected.name}? Its dedicated profile state and setup will be retained.`)) return;
    setBusy("archive"); setError(""); setNotice("");
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}`, { method: "PATCH", headers: { "content-type": "application/json", "if-match": String(selected.version) }, body: JSON.stringify({ workspaceId, brandId, status: "archived" }) }, auth.csrfToken);
      if (!response.ok) throw new Error();
      setNotice("Board archived. Its profile-scoped memory was retained and Hermes runtime access was queued for deactivation.");
      await load();
    } catch { setError(safeRequestMessage("Could not archive this board.")); }
    finally { setBusy(""); }
  }

  return <main className={styles.module} aria-labelledby="boards-title">
    <header className={styles.hero}>
      <div><p>BOARD WORKSPACES</p><h1 id="boards-title">Boards</h1><span>Keep each project’s tasks, people, and agent work together.</span></div>
      <div>{isOwner ? <button className={styles.primary} onClick={() => setFormMode("create")}><Plus size={15} />New board</button> : <em>Owner setup only</em>}<button onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? styles.spin : ""} size={15} />Refresh</button></div>
    </header>
    {error ? <div className={styles.error} role="alert"><TriangleAlert size={15} />{error}</div> : null}
    {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={15} />{notice}</div> : null}
    {formMode && isOwner ? <form className={styles.form} onSubmit={submitBoard}>
      <header><div><small>{formMode === "edit" ? "EDIT BOARD" : "NEW BOARD"}</small><strong>{formMode === "edit" ? "Update the board’s public details" : "Start a focused workspace"}</strong></div><button type="button" onClick={() => setFormMode(null)} aria-label="Close board form"><X size={16} /></button></header>
      <label>Board name<input name="name" required minLength={2} maxLength={100} defaultValue={formMode === "edit" ? selected?.name : ""} placeholder="Mumbai events" /></label>
      <label>Board purpose<textarea name="purpose" rows={3} maxLength={600} defaultValue={formMode === "edit" ? selected?.purpose : ""} placeholder="Plan verified Mumbai event coverage." /><small>This focus guides the team. Optional Hermes memory and skills are managed later inside this Board.</small></label>
      <footer><p><ShieldCheck size={14} />Board tasks work independently; optional Hermes setup stays internal.</p><button className={styles.primary} disabled={Boolean(busy)}>{busy ? <Loader2 className={styles.spin} size={14} /> : <Check size={14} />}{formMode === "edit" ? "Save changes" : "Create board"}</button></footer>
    </form> : null}
    <div className={styles.layout}>
      <aside className={styles.boardList} aria-label="Boards">
        <header><div><h2>Your boards</h2><p>{boards.filter((board) => board.status !== "archived").length} active for this brand</p></div><Columns3 size={19} /></header>
        {boards.map((board) => <button key={board.id} className={selected?.id === board.id ? styles.selectedBoard : ""} onClick={() => { setSelectedId(board.id); setPanel("tasks"); }} aria-current={selected?.id === board.id ? "true" : undefined}><span><Columns3 size={17} /></span><div><strong>{board.name}</strong><small>{board.status === "archived" ? "Archived" : "Active"}</small></div><ChevronRight size={15} /></button>)}
        {!loading && boards.length === 0 ? <div className={styles.emptyList}><Columns3 size={24} /><strong>No boards yet</strong><p>Create a board for a campaign, beat, or ongoing project.</p></div> : null}
        {loading ? <div className={styles.loading}><Loader2 className={styles.spin} size={18} />Loading boards…</div> : null}
      </aside>
      <div className={styles.detailShell}>{detailLoading && selected ? <div className={styles.detailLoading}><Loader2 className={styles.spin} size={18} />Opening board…</div> : selected ? <BoardDetailPanel board={selected} plugin={plugin} pluginUnavailable={pluginUnavailable} panel={panel} isOwner={isOwner} canRun={canRun} canManageTasks={canManageTasks} canApproveTasks={canApproveTasks} busy={busy} pendingDetail={pendingDetail} runPrompt={runPrompt} runResult={runResult} runs={runs} tasks={tasks} taskComments={taskComments} taskExecutions={taskExecutions} taskHandoffContentItemIds={taskHandoffContentItemIds} selectedTaskId={selectedTaskId} includeArchivedTasks={includeArchivedTasks} onPanelChange={setPanel} onRunPromptChange={setRunPrompt} onRun={(event) => void runBoard(event)} onHandoff={() => void handoffRun()} onSelectTask={setSelectedTaskId} onIncludeArchivedTasks={setIncludeArchivedTasks} onCreateTask={createTask} onUpdateTask={updateTask} onCommentTask={commentTask} onReleaseTask={releaseTask} onHandoffTask={handoffTask} onOpenContent={(contentItemId) => onOpenContent?.(contentItemId)} onTest={() => void testPlugin()} onReconcile={() => void reconcilePlugin()} onToggleSkill={(skill) => void toggleSkill(skill)} onReviewPending={(write) => void reviewPendingWrite(write)} onPendingDecision={(decision) => void decidePendingWrite(decision)} onEdit={() => setFormMode("edit")} onArchive={() => void archiveBoard()} /> : <div className={styles.emptyDetail}><Columns3 size={28} /><strong>Select or create a board</strong><p>Use Boards for focused tasks. Optional Hermes memory and skills appear only inside the selected Board.</p></div>}</div>
    </div>
  </main>;
}
