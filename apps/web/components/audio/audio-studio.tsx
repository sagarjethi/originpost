"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AudioLines, Download, KeyRound, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import type { AudioProfile, AudioRun, AudioSkill } from '@originpost/domain';
import { apiFetch, type AuthView } from '../../lib/api-client';
import styles from './audio-studio.module.css';

type Model = { id: string; name: string; languages: { code: string; name: string }[] };
type Voice = { id: string; name: string; category: string };
type View = { profiles: AudioProfile[]; runs: AudioRun[]; encryptionConfigured: boolean; adminIpRestricted: boolean };
const starterSkills: AudioSkill[] = [
  { id:'gujarati-news',version:'1.0.0',name:'ગુજરાતી સમાચાર',language:'gu',maxCharacters:1500,instructions:'સરળ, રોજબરોજની ગુજરાતીમાં લખો. એક વાક્યમાં એક વાત રાખો. નામ, સ્થળ, તારીખ અને આંકડા મૂળ સ્રોત પ્રમાણે જ રાખો. આરોપને હકીકત તરીકે ન કહો. અવાજ બનાવતાં પહેલાં લખાણ વાંચીને તપાસો.' },
  { id:'hindi-news',version:'1.0.0',name:'हिंदी समाचार',language:'hi',maxCharacters:1500,instructions:'सरल हिंदी और छोटे वाक्य लिखें। नाम, जगह, तारीख और आंकड़े स्रोत के अनुसार रखें। आरोप को तथ्य न बताएं। आवाज़ बनाने से पहले पूरी स्क्रिप्ट पढ़कर जांचें।' },
  { id:'english-news',version:'1.0.0',name:'English news',language:'en',maxCharacters:1500,instructions:'Use plain English and short sentences. Preserve source names, places, dates and numbers. Attribute allegations. Review every sentence before generating narration. Do not invent facts or dialogue.' },
  { id:'gujarati-weather',version:'1.0.0',name:'ગુજરાતી હવામાન',language:'gu',maxCharacters:1200,instructions:'શાંત અને સ્પષ્ટ રીતે હવામાનની માહિતી આપો. સ્થળ, આગાહીનો સમય, તાપમાન અને વરસાદની શક્યતા સ્રોત પ્રમાણે રાખો. આગાહીને ખાતરી તરીકે ન કહો. ચેતવણી હોય તો તેને સ્રોતના નામ સાથે કહો.' },
  { id:'hindi-weather',version:'1.0.0',name:'हिंदी मौसम',language:'hi',maxCharacters:1200,instructions:'शांत और स्पष्ट भाषा में मौसम बताएं। जगह, पूर्वानुमान का समय, तापमान और बारिश की संभावना स्रोत के अनुसार रखें। पूर्वानुमान को पक्का न बताएं। चेतावनी हो तो स्रोत का नाम दें।' },
  { id:'english-weather',version:'1.0.0',name:'English weather reader',language:'en',maxCharacters:1200,instructions:'Use a calm, clear weather-reader style. State the location and forecast period first. Preserve temperatures, units and rain probabilities. Attribute warnings and keep forecasts uncertain. Do not add dramatic claims.' },
  { id:'gujarati-explainer',version:'1.0.0',name:'ગુજરાતીમાં સરળ સમજ',language:'gu',maxCharacters:1800,instructions:'વાતચીત જેવી સરળ ભાષામાં સમજાવો. શું થયું, કોને અસર થશે અને આગળ શું થઈ શકે તે અલગ વાક્યોમાં કહો. સ્રોતમાં ન હોય તેવું ઉદાહરણ કે આંકડો ઉમેરશો નહીં. નામ અને આંકડા બોલવામાં સરળ છે કે નહીં તે તપાસો.' },
  { id:'hindi-explainer',version:'1.0.0',name:'हिंदी में आसान समझ',language:'hi',maxCharacters:1800,instructions:'बातचीत जैसी सरल भाषा रखें। क्या हुआ, किस पर असर होगा और आगे क्या हो सकता है, अलग वाक्यों में समझाएं। स्रोत में न दिए गए उदाहरण या आंकड़े न जोड़ें। नाम और आंकड़ों का उच्चारण जांचें।' },
  { id:'english-explainer',version:'1.0.0',name:'English conversational explainer',language:'en',maxCharacters:1800,instructions:'Use a warm, conversational tone. Explain what happened, who is affected and what is still uncertain in separate short sentences. Preserve locked facts. Do not invent examples or quotations. Check pronunciation before publication.' },
];
async function checksum(value: unknown) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join(''); }
function errorMessage(body: unknown) { const m=(body as {message?:string|string[]})?.message; return Array.isArray(m)?m.join(' '):m || 'The request could not be completed.'; }

