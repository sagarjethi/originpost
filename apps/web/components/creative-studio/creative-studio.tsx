"use client";

import {
  AlertTriangle,
  Check,
  CircleCheck,
  Download,
  FileImage,
  Focus,
  Image as ImageIcon,
  Layers3,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Type,
  WandSparkles,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import styles from "./creative-studio.module.css";
import {
  buildCreativeSpec,
  canEditCreative,
  creativeDimensions,
  creativeDraftTarget,
  defaultCreativeSpec,
  formatAssetBytes,
  isCreativeSource,
  type CreativeFormat,
  type CreativeLayout,
  type CreativeMediaAsset,
  type CreativeSpec,
} from "./creative-studio-utils";

type CreativeTemplate = {
  id: "headline" | "headline-top" | "editorial" | "quote";
  name: string;
  description: string;
  layout: CreativeLayout;
  templateVersion: string;
};

type CreativeProject = {
  id: string;
  workspaceId: string;
  brandId: string;
  version: number;
  name: string;
  currentRevisionId: string;
  status: "draft" | "rendering" | "ready" | "failed";
  latestRenderId?: string;
  outputMediaId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

type CreativeRevision = {
  id: string;
  revisionNumber: number;
  specSnapshot: CreativeSpec;
  specSha256: string;
  createdBy: string;
  createdAt: string;
};

type CreativeRender = {
  id: string;
  revisionId: string;
  status: "rendering" | "ready" | "failed";
  outputMediaId?: string;
  outputSha256?: string;
  error?: string;
  createdAt: string;
  finishedAt?: string;
};

type CreativeDetail = {
  project: CreativeProject;
  currentRevision: CreativeRevision;
  revisions: CreativeRevision[];
  renders: CreativeRender[];
  outputAsset?: CreativeMediaAsset;
};

type ContentChoice = { id: string; version?: number; title: string; summary?: string; status: string; sources?: Array<{ id: string }> };

type ImageGenerationCapability = {
  state: "available" | "setup_required";
  provider: "openai";
  model: string;
  generation: boolean;
  editing: false;
  reason?: string;
};

type ImageGeneration = {
  id: string;
  status: "generating" | "ready" | "failed" | "uncertain";
  model: string;
  prompt: string;
  visualIntent: "editorial_graphic" | "illustration" | "product_visual" | "abstract";
  size: "1024x1024" | "1024x1536" | "1536x1024";
  quality: "low" | "medium" | "high";
  altText: string;
  disclosureRequired: true;
  outputMediaId?: string;
  outputSha256?: string;
  errorSummary?: string;
  createdAt: string;
};

type CreativeStudioProps = {
  auth: AuthView;
  workspaceId: string;
  brandId: string;
  initialContentItemId?: string;
  onOpenContent?: (contentItemId: string) => void;
};

function readableError(body: { message?: string | string[] } | undefined, fallback: string) {
  return Array.isArray(body?.message) ? body.message.join(" ") : body?.message ?? fallback;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  return new Error(readableError(await response.json().catch(() => undefined) as { message?: string | string[] } | undefined, fallback));
}

function statusLabel(status: CreativeProject["status"]) {
  if (status === "rendering") return "Rendering";
  if (status === "ready") return "Output ready";
  if (status === "failed") return "Needs attention";
  return "Draft";
}

export function CreativeStudio({ auth, workspaceId, brandId, initialContentItemId, onOpenContent }: CreativeStudioProps) {
  const role = auth.memberships.find((membership) => membership.workspaceId === workspaceId)?.role;
  const canEdit = canEditCreative(role);
  const [templates, setTemplates] = useState<CreativeTemplate[]>([]);
  const [projects, setProjects] = useState<CreativeProject[]>([]);
  const [assets, setAssets] = useState<CreativeMediaAsset[]>([]);
  const [contentItems, setContentItems] = useState<ContentChoice[]>([]);
  const [generationCapability, setGenerationCapability] = useState<ImageGenerationCapability | null>(null);
  const [generations, setGenerations] = useState<ImageGeneration[]>([]);
  const [generationPrompt, setGenerationPrompt] = useState("");
  const [generationAltText, setGenerationAltText] = useState("");
  const [generationIntent, setGenerationIntent] = useState<ImageGeneration["visualIntent"]>("editorial_graphic");
  const [generationSize, setGenerationSize] = useState<ImageGeneration["size"]>("1024x1536");
  const [generationQuality, setGenerationQuality] = useState<ImageGeneration["quality"]>("medium");
  const [generationRequestKey, setGenerationRequestKey] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [detail, setDetail] = useState<CreativeDetail | null>(null);
  const [name, setName] = useState("Untitled visual");
  const [spec, setSpec] = useState<CreativeSpec>({ ...defaultCreativeSpec, focalPoint: { ...defaultCreativeSpec.focalPoint }, palette: [...defaultCreativeSpec.palette] });
  const [sourceUrl, setSourceUrl] = useState("");
  const [outputUrl, setOutputUrl] = useState("");
  const [attachPlatform, setAttachPlatform] = useState<"instagram" | "facebook">("instagram");
  const [attachTitle, setAttachTitle] = useState("");
  const [attachCaption, setAttachCaption] = useState("");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const sources = useMemo(() => assets.filter(isCreativeSource), [assets]);
  const selectedSource = sources.find((asset) => asset.id === spec.sourceMediaId);
  const selectedGenerationContent = contentItems.find((item) => item.id === spec.contentItemId);
  const dimensions = creativeDimensions[spec.format];
  const renderedFormat = detail?.currentRevision.specSnapshot.format;

  const loadDetail = useCallback(async (projectId: string, showLoading = true): Promise<CreativeDetail | null> => {
    if (!projectId) { setDetail(null); return null; }
    if (showLoading) setDetailLoading(true);
    setError("");
    try {
      const response = await apiFetch(`/v1/creative-studio/projects/${encodeURIComponent(projectId)}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) throw await responseError(response, "Could not load this visual project.");
      const result = await response.json() as CreativeDetail;
      setDetail(result);
      setName(result.project.name);
      setSpec(result.currentRevision.specSnapshot);
      setAttachTitle(result.currentRevision.specSnapshot.headline);
      setAttachCaption([result.currentRevision.specSnapshot.kicker, result.currentRevision.specSnapshot.headline, result.currentRevision.specSnapshot.subtitle, result.currentRevision.specSnapshot.footer].filter(Boolean).join("\n\n"));
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this visual project.");
      return null;
    } finally {
      if (showLoading) setDetailLoading(false);
    }
  }, [auth.csrfToken, workspaceId]);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
      const [templateResponse, projectResponse, mediaResponse, contentResponse, capabilityResponse, generationResponse] = await Promise.all([
        apiFetch("/v1/creative-studio/templates", { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/creative-studio/projects?${query}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/media-assets?${query}&limit=200`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/content-items?${query}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/image-generations/capability?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/image-generations?${query}&limit=12`, { cache: "no-store" }, auth.csrfToken),
      ]);
      if (!templateResponse.ok) throw await responseError(templateResponse, "Could not load visual templates.");
      if (!projectResponse.ok) throw await responseError(projectResponse, "Could not load visual projects.");
      if (!mediaResponse.ok) throw await responseError(mediaResponse, "Could not load Library images.");
      if (!contentResponse.ok) throw await responseError(contentResponse, "Could not load content items.");
      if (!capabilityResponse.ok) throw await responseError(capabilityResponse, "Could not inspect image-generation setup.");
      if (!generationResponse.ok) throw await responseError(generationResponse, "Could not load image-generation history.");
      const [nextTemplates, nextProjects, nextAssets, nextContentItems, nextCapability, nextGenerations] = await Promise.all([
        templateResponse.json() as Promise<CreativeTemplate[]>,
        projectResponse.json() as Promise<CreativeProject[]>,
        mediaResponse.json() as Promise<CreativeMediaAsset[]>,
        contentResponse.json() as Promise<ContentChoice[]>,
        capabilityResponse.json() as Promise<ImageGenerationCapability>,
        generationResponse.json() as Promise<ImageGeneration[]>,
      ]);
      setTemplates(nextTemplates);
      setProjects(nextProjects);
      setAssets(nextAssets);
      setContentItems(nextContentItems);
      setGenerationCapability(nextCapability);
      setGenerations(nextGenerations);
      if (initialContentItemId && nextContentItems.some((item) => item.id === initialContentItemId) && !selectedProjectId) {
        const content = nextContentItems.find((item) => item.id === initialContentItemId)!;
        setSpec((current) => ({ ...current, contentItemId: content.id, headline: current.headline || content.title }));
        setName(`${content.title} visual`);
        setAttachTitle(content.title);
        setAttachCaption(content.summary ?? "");
      } else if (!selectedProjectId && nextProjects[0]) {
        setSelectedProjectId(nextProjects[0].id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Creative Studio is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [auth.csrfToken, brandId, initialContentItemId, selectedProjectId, workspaceId]);

  useEffect(() => { void loadWorkspace(); }, [auth.csrfToken, brandId, workspaceId]);
  useEffect(() => { void loadDetail(selectedProjectId); }, [loadDetail, selectedProjectId]);

  useEffect(() => {
    let cancelled = false;
    setSourceUrl("");
    if (!selectedSource) return;
    void (async () => {
      const response = await apiFetch(`/v1/media-assets/${encodeURIComponent(selectedSource.id)}/download-url?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) return;
      const result = await response.json() as { url: string };
      if (!cancelled) setSourceUrl(result.url);
    })();
    return () => { cancelled = true; };
  }, [auth.csrfToken, selectedSource?.id, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setOutputUrl("");
    if (!detail?.outputAsset?.id || detail.project.status !== "ready") return;
    void (async () => {
      const response = await apiFetch(`/v1/media-assets/${encodeURIComponent(detail.outputAsset!.id)}/download-url?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) return;
      const result = await response.json() as { url: string };
      if (!cancelled) setOutputUrl(result.url);
    })();
    return () => { cancelled = true; };
  }, [auth.csrfToken, detail?.outputAsset?.id, detail?.project.status, workspaceId]);

  function startNewProject() {
    setSelectedProjectId("");
    setDetail(null);
    setName("Untitled visual");
    setSpec({ ...defaultCreativeSpec, ...(initialContentItemId ? { contentItemId: initialContentItemId } : {}), focalPoint: { ...defaultCreativeSpec.focalPoint }, palette: [...defaultCreativeSpec.palette] });
    setAttachTitle("");
    setAttachCaption("");
    setMessage("New project ready. Choose a source image and build the first revision.");
    setError("");
  }

  function updateSpec<K extends keyof CreativeSpec>(key: K, value: CreativeSpec[K]) {
    setSpec((current) => ({ ...current, [key]: value }));
  }

  function chooseSource(id: string) {
    const asset = sources.find((entry) => entry.id === id);
    setSpec((current) => ({ ...current, sourceMediaId: asset?.id ?? "", sourceMediaSha256: asset?.sha256 ?? "" }));
  }

  function chooseTemplate(template: CreativeTemplate) {
    updateSpec("layout", template.layout);
  }

  function changeGenerationInput(action: () => void) {
    action();
    setGenerationRequestKey("");
  }

  async function selectGeneratedOutput(generation: ImageGeneration) {
    if (!generation.outputMediaId || !generation.outputSha256) return;
    const query = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&limit=200`;
    const response = await apiFetch(`/v1/media-assets?${query}`, { cache: "no-store" }, auth.csrfToken);
    if (!response.ok) throw await responseError(response, "The generated image is ready, but Library could not refresh.");
    const nextAssets = await response.json() as CreativeMediaAsset[];
    setAssets(nextAssets);
    const output = nextAssets.find((asset) => asset.id === generation.outputMediaId);
    if (!output) throw new Error("The generated image is ready, but its Library asset is not visible yet.");
    setSpec((current) => ({ ...current, sourceMediaId: output.id, sourceMediaSha256: output.sha256 }));
    setMessage("Generated visual selected as the source. Add exact copy and branding, then save a revision.");
  }

  async function generateVisual() {
    if (!canEdit || generationCapability?.state !== "available") return;
    if (!generationPrompt.trim()) { setError("Describe the visual you want ChatGPT to create."); return; }
    if (!generationAltText.trim()) { setError("Add alt text that describes the intended visual."); return; }
    const requestKey = generationRequestKey || `image-generation-${crypto.randomUUID()}`;
    setGenerationRequestKey(requestKey);
    setBusy("generate"); setError(""); setMessage("Creating one visual foundation with ChatGPT…");
    try {
      const response = await apiFetch("/v1/image-generations", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": requestKey },
        body: JSON.stringify({
          workspaceId,
          brandId,
          ...(spec.contentItemId ? { contentItemId: spec.contentItemId } : {}),
          prompt: generationPrompt.trim(),
          visualIntent: generationIntent,
          size: generationSize,
          quality: generationQuality,
          altText: generationAltText.trim(),
          sourceEvidenceIds: selectedGenerationContent?.sources?.map((source) => source.id) ?? [],
        }),
      }, auth.csrfToken);
      if (!response.ok) throw await responseError(response, "Could not generate this visual.");
      let result = await response.json() as ImageGeneration;
      setGenerations((current) => [result, ...current.filter((entry) => entry.id !== result.id)].slice(0, 12));
      setGenerationRequestKey("");
      if (result.status === "generating") {
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const latestResponse = await apiFetch(`/v1/image-generations/${encodeURIComponent(result.id)}?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
          if (!latestResponse.ok) throw await responseError(latestResponse, "Could not check the image-generation result.");
          result = await latestResponse.json() as ImageGeneration;
          setGenerations((current) => [result, ...current.filter((entry) => entry.id !== result.id)].slice(0, 12));
          if (result.status !== "generating") break;
        }
      }
      if (result.status === "ready") await selectGeneratedOutput(result);
      else if (result.status === "failed") throw new Error(result.errorSummary || "The visual could not be generated.");
      else if (result.status === "uncertain") setMessage("The provider result is uncertain. OriginPost did not retry the paid request; inspect the generation record before trying again.");
      else setMessage("Generation is still running. Refresh Creative Studio to check its immutable record.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not generate this visual.");
    } finally { setBusy(""); }
  }

  async function saveRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    if (!name.trim()) { setError("Name this visual project before saving."); return; }
    if (!selectedSource) { setError("Choose a ready, inspected Library image with owned or cleared rights."); return; }
    if (!spec.headline.trim()) { setError("Add a headline before saving."); return; }
    setBusy("save"); setError(""); setMessage("");
    try {
      const snapshot = buildCreativeSpec(spec);
      const creating = !detail;
      const path = creating
        ? "/v1/creative-studio/projects"
        : `/v1/creative-studio/projects/${encodeURIComponent(detail.project.id)}/revisions`;
      const response = await apiFetch(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(!creating ? { "if-match": String(detail.project.version) } : {}) },
        body: JSON.stringify({ workspaceId, ...(creating ? { brandId } : {}), name: name.trim(), spec: snapshot }),
      }, auth.csrfToken);
      if (!response.ok) throw await responseError(response, "Could not save this visual revision.");
      const result = await response.json() as CreativeDetail;
      setDetail(result);
      setSelectedProjectId(result.project.id);
      setProjects((current) => [result.project, ...current.filter((project) => project.id !== result.project.id)]);
      setMessage(creating ? "Project created with revision 1. The source and settings are locked in its history." : `Revision ${result.currentRevision.revisionNumber} saved. Earlier revisions are unchanged.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this visual revision.");
    } finally { setBusy(""); }
  }

  async function renderImage() {
    if (!canEdit || !detail) return;
    setBusy("render"); setError(""); setMessage("");
    try {
      const response = await apiFetch(`/v1/creative-studio/projects/${encodeURIComponent(detail.project.id)}/revisions/${encodeURIComponent(detail.currentRevision.id)}/render`, {
        method: "POST",
        headers: { "content-type": "application/json", "if-match": String(detail.project.version) },
        body: JSON.stringify({ workspaceId }),
      }, auth.csrfToken);
      if (!response.ok) throw await responseError(response, "Could not render this image.");
      const result = await response.json() as { project: CreativeProject; render: CreativeRender; outputAsset?: CreativeMediaAsset };
      setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
      if (result.render.status === "failed" || result.project.status === "failed") {
        await loadDetail(result.project.id, false);
        throw new Error(result.render.error || result.project.lastError || "The image render failed.");
      }
      if (result.render.status === "ready" || result.project.status === "ready") {
        await loadDetail(result.project.id, false);
        setMessage("Exact platform-ready image rendered and stored in Library.");
      } else {
        setMessage("Rendering the exact platform-ready image in the background…");
        let finished = false;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const latest = await loadDetail(result.project.id, false);
          if (latest?.project.status === "ready") {
            setMessage("Exact platform-ready image rendered and stored in Library.");
            finished = true;
            break;
          }
          if (latest?.project.status === "failed") {
            throw new Error(latest.project.lastError || "The image render failed.");
          }
        }
        if (!finished) setMessage("The image is still rendering. You can keep working and use Refresh to check again.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not render this image.");
    } finally { setBusy(""); }
  }

  async function attachDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !detail?.outputAsset?.id || !spec.contentItemId) return;
    if (!attachTitle.trim() || !attachCaption.trim()) { setError("Add a draft title and caption before attaching the visual."); return; }
    setBusy("attach"); setError(""); setMessage("");
    try {
      const contentVersion = contentItems.find((item) => item.id === spec.contentItemId)?.version;
      const target = creativeDraftTarget(detail.currentRevision.specSnapshot.format, attachPlatform);
      const response = await apiFetch(`/v1/content-items/${encodeURIComponent(spec.contentItemId)}/drafts?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(contentVersion ? { "if-match": String(contentVersion) } : {}) },
        body: JSON.stringify({ platform: target.platform, format: target.format, title: attachTitle.trim(), caption: attachCaption.trim(), mediaIds: [detail.outputAsset.id] }),
      }, auth.csrfToken);
      if (!response.ok) throw await responseError(response, "Could not attach the rendered visual.");
      setMessage(target.format === "story" ? "New immutable Instagram Story draft created. Its review copy is internal and is not sent as a caption." : `New immutable ${target.platform === "instagram" ? "Instagram" : "Facebook"} image draft created.`);
      onOpenContent?.(spec.contentItemId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not attach the rendered visual.");
    } finally { setBusy(""); }
  }

  const previewStyle: CSSProperties = {
    aspectRatio: `${dimensions.width} / ${dimensions.height}`,
    backgroundColor: spec.palette[0],
    color: spec.palette[4],
    fontFamily: spec.font === "newsreader" ? '"Newsreader Variable", Newsreader, serif' : '"Manrope Variable", Manrope, sans-serif',
    textAlign: spec.textAlign,
  };
  const sourceStyle: CSSProperties = { objectPosition: `${spec.focalPoint.x}% ${spec.focalPoint.y}%`, transform: `scale(${spec.zoom})` };

  return <section className={styles.page} aria-labelledby="creative-studio-title">
    <header className={styles.hero}>
      <div><p className="eyebrow">CREATIVE STUDIO</p><h1 id="creative-studio-title">Compose exact social visuals</h1><p>Use cleared Library photography, structured layouts, and immutable revisions. The preview is a guide; the renderer produces the exact platform-ready image.</p></div>
      <div className={styles.heroActions}><button className="secondary-button" onClick={() => void loadWorkspace()} disabled={loading}><RefreshCw size={15} className={loading ? styles.spin : ""} /> Refresh</button>{canEdit ? <button className="new-button" onClick={startNewProject}><Plus size={16} /> New visual</button> : null}</div>
    </header>

    <div className={styles.statusRegion} aria-live="polite" aria-atomic="true">
      {error ? <div className={styles.error} role="alert"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => void loadWorkspace()}>Retry</button></div> : null}
      {message ? <div className={styles.message} role="status"><CircleCheck size={17} />{message}</div> : null}
      {!canEdit ? <div className={styles.readOnly} role="status"><ShieldCheck size={17} /><span><strong>Read-only view</strong> Viewers can inspect projects, revisions, output details, and rendered bytes. A creator, manager, or owner can make changes.</span></div> : null}
    </div>

    <div className={styles.shell}>
      <aside className={styles.projectRail} aria-label="Visual projects">
        <div className={styles.railHead}><div><span>Projects</span><strong>{loading ? "Loading…" : projects.length}</strong></div></div>
        {!loading && projects.length === 0 ? <div className={styles.empty}><Layers3 size={22} /><strong>No visual projects</strong><p>Create the first project from a ready Library image.</p>{canEdit ? <button onClick={startNewProject}>Create project</button> : null}</div> : null}
        <div className={styles.projectList}>{projects.map((project) => <button key={project.id} className={selectedProjectId === project.id ? styles.selectedProject : ""} aria-pressed={selectedProjectId === project.id} onClick={() => setSelectedProjectId(project.id)}><span className={`${styles.projectState} ${styles[project.status]}`}><ImageIcon size={16} /></span><span><strong>{project.name}</strong><small>Updated {new Date(project.updatedAt).toLocaleDateString()} · v{project.version}</small></span><em>{statusLabel(project.status)}</em></button>)}</div>
      </aside>

      <main className={styles.workbench} aria-busy={loading || detailLoading}>
        {detailLoading ? <div className={styles.loadingState} role="status"><RefreshCw className={styles.spin} size={22} /> Loading project…</div> : null}
        <form className={styles.editor} onSubmit={saveRevision}>
          <section className={styles.section}>
            <div className={styles.sectionTitle}><span><Save size={17} /></span><div><h2>{detail ? "Save a new version" : "Start a visual project"}</h2><p>{detail ? `Editing from revision ${detail.currentRevision.revisionNumber}. Your earlier version stays available.` : "Save your layout to start this visual project."}</p></div></div>
            <label className={styles.field}>Project name<input value={name} maxLength={160} required disabled={!canEdit} onChange={(event) => setName(event.target.value)} /></label>
            <label className={styles.field}>Connected content item <span>Optional</span><select value={spec.contentItemId ?? ""} disabled={!canEdit} onChange={(event) => updateSpec("contentItemId", event.target.value || undefined)}><option value="">No connected content</option>{contentItems.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
          </section>

          <details className={styles.generator} open>
            <summary><span><WandSparkles size={18} /></span><span><strong>Generate an image</strong><small>{generationCapability?.state === "available" ? `${generationCapability.model} · ready` : generationCapability?.reason ?? "Checking server setup…"}</small></span><em>{generationCapability?.state === "available" ? "Available" : "Setup required"}</em></summary>
            <div className={styles.generationBody}>
              <div className={styles.generationFlow} aria-label="Image creation journey"><span><i>1</i>Brief</span><b>→</b><span><i>2</i>Generate</span><b>→</b><span><i>3</i>Finish</span><b>→</b><span><i>4</i>Check</span></div>
              <p className={styles.generationNote}><ShieldCheck size={15} /> ChatGPT creates only the visual foundation. Exact text, logos, credits, and safe-area layout stay in OriginPost, and AI lineage follows the image into approval and publish proof.{selectedGenerationContent ? ` ${selectedGenerationContent.sources?.length ?? 0} saved source${selectedGenerationContent.sources?.length === 1 ? "" : "s"} will be linked from “${selectedGenerationContent.title}”.` : " Connect a Content Item above to bind its saved sources."}</p>
              {generationCapability?.state === "setup_required" ? <div className={styles.setupNotice}><AlertTriangle size={15} /><span><strong>Image provider setup needed</strong>{generationCapability.reason} {role === "owner" ? <a href="/setup?provider=images">Configure image generation</a> : "Ask your workspace owner to enable image generation."}</span></div> : null}
              <label className={styles.field}>Creative direction <span>{generationPrompt.length}/8000</span><textarea rows={4} value={generationPrompt} maxLength={8000} disabled={!canEdit || generationCapability?.state !== "available"} placeholder="Example: A clearly illustrative Mumbai skyline at dusk, warm window light, editorial collage, no people posing for camera…" onChange={(event) => changeGenerationInput(() => setGenerationPrompt(event.target.value))} /></label>
              <label className={styles.field}>Alt text <span>{generationAltText.length}/500</span><input value={generationAltText} maxLength={500} disabled={!canEdit || generationCapability?.state !== "available"} placeholder="Describe the intended visual for someone who cannot see it" onChange={(event) => changeGenerationInput(() => setGenerationAltText(event.target.value))} /></label>
              <div className={styles.generationOptions}><label className={styles.field}>Intent<select value={generationIntent} disabled={!canEdit || generationCapability?.state !== "available"} onChange={(event) => changeGenerationInput(() => setGenerationIntent(event.target.value as ImageGeneration["visualIntent"]))}><option value="editorial_graphic">Editorial graphic</option><option value="illustration">Illustration</option><option value="product_visual">Product visual</option><option value="abstract">Abstract</option></select></label><label className={styles.field}>Shape<select value={generationSize} disabled={!canEdit || generationCapability?.state !== "available"} onChange={(event) => changeGenerationInput(() => setGenerationSize(event.target.value as ImageGeneration["size"]))}><option value="1024x1536">Portrait</option><option value="1024x1024">Square</option><option value="1536x1024">Landscape</option></select></label><label className={styles.field}>Quality<select value={generationQuality} disabled={!canEdit || generationCapability?.state !== "available"} onChange={(event) => changeGenerationInput(() => setGenerationQuality(event.target.value as ImageGeneration["quality"]))}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div>
              <div className={styles.generateAction}><p>One click creates one paid, idempotent provider request. Ambiguous results are never retried automatically.</p><button className="new-button" type="button" onClick={() => void generateVisual()} disabled={!canEdit || generationCapability?.state !== "available" || busy === "generate"}>{busy === "generate" ? <RefreshCw className={styles.spin} size={15} /> : <Sparkles size={15} />}{busy === "generate" ? "Generating…" : "Generate one image"}</button></div>
              {generations.length ? <div className={styles.generationHistory}><strong>Recent generations</strong>{generations.slice(0, 4).map((generation) => <button type="button" key={generation.id} disabled={generation.status !== "ready" || !generation.outputMediaId} onClick={() => void selectGeneratedOutput(generation)}><span className={styles[generation.status]}>{generation.status}</span><span>{generation.altText}</span><small>{new Date(generation.createdAt).toLocaleString()}</small></button>)}</div> : null}
            </div>
          </details>

          <section className={styles.section}>
            <div className={styles.sectionTitle}><span><FileImage size={17} /></span><div><h2>Source image</h2><p>Only ready, inspected images with owned or cleared rights are available.</p></div></div>
            {sources.length ? <div className={styles.sourceGrid}>{sources.map((asset) => <label className={spec.sourceMediaId === asset.id ? styles.selectedSource : ""} key={asset.id}><input type="radio" name="source" value={asset.id} checked={spec.sourceMediaId === asset.id} disabled={!canEdit} onChange={() => chooseSource(asset.id)} /><span><ImageIcon size={17} /></span><div><strong>{asset.fileName}</strong><small>{asset.widthPixels && asset.heightPixels ? `${asset.widthPixels}×${asset.heightPixels} · ` : ""}{asset.rights} · {formatAssetBytes(asset.sizeBytes)}{asset.syntheticLineage ? " · AI-generated" : ""}</small></div></label>)}</div> : !loading ? <div className={styles.empty}><FileImage size={22} /><strong>No eligible images</strong><p>Generate a visual above, or add an owned or cleared image in Library.</p></div> : null}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}><span><Layers3 size={17} /></span><div><h2>Template and dimensions</h2><p>Templates select a deterministic layout; every format renders at its exact platform size.</p></div></div>
            <div className={styles.templateGrid}>{templates.map((template) => <button type="button" key={template.id} disabled={!canEdit} className={spec.layout === template.layout ? styles.activeChoice : ""} aria-pressed={spec.layout === template.layout} onClick={() => chooseTemplate(template)}><strong>{template.name}</strong><small>{template.description}</small><em>{template.templateVersion}</em></button>)}</div>
            <fieldset className={styles.formatGrid}><legend>Canvas size</legend>{(Object.keys(creativeDimensions) as CreativeFormat[]).map((format) => { const size = creativeDimensions[format]; return <label className={spec.format === format ? styles.activeChoice : ""} key={format}><input type="radio" name="format" checked={spec.format === format} disabled={!canEdit} onChange={() => updateSpec("format", format)} /><strong>{size.label}</strong><small>{size.width} × {size.height} px</small></label>; })}</fieldset>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}><span><Type size={17} /></span><div><h2>Copy and typography</h2><p>Short fields preserve hierarchy and predictable line wrapping.</p></div></div>
            <div className={styles.twoColumns}><label className={styles.field}>Kicker <span>{spec.kicker?.length ?? 0}/80</span><input value={spec.kicker ?? ""} maxLength={80} disabled={!canEdit} onChange={(event) => updateSpec("kicker", event.target.value)} /></label><label className={styles.field}>Footer <span>{spec.footer?.length ?? 0}/120</span><input value={spec.footer ?? ""} maxLength={120} disabled={!canEdit} onChange={(event) => updateSpec("footer", event.target.value)} /></label></div>
            <label className={styles.field}>Headline <span>{spec.headline.length}/180</span><textarea rows={3} value={spec.headline} maxLength={180} required disabled={!canEdit} onChange={(event) => updateSpec("headline", event.target.value)} /></label>
            <label className={styles.field}>Subtitle <span>{spec.subtitle?.length ?? 0}/280</span><textarea rows={3} value={spec.subtitle ?? ""} maxLength={280} disabled={!canEdit} onChange={(event) => updateSpec("subtitle", event.target.value)} /></label>
            <div className={styles.twoColumns}><label className={styles.field}>Font<select value={spec.font} disabled={!canEdit} onChange={(event) => updateSpec("font", event.target.value as CreativeSpec["font"])}><option value="manrope">Manrope</option><option value="newsreader">Newsreader</option></select></label><label className={styles.field}>Alignment<select value={spec.textAlign} disabled={!canEdit} onChange={(event) => updateSpec("textAlign", event.target.value as CreativeSpec["textAlign"])}><option value="left">Left</option><option value="center">Center</option></select></label></div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}><span><Focus size={17} /></span><div><h2>Crop and focal point</h2><p>Position the important subject before applying the controlled zoom.</p></div></div>
            <div className={styles.sliderGrid}><label>X position <output>{spec.focalPoint.x}%</output><input type="range" min="0" max="100" value={spec.focalPoint.x} disabled={!canEdit} onChange={(event) => updateSpec("focalPoint", { ...spec.focalPoint, x: Number(event.target.value) })} /></label><label>Y position <output>{spec.focalPoint.y}%</output><input type="range" min="0" max="100" value={spec.focalPoint.y} disabled={!canEdit} onChange={(event) => updateSpec("focalPoint", { ...spec.focalPoint, y: Number(event.target.value) })} /></label><label>Zoom <output>{spec.zoom.toFixed(2)}×</output><input type="range" min="1" max="2" step="0.01" value={spec.zoom} disabled={!canEdit} onChange={(event) => updateSpec("zoom", Number(event.target.value))} /></label></div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}><span><Palette size={17} /></span><div><h2>Earthy palette</h2><p>Five exact colors are stored with the revision and renderer manifest.</p></div></div>
            <div className={styles.paletteGrid}>{spec.palette.map((color, index) => <label key={index}><input type="color" value={color} disabled={!canEdit} aria-label={`Palette color ${index + 1}`} onChange={(event) => { const next = [...spec.palette] as CreativeSpec["palette"]; next[index] = event.target.value.toUpperCase(); updateSpec("palette", next); }} /><span>{color}</span></label>)}</div>
          </section>

          <div className={styles.saveBar}><p>{detail ? `Current revision SHA-256 ${detail.currentRevision.specSha256.slice(0, 12)}…` : "Nothing is written until you save the first revision."}</p><button className="new-button" disabled={!canEdit || busy === "save" || loading}><Save size={15} />{busy === "save" ? "Saving…" : detail ? "Save new revision" : "Create project"}</button></div>
        </form>

        <aside className={styles.previewColumn}>
          <section className={styles.previewCard}>
            <div className={styles.previewHead}><div><SlidersHorizontal size={16} /><span><strong>Layout preview</strong><small>Draft guide · not final pixels</small></span></div><em>{dimensions.width}×{dimensions.height}</em></div>
            <div data-format={spec.format} className={`${styles.canvas} ${styles[spec.layout]}`} style={previewStyle}>
              {sourceUrl ? <img src={sourceUrl} alt={selectedSource?.altText || selectedSource?.fileName || "Selected source"} style={sourceStyle} /> : <div className={styles.noSource}><ImageIcon size={28} />Choose a source</div>}
              <div className={styles.scrim} />
              <div className={styles.previewCopy}>{spec.kicker ? <small style={{ color: spec.palette[3] }}>{spec.kicker}</small> : null}<strong style={{color:spec.palette[2]}}>{spec.headline || "Your headline appears here"}</strong>{spec.subtitle ? <p>{spec.subtitle}</p> : null}{spec.footer ? <em>{spec.footer}</em> : null}</div>
              <div className={styles.paletteStrip}>{spec.palette.map((color) => <i key={color} style={{ background: color }} />)}</div>
            </div>
            <p className={styles.previewNote}>The renderer uses the saved revision, source hash, exact canvas, bundled fonts, and template version.</p>
          </section>

          {detail ? <section className={styles.renderCard}>
            <div className={styles.renderHead}><div><span className={`${styles.projectState} ${styles[detail.project.status]}`}><ImageIcon size={16} /></span><div><strong>{statusLabel(detail.project.status)}</strong><small>Revision {detail.currentRevision.revisionNumber} · project v{detail.project.version}</small></div></div><button className="new-button" type="button" onClick={() => void renderImage()} disabled={!canEdit || Boolean(busy)}>{busy === "render" ? <RefreshCw className={styles.spin} size={15} /> : <Download size={15} />}{busy === "render" ? "Rendering…" : "Render exact image"}</button></div>
            {detail.project.lastError ? <div className={styles.inlineError}><AlertTriangle size={15} />{detail.project.lastError}</div> : null}
            {outputUrl && detail.outputAsset ? <div className={styles.output}><img src={outputUrl} alt={`Rendered output for ${detail.project.name}`} /><dl><div><dt>Dimensions</dt><dd>{detail.outputAsset.widthPixels}×{detail.outputAsset.heightPixels}</dd></div><div><dt>Format</dt><dd>{detail.outputAsset.contentType}</dd></div><div><dt>Rights</dt><dd>{detail.outputAsset.rights}</dd></div><div><dt>SHA-256</dt><dd title={detail.outputAsset.sha256}>{detail.outputAsset.sha256.slice(0, 16)}…</dd></div></dl><a className="secondary-button" href={outputUrl} target="_blank" rel="noreferrer"><Download size={15} /> Open actual image</a></div> : <div className={styles.renderEmpty}><ImageIcon size={23} /><strong>No rendered image for this revision</strong><p>Save changes first, then render the exact immutable revision.</p></div>}
          </section> : null}

          {detail?.revisions.length ? <section className={styles.historyCard}><h2>Immutable history</h2><div>{detail.revisions.map((revision) => <article key={revision.id}><span>R{revision.revisionNumber}</span><div><strong>{revision.specSnapshot.headline}</strong><small>{new Date(revision.createdAt).toLocaleString()} · {revision.specSha256.slice(0, 10)}…</small></div>{revision.id === detail.currentRevision.id ? <Check size={15} /> : null}</article>)}</div></section> : null}

          {detail?.outputAsset ? <form className={styles.attachCard} onSubmit={attachDraft}>
            <div className={styles.sectionTitle}><span><Send size={17} /></span><div><h2>Attach to a new draft</h2><p>Creates a new immutable social draft; it never edits an earlier revision.</p></div></div>
            <label className={styles.field}>Content item<select value={spec.contentItemId ?? ""} required disabled={!canEdit} onChange={(event) => updateSpec("contentItemId", event.target.value || undefined)}><option value="">Choose content</option>{contentItems.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
            {renderedFormat === "story" ? <div className={styles.storyTarget}><ShieldCheck size={16} /><span><strong>Instagram Story · 9:16</strong><small>Story renders attach only as Instagram Story drafts.</small></span></div> : <label className={styles.field}>Platform<select value={attachPlatform} disabled={!canEdit} onChange={(event) => setAttachPlatform(event.target.value as typeof attachPlatform)}><option value="instagram">Instagram</option><option value="facebook">Facebook</option></select></label>}
            <label className={styles.field}>Draft title<input value={attachTitle} required maxLength={180} disabled={!canEdit} onChange={(event) => setAttachTitle(event.target.value)} /></label>
            <label className={styles.field}>{renderedFormat === "story" ? "Internal Story review note / copy" : "Caption"}<textarea rows={5} value={attachCaption} required maxLength={10000} disabled={!canEdit} onChange={(event) => setAttachCaption(event.target.value)} />{renderedFormat === "story" ? <small className={styles.internalCopy}>Internal only — not sent as an Instagram Story caption.</small> : null}</label>
            <button className="new-button" disabled={!canEdit || busy === "attach" || !spec.contentItemId}><Send size={15} />{busy === "attach" ? "Attaching…" : renderedFormat === "story" ? "Create Instagram Story draft" : "Create image draft"}</button>
          </form> : null}
        </aside>
      </main>
    </div>
  </section>;
}
