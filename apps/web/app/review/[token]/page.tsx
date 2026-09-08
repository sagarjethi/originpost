"use client";

import { CircleCheck, ExternalLink, FileText, MessageSquare, ShieldCheck } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { apiBasePath } from "@/lib/api-client";

type ReviewView = {
  review: { id: string; expiresAt: string; allowComment: boolean };
  content: { title: string; summary: string };
  draft: { id: string; revision: number; platform: string; format: string; title: string; caption: string; mediaIds: string[] };
  media: Array<{ id: string; kind: "image" | "video" | "audio" | "document"; contentType: string; fileName: string; altText?: string; url: string; expiresAt: string }>;
  sources: Array<{ id: string; title: string; url?: string; publisher?: string; publishedAt?: string; confidence: number }>;
  comments: Array<{ id: string; authorName: string; body: string; createdAt: string }>;
};

export default function ReviewPage() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<ReviewView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await fetch(`${apiBasePath}/reviews/${encodeURIComponent(token)}`, { cache: "no-store", credentials: "same-origin" });
    const body = await response.json().catch(() => ({})) as ReviewView & { message?: string };
    if (!response.ok) throw new Error(body.message ?? "This review link is not available.");
    setView(body);
  }

  useEffect(() => { void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "This review link is not available.")); }, [token]);

  async function comment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setError("");
    const form = new FormData(formElement);
    try {
      const response = await fetch(`${apiBasePath}/reviews/${encodeURIComponent(token)}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: String(form.get("name") ?? ""), body: String(form.get("body") ?? "") }),
        credentials: "same-origin",
      });
      const body = await response.json() as ReviewView & { message?: string | string[] };
      if (!response.ok) throw new Error(Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "Could not add this comment.");
      setView(body);
      formElement.reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add this comment.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !view) return <main className="review-page"><section className="review-error"><ShieldCheck size={30} /><h1>Review link unavailable</h1><p>{error}</p></section></main>;
  if (!view) return <main className="review-page"><section className="review-loading">Opening the exact draft…</section></main>;

  return <main className="review-page">
    <header className="review-top"><div className="brand-mark"><span>O</span></div><div><strong>OriginPost</strong><small>Secure draft review</small></div><span><ShieldCheck size={15} /> Signed link</span></header>
    <div className="review-layout">
      <section className="review-main">
        <p className="eyebrow">DRAFT REVIEW · REVISION {view.draft.revision}</p>
        <h1>{view.content.title}</h1>
        {view.content.summary ? <p className="review-summary">{view.content.summary}</p> : null}
        <div className="review-badges"><span>{view.draft.platform}</span><span>{view.draft.format}</span><span>Expires {new Date(view.review.expiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span></div>
        {view.media.length ? <div className="review-media">{view.media.map((asset) => asset.kind === "image" ? <img key={asset.id} src={asset.url} alt={asset.altText ?? asset.fileName} /> : asset.kind === "video" ? <video key={asset.id} src={asset.url} controls preload="metadata" /> : <a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><FileText size={17} /> {asset.fileName}</a>)}</div> : null}
        <article className="review-draft"><small>DRAFT COPY FOR REVIEW</small><h2>{view.draft.title}</h2><p>{view.draft.caption}</p>{view.draft.mediaIds.length ? <div className="review-media-note"><FileText size={16} /> {view.draft.mediaIds.length} private media file{view.draft.mediaIds.length === 1 ? "" : "s"} attached</div> : null}</article>
        <div className="review-source-list"><h2>Sources</h2>{view.sources.map((source) => <article key={source.id}><ShieldCheck size={17} /><div><strong>{source.title}</strong><small>{source.publisher ?? "Saved source"} · {source.confidence}% confidence</small></div>{source.url ? <a href={source.url} target="_blank" rel="noreferrer" aria-label={`Open ${source.title}`}><ExternalLink size={15} /></a> : null}</article>)}</div>
      </section>
      <aside className="review-comments">
        <div className="review-comments-head"><MessageSquare size={18} /><div><h2>Reviewer notes</h2><p>Comments stay tied to this exact revision.</p></div></div>
        <div className="review-comment-list">{view.comments.length ? view.comments.map((comment) => <article key={comment.id}><span>{comment.authorName.slice(0, 2).toUpperCase()}</span><div><strong>{comment.authorName}</strong><p>{comment.body}</p><small>{new Date(comment.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small></div></article>) : <div className="review-no-comments"><CircleCheck size={23} /><strong>No notes yet</strong><p>Add a clear change request or approval note.</p></div>}</div>
        {view.review.allowComment ? <form className="review-comment-form" onSubmit={comment}><label>Your name<input name="name" maxLength={100} required /></label><label>Comment<textarea name="body" rows={5} maxLength={3000} placeholder="What should change in this exact draft?" required /></label>{error ? <p>{error}</p> : null}<button disabled={busy}>{busy ? "Saving…" : "Add review note"}</button></form> : <p className="review-closed">Comments are closed for this link.</p>}
      </aside>
    </div>
  </main>;
}
