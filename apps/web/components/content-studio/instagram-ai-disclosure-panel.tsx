"use client";

import { AlertTriangle, CheckCircle2, Clock3, Info, LoaderCircle, ShieldCheck, Sparkles } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { parseCollaboratorCandidates, shortCollaboratorHash } from "./instagram-collaborator-utils";
import styles from "./instagram-ai-disclosure-panel.module.css";

export type InstagramAiDisclosurePanelProps = {
  accountId: string;
  draftId: string;
  candidateResponse: unknown;
  canEdit: boolean;
  canApprove: boolean;
  busy?: boolean | undefined;
  error?: string | undefined;
  proof?: { requested: boolean; observed: boolean; label: "ai_info" } | undefined;
  onSave(input: { isAiGenerated: boolean }): void | Promise<void>;
  onApprove(candidateId: string): void | Promise<void>;
};

export function InstagramAiDisclosurePanel(props: InstagramAiDisclosurePanelProps) {
  const candidates = useMemo(() => parseCollaboratorCandidates(props.candidateResponse), [props.candidateResponse]);
  const relevant = candidates.filter((candidate) => candidate.accountId === props.accountId && candidate.draftId === props.draftId);
  const pending = relevant.find((candidate) => candidate.status === "pending_approval");
  const approved = relevant.find((candidate) => candidate.status === "approved" && candidate.approvalId);
  const [choice, setChoice] = useState(approved?.isAiGenerated ?? false);
  useEffect(()=>setChoice(approved?.isAiGenerated??false),[approved?.approvedSettingsSha256,approved?.isAiGenerated]);
  const changed = !approved || approved.isAiGenerated !== choice;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!props.canEdit || props.busy || !changed) return;
    await props.onSave({ isAiGenerated: choice });
  }

  return <section className={styles.panel} aria-labelledby="instagram-ai-disclosure-title">
    <header><span><Sparkles size={18} /></span><div><h3 id="instagram-ai-disclosure-title">Instagram native AI label</h3><p>Choose explicitly. OriginPost never guesses from the caption, file, or drafting tool.</p></div></header>
    {props.error ? <div className={styles.error} role="alert"><AlertTriangle size={16} /><div><strong>AI-label review needs attention</strong><p>{props.error}</p></div></div> : null}
    <form onSubmit={save}>
      <fieldset><legend>Native Instagram disclosure</legend>
        <label><input type="radio" name="instagram-ai-label" checked={!choice} onChange={() => setChoice(false)} /><span><strong>No native AI info label requested</strong><small>Use only when the approved media does not need Instagram’s native AI disclosure.</small></span></label>
        <label><input type="radio" name="instagram-ai-label" checked={choice} onChange={() => setChoice(true)} /><span><strong>Add Instagram’s AI info label</strong><small>OriginPost sends the provider setting and must observe it on the published media before claiming success.</small></span></label>
      </fieldset>
      <div className={styles.truth}><Info size={15} /><p>This setting is approval-bound to the exact draft and Instagram account. It cannot be changed at scheduling time.</p></div>
      {approved ? <div className={styles.approved}><ShieldCheck size={16} /><div><strong>{approved.isAiGenerated ? "AI info label approved" : "No native label approved"}</strong><p>Exact settings hash <span title={approved.approvedSettingsSha256}>{shortCollaboratorHash(approved.approvedSettingsSha256)}</span></p></div></div> : <div className={styles.neutral}><Clock3 size={16} /><div><strong>No AI-label decision approved</strong><p>Without an approved choice, OriginPost sends no native AI-label field.</p></div></div>}
      {changed && approved ? <p className={styles.warning}><AlertTriangle size={14} />This changes the approved provider setting and needs a new human approval.</p> : null}
      {pending ? <div className={styles.pending}><Clock3 size={16} /><div><strong>Waiting for human approval</strong><p>{pending.isAiGenerated ? "Add Instagram AI info label" : "Do not request the native label"}</p></div>{props.canApprove ? <button type="button" disabled={props.busy} onClick={() => void props.onApprove(pending.id)}><ShieldCheck size={14} />Approve exact choice</button> : null}</div> : null}
      {props.proof ? <div className={props.proof.observed ? styles.proof : styles.warningProof}><CheckCircle2 size={16} /><div><strong>{props.proof.observed ? "Native label observed" : "Native label not verified"}</strong><p>{props.proof.requested ? "Requested in the approved publish" : "Not requested by OriginPost"} · provider observation {props.proof.observed ? "true" : "false"}</p></div></div> : null}
      <footer><p>Changing this choice never edits an already-published Instagram post.</p><button disabled={!props.canEdit || props.busy || !changed}>{props.busy ? <LoaderCircle className={styles.spin} size={14} /> : <ShieldCheck size={14} />}Save choice for approval</button></footer>
    </form>
  </section>;
}
