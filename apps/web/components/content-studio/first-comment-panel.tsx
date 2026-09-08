"use client";

import { AlertTriangle, CheckCircle2, Eye, MessageCircle, RefreshCw, Send, ShieldCheck, XCircle } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import styles from "./first-comment-panel.module.css";
import { firstCommentEvidenceLabel, firstCommentNeedsPoll, firstCommentPermission, firstCommentStatusCopy, parseFirstCommentRecords, type FirstCommentRecordView, type FirstCommentRole } from "./first-comment-utils";

type Target = { id: string; platform: string; draftId: string; status: string };
type Props = { auth: AuthView; workspaceId: string; contentItemId: string; targets: Target[] };
type Capability = { state: "supported" | "permission_missing" | "unsupported"; platform: "instagram" | "facebook"; providerVersion: string; maxCharacters: number; reason?: string };

function platformName(platform: string) { return platform === "facebook" ? "Facebook Page" : "Instagram"; }
function date(value: string) { return Number.isNaN(Date.parse(value)) ? "Time unavailable" : new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
function localDateTimeValue(value = new Date()) { const shifted = new Date(value.getTime() - value.getTimezoneOffset() * 60_000); return shifted.toISOString().slice(0, 16); }
function shortHash(value: string) { return value.length > 15 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value; }
async function responseMessage(response: Response, fallback: string) { const body = await response.json().catch(() => undefined) as { message?: string | string[] } | undefined; return Array.isArray(body?.message) ? body.message.join(" ") : typeof body?.message === "string" && !body.message.startsWith("Cannot ") ? body.message : fallback; }

export function FirstCommentPanel({ auth, workspaceId, contentItemId, targets }: Props) {
  const eligibleTargets = useMemo(() => targets.filter((target) => target.platform === "instagram" || target.platform === "facebook"), [targets]);
  const [targetId, setTargetId] = useState(eligibleTargets.at(-1)?.id ?? "");
  const [capability, setCapability] = useState<Capability | null>(null);
  const [records, setRecords] = useState<FirstCommentRecordView[]>([]);
  const [body, setBody] = useState("");
  const [draftBodies, setDraftBodies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selfApprovalId, setSelfApprovalId] = useState("");
  const [selfApprovalConfirmed, setSelfApprovalConfirmed] = useState(false);
  const [retryId, setRetryId] = useState("");
  const [attestId, setAttestId] = useState("");
  const [attestation, setAttestation] = useState({ occurredAt: "", evidenceUrl: "", note: "" });
  const pollCount = useRef(0);
  const role = auth.memberships.find((entry) => entry.workspaceId === workspaceId)?.role as FirstCommentRole | undefined;
  const permission = firstCommentPermission(role);
  const selectedTarget = eligibleTargets.find((target) => target.id === targetId);
  const targetRecords = records.filter((record) => record.intent.targetId === targetId);

  const load = useCallback(async (showLoading = true) => {
    if (!targetId) { setCapability(null); setRecords([]); return; }
    if (showLoading) setLoading(true);
    setError("");
    try {
      const base = `/v1/content-items/${encodeURIComponent(contentItemId)}/first-comments`;
      const [capabilityResponse, recordsResponse] = await Promise.all([
        apiFetch(`${base}/capability?workspaceId=${encodeURIComponent(workspaceId)}&targetId=${encodeURIComponent(targetId)}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`${base}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken),
      ]);
      if (!capabilityResponse.ok) throw new Error(await responseMessage(capabilityResponse, "Could not check first-comment support."));
      if (!recordsResponse.ok) throw new Error(await responseMessage(recordsResponse, "Could not load first comments."));
      const capabilityBody = await capabilityResponse.json() as { data?: { capability?: Capability } };
      if (!capabilityBody.data?.capability) throw new Error("The first-comment capability response was incomplete.");
      setCapability(capabilityBody.data.capability);
      const next = parseFirstCommentRecords(await recordsResponse.json());
      setRecords(next);
      setDraftBodies(Object.fromEntries(next.filter((record) => record.intent.status === "draft").map((record) => [record.intent.id, record.intent.body])));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load first comments."); }
    finally { if (showLoading) setLoading(false); }
  }, [auth.csrfToken, contentItemId, targetId, workspaceId]);

  useEffect(() => { if (targetId && !eligibleTargets.some((target) => target.id === targetId)) setTargetId(eligibleTargets.at(-1)?.id ?? ""); }, [eligibleTargets, targetId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!targetRecords.some((record) => firstCommentNeedsPoll(record.intent.status))) { pollCount.current = 0; return; }
    if (pollCount.current >= 20) return;
    const timer = window.setTimeout(() => { pollCount.current += 1; void load(false); }, 3_000);
    return () => window.clearTimeout(timer);
  }, [load, targetRecords]);

  async function mutate(path: string, payload: Record<string, unknown>, fallback: string, method: "POST" | "PATCH" = "POST") {
    const response = await apiFetch(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, ...payload }) }, auth.csrfToken);
    if (!response.ok) throw new Error(await responseMessage(response, fallback));
    return response.json().catch(() => undefined);
  }

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key); setError(""); setMessage("");
    try { await action(); await load(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The first-comment action failed."); }
    finally { setBusy(""); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!permission.canDraft || capability?.state !== "supported" || !targetId || !body.trim()) return;
    await run("create", async () => {
      await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/first-comments`, { targetId, body: body.trim() }, "Could not save the first-comment draft.");
      setBody(""); setMessage("First-comment draft saved. Submit it when the wording is final; a separate human approval is still required.");
    });
  }

  async function revise(record: FirstCommentRecordView) {
    const nextBody = draftBodies[record.intent.id]?.trim(); if (!nextBody) return;
    await run(`revise:${record.intent.id}`, async () => { await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/first-comments/${encodeURIComponent(record.intent.id)}`, { expectedVersion: record.intent.version, body: nextBody }, "Could not revise this first comment.", "PATCH"); setMessage("First-comment draft revised. The integrity hash was recomputed by the server."); });
  }

  async function command(record: FirstCommentRecordView, commandName: "submit" | "cancel", copy: string) {
    await run(`${commandName}:${record.intent.id}`, async () => { await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/first-comments/${encodeURIComponent(record.intent.id)}/${commandName}`, { expectedVersion: record.intent.version }, `Could not ${commandName} this first comment.`); setMessage(copy); });
  }

  async function approve(record: FirstCommentRecordView) {
    const self = record.intent.requestedBy === auth.user.id;
    await run(`approve:${record.intent.id}`, async () => { await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/first-comments/${encodeURIComponent(record.intent.id)}/approve`, { expectedVersion: record.intent.version, ...(self ? { singleOwnerOverride: true, secondConfirmation: true } : {}) }, "Could not approve this first comment."); setSelfApprovalId(""); setSelfApprovalConfirmed(false); setMessage("First comment approved. It will wait for the exact post proof before any provider call."); pollCount.current = 0; });
  }

  async function reconcile(record: FirstCommentRecordView, outcome: "inspect_provider" | "confirmed_not_sent") {
    await run(`${outcome}:${record.intent.id}`, async () => { await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/first-comments/${encodeURIComponent(record.intent.id)}/reconcile`, { expectedVersion: record.intent.version, outcome }, "Could not reconcile this first comment."); setRetryId(""); setMessage(outcome === "inspect_provider" ? "Read-only provider inspection queued. No comment will be created." : "Human no-send confirmation recorded. One new leased provider write is allowed."); pollCount.current = 0; });
  }

  async function attest(event: FormEvent<HTMLFormElement>, record: FirstCommentRecordView) {
    event.preventDefault();
    const occurred = new Date(attestation.occurredAt);
    if (Number.isNaN(occurred.getTime()) || occurred.getTime() > Date.now() + 60_000) { setError("Choose a valid observation time that is not in the future."); return; }
    await run(`attest:${record.intent.id}`, async () => { await mutate(`/v1/content-items/${encodeURIComponent(contentItemId)}/first-comments/${encodeURIComponent(record.intent.id)}/manual-attestation`, { expectedVersion: record.intent.version, ...attestation, occurredAt: occurred.toISOString() }, "Could not save operator evidence."); setAttestId(""); setAttestation({ occurredAt: "", evidenceUrl: "", note: "" }); setMessage("Operator evidence recorded distinctly from provider confirmation."); });
  }

  if (!eligibleTargets.length) return null;
  return <section className={`studio-card ${styles.panel}`} aria-labelledby="first-comment-title">
    <header className={styles.head}>
      <div><span><MessageCircle size={17} /></span><div><p className="eyebrow">POST-PUBLICATION</p><h3 id="first-comment-title">First comment</h3><p>Approve the exact text, wait for the exact post proof, then send once and verify it live.</p></div></div>
      <button className="studio-ghost" type="button" onClick={() => void load()} disabled={loading || Boolean(busy)}><RefreshCw size={12} className={loading ? styles.spin : ""} /> Refresh</button>
    </header>
    <div className={styles.targetRow}>
      <label><span>Post target</span><select value={targetId} onChange={(event) => setTargetId(event.target.value)}>{eligibleTargets.map((target) => <option key={target.id} value={target.id}>{platformName(target.platform)} · {target.status.replaceAll("_", " ")}</option>)}</select></label>
      <div className={`${styles.capability} ${capability?.state === "supported" ? styles.success : styles.warning}`}><ShieldCheck size={16} /><span><strong>{capability?.state === "supported" ? "Provider contract ready" : "Reconnect or review access"}</strong><small>{capability?.state === "supported" ? `${platformName(capability.platform)} · max ${capability.maxCharacters.toLocaleString()} characters` : capability?.reason ?? "Checking capability…"}</small></span></div>
    </div>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}{message ? <p className={styles.message} role="status">{message}</p> : null}
    {permission.canDraft && capability?.state === "supported" && targetRecords.length === 0 ? <form className={styles.create} onSubmit={create}><label><span>First-comment draft</span><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={2200} placeholder="Add the approved link, context, or CTA that belongs directly below the post." /></label><div><small>{body.length.toLocaleString()} / 2,200</small><button className="new-button" type="submit" disabled={!body.trim() || busy === "create"}><MessageCircle size={13} /> Save draft</button></div></form> : null}
    {loading ? <div className={styles.empty}>Loading governed first comments…</div> : targetRecords.length === 0 ? <div className={styles.empty}><MessageCircle size={20} /><strong>No first comment yet</strong><p>This is optional. The post can publish normally without one.</p></div> : <div className={styles.history}>{targetRecords.map((record) => {
      const view = firstCommentStatusCopy(record.intent.status, record.intent.executionMode); const self = record.intent.requestedBy === auth.user.id; const canCancel = permission.canDraft && ["draft", "pending_approval", "approved", "queued"].includes(record.intent.status);
      return <article key={record.intent.id} className={`${styles.record} ${styles[view.tone]}`}>
        <header><div><strong>{view.label}</strong><span>{platformName(record.intent.platform)} · {date(record.intent.updatedAt)}</span></div><code title={record.intent.bodySha256}>{shortHash(record.intent.bodySha256)}</code></header>
        <p className={styles.detail}>{view.detail}</p>
        {record.intent.status === "draft" ? <label className={styles.draft}><span>Draft wording</span><textarea value={draftBodies[record.intent.id] ?? record.intent.body} onChange={(event) => setDraftBodies((current) => ({ ...current, [record.intent.id]: event.target.value }))} maxLength={2200} /></label> : <blockquote>{record.intent.body}</blockquote>}
        {record.intent.lastError ? <p className={styles.error}><AlertTriangle size={13} /> {record.intent.lastError}</p> : null}
        {record.intent.publishProofId ? <dl className={styles.lineage}><div><dt>Post proof</dt><dd>{shortHash(record.intent.publishProofId)}</dd></div><div><dt>Live object</dt><dd>{shortHash(record.intent.externalPostId ?? "Unavailable")}</dd></div><div><dt>Mode</dt><dd>{record.intent.executionMode === "reconcile" ? "Read-only inspect" : "One provider write"}</dd></div></dl> : null}
        {record.proofs.length ? <div className={styles.proofs}>{record.proofs.map((proof) => <div key={proof.id}><CheckCircle2 size={16} /><span><strong>{firstCommentEvidenceLabel(proof.evidence.grade)}</strong><small>{date(proof.evidence.observedAt)} · chain {shortHash(proof.canonicalSha256)}</small></span></div>)}</div> : null}
        <div className={styles.actions}>
          {record.intent.status === "draft" ? <><button type="button" onClick={() => void revise(record)} disabled={Boolean(busy)}><RefreshCw size={12} /> Save revision</button><button className={styles.primary} type="button" onClick={() => void command(record, "submit", "First comment submitted for separate approval.")} disabled={Boolean(busy)}><Send size={12} /> Submit</button></> : null}
          {record.intent.status === "pending_approval" && permission.canApprove ? self ? <><label className={styles.confirm}><input type="checkbox" checked={selfApprovalId === record.intent.id && selfApprovalConfirmed} onChange={(event) => { setSelfApprovalId(event.target.checked ? record.intent.id : ""); setSelfApprovalConfirmed(event.target.checked); }} /><span>I am the sole active owner and explicitly confirm this separate self-approval.</span></label><button className={styles.primary} type="button" onClick={() => void approve(record)} disabled={selfApprovalId !== record.intent.id || !selfApprovalConfirmed || Boolean(busy)}><ShieldCheck size={12} /> Approve with override</button></> : <button className={styles.primary} type="button" onClick={() => void approve(record)} disabled={Boolean(busy)}><ShieldCheck size={12} /> Approve separately</button> : null}
          {record.intent.status === "uncertain" && permission.canApprove ? <><button className={styles.inspect} type="button" onClick={() => void reconcile(record, "inspect_provider")} disabled={Boolean(busy)}><Eye size={12} /> Inspect provider only</button><label className={styles.confirm}><input type="checkbox" checked={retryId === record.intent.id} onChange={(event) => setRetryId(event.target.checked ? record.intent.id : "")} /><span>I checked the live post and confirm this comment was not created.</span></label><button className={styles.dangerButton} type="button" onClick={() => void reconcile(record, "confirmed_not_sent")} disabled={retryId !== record.intent.id || Boolean(busy)}><AlertTriangle size={12} /> Allow one new write</button><button type="button" onClick={() => { const open = attestId !== record.intent.id; setAttestId(open ? record.intent.id : ""); if (open && !attestation.occurredAt) setAttestation((current) => ({ ...current, occurredAt: localDateTimeValue() })); }} disabled={Boolean(busy)}><CheckCircle2 size={12} /> Record operator evidence</button></> : null}
          {canCancel ? <button type="button" onClick={() => void command(record, "cancel", "First-comment request cancelled without contacting the provider.")} disabled={Boolean(busy)}><XCircle size={12} /> Cancel</button> : null}
        </div>
        {attestId === record.intent.id && permission.canAttest ? <form className={styles.attestation} onSubmit={(event) => void attest(event, record)}><p><AlertTriangle size={14} /><span><strong>Operator evidence is not provider confirmation.</strong> Record only a first comment you personally verified on the exact live post.</span></p><label><span>Observed at</span><input type="datetime-local" value={attestation.occurredAt} max={localDateTimeValue()} onChange={(event) => setAttestation((current) => ({ ...current, occurredAt: event.target.value }))} required /></label><label><span>HTTPS evidence link</span><input type="url" value={attestation.evidenceUrl} onChange={(event) => setAttestation((current) => ({ ...current, evidenceUrl: event.target.value }))} required /></label><label><span>Verification note</span><textarea value={attestation.note} onChange={(event) => setAttestation((current) => ({ ...current, note: event.target.value }))} minLength={3} maxLength={2000} required /></label><button className={styles.primary} type="submit" disabled={Boolean(busy)}>Save operator attestation</button></form> : null}
      </article>;
    })}</div>}
  </section>;
}
