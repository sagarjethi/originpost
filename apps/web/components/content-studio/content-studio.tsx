"use client";

import { AlertTriangle, Bot, CalendarClock, Check, ChevronDown, CircleCheck, Clock3, Eye, FileImage, ImageIcon, MessageSquareText, Play, RefreshCw, Save, Send, ShieldCheck, Smartphone, Sparkles, Video } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import { RemoteCorrectionPanel } from "./remote-correction-panel";
import { FirstCommentPanel } from "./first-comment-panel";
import { hasEligiblePublishProofs, type PublishProofSummary } from "./remote-correction-utils";
import { InstagramCollaboratorPanel } from "./instagram-collaborator-panel";
import { InstagramAiDisclosurePanel } from "./instagram-ai-disclosure-panel";
import { InstagramReelCoverPanel } from "./instagram-reel-cover-panel";
import { InstagramStoryDeliveryGuidance, InstagramStoryInternalCopyNote } from "./instagram-story-guidance";
import { parseCollaboratorCandidates } from "./instagram-collaborator-utils";
import { scheduleConflictHeadline, scheduleConflictReady } from "./schedule-conflict-utils";
import {
  defaultPlatformFormat,
  facebookPageMediaError,
  instagramStoryMediaError,
  isPublishingPlatform,
  platformBadge,
  platformFormats,
  platformLabel,
  type PublishingPlatform,
} from "../platform-ui";

type StudioDraft = {
  id: string;
  revision?: number;
  contentSha256?: string;
  platform: string;
  format: string;
  title?: string;
  caption: string;
  mediaIds?: string[];
  createdAt?: string;
};

type StudioApproval = {
  id: string;
  draftId?: string;
  draftSha256?: string;
  actorName: string;
  decision: string;
  note?: string;
  createdAt?: string;
};

export type StudioContentItem = {
  id: string;
  version?: number;
  title: string;
  summary: string;
  status: string;
  riskLevel: string;
  sources: Array<{ id: string; title: string }>;
  drafts: StudioDraft[];
  approvals: StudioApproval[];
  targets: Array<{ id: string; platform: string; accountId?: string; draftId: string; scheduledFor: string; deliveryMode?: string; status: string }>;
  proofs: PublishProofSummary[];
};

type MediaAsset = {
  id: string;
  kind: "image" | "video" | "audio" | "document";
  purpose: "creative" | "evidence" | "source";
  fileName: string;
  contentType: string;
  sizeBytes: number;
  status: "pending" | "ready" | "rejected";
  rights: "unknown" | "reference-only" | "cleared" | "owned";
  altText?: string;
  sha256?: string;
  inspectionStatus?: "pending"|"ready"|"unavailable"|"failed"|"not_applicable";
  malwareScanStatus?: "pending"|"clean"|"infected"|"unavailable"|"disabled";
  widthPixels?: number;
  heightPixels?: number;
  durationMs?: number;
};

type PublishingAccount = {
  id: string;
  platform: PublishingPlatform;
  displayName: string;
  externalAccountId: string;
  status: "setup_required" | "healthy" | "expiring" | "refresh_failed" | "disconnected";
};
type PostingQueueProfile = { id: string; connectedAccountId: string; enabled: boolean; timezone: string; version: number };
type PostingQueueRow = { account: { id: string }; profile: PostingQueueProfile | null };
type PostingQueueOccurrence = { localDate: string; localTime: string; timezone: string; scheduledFor: string; utcOffset: string; notes: string[] };
type ScheduleConflict = { contentItemId: string; contentTitle: string; targetId: string; scheduledFor: string; status: string; kinds: Array<"exact_content_duplicate" | "account_time_overlap">; minutesApart: number };
type ScheduleConflictPreflight = { conflicts: ScheduleConflict[]; acknowledgementSha256: string; requiresConfirmation: boolean };

type ContentStudioProps = {
  auth: AuthView;
  workspaceId: string;
  brandId: string;
  item: StudioContentItem;
  entryPoint?: "content" | "calendar";
  onChanged: () => void | Promise<void>;
  onOpenLibrary: () => void;
  onOpenChannels: () => void;
  onOpenCreative?: () => void;
};

function futureTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function readableError(body: { message?: string | string[] } | undefined, fallback: string) {
  return Array.isArray(body?.message) ? body.message.join(" ") : body?.message ?? fallback;
}

function decisionLabel(value: string) {
  if (value === "approved") return "Approved";
  if (value === "changes-requested") return "Changes requested";
  if (value === "rejected") return "Rejected";
  return value.replaceAll("_", " ");
}

