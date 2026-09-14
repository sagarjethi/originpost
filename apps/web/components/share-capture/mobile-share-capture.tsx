"use client";

import { AlertTriangle, ArrowLeft, Check, ExternalLink, FileImage, FolderDown, Image as ImageIcon, Link2, LoaderCircle, Send, Smartphone, Upload, Video } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import styles from "./mobile-share-capture.module.css";
import { mobileShareDraftChoices, type MobileShareReceiptMedia } from "./mobile-share-capture-utils";

type Brand = { id: string; name: string; status: "active" | "archived" };
type Receipt = {
  id: string;
  version: number;
  status: "pending" | "receiving" | "inspecting" | "pending_review" | "materializing" | "converted" | "rejected" | "failed" | "expired";
  title?: string;
  sharedText?: string;
  originalUrl?: string;
  media?: MobileShareReceiptMedia;
  expiresAt: string;
  convertedMediaAssetId?: string;
  convertedContentItemId?: string;
  convertedDraftId?: string;
  failureCode?: string;
};
type Saved = {
  receipt: Receipt;
  mediaAsset?: { id: string; fileName?: string };
  contentItem?: { id: string; title: string };
  replay: boolean;
};

const uploadAccept = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm";

async function message(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({})) as { message?: string | string[] };
  return Array.isArray(body.message) ? body.message.join(" ") : body.message ?? fallback;
}

function bytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

