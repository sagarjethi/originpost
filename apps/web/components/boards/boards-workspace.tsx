"use client";

import { Activity, Archive, Bot, Brain, Check, CheckCircle2, ChevronRight, Columns3, Loader2, LockKeyhole, Plus, RefreshCw, ShieldCheck, Sparkles, ToggleLeft, ToggleRight, TriangleAlert, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import { boardStatusLabel, formatBoardStamp, parseBoard, parseBoardHermes, parseBoards, type BoardHermesView, type BoardPendingWriteDetailView, type BoardPendingWriteView, type BoardSkillView, type BoardView } from "./board-utils";
import styles from "./boards-workspace.module.css";

type BoardPanel = "overview" | "memory" | "skills";

const emptyPlugin: BoardHermesView = { configured: false, healthy: false, modelReady: false, memoryEnabled: false, memoryWriteApproval: false, skillWriteApproval: false, pending: false, pendingManagementAvailable: false, pendingWrites: [], skills: [] };

function membershipRole(auth: AuthView, workspaceId: string) {
  return auth.memberships.find((membership) => membership.workspaceId === workspaceId)?.role ?? auth.memberships[0]?.role;
}

function safeRequestMessage(fallback: string) {
  // Provider responses can contain endpoints, profile names, and paths. Keep the browser copy deliberately generic.
  return fallback;
}

function pluginState(board: BoardView, plugin: BoardHermesView) {
  if (board.status === "provisioning") return { label: "Setting up", className: styles.pending };
  if (board.status === "attention") return { label: "Needs attention", className: styles.attention };
  if (plugin.configured && plugin.healthy && board.status === "ready") return { label: "Ready", className: styles.ready };
  return { label: "Setup required", className: styles.pending };
}

function skillState(skill: BoardSkillView) {
  if (skill.enabled && skill.applied) return "Allowed";
  if (skill.enabled) return "Approved · applying";
  if (skill.applied) return "Removal approved · applying";
  return "Not allowed";
}

function PendingWrites({ subsystem, plugin, detail, busy, isOwner, onReview, onDecision }: { subsystem: "memory" | "skills"; plugin: BoardHermesView; detail: BoardPendingWriteDetailView | null; busy: string; isOwner: boolean; onReview: (write: BoardPendingWriteView) => void; onDecision: (decision: "approve" | "reject") => void }) {
  const writes = plugin.pendingWrites.filter((write) => write.subsystem === subsystem);
  if (!plugin.pendingManagementAvailable) return <p className={styles.privacyNote}><LockKeyhole size={14} /> Pending-write review needs the hidden Hermes 0.21 OriginPost approvals extension. No proposal is auto-approved.</p>;
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

export function BoardDetailPanel({ board, plugin, panel, isOwner, busy, pendingDetail, onPanelChange, onTest, onReconcile, onToggleSkill, onReviewPending, onPendingDecision, onEdit, onArchive }: {
  board: BoardView;
  plugin: BoardHermesView;
  panel: BoardPanel;
  isOwner: boolean;
  busy: string;
  pendingDetail: BoardPendingWriteDetailView | null;
  onPanelChange: (panel: BoardPanel) => void;
  onTest: () => void;
  onReconcile: () => void;
  onToggleSkill: (skill: BoardSkillView) => void;
  onReviewPending: (write: BoardPendingWriteView) => void;
  onPendingDecision: (decision: "approve" | "reject") => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const state = pluginState(board, plugin);
  return <section className={styles.detail} aria-labelledby="board-detail-title">
    <header className={styles.detailHead}>
      <div><p>BOARD</p><h2 id="board-detail-title">{board.name}</h2><span>{board.purpose || "A private working context for this brand."}</span></div>
      <div className={styles.detailActions}>{isOwner && board.status !== "archived" ? <button onClick={onEdit}>Edit board</button> : null}<em className={state.className}>{state.label}</em></div>
    </header>

    <div className={styles.boundary}>
      <span><LockKeyhole size={19} /></span>
      <div><strong>Private board boundary</strong><p>Context, learning, and enabled skills stay isolated to this board. OriginPost never shows its internal profile, files, keys, or memory text here.</p></div>
    </div>

    <article className={styles.plugin}>
      <header className={styles.pluginHead}>
        <span className={styles.pluginIcon}><Bot size={21} /></span>
        <div><small>BUILT-IN INTERNAL PLUGIN</small><h3>Hermes</h3><p>Board intelligence, managed inside this board.</p></div>
        <div className={styles.pluginHealth}><em className={state.className}>{state.label}</em>{isOwner && board.status !== "archived" ? board.status === "attention" || board.status === "setup_required" ? <button onClick={onReconcile} disabled={Boolean(busy)}>{busy === "reconcile" ? <Loader2 className={styles.spin} size={13} /> : <RefreshCw size={13} />}Retry setup</button> : <button onClick={onTest} disabled={Boolean(busy)}>{busy === "test" ? <Loader2 className={styles.spin} size={13} /> : <Activity size={13} />}Check status</button> : null}</div>
      </header>

      {plugin.pending ? <div className={styles.applyingBanner}><Loader2 className={styles.spin} size={14} /><div><strong>Approved changes are applying</strong><p>This Board stays unavailable until Hermes matches the exact Board policy.</p></div></div> : null}

      <nav className={styles.pluginTabs} aria-label="Hermes board settings">
        {(["overview", "memory", "skills"] as const).map((value) => <button key={value} className={panel === value ? styles.activeTab : ""} onClick={() => onPanelChange(value)} aria-current={panel === value ? "page" : undefined}>{value === "overview" ? <Sparkles size={14} /> : value === "memory" ? <Brain size={14} /> : <ToggleRight size={14} />}{value[0]!.toUpperCase() + value.slice(1)}</button>)}
      </nav>

      {panel === "overview" ? <div className={styles.overview}>
        <div><span><Brain size={17} /></span><strong>Board-only memory</strong><p>Learning from this board is not shared with other boards.</p></div>
        <div><span><ToggleRight size={17} /></span><strong>Board-only skills</strong><p>Choose which installed capabilities this board may use.</p></div>
        <div><span><Activity size={17} /></span><strong>Execution model</strong><p>{plugin.modelReady ? "The Board profile has a configured primary model." : "Configure a primary model in this Board’s Hermes profile."}</p></div>
        <div><span><ShieldCheck size={17} /></span><strong>Approval protected</strong><p>Memory writes require approval. Skill access is approved by an owner here.</p></div>
      </div> : null}

      {panel === "memory" ? <div className={styles.memoryPanel}>
        <div className={styles.panelLead}><span><Brain size={20} /></span><div><strong>Memory controls</strong><p>Manage how this board can learn without exposing or mixing its private memory.</p></div></div>
        <dl>
          <div><dt>Isolation</dt><dd><CheckCircle2 size={14} /> This board only</dd></div>
          <div><dt>Learning</dt><dd>{plugin.memoryEnabled ? <><CheckCircle2 size={14} /> Enabled</> : <><TriangleAlert size={14} /> Not enabled</>}</dd></div>
          <div><dt>Write protection</dt><dd>{plugin.memoryWriteApproval ? <><ShieldCheck size={14} /> Approval required</> : <><TriangleAlert size={14} /> Review configuration</>}</dd></div>
        </dl>
        <PendingWrites subsystem="memory" plugin={plugin} detail={pendingDetail} busy={busy} isOwner={isOwner} onReview={onReviewPending} onDecision={onPendingDecision} />
        <p className={styles.privacyNote}><LockKeyhole size={14} /> Only pending proposals are shown to the Board owner for an exact approve/reject decision. Existing Board memory remains private and is never listed here.</p>
      </div> : null}

      {panel === "skills" ? <div className={styles.skillsPanel}>
        <div className={styles.panelLead}><span><ToggleRight size={20} /></span><div><strong>Allowed skills</strong><p>Only enabled skills can be used in this board. Skill instructions remain internal.</p></div></div>
        {plugin.skills.length ? <div className={styles.skillList}>{plugin.skills.map((skill) => <div key={skill.id} className={styles.skillRow}><span>{skill.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}</span><div><strong>{skill.label}</strong><small>{skillState(skill)}</small></div>{isOwner && board.status !== "archived" ? <button onClick={() => onToggleSkill(skill)} disabled={Boolean(busy)} aria-label={`${skill.enabled ? "Approve removal of" : "Allow"} ${skill.label}`}>{busy === `skill:${skill.id}` ? <Loader2 className={styles.spin} size={13} /> : skill.enabled ? "Approve removal" : "Allow on this Board"}</button> : <em>{skillState(skill)}</em>}</div>)}</div> : <div className={styles.emptyInner}><ToggleLeft size={22} /><strong>No skills available</strong><p>Finish Hermes setup, then refresh this board.</p></div>}
        <PendingWrites subsystem="skills" plugin={plugin} detail={pendingDetail} busy={busy} isOwner={isOwner} onReview={onReviewPending} onDecision={onPendingDecision} />
        <p className={styles.privacyNote}><ShieldCheck size={14} /> {plugin.skillWriteApproval ? "Skill writes inside Hermes require approval; Board access changes require an owner here." : "Skill approval protection needs attention."} Raw skill instructions are never displayed.</p>
      </div> : null}
    </article>

    <footer className={styles.detailFoot}><span>Last connection check: {formatBoardStamp(plugin.lastCheckedAt ?? board.lastCheckedAt)}</span>{isOwner && board.status !== "archived" ? <button className={styles.archiveButton} onClick={onArchive}><Archive size={13} />Archive board</button> : null}</footer>
  </section>;
}

export function BoardsWorkspace({ auth, workspaceId, brandId }: { auth: AuthView; workspaceId: string; brandId: string }) {
  const [boards, setBoards] = useState<BoardView[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [plugin, setPlugin] = useState<BoardHermesView>(emptyPlugin);
  const [panel, setPanel] = useState<BoardPanel>("overview");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingDetail, setPendingDetail] = useState<BoardPendingWriteDetailView | null>(null);
  const isOwner = membershipRole(auth, workspaceId) === "owner";
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
    setDetailLoading(true);
    setError("");
    try {
      const [boardResponse, pluginResponse] = await Promise.all([
        apiFetch(`/v1/boards/${encodeURIComponent(boardId)}?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/boards/${encodeURIComponent(boardId)}/plugins/hermes?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
      ]);
      if (!boardResponse.ok || !pluginResponse.ok) throw new Error();
      const boardBody = await boardResponse.json().catch(() => ({}));
      const parsedBoard = parseBoard((boardBody as { board?: unknown }).board ?? boardBody);
      if (parsedBoard) setBoards((current) => current.map((board) => board.id === parsedBoard.id ? parsedBoard : board));
      setPlugin(parseBoardHermes(await pluginResponse.json().catch(() => ({}))));
    } catch {
      setPlugin(emptyPlugin);
      setError(safeRequestMessage("Could not load this board’s internal plugin."));
    } finally {
      setDetailLoading(false);
    }
  }, [auth.csrfToken, brandId, workspaceId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (selectedId) void loadDetail(selectedId); else setPlugin(emptyPlugin); }, [loadDetail, selectedId]);
  useEffect(() => { setFormMode(null); setPanel("overview"); setNotice(""); }, [brandId, workspaceId]);
  useEffect(() => { setPendingDetail(null); }, [selectedId, panel]);

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
      setNotice(editing ? "Board details updated." : "Board created with its own private Hermes context.");
      await load();
      if (saved) setSelectedId(saved.id);
    } catch {
      setError(safeRequestMessage(editing ? "Could not update this board." : "Could not create this board."));
    } finally { setBusy(""); }
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
      setNotice(`Pending ${pendingDetail.subsystem === "memory" ? "memory" : "skill"} write ${decision === "approve" ? "approved" : "rejected"}.`);
      setPendingDetail(null);
      await loadDetail(selected.id);
    } catch { setError(safeRequestMessage("Could not safely apply this pending-write decision.")); }
    finally { setBusy(""); }
  }

  async function archiveBoard() {
    if (!selected || !isOwner || !window.confirm(`Archive ${selected.name}? Its isolated context and setup will be retained.`)) return;
    setBusy("archive"); setError(""); setNotice("");
    try {
      const response = await apiFetch(`/v1/boards/${encodeURIComponent(selected.id)}`, { method: "PATCH", headers: { "content-type": "application/json", "if-match": String(selected.version) }, body: JSON.stringify({ workspaceId, brandId, status: "archived" }) }, auth.csrfToken);
      if (!response.ok) throw new Error();
      setNotice("Board archived. Its isolated memory was retained and Hermes runtime access was queued for deactivation.");
      await load();
    } catch { setError(safeRequestMessage("Could not archive this board.")); }
    finally { setBusy(""); }
  }

  return <main className={styles.module} aria-labelledby="boards-title">
    <header className={styles.hero}>
      <div><p>PRIVATE AGENT WORKSPACES</p><h1 id="boards-title">Boards</h1><span>Create focused workspaces with separate context, learning, and capabilities.</span></div>
      <div>{isOwner ? <button className={styles.primary} onClick={() => setFormMode("create")}><Plus size={15} />New board</button> : <em>Owner setup only</em>}<button onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? styles.spin : ""} size={15} />Refresh</button></div>
    </header>
    {error ? <div className={styles.error} role="alert"><TriangleAlert size={15} />{error}</div> : null}
    {notice ? <div className={styles.notice} role="status"><CheckCircle2 size={15} />{notice}</div> : null}
    {formMode && isOwner ? <form className={styles.form} onSubmit={submitBoard}>
      <header><div><small>{formMode === "edit" ? "EDIT BOARD" : "NEW BOARD"}</small><strong>{formMode === "edit" ? "Update the board’s public details" : "Start with a clean, isolated context"}</strong></div><button type="button" onClick={() => setFormMode(null)} aria-label="Close board form"><X size={16} /></button></header>
      <label>Board name<input name="name" required minLength={2} maxLength={100} defaultValue={formMode === "edit" ? selected?.name : ""} placeholder="Mumbai events" /></label>
      <label>Board purpose<textarea name="purpose" rows={3} maxLength={600} defaultValue={formMode === "edit" ? selected?.purpose : ""} placeholder="Plan verified Mumbai event coverage." /><small>Hermes uses this focus for future work in this Board. Changing it does not erase existing Board memory.</small></label>
      <footer><p><ShieldCheck size={14} />A dedicated internal Hermes context is created for this board.</p><button className={styles.primary} disabled={Boolean(busy)}>{busy ? <Loader2 className={styles.spin} size={14} /> : <Check size={14} />}{formMode === "edit" ? "Save changes" : "Create board"}</button></footer>
    </form> : null}
    <div className={styles.layout}>
      <aside className={styles.boardList} aria-label="Boards">
        <header><div><h2>Your boards</h2><p>{boards.filter((board) => board.status !== "archived").length} active for this brand</p></div><Columns3 size={19} /></header>
        {boards.map((board) => <button key={board.id} className={selected?.id === board.id ? styles.selectedBoard : ""} onClick={() => { setSelectedId(board.id); setPanel("overview"); }} aria-current={selected?.id === board.id ? "true" : undefined}><span><Bot size={17} /></span><div><strong>{board.name}</strong><small>{boardStatusLabel(board.status)}</small></div><ChevronRight size={15} /></button>)}
        {!loading && boards.length === 0 ? <div className={styles.emptyList}><Columns3 size={24} /><strong>No boards yet</strong><p>Create a board for a campaign, beat, or ongoing project.</p></div> : null}
        {loading ? <div className={styles.loading}><Loader2 className={styles.spin} size={18} />Loading boards…</div> : null}
      </aside>
      <div className={styles.detailShell}>{detailLoading && selected ? <div className={styles.detailLoading}><Loader2 className={styles.spin} size={18} />Opening board…</div> : selected ? <BoardDetailPanel board={selected} plugin={plugin} panel={panel} isOwner={isOwner} busy={busy} pendingDetail={pendingDetail} onPanelChange={setPanel} onTest={() => void testPlugin()} onReconcile={() => void reconcilePlugin()} onToggleSkill={(skill) => void toggleSkill(skill)} onReviewPending={(write) => void reviewPendingWrite(write)} onPendingDecision={(decision) => void decidePendingWrite(decision)} onEdit={() => setFormMode("edit")} onArchive={() => void archiveBoard()} /> : <div className={styles.emptyDetail}><Bot size={28} /><strong>Select or create a board</strong><p>Every board gets its own internal Hermes context. Memory and skills are managed only after you open a board.</p></div>}</div>
    </div>
  </main>;
}
