"use client";

import { AlertTriangle, AtSign, Check, CircleCheck, Clock3, Link2, LoaderCircle, RefreshCw, ShieldCheck, UserPlus, Users } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";
import styles from "./instagram-collaborator-panel.module.css";
import {
  collaboratorStatusCopy,
  collaboratorStatusRows,
  normalizeCollaboratorInput,
  parseCollaboratorCapabilityView,
  parseCollaboratorCandidates,
  parseCollaboratorInviteProof,
  parseCollaboratorSettingsApproval,
  parseCollaboratorStatusResult,
  shortCollaboratorHash,
} from "./instagram-collaborator-utils";

export type InstagramCollaboratorPanelProps = {
  accountId: string;
  draftId: string;
  draftSha256: string;
  format: string;
  capabilityResponse: unknown;
  candidateResponse?: unknown;
  settingsApprovalResponse?: unknown;
  inviteProofResponse?: unknown;
  statusResponse?: unknown;
  canEdit: boolean;
  canApprove: boolean;
  busy?: boolean | undefined;
  error?: string | undefined;
  onSaveForApproval?: ((input: { accountId: string; publishingUsername?: string | undefined; draftId: string; draftSha256: string; collaborators: string[]; isAiGenerated: boolean }) => void | Promise<void>) | undefined;
  onApproveCandidate?: ((candidateId: string) => void | Promise<void>) | undefined;
  onRefreshStatuses?: (() => void | Promise<void>) | undefined;
};

