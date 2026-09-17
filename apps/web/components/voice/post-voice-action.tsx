"use client";
import { useState } from 'react';
import { MessageSquare, ArrowRight } from 'lucide-react';
import styles from './post-voice-action.module.css';

export function voiceDraftKey(userId:string, workspaceId:string, brandId:string, runId:string) {
  return JSON.stringify(['originpost-voice-draft',userId,workspaceId,brandId,runId]);
}

/** A handoff, never a provider call. Scripts stay out of navigation URLs. */
export function PostVoiceAction({userId,workspaceId,brandId,runId,caption}:{userId:string;workspaceId:string;brandId:string;runId:string;caption:string}) {
  const [open,setOpen]=useState(false),[script,setScript]=useState(caption.slice(0,3000));
  return <div className={styles.action}>
    <button type="button" aria-expanded={open} onClick={()=>setOpen(!open)}><MessageSquare size={16}/>Create voice</button>
    {open&&<div className={styles.bubble}>
      <label>Voice script<textarea rows={4} maxLength={3000} value={script} onChange={e=>setScript(e.target.value)}/></label>
      <small>Edit the post copy for spoken delivery. Review names and numbers before generating.</small>
      <a href={`/audio?${new URLSearchParams({voiceRun:runId,voiceWorkspace:workspaceId,voiceBrand:brandId})}`} onClick={()=>{
        try { sessionStorage.setItem(voiceDraftKey(userId,workspaceId,brandId,runId),JSON.stringify({text:script,expiresAt:Date.now()+15*60_000})); } catch { /* Audio can recover the saved post copy if browser storage is unavailable. */ }
      }}>Choose a voice <ArrowRight size={15}/></a>
    </div>}
  </div>;
}