export function ContentStudio({ auth, workspaceId, brandId, item, entryPoint = "content", onChanged, onOpenLibrary, onOpenChannels, onOpenCreative }: ContentStudioProps) {
  const latestDraft = item.drafts.at(-1);
  const [selectedDraftId, setSelectedDraftId] = useState(latestDraft?.id ?? "");
  const selectedDraft = item.drafts.find((draft) => draft.id === selectedDraftId) ?? latestDraft;
  const [platform, setPlatform] = useState<PublishingPlatform>(selectedDraft && isPublishingPlatform(selectedDraft.platform) ? selectedDraft.platform : "instagram");
  const [format, setFormat] = useState(selectedDraft?.format ?? "image");
  const [title, setTitle] = useState(selectedDraft?.title ?? item.title);
  const [caption, setCaption] = useState(selectedDraft?.caption ?? item.summary);
  const [mediaIds, setMediaIds] = useState<string[]>(selectedDraft?.mediaIds ?? []);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [accounts, setAccounts] = useState<PublishingAccount[]>([]);
  const [postingQueues, setPostingQueues] = useState<PostingQueueRow[]>([]);
  const [queuePreview, setQueuePreview] = useState<PostingQueueOccurrence | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [aiLanguage, setAiLanguage] = useState("English");
  const [aiInstruction, setAiInstruction] = useState("");
  const [scheduledFor, setScheduledFor] = useState(futureTime);
  const [accountId, setAccountId] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"manual_handoff" | "auto_publish">("manual_handoff");
  const [notifyDestinationId, setNotifyDestinationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [schedulePreflight, setSchedulePreflight] = useState<ScheduleConflictPreflight | null>(null);
  const [schedulePreflightBusy, setSchedulePreflightBusy] = useState(false);
  const [schedulePreflightError, setSchedulePreflightError] = useState("");
  const [acknowledgedConflictHash, setAcknowledgedConflictHash] = useState("");
  const [queueSchedulePreflight, setQueueSchedulePreflight] = useState<ScheduleConflictPreflight | null>(null);
  const [queuePreflightBusy, setQueuePreflightBusy] = useState(false);
  const [queuePreflightError, setQueuePreflightError] = useState("");
  const [acknowledgedQueueConflictHash, setAcknowledgedQueueConflictHash] = useState("");
  const [collaboratorCapability, setCollaboratorCapability] = useState<unknown>();
  const [collaboratorCandidates, setCollaboratorCandidates] = useState<unknown[]>([]);
  const [collaboratorStatus, setCollaboratorStatus] = useState<unknown>();
  const [collaboratorError, setCollaboratorError] = useState("");
  const queueCommandKey = useRef("");

  const loadSupportData = useCallback(async () => {
    setLoading(true);
    try {
      const [mediaResponse, accountsResponse, queueResponse] = await Promise.all([
        apiFetch(`/v1/media-assets?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&limit=200`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/channels/accounts?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`/v1/posting-queue-profiles?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" }, auth.csrfToken),
      ]);
      if (!mediaResponse.ok || !accountsResponse.ok || !queueResponse.ok) throw new Error("Could not load Library media, publishing accounts, and posting queues.");
      setAssets(await mediaResponse.json() as MediaAsset[]);
      const result = await accountsResponse.json() as PublishingAccount[];
      setAccounts(result);
      setPostingQueues(await queueResponse.json() as PostingQueueRow[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Content Studio.");
    } finally {
      setLoading(false);
    }
  }, [auth.csrfToken, brandId, workspaceId]);

  useEffect(() => { void loadSupportData(); }, [loadSupportData]);
  useEffect(() => {
    const next = item.drafts.at(-1);
    setSelectedDraftId(next?.id ?? "");
  }, [item.id, item.drafts.length]);
  useEffect(() => {
    if (!selectedDraft) {
      setPlatform("instagram"); setFormat("image"); setTitle(item.title); setCaption(item.summary); setMediaIds([]);
      return;
    }
    const nextPlatform = isPublishingPlatform(selectedDraft.platform) ? selectedDraft.platform : "instagram";
    setPlatform(nextPlatform);
    setFormat(selectedDraft.format);
    setTitle(selectedDraft.title ?? item.title);
    setCaption(selectedDraft.caption);
    setMediaIds(selectedDraft.mediaIds ?? []);
  }, [item.id, selectedDraft?.id]);

  const accountPlatform = selectedDraft && isPublishingPlatform(selectedDraft.platform) ? selectedDraft.platform : platform;
  useEffect(() => {
    setAccountId((current) => accounts.some((account) => account.id === current && account.platform === accountPlatform && account.status !== "disconnected")
      ? current
      : accounts.find((account) => account.platform === accountPlatform && account.status !== "disconnected")?.id ?? "");
  }, [accountPlatform, accounts]);

  const publishableAssets = useMemo(() => assets.filter((asset) => asset.status === "ready" && (asset.rights === "owned" || asset.rights === "cleared") && (asset.kind === "image" || asset.kind === "video") && (asset.malwareScanStatus === undefined || asset.malwareScanStatus === "clean" || asset.malwareScanStatus === "disabled")), [assets]);
  const selectedAssets = mediaIds.map((id) => publishableAssets.find((asset) => asset.id === id)).filter((asset): asset is MediaAsset => Boolean(asset));
  const previewAsset = selectedAssets[0];
  useEffect(() => {
    let cancelled = false;
    setPreviewUrl("");
    if (!previewAsset) return;
    void (async () => {
      const response = await apiFetch(`/v1/media-assets/${encodeURIComponent(previewAsset.id)}/download-url?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
      if (!response.ok) return;
      const body = await response.json() as { url: string };
      if (!cancelled) setPreviewUrl(body.url);
    })();
    return () => { cancelled = true; };
  }, [auth.csrfToken, previewAsset?.id, workspaceId]);

  const selectedApproval = selectedDraft ? item.approvals.findLast((approval) => approval.draftId === selectedDraft.id && (!approval.draftSha256 || !selectedDraft.contentSha256 || approval.draftSha256 === selectedDraft.contentSha256)) : undefined;
  const approvedRevision = selectedApproval?.decision === "approved";
  const publishingAccounts = accounts.filter((account) => account.platform === accountPlatform && account.status !== "disconnected");
  const selectedAccount = publishingAccounts.find((account) => account.id === accountId);
  const selectedQueue = postingQueues.find((row) => row.account.id === accountId)?.profile ?? null;
  const autoAccountReady = selectedAccount && (selectedAccount.status === "healthy" || selectedAccount.status === "expiring");

  useEffect(() => {
    setQueuePreview(null); queueCommandKey.current = "";
    if (!selectedQueue?.enabled || !accountId) return;
    let cancelled = false;
    void (async () => {
      const response = await apiFetch(`/v1/posting-queue-profiles/${encodeURIComponent(accountId)}/preview?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&count=1`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { occurrences?: PostingQueueOccurrence[] };
      if (!cancelled && response.ok) setQueuePreview(body.occurrences?.[0] ?? null);
    })();
    return () => { cancelled = true; };
  }, [accountId, auth.csrfToken, brandId, selectedQueue?.id, selectedQueue?.version, workspaceId]);
  const formats = platformFormats(platform);
  const compatibleAssets = platform === "facebook"
    ? publishableAssets.filter((asset) => asset.kind === "image")
    : platform === "instagram" && format === "story"
      ? publishableAssets.filter((asset) => asset.inspectionStatus === "ready")
      : publishableAssets;
  const reelCoverAssets=publishableAssets.filter((asset)=>asset.kind==="image"&&asset.inspectionStatus==="ready"&&Boolean(asset.sha256));
  const selectedReelVideo=selectedDraft?.format==="reel"&&selectedDraft.mediaIds?.length===1?assets.find((asset)=>asset.id===selectedDraft.mediaIds?.[0]&&asset.kind==="video"):undefined;
  const previewShape = platform === "youtube" || format === "reel" || format === "story" ? "vertical" : "portrait";
  const titleLimit = platform === "youtube" ? 100 : 180;
  const captionLimit = platform === "youtube" ? 5000 : 10000;
  const captionBytes = useMemo(() => new TextEncoder().encode(caption).length, [caption]);
  const editingStory = platform === "instagram" && format === "story";
  const selectedStory = selectedDraft?.platform === "instagram" && selectedDraft.format === "story";
  const selectedInstagramProof = selectedDraft?.platform === "instagram" && accountId
    ? item.proofs.findLast((proof) => proof.platform === "instagram" && proof.accountId === accountId && proof.draftId === selectedDraft.id)
    : undefined;
  const parsedCollaboratorCandidates = useMemo(() => parseCollaboratorCandidates(collaboratorCandidates), [collaboratorCandidates]);
  const relevantCollaboratorCandidates = parsedCollaboratorCandidates.filter((candidate) => candidate.accountId === accountId && candidate.draftId === selectedDraft?.id);
  const latestCollaboratorCandidate = relevantCollaboratorCandidates[0];
  const approvedCollaboratorCandidate = relevantCollaboratorCandidates.find((candidate) => candidate.status === "approved" && candidate.approvalId);

  useEffect(() => {
    setSchedulePreflight(null); setSchedulePreflightError(""); setAcknowledgedConflictHash("");
    if (!selectedDraft || (selectedDraft.platform !== "instagram" && selectedDraft.platform !== "facebook") || !accountId || !approvedRevision) return;
    const date = new Date(scheduledFor);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSchedulePreflightBusy(true);
      void (async () => {
        const response = await apiFetch(`/v1/content-items/${encodeURIComponent(item.id)}/schedule-preflight?workspaceId=${encodeURIComponent(workspaceId)}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(item.version ? { "if-match": String(item.version) } : {}) },
          body: JSON.stringify({ platform: selectedDraft.platform, accountId, draftId: selectedDraft.id, scheduledFor: date.toISOString(), deliveryMode }),
        }, auth.csrfToken);
        const body = await response.json().catch(() => ({})) as ScheduleConflictPreflight & { message?: string | string[] };
        if (!response.ok) throw new Error(readableError(body, "Could not check the calendar for scheduling conflicts."));
        if (!cancelled) {
          setSchedulePreflight(body);
          setAcknowledgedConflictHash((current) => current === body.acknowledgementSha256 ? current : "");
        }
      })().catch((cause) => { if (!cancelled) setSchedulePreflightError(cause instanceof Error ? cause.message : "Could not check the calendar for scheduling conflicts."); })
        .finally(() => { if (!cancelled) setSchedulePreflightBusy(false); });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [accountId, approvedRevision, auth.csrfToken, deliveryMode, item.id, item.version, scheduledFor, selectedDraft?.id, selectedDraft?.platform, workspaceId]);

  useEffect(() => {
    setQueueSchedulePreflight(null); setQueuePreflightError(""); setAcknowledgedQueueConflictHash("");
    if (!selectedDraft || !selectedAccount || !selectedQueue?.enabled || !queuePreview || !approvedRevision) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setQueuePreflightBusy(true);
      void (async () => {
        const response = await apiFetch(`/v1/content-items/${encodeURIComponent(item.id)}/schedule-preflight?workspaceId=${encodeURIComponent(workspaceId)}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(item.version ? { "if-match": String(item.version) } : {}) },
          body: JSON.stringify({ platform: selectedDraft.platform, accountId: selectedAccount.id, draftId: selectedDraft.id, scheduledFor: queuePreview.scheduledFor, timezone: queuePreview.timezone, deliveryMode }),
        }, auth.csrfToken);
        const body = await response.json().catch(() => ({})) as ScheduleConflictPreflight & { message?: string | string[] };
        if (!response.ok) throw new Error(readableError(body, "Could not check the next account slot for conflicts."));
        if (!cancelled) setQueueSchedulePreflight(body);
      })().catch((cause) => { if (!cancelled) setQueuePreflightError(cause instanceof Error ? cause.message : "Could not check the next account slot for conflicts."); })
        .finally(() => { if (!cancelled) setQueuePreflightBusy(false); });
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [approvedRevision, auth.csrfToken, deliveryMode, item.id, item.version, queuePreview?.scheduledFor, queuePreview?.timezone, selectedAccount?.id, selectedDraft?.id, selectedDraft?.platform, selectedQueue?.enabled, workspaceId]);

  const loadCollaboratorData = useCallback(async () => {
    if (selectedDraft?.platform !== "instagram" || !accountId) {
      setCollaboratorCapability(undefined); setCollaboratorCandidates([]); setCollaboratorStatus(undefined); setCollaboratorError(""); return;
    }
    setCollaboratorError("");
    const base = `/v1/content-items/${encodeURIComponent(item.id)}/instagram-collaborators`;
    try {
      const requests = [
        apiFetch(`${base}/capability?workspaceId=${encodeURIComponent(workspaceId)}&accountId=${encodeURIComponent(accountId)}&draftId=${encodeURIComponent(selectedDraft.id)}`, { cache: "no-store" }, auth.csrfToken),
        apiFetch(`${base}/approvals?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken),
      ];
      const statusIndex = selectedInstagramProof ? requests.push(apiFetch(`${base}/proofs/${encodeURIComponent(selectedInstagramProof.id)}/status?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken)) - 1 : -1;
      const responses = await Promise.all(requests);
      if (!responses[0]?.ok || !responses[1]?.ok || (statusIndex >= 0 && !responses[statusIndex]?.ok)) throw new Error("Could not load Instagram publishing-setting checks.");
      setCollaboratorCapability(await responses[0]!.json());
      setCollaboratorCandidates(await responses[1]!.json() as unknown[]);
      setCollaboratorStatus(statusIndex >= 0 ? await responses[statusIndex]!.json() : undefined);
    } catch (cause) {
      setCollaboratorError(cause instanceof Error ? cause.message : "Could not load Instagram publishing-setting checks.");
    }
  }, [accountId, auth.csrfToken, item.id, selectedDraft?.format, selectedDraft?.id, selectedDraft?.platform, selectedInstagramProof?.id, workspaceId]);

  useEffect(() => { void loadCollaboratorData(); }, [loadCollaboratorData]);

  async function post(path: string, body: Record<string, unknown>, fallback: string) {
    const response = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(item.version ? { "if-match": String(item.version) } : {}) },
      body: JSON.stringify(body),
    }, auth.csrfToken);
    const result = await response.json().catch(() => undefined) as ({ message?: string | string[]; drafts?: StudioDraft[] } | undefined);
    if (!response.ok) throw new Error(readableError(result, fallback));
    return result;
  }

  async function saveRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || !caption.trim()) { setError("Add a title and caption before saving."); return; }
    if (platform === "youtube" && (title.length > 100 || captionBytes > 5000 || /[<>]/.test(title) || /[<>]/.test(caption))) { setError("For YouTube, use a title under 100 characters and a description under 5,000 UTF-8 bytes, without angle brackets."); return; }
    if (platform === "facebook") {
      const mediaError = facebookPageMediaError(format, selectedAssets.map((asset) => asset.kind));
      if (mediaError) { setError(mediaError); return; }
    }
    if (platform === "instagram") {
      const mediaError = instagramStoryMediaError(format, selectedAssets);
      if (mediaError) { setError(mediaError); return; }
    }
    setBusy("save"); setError(""); setMessage("");
    try {
      const result = await post(`/v1/content-items/${encodeURIComponent(item.id)}/drafts?workspaceId=${encodeURIComponent(workspaceId)}`, { platform, format, title: title.trim(), caption: caption.trim(), mediaIds }, "Could not save this draft revision.");
      const nextDraft = result?.drafts?.at(-1);
      if (nextDraft) setSelectedDraftId(nextDraft.id);
      setMessage("New draft revision saved. Earlier revisions remain in the history.");
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this draft revision."); }
    finally { setBusy(""); }
  }

  async function createAgentDraft() {
    setBusy("ai-draft"); setError(""); setMessage("");
    try {
      const result = await post(`/v1/content-items/${encodeURIComponent(item.id)}/agent-draft?workspaceId=${encodeURIComponent(workspaceId)}`, { platform, format, language: aiLanguage, ...(aiInstruction.trim() ? { instruction: aiInstruction.trim() } : {}) }, "Could not create a draft with the assigned AI runtime.");
      const nextDraft = result?.drafts?.at(-1);
      if (nextDraft) setSelectedDraftId(nextDraft.id);
      setAiInstruction("");
      setMessage("AI draft saved as a new revision. Check every fact, source, and phrase before review.");
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create an AI draft."); }
    finally { setBusy(""); }
  }

  async function submitForReview() {
    if (!selectedDraft) { setError("Save a draft revision first."); return; }
    if (item.status !== "drafting") { setError("Save a new revision before sending this item to review."); return; }
    setBusy("review"); setError(""); setMessage("");
    try {
      await post(`/v1/content-items/${encodeURIComponent(item.id)}/transitions?workspaceId=${encodeURIComponent(workspaceId)}`, { to: "review", reason: `Review draft ${selectedDraft.id}` }, "Could not send this draft to review.");
      setMessage("Draft sent to review."); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not send this draft to review."); }
    finally { setBusy(""); }
  }

  async function recordDecision(decision: "approved" | "changes-requested" | "rejected") {
    if (!selectedDraft) { setError("Choose a saved revision first."); return; }
    if ((decision === "changes-requested" || decision === "rejected") && !reviewNote.trim()) { setError("Add a short review note for this decision."); return; }
    setBusy(decision); setError(""); setMessage("");
    try {
      await post(`/v1/content-items/${encodeURIComponent(item.id)}/approvals?workspaceId=${encodeURIComponent(workspaceId)}`, { decision, draftId: selectedDraft.id, note: reviewNote.trim() || undefined }, "Could not save the review decision.");
      setReviewNote(""); setMessage(`${decisionLabel(decision)} for revision ${selectedDraft.revision ?? selectedDraft.id}.`); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the review decision."); }
    finally { setBusy(""); }
  }

  async function scheduleSocial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDraft || (selectedDraft.platform !== "instagram" && selectedDraft.platform !== "facebook")) { setError("Choose an approved Instagram or Facebook Page revision."); return; }
    const schedulePlatform = selectedDraft.platform;
    const scheduleLabel = platformLabel(schedulePlatform);
    if (!approvedRevision) { setError("This exact draft revision needs approval before scheduling."); return; }
    if (!selectedAccount || selectedAccount.platform !== schedulePlatform) { setError(schedulePlatform === "facebook" ? "Choose a Facebook Page." : `Choose a ${scheduleLabel} account.`); return; }
    if (deliveryMode === "auto_publish" && !autoAccountReady) { setError("Run Connection Doctor and fix this account before auto publishing."); return; }
    if (schedulePlatform === "instagram" && latestCollaboratorCandidate?.status === "pending_approval") { setError("Approve the latest Instagram publishing settings before scheduling this post."); return; }
    const date = new Date(scheduledFor);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) { setError("Choose a publish time in the future."); return; }
    if (!schedulePreflight) { setError("Wait for the calendar conflict check before scheduling."); return; }
    if (schedulePreflight.requiresConfirmation && acknowledgedConflictHash !== schedulePreflight.acknowledgementSha256) { setError("Review and confirm the duplicate or timing warnings first."); return; }
    setBusy("schedule"); setError(""); setMessage("");
    try {
      await post(`/v1/content-items/${encodeURIComponent(item.id)}/schedule?workspaceId=${encodeURIComponent(workspaceId)}`, { platform: schedulePlatform, accountId, draftId: selectedDraft.id, scheduledFor: date.toISOString(), deliveryMode, ...(schedulePreflight.requiresConfirmation ? { conflictAcknowledgementSha256: schedulePreflight.acknowledgementSha256 } : {}), ...(schedulePlatform === "instagram" && approvedCollaboratorCandidate?.approvalId ? { instagramPublishApprovalId: approvedCollaboratorCandidate.approvalId } : {}), ...(notifyDestinationId.trim() ? { notifyDestinationId: notifyDestinationId.trim() } : {}) }, `Could not schedule this ${scheduleLabel} post.`);
      setMessage(selectedDraft.format === "story" ? deliveryMode === "manual_handoff" ? "Manual Instagram Story handoff scheduled with the existing reminder and proof path." : "Basic Instagram Story auto publish scheduled without interactive stickers." : deliveryMode === "manual_handoff" ? `Manual ${scheduleLabel} handoff scheduled.` : `${scheduleLabel} auto publish scheduled.`); await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : `Could not schedule this ${scheduleLabel} post.`); }
    finally { setBusy(""); }
  }

  async function scheduleNextAvailable() {
    if (!selectedDraft || !selectedAccount || !selectedQueue?.enabled || !queuePreview) { setError("Set up an enabled account queue in Channels, then refresh this draft."); return; }
    if (!approvedRevision) { setError("This exact draft revision needs approval before queue scheduling."); return; }
    if (selectedDraft.platform === "instagram" && latestCollaboratorCandidate?.status === "pending_approval") { setError("Approve the latest Instagram publishing settings before queue scheduling."); return; }
    if (!item.version) { setError("Refresh this Content Item before queue scheduling."); return; }
    if (!queueSchedulePreflight || !scheduleConflictReady(queueSchedulePreflight, acknowledgedQueueConflictHash)) { setError(queueSchedulePreflight?.requiresConfirmation ? "Review and confirm the next-slot scheduling warnings first." : "Wait for the next-slot conflict check before reserving."); return; }
    if (!queueCommandKey.current) queueCommandKey.current = `queue-ui-${crypto.randomUUID()}`;
    setBusy("schedule-next"); setError(""); setMessage("");
    try {
      const response = await apiFetch(`/v1/content-items/${encodeURIComponent(item.id)}/schedule-next`, { method: "POST", headers: { "content-type": "application/json", "if-match": String(item.version), "idempotency-key": queueCommandKey.current }, body: JSON.stringify({ workspaceId, brandId, draftId: selectedDraft.id, connectedAccountId: selectedAccount.id, deliveryMode, expectedProfileVersion: selectedQueue.version, ...(queueSchedulePreflight.requiresConfirmation ? { conflictAcknowledgementSha256: queueSchedulePreflight.acknowledgementSha256 } : {}), ...(selectedDraft.platform === "instagram" && approvedCollaboratorCandidate?.approvalId ? { instagramPublishApprovalId: approvedCollaboratorCandidate.approvalId } : {}), ...(notifyDestinationId.trim() ? { notifyDestinationId: notifyDestinationId.trim() } : {}) }) }, auth.csrfToken);
      const body = await response.json().catch(() => ({})) as { message?: string | string[]; target?: { scheduledFor?: string } };
      if (!response.ok) throw new Error(readableError(body, "Could not reserve the next account slot."));
      queueCommandKey.current = "";
      setMessage(`Reserved ${selectedAccount.displayName}’s next free slot: ${new Date(body.target?.scheduledFor ?? queuePreview.scheduledFor).toLocaleString([], { timeZone: queuePreview.timezone, dateStyle: "medium", timeStyle: "short" })} ${queuePreview.timezone} (UTC${queuePreview.utcOffset}).`);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not reserve the next account slot."); }
    finally { setBusy(""); }
  }

  async function saveCollaboratorCandidate(input: { accountId: string; draftId: string; collaborators: string[]; isAiGenerated: boolean }) {
    setBusy("collaborator-save"); setCollaboratorError(""); setMessage("");
    try {
      await post(`/v1/content-items/${encodeURIComponent(item.id)}/instagram-collaborators/candidates?workspaceId=${encodeURIComponent(workspaceId)}`, { draftId: input.draftId, accountId: input.accountId, collaborators: input.collaborators, shareToFeed:approvedCollaboratorCandidate?.shareToFeed??true,isAiGenerated:input.isAiGenerated,...(approvedCollaboratorCandidate?.reelCover?{reelCover:approvedCollaboratorCandidate.reelCover.mode==="custom_image"?{mode:"custom_image",mediaId:approvedCollaboratorCandidate.reelCover.mediaId}:approvedCollaboratorCandidate.reelCover}:{}) }, "Could not save this collaborator approval request.");
      setMessage("Collaborator list saved for human approval. Nothing was scheduled or sent.");
      await loadCollaboratorData();
    } catch (cause) { setCollaboratorError(cause instanceof Error ? cause.message : "Could not save this collaborator approval request."); }
    finally { setBusy(""); }
  }

  async function approveCollaboratorCandidate(candidateId: string) {
    setBusy("collaborator-approve"); setCollaboratorError(""); setMessage("");
    try {
      await post(`/v1/content-items/${encodeURIComponent(item.id)}/instagram-collaborators/candidates/${encodeURIComponent(candidateId)}/approve?workspaceId=${encodeURIComponent(workspaceId)}`, {}, "Could not approve this collaborator list.");
      setMessage("Exact collaborator list approved for this Instagram account and draft.");
      await onChanged();
      await loadCollaboratorData();
    } catch (cause) { setCollaboratorError(cause instanceof Error ? cause.message : "Could not approve this collaborator list."); }
    finally { setBusy(""); }
  }

  async function saveReelCoverCandidate(input:{accountId:string;draftId:string;collaborators:string[];shareToFeed:boolean;isAiGenerated:boolean;reelCover:{mode:"instagram_default"}|{mode:"video_frame";offsetMs:number}|{mode:"custom_image";mediaId:string}}){
    setBusy("reel-cover-save");setCollaboratorError("");setMessage("");try{await post(`/v1/content-items/${encodeURIComponent(item.id)}/instagram-collaborators/candidates?workspaceId=${encodeURIComponent(workspaceId)}`,input,"Could not save this Reel cover approval request.");setMessage("Reel cover and feed choice saved for exact human approval. Nothing was scheduled or published.");await loadCollaboratorData();}catch(cause){setCollaboratorError(cause instanceof Error?cause.message:"Could not save this Reel cover approval request.");}finally{setBusy("");}
  }

  async function saveAiDisclosureCandidate(input:{isAiGenerated:boolean}){
    if(!selectedDraft||!accountId)return;
    setBusy("ai-disclosure-save");setCollaboratorError("");setMessage("");
    try{
      await post(`/v1/content-items/${encodeURIComponent(item.id)}/instagram-collaborators/candidates?workspaceId=${encodeURIComponent(workspaceId)}`,{
        draftId:selectedDraft.id,
        accountId,
        collaborators:approvedCollaboratorCandidate?.collaborators??[],
        shareToFeed:approvedCollaboratorCandidate?.shareToFeed??true,
        isAiGenerated:input.isAiGenerated,
        ...(approvedCollaboratorCandidate?.reelCover?{reelCover:approvedCollaboratorCandidate.reelCover.mode==="custom_image"?{mode:"custom_image",mediaId:approvedCollaboratorCandidate.reelCover.mediaId}:approvedCollaboratorCandidate.reelCover}:{}),
      },"Could not save this Instagram AI-label approval request.");
      setMessage("Instagram AI-label choice saved for exact human approval. Nothing was scheduled or published.");
      await loadCollaboratorData();
    }catch(cause){setCollaboratorError(cause instanceof Error?cause.message:"Could not save this Instagram AI-label approval request.");}
    finally{setBusy("");}
  }

  function changePlatform(value: PublishingPlatform) {
    setPlatform(value);
    setFormat(defaultPlatformFormat(value));
    if (value === "facebook") setMediaIds([]);
  }

  function changeFormat(value: string) {
    setFormat(value);
    if (platform === "facebook") setMediaIds((current) => value === "text" ? [] : current.slice(0, 1));
    if (platform === "instagram" && value === "story") setMediaIds((current) => current.filter((id) => publishableAssets.some((asset) => asset.id === id && asset.inspectionStatus === "ready")).slice(0, 1));
  }

  function toggleMedia(id: string) {
    if (platform === "facebook" || (platform === "instagram" && format === "story")) {
      if (format === "text") return;
      setMediaIds((current) => current.includes(id) ? [] : [id]);
      return;
    }
    setMediaIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  }

  const role = auth.memberships.find((membership) => membership.workspaceId === workspaceId)?.role ?? auth.memberships[0]?.role;
  const canEdit = role !== "viewer";
  const canReview = role === "owner" || role === "manager";

  return <section className="content-studio panel" id="content-studio" aria-labelledby="content-studio-title">
    <header className="studio-head">
      <div><p className="eyebrow">{entryPoint === "calendar" ? "CALENDAR · CONTENT STUDIO" : "CONTENT STUDIO"}</p><h2 id="content-studio-title">Build, review, and schedule</h2><p>Every save creates a new revision. Approval and publishing stay tied to the exact version you reviewed.</p></div>
      <div className="studio-head-actions">{onOpenCreative ? <button className="secondary-button" onClick={onOpenCreative}><ImageIcon size={15} /> Create visual</button> : null}<button className="secondary-button" onClick={() => void loadSupportData()} disabled={loading}><RefreshCw size={15} /> Refresh tools</button></div>
    </header>

    {error ? <div className="studio-alert" role="alert"><AlertTriangle size={16} />{error}</div> : null}
    {message ? <div className="studio-message" role="status"><CircleCheck size={16} />{message}</div> : null}

    <div className="studio-layout">
      <div className="studio-workbench">
        <section className="studio-section">
          <div className="studio-section-title"><span><Save size={16} /></span><div><h3>Draft revision</h3><p>Edit a saved version or start from the content brief.</p></div></div>
          {item.drafts.length ? <label className="studio-label">Revision history<div className="studio-select"><select value={selectedDraft?.id ?? ""} onChange={(event) => setSelectedDraftId(event.target.value)}>{item.drafts.map((draft) => <option value={draft.id} key={draft.id}>Revision {draft.revision ?? "—"} · {draft.platform} {draft.format}</option>)}</select><ChevronDown size={15} /></div></label> : <p className="studio-empty-copy">No draft yet. Create the first revision below.</p>}
          <div className="studio-ai-assist">
            <span><Bot size={18} /></span><div><strong>Draft with the brand runtime</strong><p>Uses the exact workspace assignment. An assigned provider never silently falls back to another model.</p></div>
            <label>Language<select value={aiLanguage} onChange={(event) => setAiLanguage(event.target.value)}><option>English</option><option>Gujarati</option><option>Simple Gujarati-English</option><option>Hindi</option></select></label>
            <label className="studio-ai-instruction">Direction <span>Optional</span><input value={aiInstruction} maxLength={2000} placeholder="Tone, audience, or angle—never add unsupported facts" onChange={(event) => setAiInstruction(event.target.value)} /></label>
            <button type="button" onClick={() => void createAgentDraft()} disabled={!canEdit || Boolean(busy)}>{busy === "ai-draft" ? <RefreshCw className="analytics-spin" size={14} /> : <Sparkles size={14} />}{busy === "ai-draft" ? "Drafting…" : "Create AI revision"}</button>
          </div>
          <form className="studio-draft-form" onSubmit={saveRevision}>
            <div className="studio-field-grid"><label className="studio-label">Platform<select value={platform} onChange={(event) => changePlatform(event.target.value as PublishingPlatform)}><option value="instagram">Instagram</option><option value="facebook">Facebook Page</option><option value="youtube">YouTube</option></select></label><label className="studio-label">Format<select value={format} onChange={(event) => changeFormat(event.target.value)}>{formats.map((value) => <option value={value} key={value}>{value === "short" ? "Short" : value[0]!.toUpperCase() + value.slice(1)}</option>)}</select></label></div>
            <label className="studio-label">{editingStory ? "Internal Story title" : "Title"} <span>{title.length}/{titleLimit}</span><input value={title} required maxLength={titleLimit} onChange={(event) => setTitle(event.target.value)} /></label>
            <label className={`studio-label ${editingStory ? "story-review-field" : ""}`}>{editingStory ? "Internal Story review note / copy" : "Caption or description"} <span>{platform === "youtube" ? `${captionBytes.toLocaleString()}/5,000 bytes` : `${caption.length.toLocaleString()}/${captionLimit.toLocaleString()}`}</span><textarea rows={7} value={caption} required maxLength={captionLimit} aria-describedby={editingStory ? "story-copy-note" : undefined} onChange={(event) => setCaption(event.target.value)} />{editingStory ? <InstagramStoryInternalCopyNote id="story-copy-note" /> : null}</label>
            <div className="studio-form-foot"><p>Saving does not replace revision {selectedDraft?.revision ?? "—"}; it creates the next revision.</p><button className="new-button" disabled={!canEdit || busy === "save"}><Save size={15} />{busy === "save" ? "Saving…" : "Save new revision"}</button></div>
          </form>
        </section>

        <section className="studio-section">
          <div className="studio-section-title"><span><FileImage size={16} /></span><div><h3>{editingStory ? "Story media" : "Ready Library media"}</h3><p>{editingStory ? "Choose exactly one ready, checked 9:16 image or video. Other shapes use a center crop in preview." : platform === "facebook" ? format === "text" ? "Facebook Page text posts do not use media." : "Choose exactly one checked, owned or cleared image." : "Only checked images and videos with owned or cleared rights can be attached."}</p></div><button onClick={onOpenLibrary}>Open Library</button></div>
          <div className="studio-media-list">
            {platform === "facebook" && format === "text" ? <div className="studio-empty"><MessageSquareText size={21} /><strong>Text-only Page post</strong><p>Your title and caption will be saved without an image.</p></div> : compatibleAssets.map((asset) => <label className={`studio-media-option ${mediaIds.includes(asset.id) ? "selected" : ""}`} key={asset.id}><input type="checkbox" checked={mediaIds.includes(asset.id)} onChange={() => toggleMedia(asset.id)} /><span>{asset.kind === "video" ? <Video size={17} /> : <ImageIcon size={17} />}</span><div><strong>{asset.fileName}</strong><small>{asset.kind} · {asset.rights} · {(asset.sizeBytes / 1024 / 1024).toFixed(1)} MB</small></div></label>)}
            {platform !== "facebook" || format !== "text" ? !loading && compatibleAssets.length === 0 ? <div className="studio-empty"><FileImage size={21} /><strong>No ready publishing media</strong><p>{platform === "facebook" ? "Upload one owned or cleared image in Library." : "Upload an owned or cleared image or video in Library."}</p><button onClick={onOpenLibrary}>Open Library</button></div> : null : null}
          </div>
        </section>

        <section className="studio-section">
          <div className="studio-section-title"><span><MessageSquareText size={16} /></span><div><h3>Review exact revision</h3><p>Choose a revision above. The saved decision remains tied to its content hash.</p></div></div>
          <div className={`revision-state ${selectedApproval?.decision ?? "waiting"}`}><ShieldCheck size={17} /><div><strong>{selectedApproval ? decisionLabel(selectedApproval.decision) : "No decision for this revision"}</strong><small>{selectedApproval ? `${selectedApproval.actorName}${selectedApproval.createdAt ? ` · ${new Date(selectedApproval.createdAt).toLocaleString()}` : ""}` : "Send the draft to review, then record a decision."}</small>{selectedApproval?.note ? <p>{selectedApproval.note}</p> : null}</div></div>
          <div className="studio-review-actions"><button className="secondary-button" onClick={() => void submitForReview()} disabled={!canEdit || !selectedDraft || item.status !== "drafting" || Boolean(busy)}><Send size={15} />{busy === "review" ? "Sending…" : item.status === "review" ? "In review" : "Submit for review"}</button></div>
          <label className="studio-label">Review note<textarea rows={3} value={reviewNote} maxLength={1000} placeholder="What should change, or why is this ready?" onChange={(event) => setReviewNote(event.target.value)} /></label>
          <div className="decision-grid"><button className="approve" onClick={() => void recordDecision("approved")} disabled={!canReview || item.status !== "review" || item.sources.length === 0 || Boolean(busy)}><Check size={15} /> Approve revision</button><button onClick={() => void recordDecision("changes-requested")} disabled={!canReview || item.status !== "review" || Boolean(busy)}>Request changes</button><button className="reject" onClick={() => void recordDecision("rejected")} disabled={!canReview || item.status !== "review" || Boolean(busy)}>Reject</button></div>
          {!canReview ? <p className="studio-permission-note">A manager or owner records review decisions.</p> : item.sources.length === 0 ? <p className="studio-permission-note warning">Add at least one source before approval.</p> : null}
        </section>

        {selectedDraft?.platform==="instagram"&&selectedDraft.format==="reel"&&accountId?<InstagramReelCoverPanel workspaceId={workspaceId} csrfToken={auth.csrfToken} accountId={accountId} draftId={selectedDraft.id} candidateResponse={collaboratorCandidates} coverAssets={reelCoverAssets.map((asset)=>({id:asset.id,fileName:asset.fileName,sha256:asset.sha256!,widthPixels:asset.widthPixels,heightPixels:asset.heightPixels,rights:asset.rights,inspectionStatus:asset.inspectionStatus}))} videoDurationMs={selectedReelVideo?.durationMs} canEdit={canEdit} canApprove={canReview} busy={busy.includes("reel-cover")||busy==="collaborator-approve"} onSave={saveReelCoverCandidate} onApprove={approveCollaboratorCandidate}/>:null}

        {selectedDraft?.platform === "instagram" && accountId ? <InstagramAiDisclosurePanel
          accountId={accountId}
          draftId={selectedDraft.id}
          candidateResponse={collaboratorCandidates}
          canEdit={canEdit}
          canApprove={canReview}
          busy={busy === "ai-disclosure-save" || busy === "collaborator-approve"}
          error={collaboratorError}
          proof={selectedInstagramProof?.instagramAiDisclosure}
          onSave={saveAiDisclosureCandidate}
          onApprove={approveCollaboratorCandidate}
        /> : null}

        {selectedDraft?.platform === "instagram" && selectedDraft.format !== "story" && accountId ? <InstagramCollaboratorPanel
          accountId={accountId}
          draftId={selectedDraft.id}
          draftSha256={selectedDraft.contentSha256 ?? ""}
          format={selectedDraft.format}
          capabilityResponse={collaboratorCapability}
          candidateResponse={collaboratorCandidates}
          settingsApprovalResponse={approvedCollaboratorCandidate}
          inviteProofResponse={selectedInstagramProof}
          statusResponse={collaboratorStatus}
          canEdit={canEdit}
          canApprove={canReview}
          busy={busy.startsWith("collaborator")}
          error={collaboratorError}
          onSaveForApproval={saveCollaboratorCandidate}
          onApproveCandidate={approveCollaboratorCandidate}
          onRefreshStatuses={loadCollaboratorData}
        /> : null}

        {selectedDraft?.platform === "instagram" || selectedDraft?.platform === "facebook" ? <section className="studio-section">
          <div className="studio-section-title"><span><CalendarClock size={16} /></span><div><h3>Schedule {selectedStory ? "Instagram Story" : platformLabel(selectedDraft.platform)}</h3><p>{selectedStory ? "Use manual handoff for interactive Story features, or auto publish a basic Story." : "Choose manual handoff or a checked auto-publishing account."}</p></div></div>
          <form className="studio-schedule-form" onSubmit={scheduleSocial}>
            <div className="studio-field-grid"><label className="studio-label">{selectedDraft.platform === "facebook" ? "Page" : "Account"}<select value={accountId} required onChange={(event) => setAccountId(event.target.value)}><option value="">Choose {selectedDraft.platform === "facebook" ? "a Page" : "an account"}</option>{publishingAccounts.map((account) => <option value={account.id} key={account.id}>{account.displayName} · {decisionLabel(account.status)}</option>)}</select></label><label className="studio-label">Publish time<input type="datetime-local" value={scheduledFor} min={futureTime()} required onChange={(event) => setScheduledFor(event.target.value)} /></label></div>
            <fieldset className={`delivery-choice ${selectedStory ? "story-delivery-choice" : ""}`}><legend>Delivery</legend><label><input type="radio" name="deliveryMode" checked={deliveryMode === "manual_handoff"} onChange={() => setDeliveryMode("manual_handoff")} /><span>{selectedStory ? <InstagramStoryDeliveryGuidance mode="manual_handoff" /> : <><strong>Manual handoff</strong><small>OriginPost reminds a person to post and save proof.</small></>}</span></label><label><input type="radio" name="deliveryMode" checked={deliveryMode === "auto_publish"} onChange={() => setDeliveryMode("auto_publish")} /><span>{selectedStory ? <InstagramStoryDeliveryGuidance mode="auto_publish" /> : <><strong>Auto publish</strong><small>Requires a healthy checked {platformLabel(selectedDraft.platform)} connection.</small></>}</span></label></fieldset>
            {deliveryMode === "manual_handoff" ? <label className="studio-label">Reminder destination ID <span>Optional</span><input value={notifyDestinationId} maxLength={200} placeholder="Example: Telegram chat ID" onChange={(event) => setNotifyDestinationId(event.target.value)} /></label> : null}
            {!publishingAccounts.length ? <div className="studio-inline-warning"><AlertTriangle size={15} /><span>No connected {platformLabel(selectedDraft.platform)} is available. <button type="button" onClick={onOpenChannels}>Open Channels</button></span></div> : deliveryMode === "auto_publish" && !autoAccountReady ? <div className="studio-inline-warning"><AlertTriangle size={15} />This {selectedDraft.platform === "facebook" ? "Page" : "account"} is not ready for auto publish. Run Connection Doctor in Channels.</div> : null}
            {schedulePreflightBusy ? <div className="studio-inline-warning" role="status"><RefreshCw className="calendar-spin" size={15} />Checking this account’s calendar for duplicate content and nearby posts…</div> : schedulePreflightError ? <div className="studio-inline-warning" role="alert"><AlertTriangle size={15} />{schedulePreflightError}</div> : schedulePreflight?.requiresConfirmation ? <div className="studio-conflict-warning" role="alert"><div><AlertTriangle size={16} /><strong>Review {schedulePreflight.conflicts.length} scheduling warning{schedulePreflight.conflicts.length === 1 ? "" : "s"}</strong></div><ul>{schedulePreflight.conflicts.map((conflict) => <li key={conflict.targetId}><span>{scheduleConflictHeadline(conflict)}: <strong>{conflict.contentTitle}</strong></span><small>{new Date(conflict.scheduledFor).toLocaleString()} · {conflict.minutesApart} min apart · {decisionLabel(conflict.status)}</small></li>)}</ul><label><input type="checkbox" checked={acknowledgedConflictHash === schedulePreflight.acknowledgementSha256} onChange={(event) => setAcknowledgedConflictHash(event.target.checked ? schedulePreflight.acknowledgementSha256 : "")} /> I reviewed these exact warnings and still want to schedule.</label></div> : schedulePreflight ? <div className="studio-conflict-clear"><CircleCheck size={15} />No exact-content duplicate or same-account post within 60 minutes.</div> : null}
            {selectedQueue?.enabled && queuePreview ? <><div className="studio-queue-choice"><div><strong>Next account slot</strong><span>{new Date(queuePreview.scheduledFor).toLocaleString([], { timeZone: queuePreview.timezone, dateStyle: "medium", timeStyle: "short" })} · {queuePreview.timezone} · UTC{queuePreview.utcOffset}</span><small>{queuePreview.scheduledFor} · profile v{selectedQueue.version}{queuePreview.notes.includes("dst_ambiguous_earlier_offset") ? " · earlier DST occurrence" : ""}</small></div><button type="button" className="secondary-button" disabled={!canEdit || !approvedRevision || Boolean(busy) || queuePreflightBusy || !scheduleConflictReady(queueSchedulePreflight, acknowledgedQueueConflictHash)} onClick={() => void scheduleNextAvailable()}><CalendarClock size={15} />{busy === "schedule-next" ? "Reserving…" : "Add to next account slot"}</button></div>{queuePreflightBusy ? <div className="studio-inline-warning" role="status"><RefreshCw className="calendar-spin" size={15} />Checking the next account slot…</div> : queuePreflightError ? <div className="studio-inline-warning" role="alert"><AlertTriangle size={15} />{queuePreflightError}</div> : queueSchedulePreflight?.requiresConfirmation ? <div className="studio-conflict-warning" role="alert"><div><AlertTriangle size={16} /><strong>Next slot has {queueSchedulePreflight.conflicts.length} warning{queueSchedulePreflight.conflicts.length === 1 ? "" : "s"}</strong></div><ul>{queueSchedulePreflight.conflicts.map((conflict) => <li key={conflict.targetId}><span>{scheduleConflictHeadline(conflict)}: <strong>{conflict.contentTitle}</strong></span><small>{new Date(conflict.scheduledFor).toLocaleString()} · {conflict.minutesApart} min apart</small></li>)}</ul><label><input type="checkbox" checked={acknowledgedQueueConflictHash === queueSchedulePreflight.acknowledgementSha256} onChange={(event) => setAcknowledgedQueueConflictHash(event.target.checked ? queueSchedulePreflight.acknowledgementSha256 : "")} /> I reviewed these exact next-slot warnings.</label></div> : null}</> : <div className="studio-inline-warning"><Clock3 size={15} /><span>No enabled posting queue for this account. <button type="button" onClick={onOpenChannels}>Set it up in Channels</button>.</span></div>}
            <div className="studio-form-foot"><p>{approvedRevision ? selectedStory ? "This exact Story revision is approved. Internal review copy will not be published as a caption." : "This exact revision is approved." : "Approval is required for this exact revision."}</p><button className="new-button" disabled={!canReview || !approvedRevision || !selectedAccount || Boolean(busy) || schedulePreflightBusy || !scheduleConflictReady(schedulePreflight, acknowledgedConflictHash)}><CalendarClock size={15} />{busy === "schedule" ? "Scheduling…" : `Schedule ${selectedStory ? "Instagram Story" : platformLabel(selectedDraft.platform)}`}</button></div>
          </form>
        </section> : selectedDraft?.platform === "youtube" ? <div className="studio-youtube-note"><Play size={18} fill="currentColor" /><div><strong>YouTube final review stays below</strong><p>Approve this exact revision, then confirm audience, synthetic-media disclosure, visibility, channel, and publish time in the dedicated YouTube review.</p></div></div> : null}

        {item.targets.some((target) => target.platform === "instagram" || target.platform === "facebook") ? <FirstCommentPanel auth={auth} workspaceId={workspaceId} contentItemId={item.id} targets={item.targets} /> : null}

        {hasEligiblePublishProofs(item.proofs) ? <RemoteCorrectionPanel auth={auth} workspaceId={workspaceId} contentItemId={item.id} publishProofs={item.proofs} /> : null}

      </div>

      <aside className="studio-preview" aria-label={`${platform} preview`}>
        <div className="studio-preview-head"><div><Eye size={16} /><span><strong>Platform preview</strong><small>{platformLabel(platform)} {format}</small></span></div><em>Preview only</em></div>
        <div className={`platform-frame ${previewShape}`}>
          {previewUrl && previewAsset?.kind === "video" ? <video src={previewUrl} controls muted playsInline /> : previewUrl ? <img src={previewUrl} alt={previewAsset?.altText || previewAsset?.fileName || "Selected media preview"} /> : <div className="preview-placeholder"><Smartphone size={30} /><strong>{platform === "facebook" && format === "text" ? "Text-only Page post" : "No media selected"}</strong><small>{platform === "facebook" && format === "text" ? "The caption preview appears below." : "Attach ready Library media to see the crop."}</small></div>}
          {platform === "facebook" && format === "text" ? null : <span className="crop-label">{previewShape === "vertical" ? "9:16 crop" : "4:5 crop"}</span>}
        </div>
        {editingStory ? <div className="story-preview-note"><span>{platformBadge(platform)}</span><div><strong>{title || "Untitled Story draft"}</strong><small>Internal review note · not sent as a Story caption</small><p>{caption || "Add internal review copy for the team."}</p></div></div> : <div className="preview-copy"><span>{platformBadge(platform)}</span><div><strong>{title || "Untitled draft"}</strong><p>{caption || "Your caption or description will appear here."}</p></div></div>}
        <p className="preview-note">{editingStory ? "9:16 Story preview. The Library file is unchanged; basic auto publish does not add interactive stickers." : platform === "facebook" && format === "text" ? "This is a copy preview. Facebook may place Page name and controls differently." : "The preview uses a center crop. The original Library file is unchanged."}</p>
      </aside>
    </div>
  </section>;
}
