"use client";

import { AlertTriangle, Archive, CheckCircle2, FileUp, Files, LoaderCircle, Play, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import { buildBatchRows, cleanBatchFileStem, type BatchPlatform, type BatchRiskLevel } from "./batch-operations-utils";
import styles from "./batch-operations.module.css";

type Platform = BatchPlatform;
type Account = { id: string; brandId: string; platform: Platform; displayName: string; status: string };
type Asset = { id: string; brandId: string; fileName: string; kind: "image" | "video"; status: string; inspectionStatus: string; rights: string; sizeBytes: number };
type BatchRow = { rowNumber: number; externalRef: string; title: string; platform: Platform; format: string; scheduledFor?: string; status: "invalid" | "ready" | "review_ready" | "individual_review" | "approved" | "scheduled" | "failed"; errors: string[]; warnings: string[]; bulkApprovalEligible: boolean; contentItemId?: string; failedStep?: string };
type BatchPlan = { id: string; version: number; name: string; status: string; rows: BatchRow[]; counts: Record<string, number>; createdAt: string; updatedAt: string; processingRecoverableAt?: string };
type UploadResult = { asset: Asset; upload: { url: string; method?: string; headers?: Record<string, string> } };

async function responseError(response: Response, fallback: string) { const body = await response.json().catch(() => ({})) as { message?: string | string[] }; return Array.isArray(body.message) ? body.message.join(" ") : body.message ?? fallback; }
async function fileSha256(file: File) { const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer()); return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

export function BatchOperations({ auth, workspaceId, brandId, onOpenContent }: { auth: AuthView; workspaceId: string; brandId: string; onOpenContent?: (id: string) => void }) {
  const [plans, setPlans] = useState<BatchPlan[]>([]); const [selected, setSelected] = useState<BatchPlan | null>(null); const [accounts, setAccounts] = useState<Account[]>([]);
  const [files, setFiles] = useState<File[]>([]); const [uploaded, setUploaded] = useState<Asset[]>([]); const [platform, setPlatform] = useState<Platform>("instagram");
  const [accountId, setAccountId] = useState(""); const [caption, setCaption] = useState("{filename}"); const [batchName, setBatchName] = useState("New media campaign");
  const [startAt, setStartAt] = useState(() => { const date = new Date(Date.now() + 24 * 60 * 60_000); date.setSeconds(0, 0); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); });
  const [intervalMinutes, setIntervalMinutes] = useState(60); const [riskLevel, setRiskLevel] = useState<BatchRiskLevel>("low");
  const [madeForKids, setMadeForKids] = useState(false); const [synthetic, setSynthetic] = useState(false); const [selectedRows, setSelectedRows] = useState<number[]>([]); const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const membership = auth.memberships.find((entry) => entry.workspaceId === workspaceId) ?? auth.memberships[0]; const canCreate = membership?.role !== "viewer"; const canApprove = membership?.role === "owner" || membership?.role === "manager";
  const matchingAccounts = useMemo(() => accounts.filter((account) => account.platform === platform && account.brandId === brandId && ["healthy", "expiring"].includes(account.status)), [accounts, brandId, platform]);

  const load = useCallback(async () => {
    setError("");
    try {
      const query = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
      const [plansResponse, accountsResponse] = await Promise.all([apiFetch(`/v1/batch-operations?${query}`, { cache: "no-store" }, auth.csrfToken), apiFetch(`/v1/channels/accounts?${query}`, { cache: "no-store" }, auth.csrfToken)]);
      if (!plansResponse.ok || !accountsResponse.ok) throw new Error("Could not load batch operations.");
      const loadedPlans = await plansResponse.json() as BatchPlan[]; setPlans(loadedPlans); setAccounts(await accountsResponse.json() as Account[]);
      setSelected((current) => current ? loadedPlans.find((plan) => plan.id === current.id) ?? current : loadedPlans[0] ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load batch operations."); }
  }, [auth.csrfToken, brandId, workspaceId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!matchingAccounts.some((account) => account.id === accountId)) setAccountId(matchingAccounts[0]?.id ?? ""); }, [accountId, matchingAccounts]);

  async function uploadFiles() {
    if (!files.length) { setError("Choose one or more images or videos first."); return; } setBusy("upload"); setError(""); setMessage("");
    try {
      const assets: Asset[] = [];
      for (const file of files) {
        const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : null; if (!kind) throw new Error(`${file.name} is not a supported image or video.`);
        const create = await apiFetch("/v1/media-assets/uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId, kind, purpose: "creative", fileName: file.name, contentType: file.type, sizeBytes: file.size, sha256: await fileSha256(file), rights: "owned", altText: cleanBatchFileStem(file.name) }) }, auth.csrfToken);
        if (!create.ok) throw new Error(await responseError(create, `Could not start ${file.name}.`)); const result = await create.json() as UploadResult;
        const uploadedResponse = await fetch(result.upload.url, { method: result.upload.method || "PUT", ...(result.upload.headers ? { headers: result.upload.headers } : {}), body: file }); if (!uploadedResponse.ok) throw new Error(`Upload failed for ${file.name}.`);
        const complete = await apiFetch(`/v1/media-assets/${result.asset.id}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) }, auth.csrfToken); if (!complete.ok) throw new Error(await responseError(complete, `${file.name} could not be verified.`)); assets.push(await complete.json() as Asset);
      }
      setUploaded(assets); setMessage(`${assets.length} verified file${assets.length === 1 ? "" : "s"} ready for dry-run.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not upload this batch."); } finally { setBusy(""); }
  }

  async function preview(event: FormEvent) {
    event.preventDefault(); if (!uploaded.length) { setError("Upload and verify the files first."); return; } setBusy("preview"); setError(""); setMessage("");
    try {
      const base = new Date(startAt); if (!Number.isFinite(base.getTime())) throw new Error("Choose a valid starting time."); const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const rows = buildBatchRows(uploaded, { batchName, platform, captionTemplate: caption, ...(accountId ? { accountId } : {}), startAtIso: base.toISOString(), intervalMinutes, timezone, riskLevel, madeForKids, containsSyntheticMedia: synthetic });
      const response = await apiFetch("/v1/batch-operations/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId, name: batchName, rows }) }, auth.csrfToken); if (!response.ok) throw new Error(await responseError(response, "Could not create the dry-run.")); const body = await response.json() as { data: BatchPlan }; setSelected(body.data); setPlans((current) => [body.data, ...current.filter((plan) => plan.id !== body.data.id)]); setSelectedRows([]); setConfirmation(""); setMessage("Dry-run complete. Nothing has been created or scheduled yet.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not preview this batch."); } finally { setBusy(""); }
  }
  async function mutate(path: "commit" | "approve" | "archive") {
    if (!selected) return; setBusy(path); setError(""); setMessage("");
    try { const body = path === "approve" ? { workspaceId, version: selected.version, rowNumbers: selectedRows, confirmation } : { workspaceId, version: selected.version }; const response = await apiFetch(`/v1/batch-operations/${selected.id}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, auth.csrfToken); if (!response.ok) throw new Error(await responseError(response, `Could not ${path} this batch.`)); const result = await response.json() as { data: BatchPlan }; setSelected(result.data); setPlans((current) => [result.data, ...current.filter((plan) => plan.id !== result.data.id)]); setSelectedRows([]); setConfirmation(""); setMessage(path === "commit" ? "Valid rows are now source-backed drafts waiting for review." : path === "approve" ? "Selected safe rows were approved and scheduled." : "Batch archived."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : `Could not ${path} this batch.`); } finally { setBusy(""); }
  }
  function toggleRow(rowNumber: number) { setSelectedRows((current) => current.includes(rowNumber) ? current.filter((value) => value !== rowNumber) : [...current, rowNumber]); setConfirmation(""); }
  const recoveryReady = selected?.status === "processing" && selected.processingRecoverableAt ? Date.parse(selected.processingRecoverableAt) <= Date.now() : false;

  return <section className={styles.page}>
    <header className={styles.hero}><div><p className="eyebrow">BATCH OPERATIONS</p><h1>Prepare a campaign in one pass</h1><p>Upload many files, check every row, create drafts, then approve only the safe rows. A failed row never hides the successful ones.</p></div><button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button></header>
    {error ? <div className="module-alert" role="alert">{error}</div> : null}{message ? <div className={styles.success} role="status"><CheckCircle2 size={17} />{message}</div> : null}
    <div className={styles.layout}>
      <form className={`${styles.builder} panel`} onSubmit={preview}>
        <div className={styles.sectionHead}><span><Files size={18} /></span><div><h2>1. Add the campaign</h2><p>Files upload through the governed Media Library and keep rights, hash, and inspection records.</p></div></div>
        <label>Campaign name<input value={batchName} onChange={(event) => setBatchName(event.target.value)} minLength={2} maxLength={120} required /></label>
        <div className={styles.grid}><label>Platform<select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}><option value="instagram">Instagram</option><option value="facebook">Facebook Page</option><option value="youtube">YouTube Shorts</option></select></label><label>Publishing account<select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">Drafts only</option>{matchingAccounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label></div>
        <label>Caption template<textarea value={caption} onChange={(event) => setCaption(event.target.value)} rows={4} maxLength={10000} required /><small>Use <code>{"{filename}"}</code> where the clean file name should appear.</small></label>
        <div className={styles.grid}><label>Start time<input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} disabled={!accountId} /></label><label>Minutes between posts<input type="number" min={10} max={10080} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} disabled={!accountId} /></label><label>Risk level<select value={riskLevel} onChange={(event) => setRiskLevel(event.target.value as typeof riskLevel)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High — individual review</option><option value="sensitive">Sensitive — individual review</option></select></label></div>
        {platform === "youtube" ? <fieldset className={styles.declarations}><legend>YouTube declarations</legend><label><input type="checkbox" checked={madeForKids} onChange={(event) => setMadeForKids(event.target.checked)} /> Made for kids</label><label><input type="checkbox" checked={synthetic} onChange={(event) => setSynthetic(event.target.checked)} /> Contains realistic synthetic media</label><p>Batch Shorts stay private by default.</p></fieldset> : null}
        <label className={styles.drop}><FileUp size={24} /><strong>Choose up to 100 images or videos</strong><span>{files.length ? files.map((file) => file.name).join(" · ") : "The original files stay unchanged."}</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm" multiple onChange={(event) => { setFiles(Array.from(event.target.files ?? []).slice(0, 100)); setUploaded([]); }} disabled={!canCreate} /></label>
        <div className={styles.actions}><button type="button" className="secondary-button" onClick={() => void uploadFiles()} disabled={!canCreate || !files.length || Boolean(busy)}>{busy === "upload" ? <LoaderCircle className={styles.spin} size={15} /> : <Upload size={15} />} Upload and verify</button><button className="new-button" disabled={!canCreate || !uploaded.length || Boolean(busy)}>{busy === "preview" ? <LoaderCircle className={styles.spin} size={15} /> : <ShieldCheck size={15} />} Dry-run {uploaded.length || ""} rows</button></div>
      </form>
      <aside className={`${styles.history} panel`}><div className={styles.sectionHead}><span><Archive size={17} /></span><div><h2>Saved batches</h2><p>Durable plans and row results</p></div></div>{plans.map((plan) => <button key={plan.id} className={selected?.id === plan.id ? styles.selectedPlan : ""} onClick={() => { setSelected(plan); setSelectedRows([]); setConfirmation(""); }}><strong>{plan.name}</strong><small>{new Date(plan.createdAt).toLocaleString()} · {plan.rows.length} rows</small><em>{plan.status.replaceAll("_", " ")}</em></button>)}{!plans.length ? <p className={styles.empty}>No batches yet.</p> : null}</aside>
    </div>
    {selected ? <section className={`${styles.review} panel`}>
      <div className={styles.reviewHead}><div><p className="eyebrow">DRY-RUN AND ROW LEDGER</p><h2>{selected.name}</h2><p>{selected.rows.length} rows · {selected.status.replaceAll("_", " ")} · version {selected.version}</p>{selected.status === "processing" && selected.processingRecoverableAt ? <small className={styles.processingNote}>{recoveryReady ? "The prior run stopped updating. Recovery is now available." : `A row is being saved. Recovery becomes available ${new Date(selected.processingRecoverableAt).toLocaleString()} if it stops.`}</small> : null}</div><div className={styles.actions}>{["ready", "partially_failed"].includes(selected.status) || recoveryReady ? <button className="secondary-button" onClick={() => void mutate("commit")} disabled={Boolean(busy)}><Play size={15} /> {recoveryReady ? "Recover interrupted batch" : selected.counts.failed ? "Retry preparation" : "Create drafts for review"}</button> : null}{canApprove && selected.status !== "archived" && selected.status !== "processing" ? <button className="secondary-button" onClick={() => void mutate("archive")} disabled={Boolean(busy)}><Archive size={15} /> Archive</button> : null}</div></div>
      <div className={styles.rows}>{selected.rows.map((row) => { const selectable = canApprove && row.bulkApprovalEligible && (row.status === "review_ready" || row.status === "failed" && ["approval", "schedule"].includes(row.failedStep ?? "")); return <article key={row.rowNumber} className={styles.row}><div className={styles.rowTop}>{selectable ? <input aria-label={`Select row ${row.rowNumber}`} type="checkbox" checked={selectedRows.includes(row.rowNumber)} onChange={() => toggleRow(row.rowNumber)} /> : <span className={styles.rowNumber}>{row.rowNumber}</span>}<div><strong>{row.title}</strong><small>{row.platform} · {row.format}{row.scheduledFor ? ` · ${new Date(row.scheduledFor).toLocaleString()}` : " · draft only"}</small></div><em data-state={row.status}>{row.status.replaceAll("_", " ")}</em></div>{row.errors.map((value) => <p key={value} className={styles.rowError}><AlertTriangle size={13} />{value}</p>)}{row.warnings.map((value) => <p key={value} className={styles.rowWarning}>{value}</p>)}{row.contentItemId && onOpenContent ? <button className={styles.open} onClick={() => onOpenContent(row.contentItemId!)}>Open Content Item</button> : null}</article>; })}</div>
      {selectedRows.length ? <div className={styles.approval}><div><ShieldCheck size={22} /><div><strong>Human approval for {selectedRows.length} row{selectedRows.length === 1 ? "" : "s"}</strong><p>Review the rows above. This will approve the exact draft and create the saved schedules.</p></div></div><label>Type <b>APPROVE {selectedRows.length}</b><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label><button className="new-button" onClick={() => void mutate("approve")} disabled={confirmation !== `APPROVE ${selectedRows.length}` || Boolean(busy)}>{busy === "approve" ? <LoaderCircle className={styles.spin} size={15} /> : <CheckCircle2 size={15} />} Approve and schedule</button></div> : null}
    </section> : null}
  </section>;
}
