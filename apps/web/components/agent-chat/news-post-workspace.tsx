"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import styles from "./news-post-workspace.module.css";

type Template = {
  id: string;
  name: string;
  language: string;
  format: string;
  layout: string;
  logoMediaId: string;
  logoPosition: string;
  logoWidth: number;
  logoMargin: number;
  logoBackground: string;
  logoCrop: string;
  referenceMediaIds: string[];
  styleInstructions: string;
  footer: string;
  palette: string[];
};
type Run = {
  id: string;
  input: string;
  status: string;
  createdAt: string;
  version: number;
  template: Template;
  contentItemId: string;
  outputMediaId?: string;
  draftId?: string;
  generationId?: string;
  projectId?: string;
  copy?: { headline: string; caption: string };
  error?: string;
};
type Asset = {
  id: string;
  fileName: string;
  kind: string;
  status: string;
  inspectionStatus: string;
  rights: string;
  syntheticLineage?: unknown;
};
type Capability = {
  available: boolean;
  reason: string | null;
  research: boolean;
  text: boolean;
  storage: string;
  image: { generation: boolean; model: string };
};
const stages = [
  { id: "researching", label: "Research sources" },
  { id: "writing", label: "Write the post" },
  { id: "generating", label: "Create the image" },
  { id: "composing", label: "Apply your template" },
  { id: "drafting", label: "Prepare for review" },
];
const finished = (r: Run) =>
  ["ready", "blocked", "failed", "uncertain"].includes(r.status);
const initial = {
  name: "News post",
  language: "English",
  format: "portrait",
  layout: "headline",
  logoMediaId: "",
  logoPosition: "top-left",
  logoWidth: 18,
  logoMargin: 4,
  logoBackground: "#FFFFFF",
  logoCrop: "full",
  referenceMediaIds: [] as string[],
  styleInstructions:
    "Clear editorial illustration, strong contrast, ample space for the headline. Never invent a documentary scene.",
  footer: "",
  palette: ["#101820", "#151E2A", "#FFFFFF", "#E8EBEF", "#F6D55C"],
};

