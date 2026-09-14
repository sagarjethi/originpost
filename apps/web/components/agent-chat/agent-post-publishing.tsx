"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import { InstagramAiDisclosurePanel } from "../content-studio/instagram-ai-disclosure-panel";
import styles from "./agent-post-publishing.module.css";

type Candidate = {
  id: string;
  accountId: string;
  draftId: string;
  requestedAt: string;
  settings: {
    collaborators: string[];
    shareToFeed?: boolean;
    isAiGenerated?: boolean;
    reelCover?: unknown;
  };
};
type Detail = {
  item: {
    id: string;
    version: number;
    drafts: { id: string; contentSha256: string }[];
    approvals: { draftId: string; draftSha256: string; decision: string }[];
  };
  draftId: string;
  accounts: {
    id: string;
    displayName: string;
    platform: string;
    status: string;
    mode: string;
  }[];
  instagramCandidates: Candidate[];
  targets: {
    id: string;
    status: string;
    accountId: string;
    scheduledFor: string;
  }[];
  canSchedule: boolean;
};
type Preview = {
  previewHash: string;
  contentVersion: number;
  mode: string;
  schedule: { scheduledFor: string; accountId: string };
  account: { displayName: string; platform: string };
  draft: { title: string; caption: string; format: string };
  nativeAiLabel: boolean;
  conflicts: {
    requiresConfirmation: boolean;
    acknowledgementSha256: string;
    conflicts: {
      contentTitle: string;
      scheduledFor: string;
      kinds: string[];
    }[];
  };
};
function futureTime() {
  const date = new Date(Date.now() + 10 * 60_000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}
export function AgentPostPublishing({
  auth,
  workspaceId,
  brandId,
  runId,
}: {
  auth: AuthView;
  workspaceId: string;
  brandId: string;
  runId: string;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [accountId, setAccountId] = useState("");
  const [time, setTime] = useState(futureTime);
  const [publishSoon, setPublishSoon] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const base = `/v1/agent-posts/${encodeURIComponent(runId)}`;
  const query = `workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}`;
  const request = useCallback(
    async <T,>(path: string, body?: unknown, version?: number): Promise<T> => {
      const response = await apiFetch(
        path,
        body === undefined
          ? { cache: "no-store" }
          : {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(version ? { "If-Match": String(version) } : {}),
              },
              body: JSON.stringify(body),
            },
        auth.csrfToken,
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          Array.isArray(data.message)
            ? data.message.join(" ")
            : (data.message ??
              "This action did not complete. Refresh and check the publishing record."),
        );
      return data;
    },
    [auth.csrfToken],
  );
  const load = useCallback(async () => {
    const result = await request<Detail>(`${base}/publication?${query}`);
    setDetail((previous) =>
      previous && previous.item.version > result.item.version
        ? previous
        : result,
    );
  }, [base, query, request]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const refresh = async () => {
      try {
        const result = await request<Detail>(`${base}/publication?${query}`);
        if (live)
          setDetail((previous) =>
            previous && previous.item.version > result.item.version
              ? previous
              : result,
          );
      } catch (e) {
        if (live)
          setError(e instanceof Error ? e.message : "Cannot load publication.");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open, base, query, request]);
  useEffect(() => {
    setPreview(null);
    setAcknowledged(false);
  }, [accountId, time, publishSoon, detail?.item.version]);
  const account = detail?.accounts.find((a) => a.id === accountId);
  const draft = detail?.item.drafts.find((d) => d.id === detail.draftId);
  const approved =
    detail?.item.approvals.findLast(
      (a) => a.draftId === draft?.id && a.draftSha256 === draft?.contentSha256,
    )?.decision === "approved";
  const role = auth.memberships.find(
    (m) => m.workspaceId === workspaceId,
  )?.role;
  const canApprove = role === "owner" || role === "manager";
  const canEdit = canApprove || role === "creator";
  const candidates =
    detail?.instagramCandidates.filter((c) => c.accountId === accountId) ?? [];
  const latest = [...candidates].sort((a, b) =>
    b.requestedAt.localeCompare(a.requestedAt),
  )[0];
  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action did not complete.");
    } finally {
      setBusy(false);
    }
  }
  async function prepare(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      setPreview(null);
      const result = await request<Preview>(`${base}/publication-preview`, {
        workspaceId,
        brandId,
        recipientId: "originpost.publisher",
        accountId,
        scheduledFor: publishSoon
          ? new Date(Date.now() + 60_000).toISOString()
          : new Date(time).toISOString(),
      });
      setPreview(result);
      setAcknowledged(false);
    });
  }
  return (
    <section className={styles.panel} aria-label="Publish from agent chat">
      <button
        className={styles.trigger}
        type="button"
        aria-expanded={open}
        aria-controls={`publication-${runId}`}
        onClick={() => setOpen(!open)}
      >
        @Publisher{" "}
        <span>
          {open ? "Close publishing" : "Review & publish this version"}
        </span>
      </button>
      {open && (
        <div className={styles.body} id={`publication-${runId}`}>
          <h3>Review once. Send this exact version.</h3>
          <p>
            This command sends the approved post through your connected account.
            It never treats a message or an AI review as your approval.
          </p>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          {!detail ? (
            <p>Loading the post and account checks…</p>
          ) : (
            <>
              <div className={styles.review}>
                <strong>
                  {approved
                    ? "This draft is approved"
                    : "This draft needs your review"}
                </strong>
                <p>
                  Check the source facts, exact text, image and logo above.{" "}
                  <a
                    href={`/content?item=${encodeURIComponent(detail.item.id)}`}
                  >
                    Open the sources and full review
                  </a>
                  .
                </p>
                {!approved && canApprove && (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() =>
                      void action(async () => {
                        await request(
                          `/v1/content-items/${encodeURIComponent(detail.item.id)}/approvals?${query}`,
                          {
                            decision: "approved",
                            draftId: detail.draftId,
                            note: "Editor reviewed the exact post from agent chat.",
                          },
                          detail.item.version,
                        );
                        await load();
                      })
                    }
                  >
                    I reviewed the text and image — approve this draft
                  </button>
                )}
              </div>
              <form onSubmit={prepare}>
                <label>
                  Publishing account
                  <select
                    required
                    value={accountId}
                    disabled={busy}
                    onChange={(e) => setAccountId(e.target.value)}
                  >
                    <option value="">Choose an account</option>
                    {detail.accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName} · {a.platform}
                        {a.mode === "mock" ? " · test connection" : ""} ·{" "}
                        {a.status}
                      </option>
                    ))}
                  </select>
                </label>
                {!detail.accounts.length && (
                  <p>
                    <a href="/channels">Connect an account</a> for this draft’s
                    platform.
                  </p>
                )}
                {account?.mode === "mock" && (
                  <p>
                    Test connections cannot publish from chat.{" "}
                    <a href="/channels">Connect a live account</a>.
                  </p>
                )}
                <label>
                  When to publish
                  <select
                    disabled={busy}
                    value={publishSoon ? "soon" : "scheduled"}
                    onChange={(event) =>
                      setPublishSoon(event.target.value === "soon")
                    }
                  >
                    <option value="soon">
                      Publish next (about one minute)
                    </option>
                    <option value="scheduled">Choose a time</option>
                  </select>
                </label>
                {!publishSoon && (
                  <label>
                    Publish at (your local time)
                    <input
                      type="datetime-local"
                      required
                      value={time}
                      disabled={busy}
                      onChange={(e) => setTime(e.target.value)}
                    />
                  </label>
                )}
                <button
                  disabled={
                    busy ||
                    !accountId ||
                    !approved ||
                    account?.mode !== "official" ||
                    !detail.canSchedule
                  }
                >
                  Check publishing details
                </button>
              </form>
              {account?.platform === "instagram" && (
                <InstagramAiDisclosurePanel
                  accountId={accountId}
                  draftId={detail.draftId}
                  candidateResponse={candidates}
                  canEdit={canEdit}
                  canApprove={canApprove && approved}
                  busy={busy}
                  onSave={(input) =>
                    action(async () => {
                      await request(
                        `/v1/content-items/${encodeURIComponent(detail.item.id)}/instagram-collaborators/candidates?${query}`,
                        {
                          draftId: detail.draftId,
                          accountId,
                          collaborators: latest?.settings.collaborators ?? [],
                          shareToFeed: latest?.settings.shareToFeed ?? true,
                          ...(latest?.settings.reelCover
                            ? { reelCover: latest.settings.reelCover }
                            : {}),
                          isAiGenerated: input.isAiGenerated,
                        },
                      );
                      setPreview(null);
                      await load();
                    })
                  }
                  onApprove={(candidateId) =>
                    action(async () => {
                      await request(
                        `/v1/content-items/${encodeURIComponent(detail.item.id)}/instagram-collaborators/candidates/${encodeURIComponent(candidateId)}/approve?${query}`,
                        {},
                      );
                      setPreview(null);
                      await load();
                    })
                  }
                />
              )}
              {preview && (
                <section
                  className={styles.preview}
                  aria-label="Exact publication preview"
                >
                  <h4>
                    {preview.account.displayName} · {preview.account.platform}
                  </h4>
                  <p>
                    {new Date(preview.schedule.scheduledFor).toLocaleString()} ·{" "}
                    {preview.draft.format}
                    {preview.nativeAiLabel
                      ? " · native AI info label requested"
                      : ""}
                  </p>
                  <strong>{preview.draft.title}</strong>
                  <p className={styles.caption}>{preview.draft.caption}</p>
                  {preview.conflicts.requiresConfirmation && (
                    <div>
                      <strong>Check these existing publishing requests</strong>
                      <ul>
                        {preview.conflicts.conflicts.map((c, i) => (
                          <li key={i}>
                            {c.contentTitle} ·{" "}
                            {new Date(c.scheduledFor).toLocaleString()} ·{" "}
                            {c.kinds
                              .map((k) => k.replaceAll("_", " "))
                              .join(", ")}
                          </li>
                        ))}
                      </ul>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={acknowledged}
                          onChange={(e) => setAcknowledged(e.target.checked)}
                        />
                        I checked the duplicate and timing warnings.
                      </label>
                    </div>
                  )}
                  {Date.parse(preview.schedule.scheduledFor) <= Date.now() && (
                    <p role="status">
                      This preview’s time has passed. Check publishing details
                      again.
                    </p>
                  )}
                  <button
                    disabled={
                      busy ||
                      Date.parse(preview.schedule.scheduledFor) <= Date.now() ||
                      (preview.conflicts.requiresConfirmation && !acknowledged)
                    }
                    onClick={() =>
                      void action(async () => {
                        await request(`${base}/publication`, {
                          workspaceId,
                          brandId,
                          recipientId: "originpost.publisher",
                          accountId: preview.schedule.accountId,
                          scheduledFor: preview.schedule.scheduledFor,
                          contentVersion: preview.contentVersion,
                          previewHash: preview.previewHash,
                          ...(acknowledged
                            ? {
                                conflictAcknowledgementSha256:
                                  preview.conflicts.acknowledgementSha256,
                              }
                            : {}),
                        });
                        setPreview(null);
                        setMessage(
                          "Publishing request saved. Follow its status below; a queued request is not yet published.",
                        );
                        await load();
                      })
                    }
                  >
                    {publishSoon
                      ? "Confirm & publish this post"
                      : "Confirm & schedule this post"}
                  </button>
                </section>
              )}
              {detail.targets.length > 0 && (
                <section aria-label="Publishing receipts">
                  <h4>Publishing records</h4>
                  {detail.targets.map((t) => (
                    <p key={t.id}>
                      <strong>{t.status.replaceAll("_", " ")}</strong> ·{" "}
                      {detail.accounts.find((a) => a.id === t.accountId)
                        ?.displayName ?? "Saved account"}{" "}
                      · {new Date(t.scheduledFor).toLocaleString()}{" "}
                      <a
                        href={`/content?item=${encodeURIComponent(detail.item.id)}`}
                      >
                        Open receipt
                      </a>
                    </p>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
