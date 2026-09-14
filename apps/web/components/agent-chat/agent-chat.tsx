"use client";

import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronDown, ExternalLink, FileText, Image as ImageIcon, Link2, MessageSquare, PanelLeftClose, PanelLeftOpen, PanelRightClose, Plus, Search, Sparkles, Trash2, Users, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { agents, draftStorageKey, MAX_REQUEST_LENGTH, mentionedAgents, mentionQuery, restoreDrafts, sourceUrl, type ChatDraft } from "./chat-model";
import styles from "./agent-chat.module.css";

type Props = { userId: string; workspaceId: string; brandId: string; brandName: string; onNavigate: (page: string) => void };
const suggestions = [
  { icon: ImageIcon, title: "Create a post", detail: "An image and the words to go with it", prompt: "Create an image and matching post copy for " },
  { icon: Search, title: "Explore a story", detail: "Start with a source, find the angle", prompt: "Research this story and suggest a clear angle: " },
  { icon: FileText, title: "Refine a draft", detail: "Make every word earn its place", prompt: "Help me improve this draft: " },
];

export function AgentChat({ userId, workspaceId, brandId, brandName, onNavigate }: Props) {
  const storageKey = draftStorageKey(userId, workspaceId, brandId);
  const [drafts, setDrafts] = useState<ChatDraft[]>([]);
  const [selected, setSelected] = useState("");
  const [ready, setReady] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [text, setText] = useState("");
  const [team, setTeam] = useState(false);
  const [search, setSearch] = useState("");
  const [railOpen, setRailOpen] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState("");
  const [notice, setNotice] = useState("");
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const closeInspector = useRef<HTMLButtonElement>(null);
  const current = drafts.find(d => d.id === selected);
  const example = selected === "example";
  const activeTeam = example || (current?.team ?? team);
  const eligible = (activeTeam ? agents : agents.slice(0, 1)).filter(a => !mention || a.name.toLowerCase().startsWith(mention.query));

  useEffect(() => {
    try { setDrafts(restoreDrafts(sessionStorage.getItem(storageKey))); }
    catch { setNotice("Tab storage is unavailable. Requests will stay here until you leave this page."); }
    const sync = () => { setSelected(new URLSearchParams(window.location.search).get("conversation") ?? ""); setInspector(false); setText(""); setSources([]); };
    sync();
    setReady(true);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [storageKey]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const sync = () => setMobile(media.matches);
    sync(); media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (inspector) closeInspector.current?.focus();
  }, [inspector]);

  function persist(next: ChatDraft[]) {
    setDrafts(next);
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); }
    catch { setNotice("Could not save to tab storage. Keep this page open or copy your request."); }
  }
  function choose(id: string) {
    setSelected(id); setText(""); setSources([]); setMention(null); setInspector(false); setRailOpen(false); setNotice("");
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("conversation", id); else url.searchParams.delete("conversation");
    window.history.pushState({}, "", `${url.pathname}${url.search}`);
  }
  function dismissInspector() { setInspector(false); previewButton.current?.focus(); }
  function insertMention(name: string) {
    if (!mention) return;
    const cursor = input.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(cursor)}`;
    setText(next); setMention(null);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(mention.start + name.length + 2, mention.start + name.length + 2); });
  }
  function saveRequest(event?: FormEvent) {
    event?.preventDefault();
    if (!text.trim() || !brandId || !ready || example) return;
    if ((current?.requests.length ?? 0) >= 100 || (!current && drafts.length >= 30)) { setNotice("This tab is full. Delete an older conversation before saving more requests."); return; }
    const request = { id: crypto.randomUUID(), text: text.trim(), sources, createdAt: new Date().toISOString() };
    const next: ChatDraft = current ? { ...current, requests: [...current.requests, request] } : { id: `local-${crypto.randomUUID()}`, title: text.trim().slice(0, 80), team, requests: [request] };
    persist([next, ...drafts.filter(d => d.id !== next.id)]);
    choose(next.id);
    requestAnimationFrame(() => { end.current?.scrollIntoView({ block: "nearest" }); input.current?.focus(); });
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (mention && eligible.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMentionIndex(i => (i + (event.key === "ArrowDown" ? 1 : eligible.length - 1)) % eligible.length); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); insertMention(eligible[mentionIndex % eligible.length]!.name); return; }
      if (event.key === "Escape") { event.preventDefault(); setMention(null); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); saveRequest(); }
  }
  function addLink() {
    const url = sourceUrl(link);
    if (!url) { setNotice("Enter a full http or https source link without embedded credentials."); return; }
    if (sources.length >= 8) { setNotice("You can add up to eight source links to a request."); return; }
    setSources(s => [...new Set([...s, url])]); setLink(""); setLinkOpen(false); setNotice(""); input.current?.focus();
  }

  return <section className={`${styles.workspace} ${inspector ? styles.withInspector : ""}`} aria-label="Agent workspace" onKeyDown={e => { if (e.key === "Escape" && railOpen) { setRailOpen(false); } }}>
    <aside className={`${styles.rail} ${railOpen ? styles.railOpen : ""}`} aria-label="Conversations" inert={mobile && inspector}>
      <div className={styles.railTop}><span>YOUR SPACE</span><button type="button" aria-label="Close conversations" onClick={() => setRailOpen(false)} className={styles.railClose}><PanelLeftClose size={17} /></button></div>
      <button className={styles.newChat} onClick={() => choose("")}><Plus size={17} /> New conversation</button>
      <label className={styles.historySearch}><Search size={15} /><input aria-label="Search saved requests" placeholder="Find a conversation" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <div className={styles.history}><p>Saved in this tab</p>{drafts.filter(d => d.title.toLowerCase().includes(search.toLowerCase())).map(d => <div className={`${styles.historyRow} ${selected === d.id ? styles.historySelected : ""}`} key={d.id}><button onClick={() => choose(d.id)} aria-current={selected === d.id ? "page" : undefined}><MessageSquare size={15} /><span>{d.title}</span></button><button aria-label={`Delete ${d.title}`} title="Delete saved requests" onClick={() => { persist(drafts.filter(item => item.id !== d.id)); if (selected === d.id) choose(""); }}><Trash2 size={14} /></button></div>)}{!drafts.length && <span className={styles.historyEmpty}>A little room for your next idea.</span>}{drafts.length > 0 && !drafts.some(d => d.title.toLowerCase().includes(search.toLowerCase())) && <span className={styles.historyEmpty}>No matching conversations.</span>}</div>
      <button className={`${styles.exampleLink} ${example ? styles.historySelected : ""}`} onClick={() => choose("example")}><span className={styles.exampleIcon}><Sparkles size={17} /></span><span><strong>See the experience</strong><small>Explore an example conversation</small></span><ArrowRight size={15} /></button>
      <div className={styles.railFoot}><span className={styles.scopeDot} /><span>{brandName || "Choose a brand"}<small>Brand workspace</small></span></div>
    </aside>

    <div className={styles.chat} inert={mobile && inspector}>
      <header className={styles.header}>
        <button className={styles.mobileHistory} aria-label="Open conversations" aria-expanded={railOpen} onClick={() => setRailOpen(v => !v)}><PanelLeftOpen size={18} /></button>
        <div><strong>{example ? "A launch, thoughtfully told" : current ? "Conversation" : "Agent"}</strong><span>{brandName || "No brand selected"}<span aria-hidden="true"> / </span>General</span></div>
        <span className={styles.previewBadge}>{example ? "Example" : "UI preview"}</span>
        {example && <button ref={previewButton} className={styles.previewToggle} aria-label="Post preview" onClick={() => setInspector(v => !v)} aria-expanded={inspector}><ImageIcon size={16} /><span>Post preview</span></button>}
      </header>

      <div className={styles.scrollArea}>
        {example ? <div className={styles.messages}>
          <div className={styles.exampleNotice}>Example content · No agents have run and nothing will be published.</div>
          <div className={styles.userMessage}>@Origin turn our launch brief into an Instagram post. An image, a short caption, and a softer tone.</div>
          <article className={styles.assistant}><div className={styles.speaker}><span className={styles.originAvatar}>O</span><strong>Origin</strong><span>Coordinator</span></div><p>One idea, carried through the image and the words. Here’s how the team would bring it together.</p>
            <div className={styles.activity}><span><Search size={15} /> Research <small>Check the brief</small></span><span><FileText size={15} /> Writer <small>Find the right words</small></span><span><ImageIcon size={15} /> Image <small>Set the visual direction</small></span></div>
            <p>The direction: give the idea space. A quiet visual, a clear headline, and a caption that sounds like a person.</p>
            <button className={styles.artifactCard} onClick={() => setInspector(true)}><span className={styles.artifactThumb}><span>Make room<br />for what’s next.</span></span><span><small>EXAMPLE POST PACKAGE</small><strong>A little space. A fresh start.</strong><span>Image direction + caption</span></span><ArrowRight size={18} /></button>
            <div className={styles.reviewNote}><span className={styles.reviewDot} /> Your review comes next <span>Draft → Review → Publish</span></div>
          </article>
          <div className={styles.exampleContinue}><p>Bring your own idea into the conversation.</p><button onClick={() => { choose(""); requestAnimationFrame(() => input.current?.focus()); }}>Start your own <ArrowRight size={15} /></button></div>
        </div> : current ? <div className={styles.messages}>
          {current.requests.map(request => <article key={request.id} className={styles.request}><div className={styles.requestMeta}>You <span>Saved request</span></div><div className={styles.userMessage}>{request.text}</div>{request.sources.length > 0 && <div className={styles.requestSources}>{request.sources.map(url => <a key={url} href={url} target="_blank" rel="noopener noreferrer"><Link2 size={14} />{new URL(url).hostname}<ExternalLink size={12} /></a>)}</div>}{mentionedAgents(request.text, current.team).length > 0 && <small className={styles.routing}>Addressed to {mentionedAgents(request.text, current.team).map(id => agents.find(a => a.id === id)!.name).join(", ")}</small>}</article>)}
          <div className={styles.savedNotice}><Check size={17} /><div><strong>Request saved in this tab</strong><p>Agent execution isn’t connected yet. Your words and source links are saved here; no generation or publishing has started.</p><button onClick={() => onNavigate("Creative Studio")}>Open Creative Studio <ArrowRight size={14} /></button></div></div>
        </div> : <div className={styles.welcome}>
          <div className={styles.welcomeMark} aria-hidden="true"><span>O</span><span className={styles.markSpark}>✳</span></div>
          <p className={styles.eyebrow}>AN IDEA IS A GOOD PLACE TO START</p>
          <h1>What shall we<br /><em>make today?</em></h1>
          <p className={styles.intro}>A story worth sharing. The words to tell it.<br />A team to help you bring it together.</p>
          <div className={styles.suggestions}>{suggestions.map(({ icon: Icon, title, detail, prompt }) => <button key={title} onClick={() => { setText(prompt); input.current?.focus(); }}><Icon size={20} strokeWidth={1.5} /><strong>{title}</strong><span>{detail}</span><ArrowRight size={15} /></button>)}</div>
          {selected && !current && ready && <p className={styles.missing}>This conversation isn’t saved in this tab or brand. Start a new one below.</p>}
        </div>}
        <div ref={end} />
      </div>

      {!example && <div className={styles.composerDock}>
        <div className={styles.teamLine}><div className={styles.avatars} aria-hidden="true">{(activeTeam ? agents.slice(0, 4) : agents.slice(0, 1)).map(a => <span key={a.id}>{a.initials}</span>)}</div><span>{activeTeam ? "Your content team" : "One conversation. A clear direction."}</span>{activeTeam && <span className={styles.teamCount}>5 specialists</span>}</div>
        <form className={styles.composer} onSubmit={saveRequest}>
          {sources.length > 0 && <div className={styles.sourceChips}>{sources.map(url => <span key={url}><Link2 size={13} />{new URL(url).hostname}<button type="button" aria-label={`Remove source ${url}`} onClick={() => setSources(s => s.filter(u => u !== url))}><X size={13} /></button></span>)}</div>}
          <label className={styles.srOnly} htmlFor="agent-message">Your request</label>
          <textarea id="agent-message" ref={input} value={text} maxLength={MAX_REQUEST_LENGTH} rows={3} placeholder={activeTeam ? "Share an idea, or @mention your team…" : "Describe what you’d like to create…"} aria-describedby="agent-composer-help" aria-autocomplete="list" aria-activedescendant={mention && eligible.length ? `agent-option-${eligible[mentionIndex % eligible.length]!.id}` : undefined} aria-controls={mention && eligible.length ? "agent-mentions" : undefined} onChange={e => { setText(e.target.value); setMention(mentionQuery(e.target.value, e.target.selectionStart)); setMentionIndex(0); }} onKeyDown={onKeyDown} onClick={e => setMention(mentionQuery(text, e.currentTarget.selectionStart))} />
          {mention && eligible.length > 0 && <div className={styles.mentionMenu} id="agent-mentions" role="listbox" aria-label="Mention an agent">{eligible.map((a, i) => <button type="button" role="option" id={`agent-option-${a.id}`} aria-selected={i === mentionIndex % eligible.length} key={a.id} onMouseDown={e => e.preventDefault()} onClick={() => insertMention(a.name)}><span className={styles.smallAvatar}>{a.initials}</span><span><strong>@{a.name}</strong><small>{a.description}</small></span>{i === mentionIndex % eligible.length && <ArrowDown size={14} />}</button>)}</div>}
          <div className={styles.composerBar}><button type="button" className={styles.attach} aria-label="Add a source link" aria-expanded={linkOpen} onClick={() => setLinkOpen(v => !v)}><Plus size={19} /></button><div className={styles.agentSelect}><Users size={15} /><select aria-label="Conversation participants" value={activeTeam ? "team" : "solo"} disabled={Boolean(current)} onChange={e => setTeam(e.target.value === "team")}><option value="solo">Origin</option><option value="team">Content team</option></select><ChevronDown size={12} /></div><span className={styles.composerSpacer} /><span className={styles.shortcut}>Shift ↵ new line</span><button className={styles.send} type="submit" disabled={!text.trim() || !brandId || !ready} aria-label="Save request" title="Save request in this tab"><ArrowUp size={19} /></button></div>
        </form>
        {linkOpen && <form className={styles.linkForm} onSubmit={e => { e.preventDefault(); addLink(); }}><label htmlFor="agent-source-url">Source link</label><input id="agent-source-url" autoFocus type="url" placeholder="https://…" value={link} onChange={e => setLink(e.target.value)} required /><button type="submit">Add</button><button type="button" aria-label="Cancel source link" onClick={() => { setLinkOpen(false); input.current?.focus(); }}><X size={16} /></button></form>}
        <div className={styles.composerHelp} id="agent-composer-help"><span>UI preview · Requests stay in this tab. Agents are not connected.</span><span>{text.length > 7000 ? `${text.length}/${MAX_REQUEST_LENGTH}` : "@ to mention"}</span></div>
        <p className={styles.status} role="status">{notice}</p>
      </div>}
    </div>

    {inspector && <aside className={styles.inspector} role={mobile ? "dialog" : "complementary"} aria-modal={mobile || undefined} aria-label="Example post preview" onKeyDown={e => {
      if (e.key === "Escape") dismissInspector();
      if (mobile && e.key === "Tab") {
        const controls = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled), a[href]"));
        const first = controls[0]; const last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <header><div><small>EXAMPLE ARTIFACT</small><h2>Post preview</h2></div><button ref={closeInspector} aria-label="Close post preview" onClick={dismissInspector}><PanelRightClose size={19} /></button></header>
      <div className={styles.inspectorBody}><div className={styles.poster}><span>THE NEXT CHAPTER</span><div className={styles.posterShape} aria-hidden="true" /><strong>Make room<br />for what’s<br /><em>next.</em></strong><small>AN EXAMPLE VISUAL DIRECTION</small></div><div className={styles.artifactMeta}><span>Instagram · Portrait</span><span>Example</span></div><section><h3>Caption</h3><p>A little space. A fresh start.</p><p>We’re making room for something new. Thoughtfully made, and nearly ready to meet you.</p><p>What would you like to see next?</p></section><section className={styles.detailNote}><h3>Before this becomes a post</h3><p>Connect the brief, create the final image, and review the exact draft. This example is a layout illustration, not generated or approved content.</p></section><button className={styles.openStudio} onClick={() => onNavigate("Creative Studio")}>Open Creative Studio <ExternalLink size={15} /></button></div>
    </aside>}
  </section>;
}
