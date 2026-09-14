"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  FolderOpen,
  SlidersHorizontal,
  Sparkles,
  MessageSquare,
  Check,
  ChevronLeft,
  Image as ImageIcon,
  LoaderCircle,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import { agentPostSkills } from "@originpost/domain";
import { AgentConnections } from "./agent-connections";
import styles from "./news-post-workspace.module.css";

type Board = { id: string; name: string; status: string };
type Template = {
  boardId?: string;
  skills?: string[];
  exampleCaption?: string;
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
  conversationId?: string;
  parentRunId?: string;
  requestMessage?: string;
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
  imageMode?: "server" | "codex-upload";
  projectId?: string;
  copy?: { headline: string; caption: string };
  copyReview?: {
    status: "passed" | "needs-changes";
    reviewedAt: string;
    checks: { category: string; verdict: string; explanation: string }[];
  };
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
  codexUpload?: boolean;
  reason: string | null;
  research: boolean;
  text: boolean;
  storage: string;
  image: { generation: boolean; model: string };
};
const stages = [
  { id: "researching", label: "Research sources" },
  { id: "writing", label: "Write the post" },
  { id: "reviewing-copy", label: "Check the copy again" },
  { id: "generating", label: "Create the image" },
  { id: "composing", label: "Apply your template" },
  { id: "drafting", label: "Prepare for review" },
];
const finished = (r: Run) =>
  ["ready", "blocked", "failed", "uncertain"].includes(r.status);