export function MobileShareCapture() {
  const [auth, setAuth] = useState<AuthView>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [noReceipt, setNoReceipt] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File>();
  const [purpose, setPurpose] = useState("");
  const [rights, setRights] = useState("");
  const [altText, setAltText] = useState("");
  const [mode, setMode] = useState<"library" | "content">("library");
  const [draftChoice, setDraftChoice] = useState("");
  const [caption, setCaption] = useState("");
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [saved, setSaved] = useState<Saved>();
  const [online, setOnline] = useState(true);

  const choices = useMemo(() => mobileShareDraftChoices(receipt?.media), [receipt?.media]);
  const publishableRights = rights === "owned" || rights === "cleared";
  const canDraft = purpose === "creative" && publishableRights;

  const applyReceipt = useCallback((next: Receipt) => {
    setReceipt(next);
    setNoReceipt(false);
    setTitle(next.title ?? "");
    setText(next.sharedText ?? "");
    setUrl(next.originalUrl ?? "");
    setCaption(next.sharedText ?? "");
    const nextChoices = mobileShareDraftChoices(next.media);
    setDraftChoice(nextChoices[0]?.value ?? "");
  }, []);

  const loadBrands = useCallback(async (nextWorkspace: string, view: AuthView) => {
    const response = await apiFetch(`/v1/workspaces/${encodeURIComponent(nextWorkspace)}/brands`, { cache: "no-store" }, view.csrfToken);
    if (!response.ok) throw new Error(await message(response, "Could not load brands."));
    const list = (await response.json() as Brand[]).filter((brand) => brand.status === "active");
    setBrands(list);
    setBrandId(list[0]?.id ?? "");
  }, []);

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const me = await apiFetch("/v1/auth/me", { cache: "no-store" });
      if (me.status === 401) { setNeedsSignIn(true); return }
      if (!me.ok) throw new Error(await message(me, "Could not check your sign-in."));
      const view = await me.json() as AuthView;
      setAuth(view);
      const chosenWorkspace = view.memberships[0]?.workspaceId ?? "";
      setWorkspaceId(chosenWorkspace);
      if (chosenWorkspace) await loadBrands(chosenWorkspace, view);
      const capture = await apiFetch("/v1/share-captures/current", { cache: "no-store" }, view.csrfToken);
      if (capture.status === 404) { setNoReceipt(true); setReceipt(undefined); return }
      if (!capture.ok) throw new Error(await message(capture, "Could not open this mobile share."));
      const pending = await capture.json() as Receipt;
      applyReceipt(pending);
      if (pending.status === "converted") setSaved({ receipt: pending, ...(pending.convertedMediaAssetId ? { mediaAsset: { id: pending.convertedMediaAssetId } } : {}), ...(pending.convertedContentItemId ? { contentItem: { id: pending.convertedContentItemId, title: pending.title ?? "Saved mobile share" } } : {}), replay: true });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this mobile share.") }
    finally { setBusy(false) }
  }, [applyReceipt, loadBrands]);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    void load();
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off) };
  }, [load]);

  useEffect(() => {
    if (receipt?.status !== "materializing" || !auth) return;
    let attempts = 0;
    const timer = window.setInterval(async () => {
      if (++attempts > 15) { window.clearInterval(timer); return }
      const response = await apiFetch("/v1/share-captures/current", { cache: "no-store" }, auth.csrfToken).catch(() => null);
      if (!response?.ok) return;
      const next = await response.json() as Receipt;
      setReceipt(next);
      if (next.status === "converted") { setSaved({ receipt: next, ...(next.convertedMediaAssetId ? { mediaAsset: { id: next.convertedMediaAssetId } } : {}), ...(next.convertedContentItemId ? { contentItem: { id: next.convertedContentItemId, title: next.title ?? "Saved mobile share" } } : {}), replay: true }); window.clearInterval(timer) }
      if (!["materializing", "receiving", "inspecting"].includes(next.status)) window.clearInterval(timer);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [auth, receipt?.status]);

  async function chooseWorkspace(next: string) {
    if (!auth) return;
    setWorkspaceId(next); setBrandId(""); setError("");
    try { await loadBrands(next, auth) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load brands.") }
  }

  async function uploadFromPhone() {
    if (!auth || !file || saving || !online) return;
    setSaving(true); setError("");
    try {
      const form = new FormData();
      form.append("media", file, file.name);
      if (title.trim()) form.append("title", title.trim());
      if (text.trim()) form.append("text", text.trim());
      if (url.trim()) form.append("url", url.trim());
      const response = await apiFetch("/v1/share-captures/uploads", { method: "POST", body: form }, auth.csrfToken);
      if (!response.ok) throw new Error(await message(response, "Could not securely inspect this file."));
      const result = await response.json() as { data: { receipt: Receipt } };
      applyReceipt(result.data.receipt);
      setFile(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not securely inspect this file.") }
    finally { setSaving(false) }
  }

  async function saveTextCapture() {
    if (!auth || !receipt || !workspaceId || !brandId || saving) return;
    setSaving(true); setError("");
    try {
      const response = await apiFetch("/v1/share-captures/current/convert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId, brandId, title, text, url }) }, auth.csrfToken);
      if (!response.ok) throw new Error(await message(response, "Could not add this share to the Inbox."));
      const result = await response.json() as { data: { receipt: Receipt; contentItem: { id: string; title: string } }; meta: { idempotentReplay: boolean } };
      setSaved({ receipt: result.data.receipt, contentItem: result.data.contentItem, replay: result.meta.idempotentReplay });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this share to the Inbox.") }
    finally { setSaving(false) }
  }

  async function materialize() {
    if (!auth || !receipt?.media || !workspaceId || !brandId || !purpose || !rights || saving) return;
    if (mode === "content" && (!canDraft || !draftChoice || !caption.trim() || !title.trim())) { setError("A draft needs creative media, owned or cleared rights, a compatible destination, a title, and a caption."); return }
    const selected = choices.find((choice) => choice.value === draftChoice);
    setSaving(true); setError("");
    try {
      const response = await apiFetch("/v1/share-captures/current/materialize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, brandId, purpose, rights, mode, title, text, url, ...(altText.trim() ? { altText: altText.trim() } : {}), ...(mode === "content" && selected ? { platform: selected.platform, format: selected.format, caption: caption.trim() } : {}) }),
      }, auth.csrfToken);
      if (!response.ok) throw new Error(await message(response, "Could not save this inspected file."));
      const result = await response.json() as { data: { receipt: Receipt; mediaAsset: { id: string; fileName?: string }; contentItem?: { id: string; title: string } }; meta: { idempotentReplay: boolean } };
      setSaved({ receipt: result.data.receipt, mediaAsset: result.data.mediaAsset, ...(result.data.contentItem ? { contentItem: result.data.contentItem } : {}), replay: result.meta.idempotentReplay });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this inspected file.") }
    finally { setSaving(false) }
  }

  if (busy) return <main className={styles.shell}><section className={styles.card}><LoaderCircle className={styles.spin} /><h1>Opening your share…</h1><p>OriginPost is checking the signed-in account and the short-lived capture.</p></section></main>;
  if (needsSignIn) return <main className={styles.shell}><section className={styles.card}><Smartphone /><p className={styles.eyebrow}>MOBILE CAPTURE</p><h1>Sign in to save this share</h1><p>OriginPost keeps captures tied to one person and one workspace. Sign in, then share or upload the file again.</p><a className={styles.primary} href="/">Open OriginPost</a></section></main>;
  if (saved) return <main className={styles.shell}><section className={`${styles.card} ${styles.saved}`}><span className={styles.success}><Check /></span><p className={styles.eyebrow}>GOVERNED CAPTURE SAVED</p><h1>{saved.replay ? "Already captured" : saved.contentItem ? "Draft ready for review" : "Saved to the Library"}</h1><p>{saved.contentItem ? `“${saved.contentItem.title}” is an unapproved, unscheduled Content Item with the exact inspected asset attached.` : "The inspected asset is in the governed Media Library. No post, approval, schedule, or provider write was created."}</p>{saved.contentItem ? <a className={styles.primary} href={`/content?item=${encodeURIComponent(saved.contentItem.id)}`}>Open Content Item <ExternalLink size={16} /></a> : <a className={styles.primary} href="/library">Open Media Library <ExternalLink size={16} /></a>}<a className={styles.secondary} href="/"><ArrowLeft size={15} /> Back to OriginPost</a></section></main>;

  if (noReceipt) return <main className={styles.shell}><section className={styles.card}>
    <div className={styles.icon}><Upload /></div><p className={styles.eyebrow}>UPLOAD FROM PHONE</p><h1>Add one photo or video</h1><p className={styles.intro}>On supported Android and ChromeOS installs, use the phone Share menu. On iPhone, iPad, desktop, or an uninstalled browser, choose the file here. This first release is online-only.</p>
    {error ? <div className={styles.error} role="alert"><AlertTriangle size={17} /><span>{error}</span></div> : null}
    {!online ? <div className={styles.warning}><AlertTriangle size={17} /><span>Offline. Reconnect before uploading; OriginPost has not stored the file.</span></div> : null}
    <label className={styles.filePicker}><input type="file" accept={uploadAccept} onChange={(event) => setFile(event.target.files?.[0])} /><span><Upload size={18} />{file ? file.name : "Choose one photo or video"}</span><small>JPEG, PNG, WebP, GIF up to 64 MB · MP4, MOV, WebM up to 500 MB</small></label>
    <label>Optional title<input value={title} maxLength={180} placeholder={file?.name ?? "A useful working title"} onChange={(event) => setTitle(event.target.value)} /></label>
    <button className={styles.primary} type="button" disabled={!online || !file || saving} onClick={() => void uploadFromPhone()}>{saving ? <LoaderCircle className={styles.spin} size={17} /> : <Upload size={16} />}{saving ? "Inspecting securely…" : "Upload and inspect"}</button>
    <p className={styles.privacy}>The raw file is quarantined and server-inspected before it can enter the Library. The browser cookie contains only a random receipt token.</p>
    <a className={styles.secondary} href="/"><ArrowLeft size={15} /> Back to OriginPost</a>
  </section></main>;

  const media = receipt?.media;
  const terminalError = Boolean(receipt && ["rejected", "failed", "expired"].includes(receipt.status));
  return <main className={styles.shell}><section className={styles.card}>
    <div className={styles.icon}>{media?.kind === "video" ? <Video /> : media ? <ImageIcon /> : <Send />}</div><p className={styles.eyebrow}>{media ? "MOBILE MEDIA REVIEW" : "MOBILE CAPTURE"}</p><h1>{media ? "Review the inspected file" : "Add this to the Inbox"}</h1><p className={styles.intro}>{media ? "Choose the exact workspace, brand, purpose, and rights. Nothing is published, approved, or scheduled from this screen." : "Check the shared context, choose where it belongs, then save it. A link preview is context—not proof or image permission."}</p>
    {error ? <div className={styles.error} role="alert"><AlertTriangle size={17} /><span>{error}</span></div> : null}
    {terminalError ? <div className={styles.error} role="alert"><AlertTriangle size={17} /><span>{media?.errorSummary ?? "This capture is unavailable. Upload it again from the phone after checking the file."}</span></div> : null}
    {!online ? <div className={styles.warning}><AlertTriangle size={17} /><span>Offline. Reconnect to save; nothing has been marked saved.</span></div> : null}
    {media ? <section className={styles.mediaReview} aria-label="Inspected media">
      <div className={styles.preview}>{media.kind === "image" && media.inspectionStatus === "ready" ? <img src="/v1/share-captures/current/preview" alt={altText || "Shared image preview"} /> : <span>{media.kind === "video" ? <Video size={30} /> : <FileImage size={30} />}<small>{media.kind === "video" ? "Video bytes stay private; review the inspected facts below." : "Preview unavailable"}</small></span>}</div>
      <div className={styles.mediaFacts}><strong>{media.fileName}</strong><span>{media.detectedContentType ?? media.declaredContentType} · {bytes(media.sizeBytes)}</span><span>{media.widthPixels && media.heightPixels ? `${media.widthPixels}×${media.heightPixels}` : "Dimensions unavailable"}{media.durationMs !== undefined ? ` · ${(media.durationMs / 1000).toFixed(1)}s` : ""}</span><span className={media.inspectionStatus === "ready" ? styles.ready : styles.notReady}>{media.inspectionStatus === "ready" ? "Server inspection passed" : `Inspection ${media.inspectionStatus}`}</span></div>
    </section> : null}
    <div className={styles.grid}><label>Workspace<select value={workspaceId} onChange={(event) => void chooseWorkspace(event.target.value)}>{auth?.memberships.map((membership) => <option key={membership.workspaceId} value={membership.workspaceId}>{membership.workspaceName}</option>)}</select></label><label>Brand<select value={brandId} onChange={(event) => setBrandId(event.target.value)}>{brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></label></div>
    <label>Title<input value={title} maxLength={180} onChange={(event) => setTitle(event.target.value)} /></label>
    {!media ? <><label>Web link <span>Optional</span><div className={styles.urlField}><Link2 size={16} /><input type="url" value={url} maxLength={2048} placeholder="https://…" onChange={(event) => setUrl(event.target.value)} /></div></label><label>Shared text or note <span>Optional</span><textarea value={text} maxLength={4000} rows={5} onChange={(event) => setText(event.target.value)} /></label></> : <>
      <div className={styles.grid}><label>Purpose<select value={purpose} onChange={(event) => setPurpose(event.target.value)}><option value="">Choose purpose…</option><option value="creative">Creative media</option><option value="evidence">Evidence</option><option value="source">Source material</option></select></label><label>Rights<select value={rights} onChange={(event) => setRights(event.target.value)}><option value="">Choose rights…</option><option value="owned">Owned by this brand</option><option value="cleared">Cleared for use</option><option value="reference-only">Reference only</option><option value="unknown">Unknown</option></select></label></div>
      <label>Alt text <span>Optional</span><textarea value={altText} maxLength={500} rows={3} onChange={(event) => setAltText(event.target.value)} /></label>
      <div className={styles.modeCards} role="group" aria-label="Save destination"><button type="button" className={mode === "library" ? styles.selectedMode : ""} onClick={() => setMode("library")}><FolderDown size={18} /><strong>Save to Library</strong><span>Keep the inspected asset without creating content.</span></button><button type="button" className={mode === "content" ? styles.selectedMode : ""} disabled={!canDraft} onClick={() => setMode("content")}><FileImage size={18} /><strong>Create Content Item</strong><span>One unapproved, unscheduled draft with this exact asset.</span></button></div>
      {!canDraft ? <p className={styles.policyNote}>Draft creation unlocks only for Creative media with Owned or Cleared rights. Other choices can still be saved safely to the Library.</p> : null}
      {mode === "content" ? <div className={styles.draftFields}><label>Destination and format<select value={draftChoice} onChange={(event) => setDraftChoice(event.target.value)}><option value="">Choose a compatible format…</option>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label><label>Draft caption<textarea value={caption} maxLength={10000} rows={5} onChange={(event) => setCaption(event.target.value)} /></label><p>Compatibility comes from the server-inspected MIME type, dimensions, duration, and selected rights. The final schedule and publish checks still run later.</p></div> : null}
    </>}
    <small className={styles.expiry}>This short-lived capture expires at {receipt ? new Date(receipt.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}.</small>
    {media ? <button className={styles.primary} type="button" disabled={!online || terminalError || media.inspectionStatus !== "ready" || !brandId || !purpose || !rights || (mode === "content" && (!canDraft || !draftChoice || !caption.trim() || !title.trim())) || saving} onClick={() => void materialize()}>{saving || receipt?.status === "materializing" ? <LoaderCircle className={styles.spin} size={17} /> : mode === "content" ? <FileImage size={16} /> : <FolderDown size={16} />}{saving || receipt?.status === "materializing" ? "Saving exact asset…" : mode === "content" ? "Create unapproved draft" : "Save inspected asset"}</button> : <button className={styles.primary} type="button" disabled={!online || !brandId || !title.trim() || (!url.trim() && !text.trim()) || saving} onClick={() => void saveTextCapture()}>{saving ? <LoaderCircle className={styles.spin} size={17} /> : <Send size={16} />}{saving ? "Saving…" : "Add to Inbox"}</button>}
    {terminalError ? <button className={styles.secondary} type="button" onClick={() => { setNoReceipt(true); setReceipt(undefined); setError("") }}><Upload size={15} /> Upload the file again</button> : <a className={styles.secondary} href="/"><ArrowLeft size={15} /> Cancel</a>}
  </section></main>;
}
