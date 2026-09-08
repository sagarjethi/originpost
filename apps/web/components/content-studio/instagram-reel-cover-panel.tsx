"use client";

import {AlertTriangle,Clock3,ImageIcon,LoaderCircle,ShieldCheck,SquarePlay} from "lucide-react";
import {FormEvent,useEffect,useMemo,useState} from "react";
import {apiFetch} from "../../lib/api-client";
import {parseCollaboratorCandidates,shortCollaboratorHash} from "./instagram-collaborator-utils";
import styles from "./instagram-reel-cover-panel.module.css";

type CoverAsset={id:string;fileName:string;sha256:string;widthPixels?:number|undefined;heightPixels?:number|undefined;rights:string;inspectionStatus?:string|undefined};
type CoverInput={mode:"instagram_default"}|{mode:"video_frame";offsetMs:number}|{mode:"custom_image";mediaId:string};

export function InstagramReelCoverPanel(props:{workspaceId:string;csrfToken?:string|undefined;accountId:string;draftId:string;candidateResponse:unknown;coverAssets:CoverAsset[];videoDurationMs?:number|undefined;canEdit:boolean;canApprove:boolean;busy:boolean;onSave(input:{accountId:string;draftId:string;collaborators:string[];shareToFeed:boolean;isAiGenerated:boolean;reelCover:CoverInput}):Promise<void>|void;onApprove(candidateId:string):Promise<void>|void}){
  const candidates=useMemo(()=>parseCollaboratorCandidates(props.candidateResponse),[props.candidateResponse]);
  const relevant=candidates.filter((candidate)=>candidate.accountId===props.accountId&&candidate.draftId===props.draftId);
  const approved=relevant.find((candidate)=>candidate.status==="approved"&&candidate.approvalId);
  const pending=relevant.find((candidate)=>candidate.status==="pending_approval");
  const initial=approved?.reelCover;
  const [mode,setMode]=useState<"instagram_default"|"video_frame"|"custom_image">(initial?.mode??"instagram_default");
  const [assetId,setAssetId]=useState(initial?.mode==="custom_image"?initial.mediaId:"");
  const [offsetSeconds,setOffsetSeconds]=useState(initial?.mode==="video_frame"?String(initial.offsetMs/1000):"0");
  const [shareToFeed,setShareToFeed]=useState(approved?.shareToFeed??true);
  const [previewUrl,setPreviewUrl]=useState("");
  const selectedAsset=props.coverAssets.find((asset)=>asset.id===assetId);
  const offsetMs=Math.round(Number(offsetSeconds)*1000);
  const frameInvalid=mode==="video_frame"&&(!Number.isFinite(offsetMs)||offsetMs<0||!props.videoDurationMs||offsetMs>=props.videoDurationMs);
  const changed=!approved||approved.shareToFeed!==shareToFeed||approved.reelCover?.mode!==mode||(mode==="custom_image"&&approved.reelCover?.mode==="custom_image"&&approved.reelCover.mediaId!==assetId)||(mode==="video_frame"&&approved.reelCover?.mode==="video_frame"&&approved.reelCover.offsetMs!==offsetMs);

  useEffect(()=>{let cancelled=false;setPreviewUrl("");if(mode!=="custom_image"||!selectedAsset)return;void(async()=>{const response=await apiFetch(`/v1/media-assets/${encodeURIComponent(selectedAsset.id)}/download-url?workspaceId=${encodeURIComponent(props.workspaceId)}`,{cache:"no-store"},props.csrfToken);if(!response.ok)return;const body=await response.json() as {url?:string};if(!cancelled&&body.url)setPreviewUrl(body.url);})();return()=>{cancelled=true};},[mode,props.csrfToken,props.workspaceId,selectedAsset]);

  async function submit(event:FormEvent){event.preventDefault();if(!changed||frameInvalid||(mode==="custom_image"&&!selectedAsset))return;const reelCover:CoverInput=mode==="custom_image"?{mode,mediaId:selectedAsset!.id}:mode==="video_frame"?{mode,offsetMs}:{mode};await props.onSave({accountId:props.accountId,draftId:props.draftId,collaborators:approved?.collaborators??[],shareToFeed,isAiGenerated:approved?.isAiGenerated===true,reelCover});}

  return <section className={styles.panel} aria-labelledby="reel-cover-title"><header><span><SquarePlay size={18}/></span><div><h3 id="reel-cover-title">Instagram Reel cover review</h3><p>Approve the exact cover, feed choice, account, and Reel draft before scheduling.</p></div></header>
    <form onSubmit={submit}>
      <fieldset><legend>Cover source</legend><label><input type="radio" name="reel-cover" checked={mode==="custom_image"} onChange={()=>setMode("custom_image")}/><span><strong>Custom image</strong><small>Ready Library image with owned or cleared rights.</small></span></label><label><input type="radio" name="reel-cover" checked={mode==="video_frame"} onChange={()=>setMode("video_frame")}/><span><strong>Video frame</strong><small>Use an exact millisecond position from the checked Reel.</small></span></label><label><input type="radio" name="reel-cover" checked={mode==="instagram_default"} onChange={()=>setMode("instagram_default")}/><span><strong>Instagram default</strong><small>Send neither a cover URL nor frame offset.</small></span></label></fieldset>
      {mode==="custom_image"?<div className={styles.custom}><label>Cover image<select value={assetId} required onChange={(event)=>setAssetId(event.target.value)}><option value="">Choose a ready image</option>{props.coverAssets.map((asset)=><option value={asset.id} key={asset.id}>{asset.fileName} · {asset.rights}</option>)}</select></label>{selectedAsset?<div className={styles.asset}>{previewUrl?<img src={previewUrl} alt={selectedAsset.fileName}/>:<span><ImageIcon size={22}/></span>}<div><strong>{selectedAsset.fileName}</strong><small>{selectedAsset.widthPixels??"?"}×{selectedAsset.heightPixels??"?"} · {shortCollaboratorHash(selectedAsset.sha256)}</small><p>Preview only. Instagram may crop differently across profile and feed surfaces.</p></div></div>:<p className={styles.warning}><AlertTriangle size={14}/>Upload or choose one ready, inspected image.</p>}</div>:null}
      {mode==="video_frame"?<label className={styles.frame}>Frame time (seconds)<input type="number" inputMode="decimal" min="0" max={props.videoDurationMs?Math.max(0,(props.videoDurationMs-1)/1000):undefined} step="0.001" value={offsetSeconds} onChange={(event)=>setOffsetSeconds(event.target.value)}/><small>{props.videoDurationMs?`Allowed: 0 to ${((props.videoDurationMs-1)/1000).toFixed(3)} seconds. The approved value is stored as ${Number.isFinite(offsetMs)?offsetMs:0} ms.`:"Trusted video duration is unavailable; frame mode is blocked."}</small>{frameInvalid?<span className={styles.error}>Choose a frame strictly inside the measured Reel duration.</span>:null}</label>:null}
      <label className={styles.feed}><input type="checkbox" checked={shareToFeed} onChange={(event)=>setShareToFeed(event.target.checked)}/><span><strong>Share Reel to feed</strong><small>This choice is included in the exact settings hash.</small></span></label>
      {approved?<div className={styles.approved}><ShieldCheck size={15}/><div><strong>Approved cover settings</strong><p>{approved.reelCover?.mode.replaceAll("_"," ")??"Legacy settings"} · {shareToFeed?"shared to feed":"Reels tab only"} · {shortCollaboratorHash(approved.approvedSettingsSha256)}</p></div></div>:null}
      {changed&&approved?<p className={styles.warning}><AlertTriangle size={14}/>The cover or feed choice changed. Save and approve a new exact settings request.</p>:null}
      {pending?<div className={styles.pending}><Clock3 size={15}/><div><strong>Waiting for human approval</strong><p>{pending.reelCover?.mode.replaceAll("_"," ")??"Instagram options"} · saved {new Date(pending.requestedAt).toLocaleString()}</p></div>{props.canApprove?<button type="button" disabled={props.busy} onClick={()=>void props.onApprove(pending.id)}><ShieldCheck size={14}/>Approve exact options</button>:null}</div>:null}
      <footer><p>Meta receives a short-lived protected media URL only during publishing. OriginPost binds approval and proof to the stable media hash or frame offset.</p><button disabled={!props.canEdit||props.busy||!changed||frameInvalid||(mode==="custom_image"&&!selectedAsset)}>{props.busy?<LoaderCircle className={styles.spin} size={14}/>:<ShieldCheck size={14}/>}Save cover for approval</button></footer>
    </form>
  </section>;
}
