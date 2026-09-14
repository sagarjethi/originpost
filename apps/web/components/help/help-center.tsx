"use client";

import {
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  CircleHelp,
  Clipboard,
  Columns3,
  ExternalLink,
  Image as ImageIcon,
  KeyRound,
  Link2,
  LockKeyhole,
  MonitorCog,
  PlayCircle,
  Radio,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Workflow,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import { getHelpJourney, HELP_JOURNEYS, type HelpJourneyId } from "./help-journeys";
import styles from "./help-center.module.css";

const icons = { publish: Link2, image: ImageIcon, board: Columns3, channels: Radio } as const;

type HelpImageCapability = { state: "available" | "setup_required"; model: string; reason?: string };
type GuideSection = "start" | "journeys" | "hermes" | "troubleshooting";

const guideSections: Array<{ id: GuideSection; label: string; description: string }> = [
  { id: "start", label: "Start here", description: "Understand the platform" },
  { id: "journeys", label: "User journeys", description: "Follow a complete workflow" },
  { id: "hermes", label: "Hermes + Codex", description: "Owner setup guide" },
  { id: "troubleshooting", label: "Fix a problem", description: "Diagnose safely" },
];

const codexSetup = `npm i -g @openai/codex
codex --version
codex login
codex login status`;

const boardEnvironment = `AUTH_MODE=sessions
HERMES_BOARD_PLUGIN_ENABLED=false
HERMES_BOARD_SUPPORTED_VERSION=0.21.2
HERMES_BOARD_SECRET=<independent-32-byte-random-secret>
HERMES_DASHBOARD_URL=http://127.0.0.1:9119
HERMES_DASHBOARD_SESSION_TOKEN=<independent-32-byte-dashboard-token>
HERMES_API_URL=http://127.0.0.1:8642
HERMES_BOARD_PRIMARY_PROVIDER=openai-codex
HERMES_BOARD_PRIMARY_MODEL=<approved-model-id>
HERMES_BOARD_APPROVED_SKILLS=news-research,content-planning`;

const hermesProcess = `export ORIGINPOST_BOARD_PLUGIN_TOKEN='<same dashboard token as OriginPost>'
export HERMES_DASHBOARD_SESSION_TOKEN="$ORIGINPOST_BOARD_PLUGIN_TOKEN"
export PYTHONDONTWRITEBYTECODE=1

hermes dashboard
# In a second terminal:
hermes gateway`;

const personalCodexRuntime = `# Inside a personal or developer Hermes chat:
/codex-runtime codex_app_server

# Check without changing the active runtime:
/codex-runtime`;

const diagnosticCommands = `codex --version
codex login status
curl -fsS http://127.0.0.1:8642/v1/models \
  -H "Authorization: Bearer $HERMES_API_KEY"
docker compose ps api worker web redis postgres`;

function CodeBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  return <div className={styles.codeBlock}>
    <header><span>{label}</span><button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`}><Clipboard size={13} />{copied ? "Copied" : "Copy"}</button></header>
    <pre><code>{value}</code></pre>
  </div>;
}

function RuntimeArchitecture() {
  return <section className={styles.architecture} aria-labelledby="runtime-architecture-title">
    <div className={styles.sectionHead}>
      <div><span className={styles.sectionLabel}>RUNTIME MAP</span><h2 id="runtime-architecture-title">Choose the correct Codex path</h2></div>
      <p>The local OpenAI terminal client is Codex CLI. A ChatGPT account can authenticate it.</p>
    </div>
    <div className={styles.runtimeLanes}>
      <article className={styles.recommendedLane}>
        <header><span>ORIGINPOST BOARD MODE</span><em>Recommended here</em></header>
        <div className={styles.runtimeFlow}>
          <div><Columns3 size={17} /><strong>Board</strong><small>Tasks and human release</small></div><ArrowRight size={15} />
          <div><Server size={17} /><strong>OriginPost</strong><small>Policy, audit, receipts</small></div><ArrowRight size={15} />
          <div><Bot size={17} /><strong>Hermes profile</strong><small>One profile per Board</small></div><ArrowRight size={15} />
          <div><Sparkles size={17} /><strong>Codex Responses</strong><small>Restricted agent loop</small></div>
        </div>
        <p><ShieldCheck size={15} /> Uses <code>model.openai_runtime: auto</code>. Memory and skills stay inside the Board’s attested Hermes profile.</p>
      </article>
      <article className={styles.developerLane}>
        <header><span>PERSONAL / DEVELOPER MODE</span><em>Optional</em></header>
        <div className={styles.runtimeFlow}>
          <div><SquareTerminal size={17} /><strong>Hermes CLI</strong><small>Your local session</small></div><ArrowRight size={15} />
          <div><Workflow size={17} /><strong>Codex app-server</strong><small>Structured JSON-RPC events</small></div><ArrowRight size={15} />
          <div><Wrench size={17} /><strong>Codex tools</strong><small>Shell, patch, plugins</small></div>
        </div>
        <p><TriangleAlert size={15} /> Useful for a trusted local coding agent. OriginPost Board runs do not use this lane because it exposes a broader tool runtime.</p>
      </article>
    </div>
  </section>;
}

function ProductTour({ onNavigate }: { onNavigate: (destination: string) => void }) {
  return <div className={styles.startPanel}>
    <section className={styles.quickStart} aria-labelledby="quick-start-title">
      <div className={styles.sectionHead}>
        <div><span className={styles.sectionLabel}>FIRST 15 MINUTES</span><h2 id="quick-start-title">Set up once, then follow the next action</h2></div>
        <button type="button" className={styles.action} onClick={() => onNavigate("Content")}>Open Content <ArrowRight size={15} /></button>
      </div>
      <div className={styles.quickGrid}>
        <article><i>01</i><Settings size={17} /><strong>Choose workspace and Brand</strong><p>Use the top-left switcher. Every Content Item, Board, channel, and proof belongs to that active scope.</p></article>
        <article><i>02</i><Search size={17} /><strong>Add a source or idea</strong><p>Open Content, capture the link or brief, and run source research before drafting factual claims.</p></article>
        <article><i>03</i><Sparkles size={17} /><strong>Create the exact revision</strong><p>Write copy, create or attach media, then check the exact revision that will be approved.</p></article>
        <article><i>04</i><ShieldCheck size={17} /><strong>Approve, deliver, prove</strong><p>Publish only from an approved revision. Keep the provider result, live URL, and proof together.</p></article>
      </div>
    </section>

    <figure className={styles.screenshotTour}>
      <div className={styles.screenshotFrame}>
        <div className={styles.screenshotBar}><span /><span /><span /><small>OriginPost · Boards</small></div>
        <div className={styles.screenshotImage}>
          <img src="/help/originpost-board-tour.png" alt="OriginPost Boards screen showing the Luma Mumbai Events Board, task columns, and the Hermes settings tab." />
          <span className={`${styles.hotspot} ${styles.hotspotOne}`}>1</span>
          <span className={`${styles.hotspot} ${styles.hotspotTwo}`}>2</span>
          <span className={`${styles.hotspot} ${styles.hotspotThree}`}>3</span>
        </div>
      </div>
      <figcaption>
        <span className={styles.sectionLabel}>SCREEN GUIDE</span>
        <h2>Boards keep agent work understandable</h2>
        <ol>
          <li><b>1</b><span><strong>Select one Board</strong><small>The Board is the top-level project context.</small></span></li>
          <li><b>2</b><span><strong>Manage human-owned tasks</strong><small>Tasks keep working even if Hermes is unavailable.</small></span></li>
          <li><b>3</b><span><strong>Open Hermes settings</strong><small>Memory, skills, model health, and approvals stay inside this Board.</small></span></li>
        </ol>
        <button type="button" onClick={() => onNavigate("Boards")}>Open Boards <ArrowRight size={13} /></button>
      </figcaption>
    </figure>

    <section className={styles.endToEnd} aria-labelledby="end-to-end-title">
      <span className={styles.sectionLabel}>END-TO-END VISUAL</span>
      <h2 id="end-to-end-title">The one path to remember</h2>
      <div className={styles.endToEndFlow}>
        {["Capture", "Verify", "Create", "Approve", "Publish", "Proof"].map((label, index) => <div key={label}><i>{index + 1}</i><strong>{label}</strong>{index < 5 ? <ArrowRight size={14} /> : null}</div>)}
      </div>
      <p><LockKeyhole size={15} /> Hermes can prepare research or copy, but it cannot approve its own result or publish to a social channel.</p>
    </section>
  </div>;
}

function JourneyGuide({ selectedId, setSelectedId, imageCapability, onNavigate }: { selectedId: HelpJourneyId; setSelectedId: (id: HelpJourneyId) => void; imageCapability: HelpImageCapability | null; onNavigate: (destination: string) => void }) {
  const journey = getHelpJourney(selectedId);
  const capabilityLabel = journey.id === "image" && journey.capability === "runtime"
    ? imageCapability?.state === "available" ? `Available now · ${imageCapability.model}` : imageCapability?.reason ?? "Included · server setup required"
    : journey.capability === "planned" ? "Planned — not automated yet" : "Available now";
  const capabilityPending = journey.capability === "planned" || (journey.capability === "runtime" && imageCapability?.state !== "available");

  return <div className={styles.journeyPanel}>
    <div className={styles.layout}>
      <nav className={styles.chooser} aria-label="Choose a guided journey">
        <span>WHAT DO YOU WANT TO DO?</span>
        {HELP_JOURNEYS.map((option) => {
          const Icon = icons[option.id];
          return <button key={option.id} type="button" className={`${styles.choice} ${selectedId === option.id ? styles.active : ""}`} aria-pressed={selectedId === option.id} onClick={() => setSelectedId(option.id)}>
            <span><Icon size={16} /></span><span><strong>{option.title}</strong><small>{option.steps.length} clear steps</small></span>
          </button>;
        })}
      </nav>

      <article className={styles.journey} aria-live="polite">
        <div className={styles.journeyHead}>
          <div><span className={styles.sectionLabel}>{journey.eyebrow}</span><h2>{journey.title}</h2><p>{journey.summary}</p><span className={`${styles.capability} ${capabilityPending ? styles.planned : ""}`}>{capabilityLabel}</span></div>
          <button type="button" className={styles.action} onClick={() => onNavigate(journey.action.destination)}>{journey.action.label}<ArrowRight size={15} /></button>
        </div>
        <div className={styles.flow}>
          {journey.steps.map((step, index) => <div className={styles.step} key={step.label}><i>{index + 1}</i><strong>{step.label}</strong><p>{step.detail}</p></div>)}
        </div>
        <div className={styles.outcome}><Check size={17} /><span><strong>Finished when</strong><small>{journey.outcome}</small></span></div>
      </article>
    </div>

    <section className={styles.map} aria-labelledby="product-map-title">
      <div className={styles.mapHead}><div><span className={styles.sectionLabel}>PRODUCT MAP</span><h2 id="product-map-title">Know where each part belongs</h2></div><p>Home shows today. Help explains. Each workspace handles one kind of work.</p></div>
      <div className={styles.mapGrid}>
        <article className={styles.mapGroup}><span><Search size={16} /></span><h3>Find and verify</h3><p>Inbox, Signals, and Research turn inputs into source-backed claims.</p><button onClick={() => onNavigate("Research")}>Open Research <ArrowRight size={13} /></button></article>
        <article className={styles.mapGroup}><span><Sparkles size={16} /></span><h3>Create and approve</h3><p>Create, Creative Studio, Library, and review keep the exact draft and visual together.</p><button onClick={() => onNavigate("Create")}>Open Create <ArrowRight size={13} /></button></article>
        <article className={styles.mapGroup}><span><Radio size={16} /></span><h3>Deliver and learn</h3><p>Calendar, Channels, Engagement, Proof, and Analytics show delivery and results.</p><button onClick={() => onNavigate("Calendar")}>Open Calendar <ArrowRight size={13} /></button></article>
        <article className={styles.mapGroup}><span><Columns3 size={16} /></span><h3>Run focused work</h3><p>Boards own tasks. Memory, skills, and Hermes live inside the Board that uses them.</p><button onClick={() => onNavigate("Boards")}>Open Boards <ArrowRight size={13} /></button></article>
      </div>
      <p className={styles.note}><CircleHelp size={16} /> A generated image is a creative asset, not documentary proof. Use verified same-event media for factual evidence and disclose generated or materially edited visuals where required.</p>
    </section>
  </div>;
}

function HermesGuide({ onNavigate }: { onNavigate: (destination: string) => void }) {
  return <div className={styles.hermesPanel}>
    <RuntimeArchitecture />

    <section className={styles.ownerGuide} aria-labelledby="owner-setup-title">
      <div className={styles.sectionHead}>
        <div><span className={styles.sectionLabel}>OWNER SETUP</span><h2 id="owner-setup-title">Configure Hermes and local Codex end to end</h2></div>
        <span className={styles.ownerOnly}><KeyRound size={14} /> Deployment owner only</span>
      </div>
      <div className={styles.setupSteps}>
        <article><i>1</i><div><strong>Install and authenticate Codex CLI</strong><p>Use the browser-based ChatGPT sign-in, or pipe an OpenAI API key through stdin. Never paste a token into OriginPost.</p><CodeBlock label="Terminal" value={codexSetup} /></div></article>
        <article><i>2</i><div><strong>Prepare the pinned Hermes runtime</strong><p>Use a clean Hermes 0.21.2 checkout at commit <code>939e45c91d751fadd94dcd1b873ac3cb44846213</code>. Keep its Python environment outside the checkout.</p><span className={styles.inlineCheck}><CheckCircle2 size={14} /> <code>git status --short</code> must return no files.</span></div></article>
        <article><i>3</i><div><strong>Install the hidden Board extension</strong><p>Copy <code>integrations/hermes/originpost-board-approvals/dashboard</code> into <code>~/.hermes/plugins/originpost-board-approvals/</code>. It adds no top-level product page.</p></div></article>
        <article><i>4</i><div><strong>Configure OriginPost while disabled</strong><p>Generate the Board secret and dashboard token independently. Fill every value first; keep the plugin disabled until both Hermes services and storage are healthy.</p><CodeBlock label="OriginPost environment" value={boardEnvironment} /></div></article>
        <article><i>5</i><div><strong>Start the trusted local services</strong><p>Bind Hermes to localhost or a private interface. OriginPost talks server-to-server; the browser never receives Hermes credentials.</p><CodeBlock label="Hermes processes" value={hermesProcess} /></div></article>
        <article><i>6</i><div><strong>Create a Board and add its credential</strong><p>OriginPost creates an opaque dedicated Hermes profile. Configure an OpenAI Codex credential inside that profile, return to <b>Boards → Hermes settings</b>, and choose <b>Retry setup</b>.</p></div></article>
        <article><i>7</i><div><strong>Run the two-Board isolation canary</strong><p>Create two test Boards with different memory and skills. Confirm each sees only its own profile, then set <code>HERMES_BOARD_PLUGIN_ENABLED=true</code> and restart the OriginPost API and worker.</p><button type="button" onClick={() => onNavigate("Boards")}>Open Boards <ArrowRight size={13} /></button></div></article>
      </div>
    </section>

    <section className={styles.personalRuntime} aria-labelledby="personal-runtime-title">
      <div><span className={styles.sectionLabel}>OPTIONAL LOCAL AGENT</span><h2 id="personal-runtime-title">Use ChatGPT subscription auth through Codex app-server</h2><p>This lane is appropriate for a personal or trusted developer Hermes profile that needs Codex shell, patching, plugins, and streamed events. It is not the OriginPost Board execution lane.</p></div>
      <CodeBlock label="Hermes session" value={personalCodexRuntime} />
      <div className={styles.runtimeRules}>
        <span><CheckCircle2 size={14} /> Run <code>codex login</code> separately from Hermes authentication.</span>
        <span><CheckCircle2 size={14} /> Start a new Hermes session after changing the runtime.</span>
        <span><TriangleAlert size={14} /> Keep permissions at <code>:read-only</code> unless workspace writes are truly needed.</span>
        <span><TriangleAlert size={14} /> Do not expose the experimental WebSocket listener beyond localhost without TLS and authentication.</span>
      </div>
    </section>

    <section className={styles.sources} aria-labelledby="official-sources-title">
      <div><span className={styles.sectionLabel}>OFFICIAL REFERENCES</span><h2 id="official-sources-title">Continue with the source documentation</h2></div>
      <div>
        <a href="https://developers.openai.com/codex/cli" target="_blank" rel="noreferrer">Codex CLI <ExternalLink size={13} /></a>
        <a href="https://developers.openai.com/codex/auth" target="_blank" rel="noreferrer">Codex authentication <ExternalLink size={13} /></a>
        <a href="https://developers.openai.com/codex/app-server" target="_blank" rel="noreferrer">Codex app-server <ExternalLink size={13} /></a>
        <a href="https://hermes-agent.nousresearch.com/docs/user-guide/profiles/" target="_blank" rel="noreferrer">Hermes Profiles <ExternalLink size={13} /></a>
        <a href="https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server" target="_blank" rel="noreferrer">Hermes API server <ExternalLink size={13} /></a>
        <a href="https://hermes-agent.nousresearch.com/docs/user-guide/features/codex-app-server-runtime" target="_blank" rel="noreferrer">Hermes Codex runtime <ExternalLink size={13} /></a>
      </div>
    </section>
  </div>;
}

function TroubleshootingGuide({ onNavigate }: { onNavigate: (destination: string) => void }) {
  return <div className={styles.troubleshootingPanel}>
    <section className={styles.diagnosticIntro}>
      <div><span className={styles.sectionLabel}>SAFE DIAGNOSTICS</span><h2>Check the boundary before changing it</h2><p>Run read-only checks first. Do not paste auth files, access tokens, profile paths, full prompts, or raw Hermes responses into support messages.</p></div>
      <CodeBlock label="Local checks" value={diagnosticCommands} />
    </section>
    <section className={styles.problemGrid} aria-label="Common setup problems">
      <article><span><MonitorCog size={17} /></span><div><strong>Board says “Setup required”</strong><p>Confirm PostgreSQL, Redis, API, worker, Hermes dashboard, and Hermes gateway are healthy. Verify both dashboard token values match.</p><button onClick={() => onNavigate("Boards")}>Open Hermes settings</button></div></article>
      <article><span><KeyRound size={17} /></span><div><strong>Codex is not authenticated</strong><p>Run <code>codex login status</code>. For browser login use <code>codex login</code>; for headless hosts prefer device-code login where enabled.</p></div></article>
      <article><span><Bot size={17} /></span><div><strong>One Board sees another Board’s state</strong><p>Disable the plugin immediately. Do not run tasks. Recheck profile, key, memory, skill, state database, and multiplex routing isolation.</p></div></article>
      <article><span><PlayCircle size={17} /></span><div><strong>A task does not start</strong><p>Assignment alone does nothing. Complete dependencies, move the task to Ready, and have a manager or owner explicitly choose Release to Hermes.</p></div></article>
      <article><span><TriangleAlert size={17} /></span><div><strong>An execution is uncertain</strong><p>Do not automatically retry it. Inspect the execution history and Profile-local receipt, then deliberately create a new release only after the prior effect is understood.</p></div></article>
      <article><span><ShieldCheck size={17} /></span><div><strong>Hermes returned good copy</strong><p>That is still not approval. Review the result, hand it into a new unapproved Content Item, then follow the normal approval and publishing workflow.</p></div></article>
    </section>
    <p className={styles.securityNote}><LockKeyhole size={16} /> OriginPost intentionally does not proxy the Hermes dashboard, raw memory, raw skill files, terminal, MCP, cron, profile names, or runtime secrets into the browser.</p>
  </div>;
}

export function HelpCenter({ focusJourney = "image", onNavigate, auth, workspaceId }: { focusJourney?: HelpJourneyId; onNavigate: (destination: string) => void; auth?: AuthView; workspaceId?: string }) {
  const [section, setSection] = useState<GuideSection>("start");
  const [selectedId, setSelectedId] = useState<HelpJourneyId>(focusJourney);
  const [imageCapability, setImageCapability] = useState<HelpImageCapability | null>(null);
  useEffect(() => setSelectedId(focusJourney), [focusJourney]);
  useEffect(() => {
    let cancelled = false;
    if (!auth || !workspaceId) return;
    void apiFetch(`/v1/image-generations/capability?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken)
      .then(async (response) => response.ok ? response.json() as Promise<HelpImageCapability> : null)
      .then((capability) => { if (!cancelled && capability) setImageCapability(capability); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [auth, workspaceId]);

  return <section className={styles.page} aria-labelledby="help-title">
    <header className={styles.hero}>
      <div>
        <p className="eyebrow">ORIGINPOST FIELD GUIDE</p>
        <h1 id="help-title">Know what to do next—and why.</h1>
        <p>Follow the complete source-to-proof workflow, see where every product area belongs, and configure a Board-safe Hermes agent without exposing private memory or credentials.</p>
      </div>
      <div className={styles.promise}>
        <span><ShieldCheck size={17} /> Evidence stays connected</span>
        <small>Generated visuals, human decisions, delivery results, and live proof remain visible at the point where they matter.</small>
      </div>
    </header>

    <nav className={styles.guideTabs} aria-label="Help topics" role="tablist">
      {guideSections.map((item) => <button key={item.id} type="button" role="tab" aria-selected={section === item.id} aria-controls={`help-panel-${item.id}`} id={`help-tab-${item.id}`} className={section === item.id ? styles.selectedGuide : ""} onClick={() => setSection(item.id)}><span>{item.label}</span><small>{item.description}</small></button>)}
    </nav>

    <div id={`help-panel-${section}`} role="tabpanel" aria-labelledby={`help-tab-${section}`}>
      {section === "start" ? <ProductTour onNavigate={onNavigate} /> : null}
      {section === "journeys" ? <JourneyGuide selectedId={selectedId} setSelectedId={setSelectedId} imageCapability={imageCapability} onNavigate={onNavigate} /> : null}
      {section === "hermes" ? <HermesGuide onNavigate={onNavigate} /> : null}
      {section === "troubleshooting" ? <TroubleshootingGuide onNavigate={onNavigate} /> : null}
    </div>
  </section>;
}
