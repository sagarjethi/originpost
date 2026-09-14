"use client";

import { AlertTriangle, Camera, ExternalLink, Grid3X3, ImageIcon, LoaderCircle, RefreshCw, Video } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import { instagramGridDate, instagramGridStatusLabel, instagramGridStatusTone, type InstagramGridTileStatus } from "./instagram-grid-utils";
import styles from "./instagram-grid-planner.module.css";

type Account = { id: string; displayName: string; status: string };
type Preview = { mediaId: string; kind: "image" | "video"; contentType: string; widthPixels?: number; heightPixels?: number; durationMs?: number; altText?: string };
type Tile = {
  id: string; contentItemId: string; targetId: string; title: string; caption: string; format: "image" | "carousel" | "reel";
  targetStatus: InstagramGridTileStatus; scheduledFor: string; effectiveAt: string; previewMediaId?: string; preview?: Preview;
  proofState: "not_yet_published" | "verified" | "missing"; liveUrl?: string;
};
type View = { data: { accounts: Account[]; selectedAccountId: string | null; tiles: Tile[] }; meta: { coverage: "originpost_records_only"; providerHistoryIncluded: false; storiesExcluded: true; limit: number } };

function errorMessage(body: { message?: string | string[] } | undefined): string {
  return Array.isArray(body?.message) ? body.message.join(" ") : body?.message ?? "The Instagram projection could not be loaded.";
}

function PreviewMedia({ url, preview, title }: { url?: string | undefined; preview?: Preview | undefined; title: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || !preview || failed) return <span className={styles.placeholder}>{preview?.kind === "video" ? <Video size={25} /> : <ImageIcon size={25} />}</span>;
  if (preview.kind === "video") return <video src={url} muted playsInline preload="metadata" aria-label={preview.altText || title} onError={() => setFailed(true)} />;
  return <img src={url} alt={preview.altText || title} onError={() => setFailed(true)} />;
}

export function InstagramGridPlanner({ auth, workspaceId, brandId, dataMode }: { auth: AuthView; workspaceId: string; brandId: string; dataMode: "api" | "demo" | "loading" | "error" }) {
  const [view, setView] = useState<View | null>(null);
  const [accountId, setAccountId] = useState("");
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(dataMode === "api");
  const [error, setError] = useState("");

  const load = useCallback(async (requestedAccount = accountId) => {
    if (dataMode !== "api") { setLoading(false); return; }
    setLoading(true); setError("");
    const params = new URLSearchParams({ workspaceId, brandId, limit: "60" });
    if (requestedAccount) params.set("accountId", requestedAccount);
    try {
      const response = await apiFetch(`/v1/instagram-grid?${params}`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json().catch(() => undefined) as View | { message?: string | string[] } | undefined;
      if (!response.ok) throw new Error(errorMessage(body as { message?: string | string[] } | undefined));
      const next = body as View;
      setView(next); setAccountId(next.data.selectedAccountId ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The Instagram projection could not be loaded."); }
    finally { setLoading(false); }
  }, [accountId, auth.csrfToken, brandId, dataMode, workspaceId]);

  useEffect(() => { void load(""); }, [auth.csrfToken, brandId, dataMode, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const mediaIds = useMemo(() => [...new Set((view?.data.tiles ?? []).flatMap((tile) => tile.preview ? [tile.preview.mediaId] : []))], [view]);
  useEffect(() => {
    let cancelled = false;
    if (dataMode !== "api") return;
    void Promise.all(mediaIds.map(async (mediaId) => {
      const response = await apiFetch(`/v1/media-assets/${encodeURIComponent(mediaId)}/download-url?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) return null;
      const body = await response.json() as { url?: string; previewUrl?: string };
      const url = body.previewUrl ?? body.url;
      return url ? [mediaId, url] as const : null;
    })).then((pairs) => { if (!cancelled) setUrls(Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair)))); });
    return () => { cancelled = true; };
  }, [auth.csrfToken, dataMode, mediaIds, workspaceId]);

  if (dataMode !== "api") return <div className={styles.state}><Camera size={28} /><strong>Instagram grid needs the connected API</strong><p>Profile plans are unavailable while the API is disconnected. Connect an Instagram account to view OriginPost-owned plans.</p></div>;
  if (loading && !view) return <div className={styles.state} role="status"><LoaderCircle className={styles.spin} size={28} /><strong>Building the profile projection…</strong><p>Reading approved targets, proofs, and inspected Library media.</p></div>;

  return <section className={styles.module} aria-labelledby="instagram-grid-title">
    <header className={styles.header}>
      <div><p>INSTAGRAM PROFILE PROJECTION</p><h2 id="instagram-grid-title">See the next tiles together.</h2><span>Newest post appears at the top left, matching Instagram’s three-column profile order.</span></div>
      <div className={styles.controls}>
        <label>Account<select value={accountId} onChange={(event) => { setAccountId(event.target.value); void load(event.target.value); }} disabled={loading || !view?.data.accounts.length}><option value="">Choose account</option>{view?.data.accounts.map((account) => <option value={account.id} key={account.id}>{account.displayName} · {account.status.replaceAll("_", " ")}</option>)}</select></label>
        <button type="button" onClick={() => void load(accountId)} disabled={loading} aria-label="Refresh Instagram grid">{loading ? <LoaderCircle className={styles.spin} size={15} /> : <RefreshCw size={15} />} Refresh</button>
      </div>
    </header>

    <div className={styles.coverage} role="note"><AlertTriangle size={16} /><span><strong>OriginPost-known posts only.</strong> Provider-native and pre-connection history are not shown. Stories and Reels excluded from the profile feed are intentionally omitted.</span></div>
    {error ? <div className={styles.error} role="alert"><AlertTriangle size={17} /><span>{error}</span></div> : null}
    {!loading && view?.data.accounts.length === 0 ? <div className={styles.state}><Camera size={28} /><strong>No Instagram account for this brand</strong><p>Connect an Instagram account in Channels, then return here to see profile-visible plans.</p></div> : null}
    {!loading && view?.data.accounts.length && view.data.tiles.length === 0 ? <div className={styles.state}><Grid3X3 size={28} /><strong>No profile-visible plans yet</strong><p>Schedule an Instagram image, carousel, or feed-visible Reel. Stories stay in Calendar but never appear in this grid.</p></div> : null}
    {view?.data.tiles.length ? <div className={styles.grid} aria-label={`Instagram profile projection with ${view.data.tiles.length} tiles`}>
      {view.data.tiles.map((tile) => {
        const url = tile.preview ? urls[tile.preview.mediaId] : undefined;
        const tone = instagramGridStatusTone(tile.targetStatus);
        return <article className={styles.tile} key={tile.id} title={`${tile.title} · ${instagramGridStatusLabel(tile.targetStatus)}`}>
          <div className={styles.visual}>
            <PreviewMedia url={url} preview={tile.preview} title={tile.title} />
            <span className={`${styles.badge} ${styles[tone]}`}>{instagramGridStatusLabel(tile.targetStatus)}</span>
            {tile.format === "carousel" ? <span className={styles.format}>Carousel</span> : tile.format === "reel" ? <span className={styles.format}>Reel</span> : null}
          </div>
          <footer><div><strong>{tile.title}</strong><small>{instagramGridDate(tile.effectiveAt)}</small></div>{tile.liveUrl ? <a href={tile.liveUrl} target="_blank" rel="noreferrer" aria-label={`Open published post for ${tile.title}`}><ExternalLink size={14} /></a> : null}</footer>
        </article>;
      })}
    </div> : null}
  </section>;
}
