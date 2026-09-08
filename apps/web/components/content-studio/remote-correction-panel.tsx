"use client";

import { AlertTriangle, Check, ChevronDown, CircleCheck, ExternalLink, FileCheck2, History, LoaderCircle, RefreshCw, RotateCcw, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import styles from "./remote-correction-panel.module.css";
import {
  attestationTimeError,
  capabilityCopy,
  correctionApprovalMode,
  correctionControlState,
  correctionActions,
  correctionPermission,
  correctionStatusView,
  evidenceGradeView,
  isEligiblePublishProof,
  localDateTimeInputValue,
  manualGuidance,
  operationNeedsPoll,
  parseCapabilityResponse,
  parseCorrectionListResponse,
  shortHash,
  type CorrectionAction,
  type CorrectionCapabilities,
  type CorrectionOperation,
  type CorrectionRecord,
  type PublishProofSummary,
  type WorkspaceRole,
} from "./remote-correction-utils";

type Props = {
  auth: AuthView;
  workspaceId: string;
  contentItemId: string;
  publishProofs: PublishProofSummary[];
};

function query(workspaceId: string, publishProofId?: string) {
  const params = new URLSearchParams({ workspaceId });
  if (publishProofId) params.set("publishProofId", publishProofId);
  return params.toString();
}

async function responseMessage(response: Response, fallback: string) {
  const body = await response.json().catch(() => undefined) as { message?: string | string[] } | undefined;
  if (Array.isArray(body?.message)) return body.message.join(" ");
  return typeof body?.message === "string" && !body.message.startsWith("Cannot ") ? body.message : fallback;
}

function actionLabel(action: CorrectionAction) {
  return correctionActions.find((candidate) => candidate.value === action)?.label ?? action.replaceAll("_", " ");
}

function platformLabel(platform: string) {
  if (platform === "facebook") return "Facebook Page";
  if (platform === "youtube") return "YouTube";
  return "Instagram";
}

function formatDate(value: string | undefined) {
  if (!value || Number.isNaN(Date.parse(value))) return "Time not reported";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function RemoteCorrectionPanel({ auth, workspaceId, contentItemId, publishProofs }: Props) {
  const eligibleProofs = useMemo(() => publishProofs.filter(isEligiblePublishProof), [publishProofs]);
  const [selectedProofId, setSelectedProofId] = useState(eligibleProofs.at(-1)?.id ?? "");
  const [capabilities, setCapabilities] = useState<CorrectionCapabilities | null>(null);
  const [records, setRecords] = useState<CorrectionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<CorrectionAction>("delete_remote");
  const [visibility, setVisibility] = useState<"public" | "unlisted">("public");
  const [reason, setReason] = useState("");
  const [requestConfirmed, setRequestConfirmed] = useState(false);
  const [approvalOperation, setApprovalOperation] = useState<CorrectionOperation | null>(null);
  const [approvalConfirmed, setApprovalConfirmed] = useState(false);
  const [soleOwnerOverride, setSoleOwnerOverride] = useState(false);
  const [soleOwnerConfirmed, setSoleOwnerConfirmed] = useState(false);
  const pollCount = useRef(0);

  const membership = auth.memberships.find((entry) => entry.workspaceId === workspaceId);
  const role = membership?.role as WorkspaceRole | undefined;
  const permission = correctionPermission(role);
  const selectedProof = eligibleProofs.find((proof) => proof.id === selectedProofId);
  const selectedCapability = capabilities?.actions[action];
  const canUseAction = action === "manual_remove"
    ? selectedCapability?.state === "manual_only" || selectedCapability?.state === "supported"
    : selectedCapability?.state === "supported";

  const load = useCallback(async (showLoading = true) => {
    if (!selectedProofId) { setCapabilities(null); setRecords([]); return; }
    if (showLoading) setLoading(true);
    setError("");
    try {
      const [capabilityResponse, listResponse] = await Promise.all([
        apiFetch(`/v1/content-items/${encodeURIComponent(contentItemId)}/remote-corrections/capabilities?${query(workspaceId, selectedProofId)}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/content-items/${encodeURIComponent(contentItemId)}/remote-corrections?${query(workspaceId, selectedProofId)}`, { cache: "no-store" }, auth.csrfToken),
      ]);
      if (!capabilityResponse.ok) throw new Error(await responseMessage(capabilityResponse, "Could not check correction support."));
      if (!listResponse.ok) throw new Error(await responseMessage(listResponse, "Could not load correction history."));
      const nextCapabilities = parseCapabilityResponse(await capabilityResponse.json());
      if (!nextCapabilities) throw new Error("The correction capability response was incomplete.");
      setCapabilities(nextCapabilities);
      setRecords(parseCorrectionListResponse(await listResponse.json()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load remote corrections.");
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [auth.csrfToken, contentItemId, selectedProofId, workspaceId]);

  useEffect(() => {
    if (selectedProofId && !eligibleProofs.some((proof) => proof.id === selectedProofId)) setSelectedProofId(eligibleProofs.at(-1)?.id ?? "");
  }, [eligibleProofs, selectedProofId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!records.some((record) => operationNeedsPoll(record.operation.status))) { pollCount.current = 0; return; }
    if (pollCount.current >= 15) return;
    const timer = window.setTimeout(() => { pollCount.current += 1; void load(false); }, 4_000);
    return () => window.clearTimeout(timer);
  }, [load, records]);

  async function mutate(path: string, body: Record<string, unknown>, fallback: string) {
    const response = await apiFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, auth.csrfToken);
    if (!response.ok) throw new Error(await responseMessage(response, fallback));
    return response.json().catch(() => undefined);
  }

  async function createRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!permission.canRequest || !selectedProofId || !reason.trim() || !requestConfirmed || !canUseAction) return;
    setBusy("create"); setError(""); setMessage("");
    try {
      await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/remote-corrections`, { workspaceId, publishProofId: selectedProofId, action, reason: reason.trim(), ...(action === "restore_visibility" ? { visibility } : {}) }, "Could not create the correction request.");
      setReason(""); setRequestConfirmed(false);
      setMessage("Correction request saved. Nothing changes on the platform until a separate approval is recorded.");
      await load(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create the correction request."); }
    finally { setBusy(""); }
  }

  async function approve() {
    if (!approvalOperation || !permission.canApprove || !approvalConfirmed) return;
    const selfApproval = approvalOperation.requestedBy === auth.user.id;
    if (selfApproval && (!soleOwnerOverride || !soleOwnerConfirmed)) return;
    setBusy(`approve:${approvalOperation.id}`); setError(""); setMessage("");
    try {
      await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/remote-corrections/${encodeURIComponent(approvalOperation.id)}/approve`, { workspaceId, ...(selfApproval ? { singleOwnerOverride: true, secondConfirmation: true } : {}) }, "Could not approve this correction.");
      setApprovalOperation(null); setApprovalConfirmed(false); setSoleOwnerOverride(false); setSoleOwnerConfirmed(false);
      setMessage(selfApproval ? "Sole-owner override recorded. The approved correction is now processing." : "Correction approved and queued safely.");
      pollCount.current = 0;
      await load(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not approve this correction."); }
    finally { setBusy(""); }
  }

  async function reconcile(operation: CorrectionOperation) {
    setBusy(`reconcile:${operation.id}`); setError(""); setMessage("");
    try {
      await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/remote-corrections/${encodeURIComponent(operation.id)}/reconcile`, { workspaceId }, "Could not request reconciliation.");
      setMessage("Provider read-back queued. OriginPost will not repeat the original write.");
      pollCount.current = 0;
      await load(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not request reconciliation."); }
    finally { setBusy(""); }
  }

  async function attest(event: FormEvent<HTMLFormElement>, operation: CorrectionOperation) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const occurredAtValue = String(form.get("occurredAt") ?? "");
    const evidenceUrl = String(form.get("evidenceUrl") ?? "").trim();
    const note = String(form.get("note") ?? "").trim();
    if (!occurredAtValue || !evidenceUrl || !note) return;
    const occurredDate = new Date(occurredAtValue);
    const occurredAt = Number.isFinite(occurredDate.getTime()) ? occurredDate.toISOString() : occurredAtValue;
    const timeError = attestationTimeError(occurredAt, operation.approval?.approvedAt);
    if (timeError) { setError(timeError); return; }
    setBusy(`attest:${operation.id}`); setError(""); setMessage("");
    try {
      await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/remote-corrections/${encodeURIComponent(operation.id)}/manual-attestation`, { workspaceId, occurredAt, evidenceUrl, note }, "Could not save manual evidence.");
      setMessage("Operator evidence saved. It is labeled as human-attested, not provider-confirmed.");
      await load(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save manual evidence."); }
    finally { setBusy(""); }
  }

  const openApproval = (operation: CorrectionOperation) => {
    setApprovalOperation(operation); setApprovalConfirmed(false); setSoleOwnerOverride(false); setSoleOwnerConfirmed(false); setError("");
  };

  return <section className={`studio-section ${styles.panel}`} aria-labelledby="remote-correction-title">
    <div className="studio-section-title">
      <span><ShieldCheck size={16} /></span>
      <div><h3 id="remote-correction-title">Published proof and corrections</h3><p>Review provider support, request a change, approve it separately, and keep an evidence chain.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} /> Refresh</button>
    </div>

    {!eligibleProofs.length ? <div className={styles.empty}><FileCheck2 size={22} /><strong>No publish proof yet</strong><p>Remote correction becomes available after a real platform post and its proof are saved.</p></div> : <>
      <label className="studio-label">Published item<div className="studio-select"><select value={selectedProofId} onChange={(event) => { setSelectedProofId(event.target.value); pollCount.current = 0; }}>{eligibleProofs.map((proof) => <option key={proof.id} value={proof.id}>{platformLabel(proof.platform)} · {proof.externalPostId ?? proof.id}</option>)}</select><ChevronDown size={15} /></div></label>
      {selectedProof ? <div className={styles.lineage}><div><small>Platform</small><strong>{platformLabel(selectedProof.platform)}</strong></div><div><small>Publish proof</small><strong title={selectedProof.id}>{shortHash(selectedProof.id)}</strong></div><div><small>Post ID</small><strong title={selectedProof.externalPostId}>{selectedProof.externalPostId ?? "Saved in proof"}</strong></div><a href={selectedProof.liveUrl} target="_blank" rel="noreferrer">Open post <ExternalLink size={13} /></a></div> : null}

      {loading ? <div className={styles.state}><LoaderCircle className={styles.spin} size={22} /><strong>Checking the provider</strong><p>Loading capability and evidence history.</p></div> : error ? <div className={`${styles.banner} ${styles.danger}`} role="alert"><AlertTriangle size={17} /><div><strong>Remote correction needs attention</strong><p>{error}</p></div></div> : null}
      {message ? <div className={`${styles.banner} ${styles.success}`} role="status"><CircleCheck size={17} /><div><strong>Saved</strong><p>{message}</p></div></div> : null}

      {capabilities ? <div className={styles.capabilityBlock}>
        <header><div><strong>{platformLabel(capabilities.platform)} capabilities</strong><small>{capabilities.providerVersion ?? "Provider contract"} · checked {formatDate(capabilities.resolvedAt)}</small></div></header>
        <div className={styles.capabilityGrid}>{correctionActions.map((candidate) => {
          const value = capabilities.actions[candidate.value]; const view = capabilityCopy(value?.state);
          return <button type="button" key={candidate.value} className={`${styles.capability} ${styles[view.tone]} ${action === candidate.value ? styles.selected : ""}`} onClick={() => setAction(candidate.value)}>
            <span>{candidate.value === "delete_remote" ? <Trash2 size={15} /> : candidate.value === "restore_visibility" ? <RotateCcw size={15} /> : <ShieldAlert size={15} />}</span><div><strong>{candidate.label}</strong><small>{view.label}</small><p>{value?.reason ?? candidate.detail}</p></div>
          </button>;
        })}</div>
      </div> : null}

      {capabilities && permission.canRequest ? <form className={styles.requestForm} onSubmit={createRequest}>
        <div className={styles.formHead}><div><strong>Request {actionLabel(action)}</strong><p>This creates a pending request only. It cannot change the provider yet.</p></div></div>
        {!canUseAction ? <div className={`${styles.banner} ${styles.warning}`}><AlertTriangle size={16} /><div><strong>{capabilityCopy(selectedCapability?.state).label}</strong><p>{selectedCapability?.reason ?? "This provider action is not available. Choose Manual handoff when appropriate."}</p></div></div> : null}
        {action === "manual_remove" && capabilities ? <div className={styles.manualGuide}><ExternalLink size={16} /><p><strong>Manual path</strong><span>{manualGuidance(capabilities.platform)}</span></p></div> : null}
        {action === "restore_visibility" ? <label className="studio-label">Restore as<select value={visibility} onChange={(event) => setVisibility(event.target.value as "public" | "unlisted")}><option value="public">Public</option><option value="unlisted">Unlisted</option></select></label> : null}
        <label className="studio-label">Reason <span>{reason.length}/2,000</span><textarea rows={3} value={reason} minLength={3} maxLength={2000} required placeholder="Explain what is wrong and why this exact published item must change." onChange={(event) => setReason(event.target.value)} /></label>
        <label className={styles.confirm}><input type="checkbox" checked={requestConfirmed} onChange={(event) => setRequestConfirmed(event.target.checked)} /><span><strong>I checked the exact post and publish proof.</strong><small>I understand this request still needs a separate human approval.</small></span></label>
        <button className="new-button" disabled={!canUseAction || !reason.trim() || !requestConfirmed || Boolean(busy)}>{busy === "create" ? <LoaderCircle className={styles.spin} size={15} /> : <ShieldAlert size={15} />} Create pending request</button>
      </form> : capabilities ? <p className="studio-permission-note">Only a workspace manager or owner can request or approve remote changes.</p> : null}

      <div className={styles.history}>
        <div className={styles.historyHead}><History size={16} /><div><strong>Operation and proof history</strong><small>{records.length} operation{records.length === 1 ? "" : "s"} for this publish proof</small></div></div>
        {!loading && records.length === 0 ? <div className={styles.empty}><History size={20} /><strong>No correction requests</strong><p>This published item has no remote-correction history.</p></div> : records.map((record) => {
          const operation = record.operation; const view = correctionStatusView(operation.status); const selfApproval = operation.requestedBy === auth.user.id; const controls = correctionControlState(operation.status, correctionApprovalMode(role, auth.user.id, operation.requestedBy));
          return <article className={`${styles.operation} ${styles[view.tone]}`} key={operation.id}>
            <header><div><span>{actionLabel(operation.mutation.action)}</span><strong>{view.label}</strong></div><time>{formatDate(operation.updatedAt)}</time></header>
            <p>{view.detail}</p>{operation.statusReason ? <blockquote>{operation.statusReason}</blockquote> : null}
            <dl><div><dt>Reason</dt><dd>{operation.reason}</dd></div><div><dt>Intent hash</dt><dd title={operation.immutableIntentSha256}>{shortHash(operation.immutableIntentSha256)}</dd></div><div><dt>Attempts</dt><dd>{record.attempts.length}</dd></div><div><dt>Proofs</dt><dd>{record.proofs.length}</dd></div></dl>
            {record.attempts.length ? <details><summary>Attempt ledger</summary><div className={styles.attempts}>{record.attempts.map((attempt) => <div key={attempt.id}><span><strong>{attempt.kind === "reconcile" ? "Provider read-back" : "Provider write"}</strong><small>{attempt.status} · {formatDate(attempt.completedAt ?? attempt.startedAt)}</small></span><code title={attempt.responseSha256 ?? attempt.requestSha256}>{shortHash(attempt.responseSha256 ?? attempt.requestSha256)}</code>{attempt.errorSummary ? <p>{attempt.errorSummary}</p> : null}</div>)}</div></details> : null}
            {record.proofs.length ? <div className={styles.proofs}>{record.proofs.map((proof) => { const grade = evidenceGradeView(proof.evidenceGrade); return <div className={styles[grade.tone]} key={proof.id}><ShieldCheck size={16} /><span><strong>{grade.label}</strong><small>{grade.detail}</small></span><dl><div><dt>Proof hash</dt><dd title={proof.canonicalSha256}>{shortHash(proof.canonicalSha256)}</dd></div><div><dt>Previous proof</dt><dd title={proof.previousProofSha256}>{shortHash(proof.previousProofSha256)}</dd></div></dl></div>; })}</div> : null}
            {controls.approve ? <button type="button" className={styles.approveButton} onClick={() => openApproval(operation)}><Check size={14} /> Review approval</button> : null}
            {permission.canApprove && controls.reconcile ? <button type="button" className={styles.reconcileButton} disabled={Boolean(busy)} onClick={() => void reconcile(operation)}><RefreshCw className={busy === `reconcile:${operation.id}` ? styles.spin : ""} size={14} /> Reconcile with provider</button> : null}
            {permission.canApprove && controls.attest ? <form className={styles.attestation} onSubmit={(event) => void attest(event, operation)}><div className={styles.manualGuide}><ExternalLink size={15} /><p><strong>Complete it outside OriginPost</strong><span>{manualGuidance(operation.platform)}</span></p></div><label>Action time<input name="occurredAt" type="datetime-local" min={operation.approval?.approvedAt && Number.isFinite(Date.parse(operation.approval.approvedAt)) ? localDateTimeInputValue(new Date(operation.approval.approvedAt)) : undefined} max={localDateTimeInputValue()} required /></label><label>HTTPS evidence link<input name="evidenceUrl" type="url" pattern="https://.*" placeholder="https://…" required /></label><label>What you checked<textarea name="note" rows={2} minLength={3} maxLength={2000} required /></label><label className={styles.confirm}><input type="checkbox" required /><span><strong>This is operator evidence.</strong><small>It must not be treated as provider confirmation.</small></span></label><button className={styles.attestButton} disabled={Boolean(busy)}><FileCheck2 size={14} />{busy === `attest:${operation.id}` ? " Saving…" : " Save operator attestation"}</button></form> : null}
            {selfApproval && operation.status === "pending_approval" ? <small className={styles.overrideHint}>{role === "owner" ? "You requested this. Self-approval works only when you are the sole workspace owner and record the explicit override below." : "You requested this. Another workspace manager or owner must approve it."}</small> : null}
          </article>;
        })}
      </div>
    </>}

    {approvalOperation ? <div className={styles.modalLayer} role="dialog" aria-modal="true" aria-labelledby="correction-approval-title"><button type="button" className={styles.scrim} aria-label="Close approval dialog" onClick={() => setApprovalOperation(null)} /><div className={styles.modal}><div><p className="eyebrow">SEPARATE HUMAN APPROVAL</p><h3 id="correction-approval-title">Approve {actionLabel(approvalOperation.mutation.action)}?</h3><p>This approval binds the exact publish proof, request, provider snapshot, and immutable intent hash. The provider write happens only after approval.</p></div><dl><div><dt>Platform object</dt><dd>{platformLabel(approvalOperation.platform)} · {approvalOperation.externalPostId}</dd></div><div><dt>Reason</dt><dd>{approvalOperation.reason}</dd></div><div><dt>Intent hash</dt><dd>{shortHash(approvalOperation.immutableIntentSha256)}</dd></div></dl><label className={styles.confirm}><input type="checkbox" checked={approvalConfirmed} onChange={(event) => setApprovalConfirmed(event.target.checked)} /><span><strong>I reviewed this exact request and proof.</strong><small>I approve this provider action and understand it may be permanent.</small></span></label>{correctionApprovalMode(role, auth.user.id, approvalOperation.requestedBy) === "single_owner_override" ? <div className={styles.override}><strong>Sole-owner override</strong><p>OriginPost normally requires another manager or owner. Use this only if you are the workspace’s only owner.</p><label className={styles.confirm}><input type="checkbox" checked={soleOwnerOverride} onChange={(event) => setSoleOwnerOverride(event.target.checked)} /><span><strong>I am the sole workspace owner.</strong><small>The server will verify workspace membership.</small></span></label><label className={styles.confirm}><input type="checkbox" checked={soleOwnerConfirmed} onChange={(event) => setSoleOwnerConfirmed(event.target.checked)} /><span><strong>Second confirmation</strong><small>I explicitly approve my own request under the sole-owner exception.</small></span></label></div> : null}<div className={styles.modalActions}><button type="button" className="secondary-button" onClick={() => setApprovalOperation(null)}>Cancel</button><button type="button" className="new-button" disabled={!approvalConfirmed || (correctionApprovalMode(role, auth.user.id, approvalOperation.requestedBy) === "single_owner_override" && (!soleOwnerOverride || !soleOwnerConfirmed)) || Boolean(busy)} onClick={() => void approve()}>{busy.startsWith("approve:") ? <LoaderCircle className={styles.spin} size={14} /> : <Check size={14} />} Approve exact request</button></div></div></div> : null}
  </section>;
}