export function AudioStudio({auth,workspaceId,brandId}:{auth:AuthView;workspaceId:string;brandId:string}) {
  const role=auth.memberships.find(m=>m.workspaceId===workspaceId)?.role;
  const owner=role==='owner';
  const [view,setView]=useState<View>({profiles:[],runs:[],encryptionConfigured:false,adminIpRestricted:false});
  const [profileId,setProfileId]=useState('');
  const [catalogue,setCatalogue]=useState<{models:Model[];voices:Voice[];nextCursor?:string}>({models:[],voices:[]});
  const [voiceId,setVoiceId]=useState(''); const [language,setLanguage]=useState('gu');
  const [text,setText]=useState(''); const [skillId,setSkillId]=useState(''); const [contentItemId,setContentItemId]=useState('');
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
  const limit=Math.min(profile?.maxCharacters ?? 1500,selectedSkill?.maxCharacters ?? 3000);
  const query=new URLSearchParams({workspaceId,brandId}).toString();
  const request=useCallback(async(path:string,init:RequestInit={})=>{const response=await apiFetch(path,init,auth.csrfToken);const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(errorMessage(body));return body;},[auth.csrfToken]);
  const load=useCallback(async()=>{
    const [next,content]=await Promise.all([request(`/v1/audio?${new URLSearchParams({workspaceId,brandId})}`),request(`/v1/content-items?${new URLSearchParams({workspaceId,brandId})}`)]);
    setView(next as View); setItems(Array.isArray(content)?content:[]);
    setProfileId(current=>(next as View).profiles.some(p=>p.id===current)?current:((next as View).profiles[0]?.id ?? ''));
  },[request,workspaceId,brandId]);
  useEffect(()=>{void load().catch(e=>setError(e.message)).finally(()=>setLoading(false));},[load]);
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
      const body={workspaceId,brandId,version:editing?.version ?? 0,provider:'elevenlabs',name:String(data.get('name')),model:String(data.get('model')),enabled:data.get('enabled')==='on',allowedRoles:data.getAll('roles'),maxCharacters:Number(data.get('maxCharacters')),dailyRequests:Number(data.get('dailyRequests')),skills,...(key?{apiKey:key}:{})};
      const result=await request(`/v1/audio/profiles${editing?`/${encodeURIComponent(editing.id)}`:''}`,{method:editing?'PATCH':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      form.reset();setSettings(false);setCatalogue({models:[],voices:[]});await load();setProfileId(result.id);setNotice('Provider saved. Load voices to verify access before generating.');
    });
  }
  async function generate(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();await act('generate',async()=>{
      const draft={workspaceId,brandId,profileId,voiceId,language,text,rightsConfirmed:rights,...(skillId?{skillId}:{}),...(contentItemId?{contentItemId}:{})};
      const identity=JSON.stringify({...draft,profileVersion:profile?.version});
      if(pendingRequest.current?.body!==identity)pendingRequest.current={body:identity,id:crypto.randomUUID()};
      const run=await request('/v1/audio/generations',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...draft,requestId:pendingRequest.current.id})}) as AudioRun;
      await load();
      if(run.status==='failed')setError(run.error ?? 'Generation failed.');
      else setNotice(run.status==='ready'?'Narration saved to Library. Listen and review before using it in a post.':'This request is already running. Refresh to check its result; it will not be generated again.');
    });
  }
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
    <header className={styles.hero}><div><p className={styles.eyebrow}>VOICE & NARRATION</p><h1>Give your story a voice.</h1><p>Create narration in ગુજરાતી, हिंदी, English, and your model’s other languages.</p></div><AudioLines size={54} strokeWidth={1.2}/></header>
    <div className={styles.toolbar}><span><ShieldCheck size={17}/> Keys stay encrypted on the server</span><div><button disabled={!!busy} onClick={()=>void act('refresh',load)}><RefreshCw size={15}/>Refresh</button>{owner&&<button onClick={()=>edit(null)}><KeyRound size={15}/>Connect provider</button>}</div></div>
    {error&&<p className={styles.error} role="alert">{error}</p>}{notice&&<p className={styles.notice} role="status">{notice}</p>}
    {loading?<p role="status">Loading audio workspace…</p>:<div className={styles.layout}>
      <form className={styles.card} onSubmit={generate}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>01 / CREATE</p><h2>Build a narration</h2></div><span>MP3 · 128 kbps</span></div>
        {!view.profiles.length?<div className={styles.empty}><AudioLines size={32}/><h3>Connect your first voice provider</h3><p>{owner?'Add an ElevenLabs key, choose a model, and decide who can generate.':'Ask the workspace owner to connect an audio provider and enable your role.'}</p>{owner&&<button type="button" onClick={()=>edit(null)}>Configure ElevenLabs</button>}</div>:<>
          <label>Provider<select value={profileId} onChange={e=>setProfileId(e.target.value)} disabled={!!busy}>{view.profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.model}{p.enabled?'':' · Disabled'}</option>)}</select></label>
          <div className={styles.row}><button type="button" disabled={!!busy||!profile} onClick={()=>void act('catalogue',()=>catalogueLoad())}>{busy==='catalogue'?'Checking…':'Load voices & check connection'}</button>{owner&&<button type="button" onClick={()=>edit(profile ?? null)}><Settings2 size={15}/>Settings</button>}</div>
          <div className={styles.fields}><label>Language<select value={language} onChange={e=>{setLanguage(e.target.value);setSkillId('');}}>{languages.map(l=><option key={l.code} value={l.code}>{l.code==='gu'?'ગુજરાતી · Gujarati':l.code==='hi'?'हिंदी · Hindi':l.name}</option>)}</select></label><label>Voice<select value={voiceId} onChange={e=>setVoiceId(e.target.value)}><option value="">Load and select a voice</option>{catalogue.voices.map(v=><option key={v.id} value={v.id}>{v.name} · {v.category}</option>)}</select></label></div>
          {catalogue.nextCursor&&<button type="button" disabled={!!busy} onClick={()=>void act('catalogue',()=>catalogueLoad(true))}>Load more voices</button>}
          <label>Reading style & skill<select value={skillId} onChange={e=>setSkillId(e.target.value)}><option value="">Your own reviewed script</option>{profile?.skills.filter(s=>s.language===language).map(s=><option key={s.id} value={s.id}>{s.name} · v{s.version}</option>)}</select></label>
          {selectedSkill&&<p className={styles.guidance} lang={language}>{selectedSkill.instructions}</p>}
          <label>Script<textarea value={text} onChange={e=>setText(e.target.value)} maxLength={3000} rows={8} lang={language} placeholder={language==='gu'?'તમારા ચકાસેલા સમાચાર અહીં લખો…':language==='hi'?'अपनी जांची हुई खबर यहां लिखें…':'Paste your reviewed narration here…'}/></label><small>{text.length.toLocaleString()} / {limit.toLocaleString()} characters · Only this script is sent to the voice provider.</small>
          <label>Save with a post<select value={contentItemId} onChange={e=>setContentItemId(e.target.value)}><option value="">Save in this brand’s Library</option>{items.map(i=><option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
          <label className={styles.check}><input type="checkbox" checked={rights} onChange={e=>setRights(e.target.checked)}/>I have permission to use this script and voice, and have reviewed the wording.</label>
          <button className={styles.primary} disabled={!!busy||!canGenerate||!voiceId||!text.trim()||text.length>limit||!rights}>{busy==='generate'?'Generating narration…':'Generate narration'}</button>
          <small>Provider usage is billed to your account. Repeated clicks reuse the same request. Editing the script creates a new request.</small>
        </>}
      </form>
      <aside className={styles.card}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>02 / LISTEN & REUSE</p><h2>Your recordings</h2></div><a href="/library">Library ↗</a></div>
        {preview&&<div className={styles.playback}><audio controls src={preview.url}/><a href={preview.url} download><Download size={15}/>Download MP3</a></div>}
        {!view.runs.length?<div className={styles.empty}><p>Your generated narrations will appear here, ready to listen to, download, and reuse.</p></div>:view.runs.map(run=><article key={run.id} className={styles.recording}><div><strong>{run.language.toUpperCase()} narration</strong><span>{run.characterCount} characters · {run.model}</span><small>{new Date(run.createdAt).toLocaleString()}</small></div><span className={styles.status}>{run.status}</span>{run.status==='ready'&&run.mediaId&&<button disabled={!!busy} onClick={()=>void act('play',async()=>{const result=await request(`/v1/media-assets/${encodeURIComponent(run.mediaId!)}/download-url?${query}`);setPreview({url:result.url,id:run.id});})}>Listen / download</button>}{run.contentItemId&&<a href={`/content?item=${encodeURIComponent(run.contentItemId)}`}>Open post ↗</a>}{run.error&&<p>{run.error}</p>}{run.status==='generating'&&<p>Refresh for the result. An interrupted request is retained for investigation and will not be charged again automatically.</p>}</article>)}
        <p className={styles.footnote}>Narration is labeled as AI-generated. Add it to a video before publishing to Instagram or YouTube; those platforms do not accept an MP3 as a video post.</p>
      </aside>
    </div>}
    {settings&&owner&&<form className={styles.settings} onSubmit={save} key={editing?.id ?? 'new'}><div className={styles.sectionHead}><div><p className={styles.eyebrow}>OWNER SETTINGS</p><h2>{editing?'Edit audio provider':'Connect ElevenLabs'}</h2></div><button type="button" onClick={()=>setSettings(false)}>Close</button></div>
      <p>Only the workspace owner can change these settings. Managers and creators get generation access only when selected below. {view.adminIpRestricted?'Administrator network restrictions are enabled.':'Network restrictions can be configured by the server operator with ADMIN_ALLOWED_IPS.'}</p>
      {!view.encryptionConfigured&&<p className={styles.error}>Configure CREDENTIAL_ENCRYPTION_KEY on the server before saving a provider key.</p>}
      <div className={styles.fields}><label>Connection name<input name="name" required maxLength={100} defaultValue={editing?.name ?? 'ElevenLabs narration'}/></label><label>Model ID<input name="model" required pattern="[a-zA-Z0-9_-]{1,100}" defaultValue={editing?.model ?? 'eleven_v3'}/><small>eleven_v3 supports Gujarati, Hindi, and English. Check availability after saving.</small></label><label>API key<input name="apiKey" type="password" autoComplete="new-password" required={!editing} minLength={19} maxLength={1000} pattern="sk_[a-zA-Z0-9_-]{16,}" placeholder={editing?'Leave blank to keep the current key':'Secret key starting with sk_ (not the key ID)'}/></label><label>Characters per request<input name="maxCharacters" type="number" min={1} max={3000} defaultValue={editing?.maxCharacters ?? 1500}/></label><label>Requests per day (UTC)<input name="dailyRequests" type="number" min={1} max={1000} defaultValue={editing?.dailyRequests ?? 10}/></label></div>
      <fieldset><legend>Who may generate audio?</legend>{(['owner','manager','creator'] as const).map(r=><label className={styles.check} key={r}><input name="roles" type="checkbox" value={r} defaultChecked={(editing?.allowedRoles ?? ['owner']).includes(r)}/>{r}</label>)}</fieldset>
      <label className={styles.check}><input name="enabled" type="checkbox" defaultChecked={editing?.enabled ?? true}/>Enable this provider</label>
      <div className={styles.sectionHead}><h3>Reusable writing skills</h3><button type="button" onClick={()=>void act('export',exportSkills)}>Download skill pack</button></div>
      <p>Versioned writing guidance and character limits. No executable tools, remote downloads, or hidden agent instructions are installed. Review imported guidance before saving.</p>
      <label>Import reviewed skill pack<input type="file" accept="application/json,.json" onChange={e=>{const file=e.target.files?.[0];if(file)void act('import',()=>importSkills(file));e.target.value='';}}/></label>
      {skills.map((skill,index)=><details key={skill.id}><summary>{skill.name} · {skill.language} · v{skill.version}</summary><label>Instructions<textarea rows={3} maxLength={2000} value={skill.instructions} onChange={e=>setSkills(current=>current.map((s,i)=>i===index?{...s,instructions:e.target.value}:s))}/></label><label>Version<input value={skill.version} onChange={e=>setSkills(current=>current.map((s,i)=>i===index?{...s,version:e.target.value}:s))}/></label></details>)}
      <button className={styles.primary} disabled={!!busy||!view.encryptionConfigured}>{busy==='save'?'Saving…':'Save protected settings'}</button>
      <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noreferrer">Manage available voices in ElevenLabs ↗</a>
    </form>}
  </section>;
}
