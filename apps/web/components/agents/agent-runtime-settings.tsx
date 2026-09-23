"use client";

import { Activity, ArrowRight, Bot, CheckCircle2, CircleOff, Cpu, KeyRound, Loader2, PlugZap, RefreshCw, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import { requestDeadline } from "../../lib/request-deadline";
import styles from "./agent-runtime-settings.module.css";

type RuntimePreset = "openai" | "openrouter" | "ollama" | "custom" | "codex-local";
type RuntimeStatus = "unverified" | "healthy" | "error" | "disabled";
type RuntimeProfile = { id:string; version:number; name:string; preset:RuntimePreset; baseUrl:string; textModel:string; visionModel?:string; credentialConfigured:boolean; status:RuntimeStatus; lastCheckedAt?:string; lastError?:string; updatedAt:string };
type RuntimeAssignment = { workspaceId:string; brandId:string; profileId:string; assignedAt:string };
type RuntimeRun = { id:string; profileId:string; contentItemId?:string; feature:"draft_assist"|"copy_review"|"image_review"; model:string; status:"succeeded"|"failed"; inputTokens?:number; outputTokens?:number; latencyMs:number; errorCode?:string; createdAt:string };
type RuntimeView = { profiles:RuntimeProfile[]; assignment:RuntimeAssignment|null; runs:RuntimeRun[]; serverHermes:{configured:boolean;fallbackOnlyWhenUnassigned:boolean} };

const emptyView:RuntimeView={profiles:[],assignment:null,runs:[],serverHermes:{configured:false,fallbackOnlyWhenUnassigned:true}};
const presetCopy:Record<RuntimePreset,{label:string;hint:string;baseUrl:string;modelPlaceholder:string}>={
  "codex-local":{label:"Local Codex",hint:"Use your server’s signed-in Codex bridge for writing and image review. Image creation is configured separately.",baseUrl:"Server-configured local bridge",modelPlaceholder:"Exact model configured on the bridge"},
  openai:{label:"OpenAI API",hint:"Use an OpenAI API key for text and image review. API usage has separate billing from ChatGPT.",baseUrl:"https://api.openai.com/v1",modelPlaceholder:"Your approved OpenAI model"},
  openrouter:{label:"OpenRouter",hint:"Use one key across supported model providers",baseUrl:"https://openrouter.ai/api/v1",modelPlaceholder:"provider/model-name"},
  ollama:{label:"Ollama",hint:"A trusted local OpenAI-compatible server",baseUrl:"http://host.docker.internal:11434/v1",modelPlaceholder:"Your installed Ollama model"},
  custom:{label:"Custom endpoint",hint:"vLLM, LM Studio, or another compatible server",baseUrl:"",modelPlaceholder:"Exact provider model ID"},
};

function message(body:unknown,fallback:string){if(!body||typeof body!=="object")return fallback;const value=(body as{message?:unknown}).message;return Array.isArray(value)?value.join(" "):typeof value==="string"?value:fallback;}
function stamp(value?:string){if(!value)return"Not checked";const date=new Date(value);return Number.isNaN(date.getTime())?"Time unavailable":new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(date);}
function statusCopy(status:RuntimeStatus){return status==="healthy"?"Ready":status==="unverified"?"Test required":status==="disabled"?"Disabled":"Needs attention";}

export function AgentRuntimeSettings({auth,workspaceId,brandId}:{auth:AuthView;workspaceId:string;brandId:string}){
  const [view,setView]=useState<RuntimeView>(emptyView);const [loading,setLoading]=useState(true);const [busy,setBusy]=useState("");const [error,setError]=useState("");const [notice,setNotice]=useState("");const [formOpen,setFormOpen]=useState(false);const [preset,setPreset]=useState<RuntimePreset>("openai");
  const role=auth.memberships.find((membership)=>membership.workspaceId===workspaceId)?.role;const isOwner=role==="owner";
  const assigned=useMemo(()=>view.profiles.find((profile)=>profile.id===view.assignment?.profileId),[view.assignment?.profileId,view.profiles]);
  const activeLoad=useRef<ReturnType<typeof requestDeadline>|null>(null);
  const load=useCallback(async()=>{
    activeLoad.current?.cancel();
    if(!isOwner){activeLoad.current=null;setView(emptyView);setLoading(false);return;}
    const deadline=requestDeadline();
    activeLoad.current=deadline;
    setLoading(true);setError("");
    try{
      const response=await apiFetch(`/v1/agent-runtimes?workspaceId=${encodeURIComponent(workspaceId)}&brandId=${encodeURIComponent(brandId)}&limit=50`,{cache:"no-store",signal:deadline.signal},auth.csrfToken);
      const body=await response.json();
      if(!response.ok)throw new Error(message(body,"Could not load AI runtimes."));
      if(activeLoad.current===deadline)setView(body as RuntimeView);
    }catch(cause){
      if(activeLoad.current===deadline)setError(deadline.signal.aborted?"The server took too long to respond. Try Refresh to check your providers again.":cause instanceof Error?cause.message:"Could not load AI runtimes.");
    }finally{
      deadline.dispose();
      if(activeLoad.current===deadline)setLoading(false);
    }
  },[auth.csrfToken,brandId,isOwner,workspaceId]);
  useEffect(()=>{
    void load();
    return()=>{activeLoad.current?.cancel();activeLoad.current=null;};
  },[load]);

  async function request(path:string,init:RequestInit,fallback:string){setError("");setNotice("");const response=await apiFetch(path,init,auth.csrfToken);const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(message(body,fallback));return body;}
  async function saveVision(profile:RuntimeProfile,event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);setBusy(`vision:${profile.id}`);try{await request(`/v1/agent-runtimes/${encodeURIComponent(profile.id)}?workspaceId=${encodeURIComponent(workspaceId)}`,{method:"PATCH",headers:{"content-type":"application/json","If-Match":String(profile.version)},body:JSON.stringify({visionModel:String(data.get("visionModel")??"").trim()})},"Could not save the vision model.");setNotice("Vision model saved. Test this runtime again before using it.");await load();}catch(cause){setError(cause instanceof Error?cause.message:"Could not save the vision model.");}finally{setBusy("");}}
  async function create(event:FormEvent<HTMLFormElement>){event.preventDefault();const target=event.currentTarget;const data=new FormData(target);setBusy("create");try{const body={workspaceId,name:String(data.get("name")??"").trim(),preset,textModel:String(data.get("textModel")??"").trim(),...(String(data.get("visionModel")??"").trim()?{visionModel:String(data.get("visionModel")).trim()}:{}),...(preset==="ollama"||preset==="custom"?{baseUrl:String(data.get("baseUrl")??"").trim()}:{}),...(String(data.get("apiKey")??"").trim()?{apiKey:String(data.get("apiKey")).trim()}:{})};await request("/v1/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)},"Could not save this AI runtime.");target.reset();setFormOpen(false);setNotice("Runtime saved. Test it before assigning it to this brand.");await load();}catch(cause){setError(cause instanceof Error?cause.message:"Could not save this AI runtime.");}finally{setBusy("");}}
  async function test(profile:RuntimeProfile){setBusy(`test:${profile.id}`);try{const result=await request(`/v1/agent-runtimes/${encodeURIComponent(profile.id)}/test?workspaceId=${encodeURIComponent(workspaceId)}`,{method:"POST"},"Could not test this runtime.") as {ok?:boolean;error?:{message?:string}};setNotice(result.ok?`${profile.name} is ready.`:result.error?.message??`${profile.name} needs attention.`);await load();}catch(cause){setError(cause instanceof Error?cause.message:"Could not test this runtime.");}finally{setBusy("");}}
  async function assign(profile:RuntimeProfile){setBusy(`assign:${profile.id}`);try{await request(`/v1/agent-runtimes/${encodeURIComponent(profile.id)}/assign`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspaceId,brandId})},"Could not assign this runtime.");setNotice(`${profile.name} now handles draft assistance for this brand.`);await load();}catch(cause){setError(cause instanceof Error?cause.message:"Could not assign this runtime.");}finally{setBusy("");}}
  async function unassign(){setBusy("unassign");try{await request(`/v1/agent-runtimes/assignments/${encodeURIComponent(brandId)}?workspaceId=${encodeURIComponent(workspaceId)}`,{method:"DELETE"},"Could not return this brand to the server default.");setNotice(view.serverHermes.configured?"This brand now uses the configured server draft provider.":"Assignment removed. Assign a tested runtime before drafting with AI.");await load();}catch(cause){setError(cause instanceof Error?cause.message:"Could not remove this assignment.");}finally{setBusy("");}}
  async function toggle(profile:RuntimeProfile){const disabled=profile.status!=="disabled";setBusy(`toggle:${profile.id}`);try{await request(`/v1/agent-runtimes/${encodeURIComponent(profile.id)}?workspaceId=${encodeURIComponent(workspaceId)}`,{method:"PATCH",headers:{"content-type":"application/json","if-match":String(profile.version)},body:JSON.stringify({disabled})},`Could not ${disabled?"disable":"enable"} this runtime.`);setNotice(disabled?`${profile.name} is disabled.`:`${profile.name} must be tested again before use.`);await load();}catch(cause){setError(cause instanceof Error?cause.message:"Could not update this runtime.");}finally{setBusy("");}}
  async function remove(profile:RuntimeProfile){if(!window.confirm(`Delete ${profile.name}? This is available only before the runtime has usage history. Its encrypted key will be removed.`))return;setBusy(`remove:${profile.id}`);try{await request(`/v1/agent-runtimes/${encodeURIComponent(profile.id)}?workspaceId=${encodeURIComponent(workspaceId)}`,{method:"DELETE",headers:{"if-match":String(profile.version)}},"Could not delete this runtime.");setNotice(`${profile.name} deleted.`);await load();}catch(cause){setError(cause instanceof Error?cause.message:"Could not delete this runtime.");}finally{setBusy("");}}

  function connect(value:RuntimePreset){setPreset(value);setFormOpen(true);}

  if(!isOwner)return <section className={styles.module} aria-labelledby="agent-runtime-title"><header className={styles.heading}><div><p>AI PROVIDERS</p><h2 id="agent-runtime-title">Create with your project’s AI</h2><span>Your workspace owner manages provider connections and keys. Use the generation tools with your project’s configured providers.</span></div></header><nav className={styles.generationLinks} aria-label="Generation tools"><a href="/create">Generate text <ArrowRight size={14}/></a><a href="/creative-studio?generate=image">Generate an image <ArrowRight size={14}/></a><a href="/agent">Open agent <ArrowRight size={14}/></a></nav></section>;

  return <section className={styles.module} aria-labelledby="agent-runtime-title">
    <header className={styles.heading}><div><p>AI PROVIDERS</p><h2 id="agent-runtime-title">Connect your generation tools</h2><span>Choose a text provider for this brand. Connect image generation separately, then create your post.</span></div><button onClick={()=>void load()} disabled={loading}><RefreshCw className={loading?styles.spin:""} size={15}/>Refresh</button></header>
    <nav className={styles.generationLinks} aria-label="Generation tools"><a href="/create">Generate text <ArrowRight size={14}/></a><a href="/creative-studio?generate=image">Generate an image <ArrowRight size={14}/></a><a href="/setup?provider=images">Set up image API <ArrowRight size={14}/></a></nav>
    <ol className={styles.steps} aria-label="Provider setup steps"><li><strong>1. Connect</strong><span>Save a provider and model</span></li><li><strong>2. Test</strong><span>Check the model connection</span></li><li><strong>3. Assign</strong><span>Use it for this brand</span></li><li><strong>4. Create</strong><span>Generate text or open the agent</span></li></ol>
    {error?<div className={styles.error} role="alert"><TriangleAlert size={15}/>{error}</div>:null}{notice?<div className={styles.notice} role="status"><CheckCircle2 size={15}/>{notice}</div>:null}
    {!loading&&!error?<div className={styles.assignment}>
      <span className={assigned?styles.assignedIcon:styles.defaultIcon}>{assigned?<PlugZap size={22}/>:<Bot size={22}/>}</span>
      <div><small>ACTIVE FOR THIS BRAND</small><strong>{assigned?.name??(view.serverHermes.configured?"Hermes · server default":"No text provider assigned")}</strong><p>{assigned?`${presetCopy[assigned.preset].label} · ${assigned.textModel}`:view.serverHermes.configured?"Hermes handles text when no provider is assigned. Live research also needs its server connection; images use the image API.":"Draft assistance will stay unavailable until an owner assigns a tested runtime."}</p></div>
      {assigned?<button onClick={()=>void unassign()} disabled={Boolean(busy)}><CircleOff size={14}/>{busy==="unassign"?"Removing…":"Use server default"}</button>:null}
    </div>:loading?<p className={styles.loading} role="status"><Loader2 className={styles.spin} size={15}/>Checking provider connections…</p>:null}
    <div className={styles.toolbar}><div><h3>Text and image review</h3><p>Keys are encrypted on the server and never returned to this screen.</p></div><button className={styles.primary} onClick={()=>setFormOpen((value)=>!value)} aria-expanded={formOpen} aria-controls="provider-connection-form">{formOpen?"Close form":"Add provider"}</button></div>
    <div className={styles.providerChoices} aria-label="Connect a text provider"><button onClick={()=>connect("openai")}>Connect OpenAI API</button><button onClick={()=>connect("codex-local")}>Connect local Codex</button><button onClick={()=>connect("custom")}>Other provider</button><p>OpenAI API usage is billed separately from ChatGPT. Codex requires a local bridge; Hermes is managed on the server. These text connections do not enable image creation.</p></div>
    {formOpen?<form id="provider-connection-form" key={preset} className={styles.form} onSubmit={create}>
      <label>Provider<select value={preset} onChange={(event)=>setPreset(event.target.value as RuntimePreset)}>{Object.entries(presetCopy).map(([value,copy])=><option key={value} value={value}>{copy.label}</option>)}</select><small>{presetCopy[preset].hint}</small></label>
      <label>Connection name<input name="name" required minLength={2} maxLength={100} placeholder="Editorial text provider"/></label>
      {(preset==="ollama"||preset==="custom")?<label className={styles.wide}>Base URL<input name="baseUrl" type="url" required maxLength={500} defaultValue={presetCopy[preset].baseUrl} key={preset} placeholder="https://provider.example/v1"/><small>Private-network endpoints require the deployment owner to enable the explicit server gate.</small></label>:<div className={`${styles.fixed} ${styles.wide}`}><ShieldCheck size={15}/><span><strong>Fixed provider endpoint</strong><small>{presetCopy[preset].baseUrl}</small></span></div>}
      <label>Text model<input name="textModel" required maxLength={160} placeholder={presetCopy[preset].modelPlaceholder}/></label>
      <label>Vision model <span>For checking images, not creating them</span><input name="visionModel" maxLength={160} placeholder="Exact model ID that accepts image input"/></label>
      <p className={styles.formHint}>News-post creation needs a tested vision model. Testing sends a small generated color sample and uses your provider’s image-input allowance. This checks the connection, not editorial accuracy.</p>
      <label>{preset==="codex-local"?"Local bridge token":"Provider key"} <span>{preset==="codex-local"?"Required · supplied by your bridge":preset==="openai"||preset==="openrouter"?"Required":"If your endpoint requires authentication"}</span><input name="apiKey" type="password" autoComplete="new-password" maxLength={1000} required={preset==="openai"||preset==="openrouter"||preset==="codex-local"} placeholder="Saved encrypted; never shown again"/></label>
      <div className={styles.formFoot}><p><KeyRound size={14}/>Next: test the connection, then assign it to this brand.</p><button className={styles.primary} disabled={busy==="create"}>{busy==="create"?<Loader2 className={styles.spin} size={14}/>:<PlugZap size={14}/>}Save provider</button></div>
    </form>:null}
    <div className={styles.cards} aria-busy={loading}>{view.profiles.map((profile)=><article key={profile.id} className={`${styles.card} ${styles[profile.status]}`}>
      <div className={styles.cardHead}><span><Cpu size={18}/></span><div><strong>{profile.name}</strong><small>{presetCopy[profile.preset].label} · {profile.textModel}</small></div><em>{statusCopy(profile.status)}</em></div>
      <dl><div><dt>Image review</dt><dd>{profile.visionModel??"Not configured"}</dd></div><div><dt>Endpoint</dt><dd>{profile.baseUrl}</dd></div><div><dt>Credential</dt><dd>{profile.credentialConfigured?"Encrypted key saved":"No key required/saved"}</dd></div><div><dt>Last check</dt><dd>{stamp(profile.lastCheckedAt)}</dd></div></dl>
      <form key={profile.version} className={styles.visionForm} onSubmit={event=>void saveVision(profile,event)}><label>Vision model<input name="visionModel" defaultValue={profile.visionModel??""} maxLength={160} placeholder="Add an image-capable model ID" disabled={Boolean(busy)||profile.status==="disabled"}/></label><button disabled={Boolean(busy)||profile.status==="disabled"}>Save vision model</button></form>
      {profile.visionModel?<p className={styles.formHint}>Testing image review sends one small sample and may use provider credits.</p>:null}
      {profile.lastError?<p className={styles.profileError}><TriangleAlert size={13}/>{profile.lastError}</p>:null}
      <div className={styles.actions}><button onClick={()=>void test(profile)} disabled={Boolean(busy)||profile.status==="disabled"}>{busy===`test:${profile.id}`?<Loader2 className={styles.spin} size={13}/>:<Activity size={13}/>}Test{profile.visionModel?" connection + image review":" connection"}</button><button className={styles.assign} onClick={()=>void assign(profile)} disabled={Boolean(busy)||profile.status!=="healthy"||view.assignment?.profileId===profile.id}>{view.assignment?.profileId===profile.id?"Assigned":"Assign to brand"}</button><button onClick={()=>void toggle(profile)} disabled={Boolean(busy)}>{profile.status==="disabled"?"Enable":"Disable"}</button><button className={styles.delete} aria-label={`Delete ${profile.name}`} onClick={()=>void remove(profile)} disabled={Boolean(busy)}><Trash2 size={13}/></button></div>
    </article>)}</div>
    {!loading&&!error&&view.profiles.length===0?<div className={styles.empty}><Cpu size={24}/><strong>No text provider connected yet</strong><p>Choose OpenAI API, local Codex, or another compatible provider above. The image API has its own setup and generation controls.</p></div>:null}
    <section className={styles.ledger}><div><h3>Usage ledger</h3><p>Hashes, model, token counts, latency, and outcome only. Prompt and response text are not stored here.</p></div>{view.runs.length?<div className={styles.runList}>{view.runs.slice(0,12).map((run)=><article key={run.id}><span className={run.status===`succeeded`?styles.runOk:styles.runFail}>{run.status===`succeeded`?<CheckCircle2 size={13}/>:<TriangleAlert size={13}/>}</span><div><strong>{run.model}</strong><small>{run.feature.replaceAll("_"," ")} · {run.status}{run.errorCode?` · ${run.errorCode}`:""} · {stamp(run.createdAt)}</small></div><em>{typeof run.inputTokens==="number"||typeof run.outputTokens==="number"?`${(run.inputTokens??0)+(run.outputTokens??0)} tokens`:"Tokens unavailable"}</em><time>{run.latencyMs.toLocaleString()} ms</time></article>)}</div>:<div className={styles.emptyLedger}>No workspace-runtime draft runs yet.</div>}</section>
  </section>;
}
