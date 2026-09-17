"use client";
import { useState } from 'react';
import { spokenScript } from '@originpost/domain';
import { MessageSquare, ArrowRight } from 'lucide-react';
import styles from './post-voice-action.module.css';
import { VoiceScriptEditor } from './voice-script-editor';

export function voiceDraftKey(userId:string, workspaceId:string, brandId:string, runId:string) {
  return JSON.stringify(['originpost-voice-draft',userId,workspaceId,brandId,runId]);
}

/** A handoff, never a provider call. Scripts stay out of navigation URLs. */
export function PostVoiceAction({userId,workspaceId,brandId,runId,caption}:{userId:string;workspaceId:string;brandId:string;runId:string;caption:string}) {
  const [open,setOpen]=useState(false),[script,setScript]=useState(spokenScript(caption).slice(0,3000));
  return <div className={styles.action}>
    <button type="button" aria-expanded={open} onClick={()=>setOpen(!open)}><MessageSquare size={16}/>Create voice</button>
    {open&&<div className={styles.bubble}>
      <VoiceScriptEditor value={script} onChange={setScript} rows={4} limit={100}/>
      <small>Next: choose a voice and review the cost limit. Opening Audio does not start generation.</small>
      <a href={`/audio?${new URLSearchParams({voiceRun:runId,voiceWorkspace:workspaceId,voiceBrand:brandId})}`} onClick={()=>{
        try { sessionStorage.setItem(voiceDraftKey(userId,workspaceId,brandId,runId),JSON.stringify({text:spokenScript(script),expiresAt:Date.now()+15*60_000})); } catch { /* Audio can recover the saved post copy if browser storage is unavailable. */ }
      }}>Choose a voice <ArrowRight size={15}/></a>
    </div>}
  </div>;
}