export function NewsPostWorkspace({
  auth,
  workspaceId,
  brandId,
  brandName,
  onNavigate,
}: {
  auth: AuthView;
  workspaceId: string;
  brandId: string;
  brandName: string;
  onNavigate: (page: string) => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [assets, setAssets] = useState<Asset[]>([]);
  const [capability, setCapability] = useState<Capability | null>(null),
    [templateId, setTemplateId] = useState(""),
    [selected, setSelected] = useState("");
  const [input, setInput] = useState(""),
    [direction, setDirection] = useState(""),
    [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(false),
    [form, setForm] = useState(initial),
    [imageUrl, setImageUrl] = useState(""),
    [logoUrl, setLogoUrl] = useState("");
  const [mobileHistory, setMobileHistory] = useState(false);
  const [uploadRights, setUploadRights] = useState("owned");
  const submission = useRef<{ key: string; fingerprint: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null),
    settingsRef = useRef<HTMLDialogElement>(null),
    settingsButton = useRef<HTMLButtonElement>(null);
  const selectedRun = runs.find((r) => r.id === selected),
    activeTemplate = templates.find((t) => t.id === templateId);
  const role = auth.memberships.find(
    (m) => m.workspaceId === workspaceId,
  )?.role;
  const editable = Boolean(role && role !== "viewer");
  const query = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(path, init, auth.csrfToken);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        response.status === 404
          ? "This server needs the news-post workflow update. Your input is still here."
          : Array.isArray(data.message)
            ? data.message.join(" ")
            : (data.message ?? `Request failed (${response.status}).`),
      );
    }
    return response.json() as Promise<T>;
  }
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh(first = false) {
      if (!brandId) {
        setLoading(false);
        return;
      }
      try {
        const [newRuns, newTemplates, newCapability] = await Promise.all([
          request<Run[]>(`/v1/agent-posts?${query}`),
          request<Template[]>(`/v1/agent-posts/templates?${query}`),
          request<Capability>(`/v1/agent-posts/capability?${query}`),
        ]);
        if (!live) return;
        setRuns(newRuns);
        setTemplates(newTemplates);
        setCapability(newCapability);
        setTemplateId((old) =>
          newTemplates.some((t) => t.id === old)
            ? old
            : (newTemplates[0]?.id ?? ""),
        );
        if (first)
          setSelected(
            new URLSearchParams(window.location.search).get("conversation") ??
              "",
          );
        setLoadError("");
      } catch (e) {
        if (live)
          setLoadError(
            e instanceof Error ? e.message : "Could not load post runs.",
          );
      } finally {
        if (live) {
          setLoading(false);
          timer = setTimeout(() => void refresh(), 4000);
        }
      }
    }
    void refresh(true);
    const pop = () =>
      setSelected(
        new URLSearchParams(window.location.search).get("conversation") ?? "",
      );
    window.addEventListener("popstate", pop);
    return () => {
      live = false;
      clearTimeout(timer);
      window.removeEventListener("popstate", pop);
    };
  }, [workspaceId, brandId, auth.user.id]);
  useEffect(() => {
    let live = true;
    if (settings) {
      settingsRef.current?.showModal();
      void request<Asset[]>(`/v1/media-assets?${query}&limit=200`)
        .then((list) => {
          if (live)
            setAssets(
              list.filter(
                (a) =>
                  a.kind === "image" &&
                  a.status === "ready" &&
                  a.inspectionStatus === "ready" &&
                  ["owned", "cleared"].includes(a.rights),
              ),
            );
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    } else {
      settingsRef.current?.close();
    }
    return () => {
      live = false;
    };
  }, [settings, query]);
  useEffect(() => {
    let live = true;
    setImageUrl("");
    if (selectedRun?.outputMediaId)
      void request<{ url: string; previewUrl?: string }>(
        `/v1/media-assets/${encodeURIComponent(selectedRun.outputMediaId)}/download-url?${query}`,
      )
        .then((r) => {
          if (live) setImageUrl(r.previewUrl ?? r.url);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [selectedRun?.outputMediaId, query]);
  useEffect(() => {
    let live = true;
    setLogoUrl("");
    if (settings && form.logoMediaId)
      void request<{ url: string; previewUrl?: string }>(
        `/v1/media-assets/${encodeURIComponent(form.logoMediaId)}/download-url?${query}`,
      )
        .then((r) => {
          if (live) setLogoUrl(r.previewUrl ?? r.url);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [settings, form.logoMediaId, query]);
  function choose(id: string) {
    setSelected(id);
    setMobileHistory(false);
    const url = new URL(location.href);
    if (id) url.searchParams.set("conversation", id);
    else url.searchParams.delete("conversation");
    history.pushState({}, "", url.pathname + url.search);
  }
  async function start(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || !activeTemplate || busy) return;
    setBusy(true);
    setError("");
    const payload = {
      workspaceId,
      brandId,
      templateId,
      input: input.trim(),
      direction,
    };
    const fingerprint = JSON.stringify(payload);
    const storageKey = `originpost:post-request:${auth.user.id}:${workspaceId}:${brandId}`;
    try {
      const old = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (old?.fingerprint === fingerprint && typeof old.key === "string")
        submission.current = old;
    } catch {}
    if (submission.current?.fingerprint !== fingerprint)
      submission.current = { key: crypto.randomUUID(), fingerprint };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(submission.current));
    } catch {}
    try {
      const run = await request<Run>("/v1/agent-posts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": submission.current!.key,
        },
        body: fingerprint,
      });
      setRuns((old) => [run, ...old.filter((r) => r.id !== run.id)]);
      choose(run.id);
      setInput("");
      setDirection("");
      submission.current = null;
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the post.");
    } finally {
      setBusy(false);
    }
  }
  async function uploadTemplateImage(file: File | undefined) {
    if (!file || busy) return;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 16 * 1024 * 1024
    ) {
      setError("Choose a PNG, JPEG, or WebP image up to 16 MB.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const sha256 = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const created = await request<{
        asset: Asset;
        upload: { url: string; headers: Record<string, string> };
      }>("/v1/media-assets/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          brandId,
          kind: "image",
          purpose: "creative",
          fileName: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          sha256,
          rights: uploadRights,
          altText: file.name,
        }),
      });
      const stored = await fetch(created.upload.url, {
        method: "PUT",
        headers: created.upload.headers,
        body: file,
      });
      if (!stored.ok)
        throw new Error("Private storage did not accept the image.");
      const asset = await request<Asset>(
        `/v1/media-assets/${created.asset.id}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        },
      );
      if (asset.status !== "ready" || asset.inspectionStatus !== "ready")
        throw new Error(
          "The image is awaiting inspection. Open Library to check its status.",
        );
      setAssets((old) => [asset, ...old.filter((a) => a.id !== asset.id)]);
      setForm((old) =>
        old.logoMediaId
          ? {
              ...old,
              referenceMediaIds:
                old.referenceMediaIds.length < 3
                  ? [...old.referenceMediaIds, asset.id]
                  : old.referenceMediaIds,
            }
          : { ...old, logoMediaId: asset.id },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Image upload failed.");
    } finally {
      setBusy(false);
    }
  }
  async function saveTemplate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = await request<Template>("/v1/agent-posts/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, brandId, template: form }),
      });
      setTemplates((old) => [saved, ...old]);
      setTemplateId(saved.id);
      closeSettings();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Template could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  function closeSettings() {
    setSettings(false);
    settingsRef.current?.close();
    settingsButton.current?.focus();
  }
  function openSettings() {
    setForm(
      activeTemplate
        ? {
            ...initial,
            ...Object.fromEntries(
              Object.keys(initial).map((k) => [
                k,
                activeTemplate[k as keyof Template],
              ]),
            ),
          }
        : initial,
    );
    setSettings(true);
  }
  return (
    <section className={styles.workspace} aria-label="News creation workspace">
      <aside
        className={`${styles.history} ${mobileHistory ? styles.historyOpen : ""}`}
        aria-label="Post runs"
      >
        <div className={styles.historyHeader}>
          <span>YOUR POSTS</span>
          <button
            aria-label="Close post history"
            onClick={() => setMobileHistory(false)}
          >
            <X size={16} />
          </button>
        </div>
        <button
          className={styles.newPost}
          onClick={() => {
            choose("");
            inputRef.current?.focus();
          }}
        >
          <Plus size={17} /> New post
        </button>
        <p>Saved in {brandName}</p>
        <div className={styles.runList}>
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => choose(r.id)}
              aria-current={r.id === selected ? "page" : undefined}
            >
              <span
                className={`${styles.dot} ${r.status === "ready" ? styles.readyDot : ""}`}
              />
              <span>
                <strong>{r.copy?.headline ?? r.input}</strong>
                <small>
                  {r.status === "ready" ? "Ready for your review" : r.status}
                </small>
              </span>
            </button>
          ))}
          {!runs.length && !loading && <p>Your next story starts here.</p>}
        </div>
        <button
          className={styles.templateButton}
          ref={settingsButton}
          onClick={openSettings}
        >
          <Settings2 size={17} />
          <span>
            Project templates<small>Logo, layout & references</small>
          </span>
        </button>
      </aside>
      <div className={styles.main}>
        <header className={styles.header}>
          <button
            className={styles.mobileToggle}
            onClick={() => setMobileHistory(true)}
            aria-label="Open post history"
          >
            <ChevronLeft size={19} />
          </button>
          <div>
            <strong>News studio</strong>
            <span>{brandName} / Agent</span>
          </div>
          <span className={styles.badge}>
            {loading
              ? "Connecting"
              : capability?.available
                ? "Ready to create"
                : "Setup needed"}
          </span>
          <button onClick={openSettings} aria-label="Open project template">
            <Settings2 size={18} />
          </button>
        </header>
        <div className={styles.body}>
          {!loading && !capability?.available && (
            <div className={styles.setup}>
              <Settings2 size={18} />
              <div>
                <strong>Finish connecting your studio</strong>
                <p>
                  {capability?.reason ??
                    "The workflow API is not available on this server yet."}
                </p>
                <button onClick={() => onNavigate("Agent plugins")}>
                  Open runtime settings <ArrowRight size={13} />
                </button>
              </div>
            </div>
          )}
          {selectedRun ? (
            <article className={styles.result}>
              <div className={styles.request}>{selectedRun.input}</div>
              <div className={styles.speaker}>
                <span>O</span>
                <strong>Origin</strong>
                <small>{selectedRun.template.name}</small>
              </div>
              <h1>
                {selectedRun.status === "ready"
                  ? "Your post is ready to review."
                  : finished(selectedRun)
                    ? "This post needs attention."
                    : "Bringing your story together."}
              </h1>
              <ol className={styles.stages}>
                {stages.map((s, i) => {
                  const index = stages.findIndex(
                      (stage) => stage.id === selectedRun.status,
                    ),
                    done = selectedRun.status === "ready" || index > i,
                    active = selectedRun.status === s.id;
                  return (
                    <li key={s.id} aria-current={active ? "step" : undefined}>
                      {done ? (
                        <Check size={17} />
                      ) : active ? (
                        <LoaderCircle className={styles.spin} size={17} />
                      ) : (
                        <span className={styles.stepNumber}>{i + 1}</span>
                      )}
                      <span>{s.label}</span>
                      {active && <small>In progress</small>}
                    </li>
                  );
                })}
              </ol>
              {selectedRun.error && (
                <p className={styles.error} role="status">
                  {selectedRun.error}
                </p>
              )}
              {selectedRun.copy && (
                <section className={styles.package}>
                  <div className={styles.image}>
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt={selectedRun.copy.headline}
                        onError={() =>
                          setError(
                            "The image preview expired. Refresh the page to request a new link.",
                          )
                        }
                      />
                    ) : (
                      <div>
                        <ImageIcon size={28} />
                        <p>
                          {selectedRun.status === "ready"
                            ? "Loading your image…"
                            : "The finished image will appear here automatically."}
                        </p>
                      </div>
                    )}
                  </div>
                  <div className={styles.copy}>
                    <small>POST COPY</small>
                    <h2>{selectedRun.copy.headline}</h2>
                    <p>{selectedRun.copy.caption}</p>
                    {imageUrl && (
                      <a
                        href={imageUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open full image <ArrowRight size={14} />
                      </a>
                    )}
                  </div>
                </section>
              )}
              <div className={styles.resultActions}>
                <a
                  href={`/content?item=${encodeURIComponent(selectedRun.contentItemId)}`}
                >
                  Sources & review <ArrowRight size={15} />
                </a>
                <button
                  onClick={() => {
                    setInput(selectedRun.input);
                    setTemplateId(selectedRun.template.id);
                    choose("");
                    setDirection(
                      "Create a new visual direction while preserving the verified facts.",
                    );
                  }}
                >
                  Create another version
                </button>
              </div>
              <p className={styles.note}>
                Generated imagery is labeled. Publishing requires review of the
                exact draft.
              </p>
            </article>
          ) : (
            <div className={styles.welcome}>
              <span className={styles.wordmark}>
                O<em>✳</em>
              </span>
              <p className={styles.eyebrow}>YOUR STORY. YOUR SIGNATURE.</p>
              <h1>
                One news link.
                <br />
                <em>A complete post.</em>
              </h1>
              <p>
                Research, words, and a finished image.
                <br />
                Made with your project’s logo and visual direction.
              </p>
              <div className={styles.steps}>
                <span>
                  01 <strong>Verify</strong>
                </span>
                <span>
                  02 <strong>Create</strong>
                </span>
                <span>
                  03 <strong>Review</strong>
                </span>
              </div>
            </div>
          )}
          {(error || loadError) && (
            <div className={styles.error} role="alert">
              {error || loadError}
            </div>
          )}

        </div>
        {!selectedRun && (
          <form className={styles.composerDock} onSubmit={start}>
            <div className={styles.templateSelect}>
              <label htmlFor="post-template">Project template</label>
              <select
                id="post-template"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                <option value="" disabled>
                  Choose a template
                </option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.language} · {t.format}
                  </option>
                ))}
              </select>
              <button type="button" onClick={openSettings}>
                <Plus size={15} /> New
              </button>
            </div>
            <div className={styles.composer}>
              <label htmlFor="news-input" className={styles.srOnly}>
                News link or text
              </label>
              <textarea
                ref={inputRef}
                id="news-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={8000}
                rows={3}
                placeholder="Paste the news link or news text here…"
                required
              />
              <details>
                <summary>
                  Direction for this post <span>Optional</span>
                </summary>
                <label className={styles.srOnly} htmlFor="post-direction">
                  Direction for this post
                </label>
                <textarea
                  id="post-direction"
                  value={direction}
                  onChange={(e) => setDirection(e.target.value)}
                  maxLength={2000}
                  placeholder="For example: focus on the local impact; use a simple illustration."
                />
              </details>
              <div className={styles.composerActions}>
                <span>
                  {activeTemplate
                    ? `${activeTemplate.language} · ${activeTemplate.format} · exact logo`
                    : "Set up your logo and references once"}
                </span>
                <button
                  disabled={
                    busy ||
                    !editable ||
                    !input.trim() ||
                    !activeTemplate ||
                    !capability?.available
                  }
                  type="submit"
                >
                  {busy ? (
                    <LoaderCircle size={16} className={styles.spin} />
                  ) : (
                    <ImageIcon size={16} />
                  )}{" "}
                  Research & create
                </button>
              </div>
            </div>
            <p className={styles.note}>
              Starts research, writing, one paid image request, and exact brand
              composition. Saves an unapproved draft. No auto-publishing.
            </p>
          </form>
        )}
      </div>
      <dialog
        ref={settingsRef}
        className={styles.dialog}
        onCancel={closeSettings}
        onClose={() => setSettings(false)}
        aria-labelledby="template-heading"
      >
        <form onSubmit={saveTemplate}>
          <header>
            <div>
              <small>PROJECT TEMPLATE</small>
              <h2 id="template-heading">Make it unmistakably yours.</h2>
            </div>
            <button
              type="button"
              aria-label="Close template settings"
              onClick={closeSettings}
            >
              <X size={20} />
            </button>
          </header>
          <p className={styles.note}>
            Saved for this brand. Each post keeps the exact template version it
            started with.
          </p>
          <label>
            Template name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              maxLength={100}
            />
          </label>
          <div className={styles.formGrid}>
            <label>
              Language
              <input
                value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}
                required
                minLength={2}
                maxLength={40}
              />
            </label>
            <label>
              Format
              <select
                value={form.format}
                onChange={(e) => setForm({ ...form, format: e.target.value })}
              >
                <option value="portrait">Portrait · 1080 × 1350</option>
                <option value="square">Square · 1080 × 1080</option>
                <option value="story">Story · 1080 × 1920</option>
              </select>
            </label>
          </div>
          <label>
            Approved logo
            <select
              value={form.logoMediaId}
              onChange={(e) =>
                setForm({ ...form, logoMediaId: e.target.value })
              }
              required
            >
              <option value="">Select an original Library image</option>
              {assets
                .filter((a) => !a.syntheticLineage)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fileName}
                  </option>
                ))}
            </select>
          </label>
          {logoUrl && <TemplateLogoPreview url={logoUrl} template={form} />}
          <div className={styles.formGrid}>
            <label>
              Logo position
              <select
                value={form.logoPosition}
                onChange={(e) =>
                  setForm({ ...form, logoPosition: e.target.value })
                }
              >
                <option value="top-left">Top left</option>
                <option value="top-right">Top right</option>
              </select>
            </label>
            <label>
              Logo board crop
              <select
                value={form.logoCrop}
                onChange={(e) => setForm({ ...form, logoCrop: e.target.value })}
              >
                {[
                  "full",
                  "top-left",
                  "top-right",
                  "bottom-left",
                  "bottom-right",
                ].map((v) => (
                  <option key={v} value={v}>
                    {v === "full" ? "Whole logo image" : `${v} quarter`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Logo width · {form.logoWidth}%
              <input
                type="range"
                min={8}
                max={25}
                value={form.logoWidth}
                onChange={(e) =>
                  setForm({ ...form, logoWidth: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Margin · {form.logoMargin}%
              <input
                type="range"
                min={2}
                max={6}
                value={form.logoMargin}
                onChange={(e) =>
                  setForm({ ...form, logoMargin: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Logo plate
              <input
                type="color"
                value={form.logoBackground}
                onChange={(e) =>
                  setForm({ ...form, logoBackground: e.target.value })
                }
              />
            </label>
            <label>
              Text layout
              <select
                value={form.layout}
                onChange={(e) => setForm({ ...form, layout: e.target.value })}
              >
                <option value="headline">Lower headline</option>
                <option value="editorial">Editorial side panel</option>
                <option value="quote">Statement panel</option>
              </select>
            </label>
          </div>
          <fieldset>
            <legend>Style references · up to three</legend>
            <p className={styles.note}>
              These images guide style only. Their text, logo, and factual
              content are not reused.
            </p>
            <div className={styles.referenceList} aria-label="Available style references">{assets
              .filter((a) => a.id !== form.logoMediaId)
              .map((a) => (
                <label className={styles.checkbox} key={a.id}>
                  <input
                    type="checkbox"
                    checked={form.referenceMediaIds.includes(a.id)}
                    disabled={
                      !form.referenceMediaIds.includes(a.id) &&
                      form.referenceMediaIds.length >= 3
                    }
                    onChange={(e) =>
                      setForm({
                        ...form,
                        referenceMediaIds: e.target.checked
                          ? [...form.referenceMediaIds, a.id]
                          : form.referenceMediaIds.filter((id) => id !== a.id),
                      })
                    }
                  />
                  {a.fileName}
                </label>
              ))}</div>
            {!assets.length && (
              <p>No ready, rights-cleared images in this brand.</p>
            )}
            <div className={styles.formGrid}>
              <label>
                Image rights
                <select
                  value={uploadRights}
                  onChange={(e) => setUploadRights(e.target.value)}
                >
                  <option value="owned">I own this image</option>
                  <option value="cleared">I have permission to use it</option>
                </select>
              </label>
              <label>
                Upload logo or reference
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={busy || !editable}
                  onChange={(e) => {
                    void uploadTemplateImage(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <a href="/library" target="_blank" rel="noopener noreferrer">
              Manage images in Library ↗
            </a>
          </fieldset>
          <label>
            Visual instructions
            <textarea
              value={form.styleInstructions}
              onChange={(e) =>
                setForm({ ...form, styleInstructions: e.target.value })
              }
              maxLength={2000}
              rows={3}
            />
          </label>
          <label>
            Footer / social handle
            <input
              value={form.footer}
              onChange={(e) => setForm({ ...form, footer: e.target.value })}
              maxLength={100}
            />
          </label>
          <fieldset>
            <legend>Brand colors</legend>
            <div className={styles.colors}>
              {[
                "Background",
                "Panel",
                "Headline",
                "Supporting text",
                "Accent",
              ].map((name, i) => (
                <label key={name}>
                  {name}
                  <input
                    type="color"
                    value={form.palette[i]}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        palette: form.palette.map((c, j) =>
                          j === i ? e.target.value : c,
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </fieldset>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <footer>
            <p>Original logo pixels are composed after generation.</p>
            <button
              type="submit"
              disabled={busy || !editable || !form.logoMediaId}
            >
              {busy ? "Saving…" : "Save template"}
            </button>
          </footer>
        </form>
      </dialog>
    </section>
  );
}

function TemplateLogoPreview({
  url,
  template,
}: {
  url: string;
  template: typeof initial;
}) {
  const [dimensions, setDimensions] = useState({ width: 1, height: 1 });
  const height =
    template.format === "story"
      ? 1920
      : template.format === "square"
        ? 1080
        : 1350;
  const crop = template.logoCrop !== "full";
  const w = dimensions.width / (crop ? 2 : 1),
    h = dimensions.height / (crop ? 2 : 1);
  const x = crop && template.logoCrop.endsWith("right") ? w : 0,
    y = crop && template.logoCrop.startsWith("bottom") ? h : 0;
  const logoWidth = Math.min(
    (1080 * template.logoWidth) / 100,
    (height * 0.09 * w) / h,
  );
  return (
    <figure className={styles.templatePreview}>
      <div
        className={styles.templateCanvas}
        style={{
          aspectRatio: `1080 / ${height}`,
          background: template.palette[0],
        }}
      >
        <img
          src={url}
          alt=""
          className={styles.measureLogo}
          onLoad={(e) =>
            setDimensions({
              width: e.currentTarget.naturalWidth,
              height: e.currentTarget.naturalHeight,
            })
          }
        />
        <div
          style={{
            position: "absolute",
            top: `${(1080 * template.logoMargin) / height}%`,
            [template.logoPosition === "top-left" ? "left" : "right"]:
              `${template.logoMargin}%`,
            width: `${((logoWidth + 24) / 1080) * 100}%`,
            padding: "1.111%",
            background: template.logoBackground,
          }}
        >
          <svg
            viewBox={`${x} ${y} ${w} ${h}`}
            role="img"
            aria-label="Selected original logo crop"
            style={{ display: "block", width: "100%" }}
          >
            <image
              href={url}
              width={dimensions.width}
              height={dimensions.height}
            />
          </svg>
        </div>
        <span
          style={{
            color: template.palette[2],
            background: template.palette[1],
          }}
        >
          Your headline
          <br />
          <small>{template.footer || "Your footer"}</small>
        </span>
      </div>
      <figcaption>
        Logo placement preview · final text layout is composed after generation
      </figcaption>
    </figure>
  );
}
