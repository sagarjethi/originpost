"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AudioLines, Download, KeyRound, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import { languageSkills as starterSkills, languageCode, shortAudioSamples, type AudioProfile, type AudioRun, type AudioSkill } from '@originpost/domain';
import { apiFetch, type AuthView } from '../../lib/api-client';
import styles from './audio-studio.module.css';
import { voiceDraftKey } from '../voice/post-voice-action';
import { FormSection } from '../forms/form-section';

type ProjectTemplate = {id:string;name:string;language:string;boardId?:string};
type NewsRun = {id:string;contentItemId:string;createdAt:string;template:ProjectTemplate;copy?:{headline:string;caption:string}};
type Model = { id: string; name: string; languages: { code: string; name: string }[] };
type Voice = { id: string; name: string; category: string };
type View = { profiles: AudioProfile[]; runs: AudioRun[]; encryptionConfigured: boolean; adminIpRestricted: boolean };

async function checksum(value: unknown) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function localDate(value:string) {const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function errorMessage(body: unknown) { const m=(body as {message?:string|string[]})?.message; return Array.isArray(m)?m.join(' '):m || 'The request could not be completed.'; }

export function AudioStudio({auth,workspaceId,brandId,brandName}:{auth:AuthView;workspaceId:string;brandId:string;brandName?:string}) {
  const role=auth.memberships.find(m=>m.workspaceId===workspaceId)?.role;
  const owner=role==='owner';
  const [view,setView]=useState<View>({profiles:[],runs:[],encryptionConfigured:false,adminIpRestricted:false});
  const [profileId,setProfileId]=useState('');
  const [catalogue,setCatalogue]=useState<{models:Model[];voices:Voice[];nextCursor?:string}>({models:[],voices:[]});
  const [voiceId,setVoiceId]=useState(''); const [language,setLanguage]=useState('gu');
  const [text,setText]=useState(''); const [skillId,setSkillId]=useState(''); const [contentItemId,setContentItemId]=useState('');
  const [templates,setTemplates]=useState<ProjectTemplate[]>([]);
  const [newsRuns,setNewsRuns]=useState<NewsRun[]>([]);
  const [boards,setBoards]=useState<{id:string;name:string}[]>([]);
  const [boardFilter,setBoardFilter]=useState('');
  const [projectFilter,setProjectFilter]=useState(''); const [dateFilter,setDateFilter]=useState('');
  const [sample,setSample]=useState(true); const [contextRun,setContextRun]=useState<NewsRun|null>(null);
  const dialogRef=useRef<HTMLDialogElement>(null);
  const [items,setItems]=useState<{id:string;title:string}[]>([]);
  const [rights,setRights]=useState(false); const [busy,setBusy]=useState(''); const [loading,setLoading]=useState(true);
  const [error,setError]=useState(''); const [notice,setNotice]=useState(''); const [settings,setSettings]=useState(false);
  const [editing,setEditing]=useState<AudioProfile|null>(null); const [skills,setSkills]=useState<AudioSkill[]>(starterSkills);
  const [preview,setPreview]=useState<{url:string;id:string}|null>(null);
  const pendingRequest=useRef<{body:string;id:string}|null>(null);
  const profile=view.profiles.find(p=>p.id===profileId);
  const model=catalogue.models.find(m=>m.id===profile?.model);
  const selectedSkill=profile?.skills.find(s=>s.id===skillId);
  const languages=[...(model?.languages ?? [{code:'gu',name:'Gujarati'},{code:'hi',name:'Hindi'},{code:'en',name:'English'}])].sort((a,b)=> ['gu','hi','en'].indexOf(a.code)<0 ? 1 : ['gu','hi','en'].indexOf(b.code)<0 ? -1 : ['gu','hi','en'].indexOf(a.code)-['gu','hi','en'].indexOf(b.code));
  const canGenerate=Boolean(profile?.enabled && role && profile.allowedRoles.includes(role) && model && model.languages.some(l=>l.code===language));
  const limit=Math.min(sample?100:3000,profile?.maxCharacters ?? 1500,selectedSkill?.maxCharacters ?? 3000);
  const query=new URLSearchParams({workspaceId,brandId}).toString();
  const request=useCallback(async(path:string,init:RequestInit={})=>{const response=await apiFetch(path,init,auth.csrfToken);const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(errorMessage(body));return body;},[auth.csrfToken]);
  const load=useCallback(async()=>{
    const [next,content,projects,posts,boardView]=await Promise.all([request(`/v1/audio?${new URLSearchParams({workspaceId,brandId})}`),request(`/v1/content-items?${new URLSearchParams({workspaceId,brandId})}`),request(`/v1/agent-posts/templates?${new URLSearchParams({workspaceId,brandId})}`),request(`/v1/agent-posts?${new URLSearchParams({workspaceId,brandId})}`),request(`/v1/boards?${new URLSearchParams({workspaceId,brandId})}`)]);
    setBoards(boardView.boards);setTemplates(projects);setNewsRuns(posts);setView(next as View); setItems(Array.isArray(content)?content:[]);
    setProfileId(current=>(next as View).profiles.some(p=>p.id===current)?current:((next as View).profiles[0]?.id ?? ''));
  },[request,workspaceId,brandId]);
  useEffect(()=>{void load().catch(e=>setError(e.message)).finally(()=>setLoading(false));},[load]);
  useEffect(()=>{if(settings)dialogRef.current?.showModal();else dialogRef.current?.close();},[settings]);
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search),runId=params.get('voiceRun');
    if(!runId)return;
    if(params.get('voiceWorkspace')!==workspaceId||params.get('voiceBrand')!==brandId){setError('Select the original workspace and brand to open this post’s voice script.');return;}
    let active=true;
    void request(`/v1/agent-posts/${encodeURIComponent(runId)}?${new URLSearchParams({workspaceId,brandId})}`).then((run:NewsRun)=>{
      if(!active)return;
      let script=run.copy?.caption ?? '';
      try { const key=voiceDraftKey(auth.user.id,workspaceId,brandId,runId),raw=sessionStorage.getItem(key);sessionStorage.removeItem(key);if(raw){const saved=JSON.parse(raw);if(saved.expiresAt>Date.now()&&typeof saved.text==='string'&&saved.text.length<=3000)script=saved.text;} } catch { /* Recover persisted copy if the ephemeral draft is unavailable. */ }
      setContextRun(run);setContentItemId(run.contentItemId);setLanguage(languageCode(run.template.language));setText(script);setSample(script.length<=100);setRights(false);
    }).catch(e=>{if(active)setError(e.message);});
    return ()=>{active=false;};
  },[request,workspaceId,brandId,auth.user.id]);
  // The parent keys this component by workspace and brand, preventing cross-project state reuse.
  useEffect(()=>{setCatalogue({models:[],voices:[]});setVoiceId('');setSkillId('');setPreview(null);},[profileId]);
  async function act(name:string,work:()=>Promise<void>) { setBusy(name);setError('');setNotice('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Request failed.');}finally{setBusy('');} }
  async function catalogueLoad(more=false) {
    const next=await request(`/v1/audio/profiles/${encodeURIComponent(profileId)}/catalogue?${query}${more&&catalogue.nextCursor?`&cursor=${encodeURIComponent(catalogue.nextCursor)}`:''}`);
    setCatalogue({models:next.models,voices:more?[...catalogue.voices,...next.voices]:next.voices,...(next.nextCursor?{nextCursor:next.nextCursor}:{})});
    if (!more) setVoiceId(next.voices[0]?.id ?? '');
    setNotice('Connection checked. The voice and model lists are current.');
  }
  function edit(p:AudioProfile|null) { setEditing(p);setSkills(p?.skills ?? starterSkills);setSettings(true); }
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form=event.currentTarget;const data=new FormData(form);
    await act('save',async()=>{
      const key=String(data.get('apiKey') ?? '').trim();
      const projectTemplateId=String(data.get('projectTemplateId')??'');
      const body={workspaceId,brandId,...(projectTemplateId?{projectTemplateId}:{}),version:editing?.version ?? 0,provider:'elevenlabs',name:String(data.get('name')),model:String(data.get('model')),enabled:data.get('enabled')==='on',allowedRoles:data.getAll('roles'),maxCharacters:Number(data.get('maxCharacters')),dailyRequests:Number(data.get('dailyRequests')),skills,...(key?{apiKey:key}:{})};
      const result=await request(`/v1/audio/profiles${editing?`/${encodeURIComponent(editing.id)}`:''}`,{method:editing?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      form.reset();setSettings(false);setCatalogue({models:[],voices:[]});await load();setProfileId(result.id);setNotice('Provider saved. Load voices to verify access before generating.');
    });
  }
  async function generate(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();await act('generate',async()=>{
      const draft={workspaceId,brandId,profileId,voiceId,language,text,sample,...(contextRun?.contentItemId===contentItemId?{projectTemplateId:contextRun.template.id}:{}),rightsConfirmed:rights,...(skillId?{skillId}:{}),...(contentItemId?{contentItemId}:{})};
      const identity=JSON.stringify({...draft,profileVersion:profile?.version});
      if(pendingRequest.current?.body!==identity)pendingRequest.current={body:identity,id:crypto.randomUUID()};
      const run=await request('/v1/audio/generations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...draft,requestId:pendingRequest.current.id})}) as AudioRun;
      await load();
      if(run.status==='failed')setError(run.error ?? 'Generation failed.');
      else setNotice(run.status==='ready'?'Narration saved to Library. Listen and review before using it in a post.':'This request is already running. Refresh to check its result; it will not be generated again.');
    });
  }
  async function draftScript() {
    const result=await request('/v1/audio/draft-script',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceId,brandId,profileId,contentItemId,language,sample,...(skillId?{skillId}:{}),...(contextRun?.contentItemId===contentItemId?{projectTemplateId:contextRun.template.id}:{})})});
    setText(result.text);setRights(false);setNotice('Script drafted from supported facts. Review the wording before generating voice.');
  }
  const associatedPost=(run:AudioRun)=>newsRuns.find(n=>n.contentItemId===run.contentItemId);
  const runTemplate=(run:AudioRun)=>templates.find(t=>t.id===run.projectTemplateId) ?? associatedPost(run)?.template;
  const filteredRuns=view.runs.filter(run=>(!boardFilter||runTemplate(run)?.boardId===boardFilter)&&(!dateFilter||localDate(run.createdAt)===dateFilter)&&(!projectFilter||(run.projectTemplateId ?? associatedPost(run)?.template.id)===projectFilter));
  const recordingDays=[...new Set(filteredRuns.map(run=>localDate(run.createdAt)))];
  async function exportSkills() {
    const manifest={schemaVersion:1,skills};const blob=new Blob([JSON.stringify({...manifest,sha256:await checksum(manifest)},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='originpost-audio-skills.json';a.click();URL.revokeObjectURL(url);
  }
  async function importSkills(file:File) {
    if(file.size>60_000)throw new Error('Skill packs must be under 60 KB.');
    const pack=JSON.parse(await file.text());
    if(pack.schemaVersion!==1||!Array.isArray(pack.skills)||pack.skills.length>20||pack.sha256!==await checksum({schemaVersion:pack.schemaVersion,skills:pack.skills}))throw new Error('Invalid or changed skill pack. Import a checksummed OriginPost export.');
    for (const skill of pack.skills) {
      if (!skill || typeof skill !== 'object' || Object.keys(skill).some(k=>!['id','name','version','language','instructions','maxCharacters'].includes(k)) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.id) || !/^\d+\.\d+\.\d+$/.test(skill.version) || !/^[a-z]{2,3}$/.test(skill.language) || typeof skill.name !== 'string' || !skill.name.trim() || skill.name.length>100 || typeof skill.instructions !== 'string' || !skill.instructions.trim() || skill.instructions.length>2000 || !Number.isInteger(skill.maxCharacters) || skill.maxCharacters<1 || skill.maxCharacters>3000) throw new Error('The skill pack contains an invalid or executable field.');
    }
    setSkills(pack.skills);setNotice('Imported for review. Read the instructions below and save settings to activate them.');
  }
  return <section className={styles.studio}>
    <header className={styles.hero}><div><p className={styles.eyebrow}>{brandName ?? "Current brand"} / VOICE & NARRATION</p><h1>Give your story a voice.</h1><p>Create narration in ગુજરાતી, हिंदी, English, and your model’s other languages.</p></div><AudioLines size={54} strokeWidth={1.2}/></header>
    <div className={styles.toolbar}><span><ShieldCheck size={17}/> Keys stay encrypted on the server</span><div><button disabled={!!busy} onClick={()=>void act('refresh',load)}><RefreshCw size={15}/>Refresh</button>{owner&&<button onClick={()=>edit(null)}><KeyRound size={15}/>Connect provider</button>}</div></div>
    {error&&<p className={styles.error} role="alert">{error}</p>}{notice&&<p className={styles.notice} role="status">{notice}</p>}
    {contextRun&&<div className={styles.context}><div><small>{contextRun.template.name} · {new Date(contextRun.createdAt).toLocaleDateString()}</small><strong>{contextRun.copy?.headline ?? 'News post'}</strong><span>The script and recording stay linked to this news item.</span></div><a href={`/agent?conversation=${encodeURIComponent(contextRun.id)}`}>Back to agent ↗</a></div>}
    {loading?<p role="status">Loading audio workspace…</p>:<div className={styles.layout}>
      <form className={styles.card} onSubmit={generate}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>01 / CREATE</p><h2>Build a narration</h2></div><span>MP3 · 128 kbps</span></div>
        {!view.profiles.length?<div className={styles.empty}><AudioLines size={32}/><h3>Connect your first voice provider</h3><p>{owner?'Add an ElevenLabs key, choose a model, and decide who can generate.':'Ask the workspace owner to connect an audio provider and enable your role.'}</p>{contextRun&&<label>Voice script<textarea rows={5} maxLength={3000} value={text} onChange={e=>setText(e.target.value)}/><small>{text.length} characters · Saved post copy, editable before generation.</small></label>}{owner&&<button type="button" onClick={()=>edit(null)}>Configure ElevenLabs</button>}</div>:<>
          <label>Provider<select value={profileId} onChange={e=>setProfileId(e.target.value)} disabled={!!busy}>{view.profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.model}{p.enabled?'':' · Disabled'}</option>)}</select></label>
          <div className={styles.row}><button type="button" disabled={!!busy||!profile} onClick={()=>void act('catalogue',()=>catalogueLoad())}>{busy==='catalogue'?'Checking…':'Load voices & check connection'}</button>{owner&&<button type="button" onClick={()=>edit(profile ?? null)}><Settings2 size={15}/>Settings</button>}</div>
          <div className={styles.fields}><label>Language<select value={language} onChange={e=>{setLanguage(e.target.value);setSkillId('');}}>{languages.map(l=><option key={l.code} value={l.code}>{l.code==='gu'?'ગુજરાતી · Gujarati':l.code==='hi'?'हिंदी · Hindi':l.name}</option>)}</select></label><label>Voice<select value={voiceId} onChange={e=>setVoiceId(e.target.value)}><option value="">Load and select a voice</option>{catalogue.voices.map(v=><option key={v.id} value={v.id}>{v.name} · {v.category}</option>)}</select></label></div>
          {catalogue.nextCursor&&<button type="button" disabled={!!busy} onClick={()=>void act('catalogue',()=>catalogueLoad(true))}>Load more voices</button>}
          <label>Reading style & skill<select value={skillId} onChange={e=>setSkillId(e.target.value)}><option value="">Your own reviewed script</option>{profile?.skills.filter(s=>s.language===language).map(s=><option key={s.id} value={s.id}>{s.name} · v{s.version}</option>)}</select></label>
          {selectedSkill&&<p className={styles.guidance} lang={language}>{selectedSkill.instructions}</p>}
          <div className={styles.row}><label className={styles.check}><input type="checkbox" checked={sample} onChange={e=>{setSample(e.target.checked);setRights(false);}}/>Short sample · 100 characters</label>{shortAudioSamples[language]&&<button type="button" disabled={!!busy} onClick={()=>{setText(shortAudioSamples[language]!);setSample(true);setRights(false);}}>Use sample</button>}</div>
          <label>Script<textarea value={text} onChange={e=>{setText(e.target.value);setRights(false);}} maxLength={limit} rows={5} lang={language} placeholder={language==='gu'?'તમારા ચકાસેલા સમાચાર અહીં લખો…':language==='hi'?'अपनी जांची हुई खबर यहां लिखें…':'Paste your reviewed narration here…'}/></label><small>{text.length.toLocaleString()} / {limit.toLocaleString()} characters · Only this script is sent to the voice provider.</small>
          <label>News item<select value={contentItemId} onChange={e=>{setContentItemId(e.target.value);setRights(false);}}><option value="">Save in this brand’s Library</option>{items.map(i=><option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
          <button type="button" disabled={!!busy||!contentItemId||!profile?.enabled||!role||!profile.allowedRoles.includes(role)} onClick={()=>void act("draft",draftScript)}>{busy==='draft'?'Drafting…':'Draft script from this post'}</button><small>Drafting uses the configured text model. Voice generation is a separate action.</small>
          <label className={styles.check}><input type="checkbox" checked={rights} onChange={e=>setRights(e.target.checked)}/>I have permission to use this script and voice, and have reviewed the wording.</label>
          <button className={styles.primary} disabled={!!busy||!canGenerate||!voiceId||!text.trim()||text.length>limit||!rights}>{busy==='generate'?'Generating narration…':'Generate narration'}</button>
          <small>Provider usage is billed to your account. Repeated clicks reuse the same request. Editing the script creates a new request.</small>
        </>}
      </form>
      <aside className={styles.card}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>02 / LISTEN & REUSE</p><h2>Your recordings</h2></div><a href="/library">Library ↗</a></div>
        {preview&&<div className={styles.playback}><audio controls src={preview.url}/><a href={preview.url} download><Download size={15}/>Download MP3</a></div>}
        <label>Project<select value={boardFilter} onChange={e=>setBoardFilter(e.target.value)}><option value="">All projects in this brand</option>{boards.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <div className={styles.fields}><label>Project profile<select value={projectFilter} onChange={e=>setProjectFilter(e.target.value)}><option value="">All project profiles</option>{[...new Map([...templates,...newsRuns.map(n=>n.template)].map(t=>[t.id,t])).values()].map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>Date<input type="date" value={dateFilter} onChange={e=>setDateFilter(e.target.value)}/></label></div>
        {!filteredRuns.length?<div className={styles.empty}><p>No recordings in this view. Generate a narration to listen, download, and reuse it with its news item.</p></div>:recordingDays.map(day=><section key={day}><h3 className={styles.dateHeading}>{new Date(day+'T12:00:00').toLocaleDateString(undefined,{dateStyle:'long'})}</h3>{filteredRuns.filter(run=>localDate(run.createdAt)===day).map(run=><article key={run.id} className={styles.recording}><div><small>{templates.find(t=>t.id===run.projectTemplateId)?.name ?? associatedPost(run)?.template.name ?? 'Brand library'}</small><strong>{items.find(i=>i.id===run.contentItemId)?.title ?? `${run.language.toUpperCase()} narration`}</strong><span>{run.language.toUpperCase()} · {run.characterCount} characters · {new Date(run.createdAt).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}</span></div><span className={styles.status}>{run.status}</span>{run.status==='ready'&&run.mediaId&&<button disabled={!!busy} onClick={()=>void act('play',async()=>{const result=await request(`/v1/media-assets/${encodeURIComponent(run.mediaId!)}/download-url?${query}`);setPreview({url:result.url,id:run.id});})}>Listen / download</button>}{run.contentItemId&&<a href={`/content?item=${encodeURIComponent(run.contentItemId)}`}>Open news item ↗</a>}{run.error&&<p>{run.error}</p>}{run.status==='generating'&&<p>Refresh for the result. Interrupted requests are retained and never retried automatically.</p>}</article>)}</section>)}
        <p className={styles.footnote}>Narration is labeled as AI-generated. Add it to a video before publishing to Instagram or YouTube; those platforms do not accept an MP3 as a video post.</p>
      </aside>
    </div>}
    {owner&&<dialog ref={dialogRef} className={styles.dialog} onCancel={()=>setSettings(false)} onClose={()=>setSettings(false)} aria-labelledby="audio-settings-heading">{settings&&<form className={styles.settings} onSubmit={save} key={editing?.id ?? 'new'}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>OWNER SETTINGS</p><h2 id="audio-settings-heading">{editing?'Edit audio provider':'Connect ElevenLabs'}</h2></div><button type="button" onClick={()=>setSettings(false)}>Close</button></div>
      <p>Only owners can manage keys and grant generation access.</p>
      {!view.encryptionConfigured&&<p className={styles.error}>Configure CREDENTIAL_ENCRYPTION_KEY on the server before saving a provider key.</p>}
      {error&&<p className={styles.error} role="alert">{error}</p>}
      <label>Connection name<input name="name" required maxLength={100} defaultValue={editing?.name ?? 'ElevenLabs narration'}/></label>
      <label>API key<input name="apiKey" type="password" autoComplete="new-password" required={!editing} minLength={19} maxLength={1000} pattern="sk_[a-zA-Z0-9_-]{16,}" placeholder={editing?'Leave blank to keep the current key':'Secret key starting with sk_ (not the key ID)'}/></label>
      <label>Default project profile<select name="projectTemplateId" defaultValue={editing?.projectTemplateId ?? contextRun?.template.id ?? ''}><option value="">No default project profile</option>{templates.map(t=><option key={t.id} value={t.id}>{t.name} · {t.language}</option>)}</select><small>Reuse saved language skills. Your logo remains part of the image workflow.</small></label>
      <FormSection title="Model, limits & access" description="Eleven v3 · 100 characters · 2 requests per day by default">
      <div className={styles.fields}><label>Model ID<input name="model" required pattern="[a-zA-Z0-9_-]{1,100}" defaultValue={editing?.model ?? 'eleven_v3'}/></label><label>Characters per request<input name="maxCharacters" type="number" min={1} max={3000} defaultValue={editing?.maxCharacters ?? 100}/></label><label>Requests per day (UTC)<input name="dailyRequests" type="number" min={1} max={1000} defaultValue={editing?.dailyRequests ?? 2}/></label></div>
      <fieldset><legend>Who may generate audio?</legend>{(['owner','manager','creator'] as const).map(r=><label className={styles.check} key={r}><input name="roles" type="checkbox" value={r} defaultChecked={(editing?.allowedRoles ?? ['owner']).includes(r)}/>{r}</label>)}</fieldset>
      <label className={styles.check}><input name="enabled" type="checkbox" defaultChecked={editing?.enabled ?? true}/>Enable this provider</label>
      </FormSection>
      <FormSection title="Reusable writing skills" description="Gujarati, Hindi and English · News, weather and explainers">
      <div className={styles.sectionHead}><h3>Reusable writing skills</h3><button type="button" onClick={()=>void act('export',exportSkills)}>Download skill pack</button></div>
      <p>Versioned writing guidance and character limits. No executable tools, remote downloads, or hidden agent instructions are installed. Review imported guidance before saving.</p>
      <label>Import reviewed skill pack<input type="file" accept="application/json,.json" onChange={e=>{const file=e.target.files?.[0];if(file)void act('import',()=>importSkills(file));e.target.value='';}}/></label>
      {skills.map((skill,index)=><details key={skill.id}><summary>{skill.name} · {skill.language} · v{skill.version}</summary><label>Instructions<textarea rows={3} maxLength={2000} value={skill.instructions} onChange={e=>setSkills(current=>current.map((s,i)=>i===index?{...s,instructions:e.target.value}:s))}/></label><label>Version<input value={skill.version} onChange={e=>setSkills(current=>current.map((s,i)=>i===index?{...s,version:e.target.value}:s))}/></label></details>)}
      </FormSection>
      <button className={styles.primary} disabled={!!busy||!view.encryptionConfigured}>{busy==='save'?'Saving…':'Save protected settings'}</button>
      <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noreferrer">Manage available voices in ElevenLabs ↗</a>
    </form>}</dialog>}
  </section>;
}