const initial = {
  boardId: "",
  skills: ["clear-language", "source-first"] as string[],
  exampleCaption: "",
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
  const [imageMode, setImageMode] = useState<"server" | "codex-upload">(
    "server",
  );
  const [mobileHistory, setMobileHistory] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [boards, setBoards] = useState<Board[]>([]);
  const [contextOpen, setContextOpen] = useState(false);
  const [settingsMode, setSettingsMode] = useState<"new" | "edit">("new");
  const contextRef = useRef<HTMLDialogElement>(null);
  const [uploadRights, setUploadRights] = useState("owned");
  const submission = useRef<{ key: string; fingerprint: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null),
    settingsRef = useRef<HTMLDialogElement>(null),
    settingsButton = useRef<HTMLButtonElement>(null);
  const selectedRun = runs.find((r) => r.id === selected),
    activeTemplate =
      templates.find((t) => t.id === templateId) ?? selectedRun?.template;
  const activeImageMode = selectedRun?.imageMode ?? imageMode;
  const creationAvailable =
    activeImageMode === "codex-upload"
      ? capability?.codexUpload
      : capability?.available;
  const role = auth.memberships.find(
    (m) => m.workspaceId === workspaceId,
  )?.role;
  const editable = Boolean(role && role !== "viewer");
  const projectTemplates = templates.filter(
    (t) => !projectId || t.boardId === projectId,
  );
  const historyRuns = runs
    .filter((r) => !projectId || r.template.boardId === projectId)
    .filter(
      (r, i, list) =>
        list.findIndex(
          (other) =>
            (other.conversationId ?? other.id) === (r.conversationId ?? r.id),
        ) === i,
    );
  const earlierTurns = selectedRun
    ? runs
        .filter(
          (r) =>
            r.id !== selectedRun.id &&
            (r.conversationId ?? r.id) ===
              (selectedRun.conversationId ?? selectedRun.id) &&
            r.createdAt < selectedRun.createdAt,
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : [];
  const canRevise = Boolean(
    selectedRun && finished(selectedRun) && selectedRun.status !== "uncertain",
  );
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
    void request<{ boards: Board[] }>(`/v1/boards?${query}`)
      .then((r) => {
        if (live) setBoards(r.boards.filter((b) => b.status !== "archived"));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [query]);
  useEffect(() => {
    if (contextOpen) contextRef.current?.showModal();
    else contextRef.current?.close();
  }, [contextOpen]);
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
        const openedRun = first
          ? newRuns.find(
              (run) =>
                run.id ===
                new URLSearchParams(window.location.search).get("conversation"),
            )
          : undefined;
        setTemplateId(
          (old) =>
            openedRun?.template.id ??
            (newTemplates.some(
              (t) => t.id === old && (!projectId || t.boardId === projectId),
            )
              ? old
              : (newTemplates.find((t) => !projectId || t.boardId === projectId)
                  ?.id ?? "")),
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
  }, [workspaceId, brandId, auth.user.id, projectId]);
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
    const refreshPreview = () => {
      if (!selectedRun?.outputMediaId) return;
      void request<{ url: string; previewUrl?: string }>(
        `/v1/media-assets/${encodeURIComponent(selectedRun.outputMediaId)}/download-url?${query}`,
      )
        .then((r) => {
          if (live) setImageUrl(r.previewUrl ?? r.url);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    };
    refreshPreview();
    const timer = setInterval(refreshPreview, 4 * 60 * 1000);
    return () => {
      live = false;
      clearInterval(timer);
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
    setInput("");
    setDirection("");
    const chosen = runs.find((r) => r.id === id);
    if (chosen) {
      setProjectId(chosen.template.boardId ?? "");
      setTemplateId(chosen.template.id);
    }
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
      templateId: activeTemplate.id,
      imageMode: activeImageMode,
      input: selectedRun ? selectedRun.input : input.trim(),
      direction: selectedRun ? input.trim() : direction,
      ...(selectedRun ? { parentRunId: selectedRun.id } : {}),
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
  async function uploadTemplateImage(
    file: File | undefined,
    purpose: "logo" | "reference" | "codex",
  ) {
    if (!file || busy) return;
    if (purpose === "reference" && form.referenceMediaIds.length >= 3) {
      setError("A template supports up to three style references.");
      return;
    }
    if (
      purpose === "codex" &&
      !["image/png", "image/jpeg"].includes(file.type)
    ) {
      setError("Upload the PNG or JPEG generated in Codex.");
      return;
    }
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
      if (purpose === "codex" && selectedRun) {
        const brief = await request<{ briefHash: string }>(
          `/v1/agent-posts/${selectedRun.id}/image-brief?${query}`,
        );
        const next = await request<Run>(
          `/v1/agent-posts/${selectedRun.id}/image`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId,
              brandId,
              expectedVersion: selectedRun.version,
              mediaId: asset.id,
              briefHash: brief.briefHash,
            }),
          },
        );
        setRuns((old) => old.map((r) => (r.id === next.id ? next : r)));
        return;
      }
      setForm((old) =>
        purpose === "logo"
          ? {
              ...old,
              logoMediaId: asset.id,
              referenceMediaIds: old.referenceMediaIds.filter(
                (id) => id !== asset.id,
              ),
            }
          : { ...old, referenceMediaIds: [...old.referenceMediaIds, asset.id] },
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
                activeTemplate[k as keyof Template] ??
                  initial[k as keyof typeof initial],
              ]),
            ),
          }
        : initial,
    );
    setSettingsMode(activeTemplate ? "edit" : "new");
    setSettings(true);
  }
  function newTemplate() {
    setForm({ ...initial, boardId: projectId, footer: "" });
    setSettingsMode("new");
    setError("");
    setSettings(true);
  }
  return (
    <section className={styles.workspace} aria-label="News creation workspace">
      <aside
        className={`${styles.history} ${mobileHistory ? styles.historyOpen : ""}`}
        aria-label="Post runs"
      >
        <div className={styles.historyHeader}>
          <span>PROJECT CHATS</span>
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
          <Plus size={17} /> New chat
        </button>
        <label className={styles.projectPicker}>
          <span>
            <FolderOpen size={14} /> Project board
          </span>
          <select
            aria-label="Project board"
            value={projectId}
            onChange={(e) => {
              const id = e.target.value;
              setProjectId(id);
              choose("");
              setTemplateId(
                templates.find((t) => !id || t.boardId === id)?.id ?? "",
              );
            }}
          >
            <option value="">All brand projects</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className={styles.subtleButton}
          onClick={() => onNavigate("Boards")}
        >
          Manage projects <ArrowRight size={13} />
        </button>
        <p>Saved in {brandName}</p>
        <div className={styles.runList}>
          {historyRuns.map((r) => (
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
                  {r.status === "ready"
                    ? "Ready for review"
                    : r.status === "awaiting-image"
                      ? "Waiting for Codex image"
                      : r.status === "uncertain"
                        ? "Check previous attempt"
                        : r.status === "failed" || r.status === "blocked"
                          ? "Needs attention"
                          : "Creating your post"}
                </small>
              </span>
            </button>
          ))}
          {!historyRuns.length && !loading && (
            <p>Your next story starts here.</p>
          )}
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
      <div className={`${styles.main} ${!selectedRun ? styles.starting : ""}`}>
        <header className={styles.header}>
          <button
            className={styles.mobileToggle}
            onClick={() => setMobileHistory(true)}
            aria-label="Open project chats"
          >
            <MessageSquare size={19} />
          </button>
          <div>
            <strong>
              {boards.find((b) => b.id === projectId)?.name ?? "Origin Agent"}
            </strong>
            <span>{brandName} / Agent</span>
          </div>
          <span className={styles.badge}>
            {loading
              ? "Connecting"
              : creationAvailable
                ? "Ready to create"
                : "Setup needed"}
          </span>
          <button
            className={styles.contextButton}
            onClick={() => setContextOpen(true)}
            aria-label="Open agent setup"
          >
            <SlidersHorizontal size={18} />
            <span>Setup</span>
          </button>
        </header>
        <div className={styles.contextBar}>
          {!selectedRun && (
            <label>
              Image creation{" "}
              <select
                aria-label="Image creation"
                value={imageMode}
                onChange={(e) =>
                  setImageMode(e.target.value as "server" | "codex-upload")
                }
              >
                <option value="server">Automatic image API</option>
                <option value="codex-upload">Generate in Codex & upload</option>
              </select>
            </label>
          )}
          <button onClick={openSettings}>
            <FolderOpen size={14} />
            {activeTemplate?.name ?? "Choose a template"}
          </button>
          <button onClick={openSettings}>
            <Sparkles size={14} />
            {activeTemplate?.skills?.length ?? 0} writing skills
          </button>
          <button onClick={openSettings}>
            <ImageIcon size={14} />
            {activeTemplate?.referenceMediaIds.length ?? 0} references
          </button>
          <button onClick={() => setContextOpen(true)}>
            Social accounts <ArrowRight size={13} />
          </button>
        </div>
        <div className={styles.body}>
          {!loading && !creationAvailable && (
            <div className={styles.setup}>
              <Settings2 size={18} />
              <div>
                <strong>Finish connecting your studio</strong>
                <p>
                  {(activeImageMode === "codex-upload" && !capability?.text
                    ? "Assign a tested text runtime for research and copy."
                    : capability?.reason) ??
                    "The workflow API is not available on this server yet."}
                </p>
                <button onClick={() => setContextOpen(true)}>
                  Review setup <ArrowRight size={13} />
                </button>
              </div>
            </div>
          )}
          {selectedRun ? (
            <article className={styles.result}>
              {earlierTurns.length > 0 && (
                <details className={styles.earlierTurns}>
                  <summary>
                    {earlierTurns.length} earlier{" "}
                    {earlierTurns.length === 1 ? "version" : "versions"} in this
                    chat
                  </summary>
                  {earlierTurns.map((turn) => (
                    <div key={turn.id}>
                      <p>
                        <strong>You</strong> {turn.requestMessage ?? turn.input}
                      </p>
                      <button onClick={() => choose(turn.id)}>
                        {turn.copy?.headline ?? "Open this version"}{" "}
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  ))}
                </details>
              )}
              <div className={styles.request}>
                {selectedRun.requestMessage ?? selectedRun.input}
              </div>
              <div className={styles.speaker}>
                <span>O</span>
                <strong>Origin</strong>
                <small>{selectedRun.template.name}</small>
              </div>
              <h1>
                {selectedRun.status === "ready"
                  ? "Your post is ready to review."
                  : selectedRun.status === "awaiting-image"
                    ? "Your image brief is ready for Codex."
                    : finished(selectedRun)
                      ? "This post needs attention."
                      : "Bringing your story together."}
              </h1>
              <details
                className={styles.activity}
                open={!finished(selectedRun)}
              >
                <summary>
                  {selectedRun.status === "ready"
                    ? "Research, copy, and image complete"
                    : "Task activity"}
                </summary>
                <ol className={styles.stages}>
                  {stages.map((s, i) => {
                    const index = stages.findIndex(
                        (stage) =>
                          stage.id ===
                          (selectedRun.status === "awaiting-image"
                            ? "generating"
                            : selectedRun.status),
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
                        {selectedRun.status === "awaiting-image" &&
                        s.id === "generating" ? (
                          <small>Waiting for upload</small>
                        ) : (
                          active && <small>In progress</small>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </details>
              {selectedRun.error && (
                <p className={styles.error} role="status">
                  {selectedRun.error}
                </p>
              )}
              {selectedRun.status === "awaiting-image" && (
                <section
                  className={styles.setup}
                  aria-label="Codex image handoff"
                >
                  <ImageIcon size={22} />
                  <div>
                    <strong>Ready for your Codex image</strong>
                    <p>
                      Download the brief and attach it in Codex with your style
                      references. Ask for the illustration layer. OriginPost
                      adds your exact headline, original logo and AI label after
                      upload.
                    </p>
                    <button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          const brief = await request<unknown>(
                            `/v1/agent-posts/${selectedRun.id}/image-brief?${query}`,
                          );
                          const url = URL.createObjectURL(
                            new Blob([JSON.stringify(brief, null, 2)], {
                              type: "application/json",
                            }),
                          );
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `${selectedRun.id}-codex-brief.json`;
                          a.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        } catch (e) {
                          setError(
                            e instanceof Error
                              ? e.message
                              : "Brief download failed.",
                          );
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Download Codex brief
                    </button>
                    {selectedRun.template.referenceMediaIds.map((id, i) => (
                      <button
                        key={id}
                        disabled={busy}
                        onClick={async () => {
                          try {
                            const result = await request<{ url: string }>(
                              `/v1/media-assets/${id}/download-url?${query}`,
                            );
                            window.open(
                              result.url,
                              "_blank",
                              "noopener,noreferrer",
                            );
                          } catch (e) {
                            setError(
                              e instanceof Error
                                ? e.message
                                : "Reference unavailable.",
                            );
                          }
                        }}
                      >
                        Open style reference {i + 1}
                      </button>
                    ))}
                    {editable && (
                      <label>
                        Upload your Codex-generated PNG or JPEG (you own or have
                        cleared its rights)
                        <input
                          type="file"
                          accept="image/png,image/jpeg"
                          disabled={busy}
                          onChange={(e) => {
                            void uploadTemplateImage(
                              e.target.files?.[0],
                              "codex",
                            );
                            e.target.value = "";
                          }}
                        />
                      </label>
                    )}
                    <p>
                      The upload is recorded as editor-attested AI imagery. It
                      still needs visual and editorial review.
                    </p>
                  </div>
                </section>
              )}
              {selectedRun.copyReview && (
                <section
                  className={styles.copy}
                  aria-label="Second copy review"
                >
                  <h3>
                    {selectedRun.copyReview.status === "passed"
                      ? "Second copy check passed"
                      : "Copy needs changes"}
                  </h3>
                  <ul>
                    {selectedRun.copyReview.checks.map((check) => (
                      <li key={check.category}>
                        <strong>
                          {check.category === "visual-direction"
                            ? "Image direction (text only)"
                            : check.category}
                          :{" "}
                          {check.verdict === "pass"
                            ? "Passed"
                            : "Needs changes"}
                          .
                        </strong>{" "}
                        {check.explanation}
                      </li>
                    ))}
                  </ul>
                  <p>
                    AI review against the saved evidence. An editor still needs
                    to check the actual image and approve publication.
                  </p>
                </section>
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
                {canRevise && (
                  <button
                    onClick={() => {
                      setInput(
                        "Create a new visual direction while preserving the verified facts.",
                      );
                      inputRef.current?.focus();
                    }}
                  >
                    Request changes
                  </button>
                )}
              </div>
              <p className={styles.note}>
                Generated imagery is labeled. Publishing requires review of the
                exact draft.
              </p>
            </article>
          ) : (
            <div className={styles.welcome}>
              <span className={styles.agentMark}>
                <Sparkles size={28} />
              </span>
              <p className={styles.eyebrow}>
                YOUR PROJECT. YOUR CREATIVE TEAM.
              </p>
              <h1>
                What are we
                <br />
                <em>creating today?</em>
              </h1>
              <p>
                Start with a story. Bring your brand, skills, and references.
                <br />
                Keep each version together, from the first brief to review.
              </p>
              <div className={styles.starters}>
                <button
                  onClick={() => {
                    setInput("");
                    inputRef.current?.focus();
                  }}
                >
                  <MessageSquare size={18} />
                  <strong>News to post</strong>
                  <span>Paste a link or a story</span>
                </button>
                <button onClick={newTemplate}>
                  <FolderOpen size={18} />
                  <strong>Build a template</strong>
                  <span>Save your logo and style</span>
                </button>
                <button
                  onClick={() => {
                    openSettings();
                    setForm((old) => ({
                      ...old,
                      styleInstructions:
                        "Follow the uploaded reference’s visual hierarchy and mood. Create an original composition using verified facts; do not copy its claims or branding.",
                    }));
                  }}
                >
                  <ImageIcon size={18} />
                  <strong>Create a similar post</strong>
                  <span>Add an example to follow</span>
                </button>
              </div>
            </div>
          )}
          {(error || loadError) && (
            <div className={styles.error} role="alert">
              {error || loadError}
            </div>
          )}
        </div>
        {(!selectedRun || canRevise) && (
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
                {projectTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} · {t.language} · {t.format}
                  </option>
                ))}
              </select>
              <button type="button" onClick={newTemplate}>
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
                placeholder={
                  selectedRun
                    ? "Describe what to change in the next version…"
                    : "Paste a news link or tell Origin what the post is about…"
                }
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
                    !creationAvailable
                  }
                  type="submit"
                >
                  {busy ? (
                    <LoaderCircle size={16} className={styles.spin} />
                  ) : (
                    <ImageIcon size={16} />
                  )}{" "}
                  {selectedRun ? "Create revision" : "Research & create"}
                </button>
              </div>
            </div>
            <p className={styles.note}>
              {selectedRun
                ? "Creates a separate version from the original story. "
                : ""}
              {activeImageMode === "codex-upload"
                ? "Research, writing and a second copy check prepare your brief using your configured services. Generate the image in Codex, upload it here, then review the finished draft."
                : "Each request uses research, two text passes and one paid image if the copy checks pass. Review the draft before publishing."}
            </p>
          </form>
        )}
      </div>
      <dialog
        ref={contextRef}
        className={`${styles.dialog} ${styles.contextDialog}`}
        onCancel={() => setContextOpen(false)}
        onClose={() => setContextOpen(false)}
        aria-labelledby="agent-context-title"
      >
        <header>
          <div>
            <small>PROJECT CONTEXT</small>
            <h2 id="agent-context-title">Make Origin your own</h2>
          </div>
          <button
            aria-label="Close agent setup"
            onClick={() => setContextOpen(false)}
          >
            <X size={18} />
          </button>
        </header>
        <div className={styles.contextTemplate}>
          <strong>
            {activeTemplate?.name ?? "Start with a brand template"}
          </strong>
          <p>
            {activeTemplate
              ? `${activeTemplate.language} · ${activeTemplate.format} · ${activeTemplate.referenceMediaIds.length} visual references`
              : "Add your original logo, writing skills, and examples once."}
          </p>
          <button
            onClick={() => {
              setContextOpen(false);
              openSettings();
            }}
          >
            Configure template <ArrowRight size={14} />
          </button>
          <button
            onClick={() => {
              setContextOpen(false);
              newTemplate();
            }}
          >
            New template <Plus size={14} />
          </button>
        </div>
        <AgentConnections
          auth={auth}
          workspaceId={workspaceId}
          brandId={brandId}
          onNavigate={onNavigate}
        />
      </dialog>
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
              <h2 id="template-heading">
                {settingsMode === "new"
                  ? "Create your brand template"
                  : "Refine your brand template"}
              </h2>
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
            Project board
            <select
              value={form.boardId}
              onChange={(e) => setForm({ ...form, boardId: e.target.value })}
            >
              <option value="">Brand-wide template</option>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <small className={styles.note}>
              Organizes this template. Board agents and their installed skills
              stay in Boards.
            </small>
          </label>
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
          <label>
            Upload original logo
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy || !editable}
              onChange={(e) => {
                void uploadTemplateImage(e.target.files?.[0], "logo");
                e.target.value = "";
              }}
            />
            <small className={styles.note}>
              Use a logo you own or have permission to use. It is placed exactly
              after image generation.
            </small>
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
            <div className={styles.referencePreviews}>
              {form.referenceMediaIds.map((id) => (
                <ReferenceThumbnail
                  key={id}
                  id={id}
                  query={query}
                  auth={auth}
                  name={
                    assets.find((a) => a.id === id)?.fileName ??
                    "Style reference"
                  }
                  onRemove={() =>
                    setForm({
                      ...form,
                      referenceMediaIds: form.referenceMediaIds.filter(
                        (ref) => ref !== id,
                      ),
                    })
                  }
                />
              ))}
            </div>
            <div
              className={styles.referenceList}
              aria-label="Available style references"
            >
              {assets
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
                            : form.referenceMediaIds.filter(
                                (id) => id !== a.id,
                              ),
                        })
                      }
                    />
                    {a.fileName}
                  </label>
                ))}
            </div>
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
                Add style reference
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={busy || !editable}
                  onChange={(e) => {
                    void uploadTemplateImage(e.target.files?.[0], "reference");
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            <a href="/library" target="_blank" rel="noopener noreferrer">
              Manage images in Library ↗
            </a>
          </fieldset>
          <fieldset>
            <legend>Reusable writing skills</legend>
            <div className={styles.skillGrid}>
              {agentPostSkills.map((skill) => (
                <label key={skill.id} className={styles.skillCard}>
                  <input
                    type="checkbox"
                    checked={form.skills.includes(skill.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        skills: e.target.checked
                          ? [...form.skills, skill.id]
                          : form.skills.filter((id) => id !== skill.id),
                      })
                    }
                  />
                  <span>
                    <strong>{skill.label}</strong>
                    <small>{skill.description}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Example caption to learn the style
            <textarea
              rows={3}
              maxLength={1500}
              value={form.exampleCaption}
              onChange={(e) =>
                setForm({ ...form, exampleCaption: e.target.value })
              }
              placeholder="Paste a post you like. Origin follows its tone and structure, not its facts."
            />
          </label>
          <label>
            Custom writing and visual instructions
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
              {busy
                ? "Saving…"
                : settingsMode === "edit"
                  ? "Save new version"
                  : "Save template"}
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

function ReferenceThumbnail({
  id,
  query,
  auth,
  name,
  onRemove,
}: {
  id: string;
  query: string;
  auth: AuthView;
  name: string;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    void apiFetch(
      `/v1/media-assets/${encodeURIComponent(id)}/download-url?${query}`,
      {},
      auth.csrfToken,
    )
      .then(async (r) => {
        if (!r.ok) return;
        const value = await r.json();
        if (live) setUrl(value.previewUrl ?? value.url);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, query, auth.csrfToken]);
  return (
    <figure>
      {url ? <img src={url} alt={name} /> : <ImageIcon size={24} />}
      <figcaption>{name}</figcaption>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove reference ${name}`}
      >
        <X size={13} />
      </button>
    </figure>
  );
}