function dateLabel(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Time not reported";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function InstagramCollaboratorPanel({
  accountId,
  draftId,
  draftSha256,
  format,
  capabilityResponse,
  candidateResponse,
  settingsApprovalResponse,
  inviteProofResponse,
  statusResponse,
  canEdit,
  canApprove,
  busy = false,
  error,
  onSaveForApproval,
  onApproveCandidate,
  onRefreshStatuses,
}: InstagramCollaboratorPanelProps) {
  const capabilityView = parseCollaboratorCapabilityView(capabilityResponse);
  const capability = capabilityView?.capability ?? null;
  const publishingUsername = capabilityView?.publishingUsername;
  const candidates = parseCollaboratorCandidates(candidateResponse);
  const pendingCandidate = candidates.find((candidate) => candidate.status === "pending_approval" && candidate.accountId === accountId && candidate.draftId === draftId && candidate.collaborators.length>0);
  const approved = parseCollaboratorSettingsApproval(settingsApprovalResponse);
  const inviteProof = parseCollaboratorInviteProof(inviteProofResponse);
  const statusResult = parseCollaboratorStatusResult(statusResponse);
  const [input, setInput] = useState(approved?.collaborators.map((username) => `@${username}`).join(", ") ?? "");
  const [submitted, setSubmitted] = useState(false);
  const normalized = useMemo(() => normalizeCollaboratorInput(input, publishingUsername), [input, publishingUsername]);
  const formatSupported = format === "image" || format === "carousel" || format === "reel";
  const rows = inviteProof?.requestState === "requested_unverified" ? collaboratorStatusRows(inviteProof.requestedUsernames, statusResult?.snapshots ?? []) : [];
  const settingsChanged = Boolean(approved) && normalized.error === null && normalized.usernames.join("\n") !== approved?.collaborators.join("\n");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onSaveForApproval || normalized.error || !normalized.usernames.length || !formatSupported || capability?.state !== "supported") return;
    setSubmitted(false);
    await onSaveForApproval({ accountId, ...(publishingUsername ? { publishingUsername } : {}), draftId, draftSha256, collaborators: normalized.usernames, isAiGenerated: approved?.isAiGenerated === true });
    setSubmitted(true);
  }

  return <section className={styles.panel} aria-labelledby="instagram-collaborator-title">
    <header className={styles.head}>
      <span><Users size={18} /></span>
      <div><h3 id="instagram-collaborator-title">Instagram collaborators</h3><p>Add names before approval. Invitations are requested only during the approved Instagram publish.</p></div>
    </header>

    {error ? <div className={`${styles.banner} ${styles.danger}`} role="alert"><AlertTriangle size={17} /><div><strong>Collaborator checks need attention</strong><p>{error}</p></div></div> : !capability ? <div className={styles.state}><LoaderCircle className={styles.spin} size={20} /><strong>Checking collaborator support</strong><p>Waiting for a verified account capability response.</p></div> : capability.state === "unsupported" ? <div className={`${styles.banner} ${styles.warning}`}><AlertTriangle size={17} /><div><strong>Collaborators are not ready on this account</strong><p>{capability.reason === "facebook_login_required" ? "Reconnect Instagram through Facebook Login." : capability.reason === "required_scopes_missing" ? "Reconnect and grant the required Instagram permissions." : capability.reason === "endpoint_probe_required" ? "The server must verify the current Meta collaborator contract first." : "This connection uses an unsupported Meta endpoint setup."}</p><small>No collaborator invitation will be sent until the account passes every check.</small></div></div> : <>
      {!formatSupported ? <div className={`${styles.banner} ${styles.warning}`}><AlertTriangle size={17} /><div><strong>This format cannot invite collaborators</strong><p>Use an Instagram feed image, Reel, or carousel. Collaborator settings do not apply to this format.</p></div></div> : null}
      {submitted ? <div className={`${styles.banner} ${styles.success}`} role="status"><CircleCheck size={17} /><div><strong>Settings sent for approval</strong><p>The server must return the approval-bound settings hash before publishing.</p></div></div> : null}

      <form className={styles.editor} onSubmit={save}>
        <label><span>Instagram usernames <em>{normalized.usernames.length}/3</em></span><div className={styles.input}><AtSign size={15} /><input value={input} maxLength={100} placeholder="news.partner, local.creator" onChange={(event) => { setInput(event.target.value); setSubmitted(false); }} /></div><small>Separate names with spaces, commas, or new lines. We remove @, use lowercase, and remove duplicates.</small></label>
        {normalized.error ? <p className={styles.fieldError}><AlertTriangle size={13} />{normalized.error}</p> : normalized.usernames.length ? <div className={styles.chips}>{normalized.usernames.map((username) => <span key={username}>@{username}</span>)}</div> : <p className={styles.emptyCopy}>No collaborator invitations requested.</p>}
        {settingsChanged ? <div className={`${styles.banner} ${styles.warning}`}><AlertTriangle size={15} /><div><strong>Approval is now stale</strong><p>Changing the username list needs a new settings approval and a new exact hash.</p></div></div> : null}
        <div className={styles.editorFoot}><p>Saving binds the exact Instagram account, draft, normalized names, and server settings hash for review. It must not publish or send an invitation.</p><button disabled={!canEdit || !onSaveForApproval || busy || Boolean(normalized.error) || !normalized.usernames.length || !formatSupported}>{busy ? <LoaderCircle className={styles.spin} size={14} /> : <ShieldCheck size={14} />}{approved ? " Save as new approval request" : " Save for approval"}</button></div>
      </form>

      {pendingCandidate ? <article className={styles.pendingApproval}>
        <Clock3 size={16} /><div><strong>Waiting for human approval</strong><p>{pendingCandidate.collaborators.map((username) => `@${username}`).join(", ")} · saved {dateLabel(pendingCandidate.requestedAt)}</p><small>Creating this request did not schedule or publish anything.</small></div>
        {canApprove && onApproveCandidate ? <button type="button" disabled={busy} onClick={() => void onApproveCandidate(pendingCandidate.id)}><ShieldCheck size={14} /> Approve exact list</button> : null}
      </article> : null}

      {approved ? <article className={styles.approval}>
        <div className={styles.approvalTitle}><span><ShieldCheck size={16} /></span><div><strong>Approval-bound settings</strong><small>{approved.approvedAt ? `Approved ${dateLabel(approved.approvedAt)}` : "Approval time not reported"}</small></div></div>
        <div className={styles.approvedNames}>{approved.collaborators.length ? approved.collaborators.map((username) => <span key={username}>@{username}</span>) : <em>No collaborators approved</em>}</div>
        <dl><div><dt>Instagram account</dt><dd title={approved.accountId}>@{approved.publishingUsername} · {approved.accountId}</dd></div><div><dt>Exact settings hash</dt><dd title={approved.approvedSettingsSha256}>{shortCollaboratorHash(approved.approvedSettingsSha256)}</dd></div>{approved.draftSha256 ? <div><dt>Approved draft hash</dt><dd title={approved.draftSha256}>{shortCollaboratorHash(approved.draftSha256)}</dd></div> : null}</dl>
        <p><Link2 size={13} />Publishing must send this exact username list and settings hash. Any change needs new approval.</p>
      </article> : <div className={styles.pendingApproval}><Clock3 size={16} /><div><strong>No approved collaborator settings</strong><p>Add the names before draft approval. A schedule or publish action must not create its own unreviewed list.</p></div></div>}
    </>}

    {inviteProof ? <section className={styles.proof}>
      <div className={styles.proofHead}><div><span><UserPlus size={16} /></span><div><strong>Invitation proof</strong><small>{inviteProof.requestState === "requested_unverified" ? "Requested during publish · acceptance not implied" : "No invitation requested"}</small></div></div>{inviteProof.requestState === "requested_unverified" && onRefreshStatuses ? <button type="button" disabled={busy} onClick={() => void onRefreshStatuses()}><RefreshCw className={busy ? styles.spin : ""} size={13} /> Refresh status</button> : null}</div>
      <dl><div><dt>Requested usernames hash</dt><dd title={inviteProof.requestedUsernamesSha256}>{shortCollaboratorHash(inviteProof.requestedUsernamesSha256)}</dd></div><div><dt>Provider connection</dt><dd>{inviteProof.providerConnectionMode === "facebook_login" ? "Facebook Login" : "Instagram Login"}</dd></div></dl>
      {inviteProof.requestState === "requested_unverified" ? <div className={styles.statusList}>{rows.map((row) => { const view = collaboratorStatusCopy(row.status); return <article className={styles[view.tone]} key={row.username}><span>{row.status === "accepted" ? <Check size={15} /> : row.status === "pending" ? <Clock3 size={15} /> : <AlertTriangle size={15} />}</span><div><strong>@{row.username}</strong><small>{view.label}</small><p>{view.detail}</p>{row.capturedAt ? <time>Checked {dateLabel(row.capturedAt)}</time> : null}</div></article>; })}</div> : <p className={styles.emptyCopy}>The approved publish did not request any collaborator usernames.</p>}
      {statusResult?.capturedAt ? <footer>{statusResult.providerReadComplete ? "Complete provider read" : "Provider read incomplete"} · tracking {statusResult.trackingStatus.replaceAll("_", " ")} · {dateLabel(statusResult.capturedAt)}{statusResult.rawResponseSha256 ? ` · response ${shortCollaboratorHash(statusResult.rawResponseSha256)}` : ""}{statusResult.nextAttemptAt ? ` · next check ${dateLabel(statusResult.nextAttemptAt)}` : ""}</footer> : inviteProof.requestState === "requested_unverified" ? <footer>Status has not been read yet. “Requested” does not mean “accepted.”</footer> : null}
    </section> : null}
  </section>;
}
