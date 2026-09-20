"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import { WorkspacePageHeader } from "../workspace/workspace-page-header";
import { WorkspaceLoading } from "../loading/workspace-loading";
import styles from "./installation-settings.module.css";

export type InstallationView = {
  version: number; restartRequired: boolean;
  values: Record<string, string>; secrets: Record<string, boolean>;
  activeValues: Record<string, string>; activeSecrets: Record<string, boolean>;
  checks: { sessions: boolean; encryption: boolean; networkRestricted: boolean };
  callbacks: { instagram: string; facebook: string; instagramFacebook: string; youtube: string };
};
const steps = ["Your site", "Secure access", "Set up apps", "Social accounts", "Publish a post"];
const providers = ["Instagram & Facebook", "YouTube", "Images"] as const;
type Provider = typeof providers[number];
export function appSetupStatus(view: InstallationView, provider: Provider): string {
  if (view.restartRequired) return "Saved · activation pending";
  const key = provider === "Images" ? "OPENAI_IMAGE_API_KEY" : provider === "YouTube" ? "GOOGLE_CLIENT_SECRET" : "META_APP_SECRET";
  return view.activeSecrets[key] ? "App settings active" : "App setup needed";
}
export function canShowInstallation(auth: AuthView, workspaceId: string) {
  return auth.memberships.some(member => member.workspaceId === workspaceId && member.role === "owner");
}
export function installationPatch(form: FormData): Record<string, string> {
  return Object.fromEntries([...form.entries()].filter((entry): entry is [string, string] => typeof entry[1] === "string" && (!entry[0].includes("SECRET") && !entry[0].endsWith("API_KEY") && !entry[0].endsWith("VERIFY_TOKEN") || Boolean(entry[1].trim()))));
}
function PasswordSettings({ csrfToken }: { csrfToken: string | undefined }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setMessage("");
    if (data.get("newPassword") !== data.get("confirmPassword")) { setMessage("The new passwords do not match."); return; }
    setBusy(true);
    try {
      const response = await apiFetch("/v1/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: data.get("currentPassword"), newPassword: data.get("newPassword") }) }, csrfToken);
      if (!response.ok) { setMessage("Password was not changed. Check your current password and try again."); return; }
      form.reset();
      const signedOut = await apiFetch("/v1/auth/logout", { method: "POST" }, csrfToken).catch(() => null);
      if (!signedOut?.ok) { setMessage("Password changed. Sign out, then sign in with your new password."); return; }
      window.location.assign("/setup");
    } catch { setMessage("Could not reach the server. Try again."); }
    finally { form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => { input.value = ""; }); setBusy(false); }
  }
  return <form onSubmit={changePassword}>
    <p className={styles.intro}>Replace the temporary installer password before inviting your team. You will sign in again after saving.</p>
    <div className={styles.fields}>
      <label className={styles.full}>Current password<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} /></label>
      <label>New password<input name="newPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} pattern="(?=.*[A-Za-z])(?=.*[0-9]).{12,128}" /><small>At least 12 characters, including a letter and a number.</small></label>
      <label>Confirm new password<input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} /></label>
    </div>
    {message && <p role="alert" className={styles.message}>{message}</p>}
    <div className={styles.actions}><button className="new-button" disabled={busy}>{busy ? "Saving…" : "Change password"}</button></div>
  </form>;
}
export function InstallationSettings({ auth, workspaceId }: { auth: AuthView; workspaceId: string }) {
  const owner = canShowInstallation(auth, workspaceId);
  const [view, setView] = useState<InstallationView | null>(null);
  const [step, setStep] = useState(2);
  const [dirty, setDirty] = useState(false);
  const [provider, setProvider] = useState<Provider>(providers[0]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(owner);
  const [busy, setBusy] = useState(false);
  const request = useCallback(async (init: RequestInit = {}) => {
    const response = await apiFetch(`/v1/installation/settings?${new URLSearchParams({ workspaceId })}`, { cache: "no-store", ...init }, auth.csrfToken);
    if (!response.ok) {
      // Do not echo submitted values or arbitrary server diagnostics from a credential form.
      if (response.status === 403) throw new Error("Sign in as the installation owner in the installation workspace to manage these settings. Shared workspaces cannot change server connections.");
      if (response.status === 409) throw new Error("Settings changed in another window. Refresh this page before saving again.");
      throw new Error("Settings could not be saved or loaded. Check the addresses and required fields, then try again.");
    }
    return await response.json() as InstallationView;
  }, [auth.csrfToken, workspaceId]);
  useEffect(() => {
    if (!owner) return;
    let active = true;
    void request().then(next => { if (active) setView(next); }).catch(reason => { if (active) setError(reason.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [owner, request]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const leave = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
      if (!window.confirm("Leave without saving these settings?")) { event.preventDefault(); event.stopPropagation(); }
      else setDirty(false);
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", leave, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", leave, true); };
  }, [dirty]);
  function discardChanges() {
    if (dirty && !window.confirm("Leave without saving these settings?")) return false;
    setDirty(false); return true;
  }
  function chooseStep(next: number) { if (next !== step && discardChanges()) { setStep(next); setNotice(""); } }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view) return;
    const form = event.currentTarget;
    const values = installationPatch(new FormData(form));
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await request({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: view.version, values }) });
      setView(next); setDirty(false); form.reset();
      setNotice("Settings saved. Apply pending changes before continuing.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Settings could not be saved."); }
    finally {
      form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach(input => { input.value = ""; });
      setBusy(false);
    }
  }
  async function removeCredential() {
    if (!view || !discardChanges()) return;
    const clearSecrets = provider === "Images" ? ["OPENAI_IMAGE_API_KEY"] : provider === "YouTube" ? ["GOOGLE_CLIENT_SECRET"] : ["META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"];
    const values = provider === "Images" ? { IMAGE_GENERATION_MODE: "disabled" } : provider === "YouTube" ? { GOOGLE_CLIENT_ID: "" } : { META_APP_ID: "" };
    setBusy(true); setError(""); setNotice("");
    try {
      setView(await request({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: view.version, values, clearSecrets }) }));
      setNotice("Service credentials removed from saved settings. Apply the change to remove them from the running service. Connected social accounts must be disconnected separately in Social accounts.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Credentials could not be removed."); }
    finally { setBusy(false); }
  }
  const removalBlocked = provider === "Instagram & Facebook" ? view?.values.INSTAGRAM_CONNECTOR_MODE === "official" || view?.values.FACEBOOK_CONNECTOR_MODE === "official" : provider === "YouTube" ? view?.values.YOUTUBE_CONNECTOR_MODE === "official" : false;
  const field = (name: string, label: string, options: { secret?: boolean; required?: boolean; url?: boolean; hint?: string } = {}) => <label key={name}>{label}<input name={name} type={options.secret ? "password" : options.url ? "url" : "text"} defaultValue={options.secret ? "" : view?.values[name] ?? ""} autoComplete={options.secret ? "new-password" : "off"} required={options.required && !(options.secret && view?.secrets[name])} spellCheck={false} maxLength={options.secret ? 4096 : 500} />{options.secret ? <small>{view?.secrets[name] ? "Saved securely. Leave blank to keep the current key." : "Enter once. This key is never shown again."}</small> : options.hint ? <small>{options.hint}</small> : null}</label>;
  const mode = (name: string, label: string, choices: string[]) => <label key={name}>{label}<select name={name} defaultValue={view?.values[name] ?? choices[0]}>{choices.map(value => <option value={value} key={value}>{value === "disabled" || value === "false" ? "Off" : value === "true" ? "On — approved posts only" : value === "official" ? "Publish approved posts" : value === "mock" ? "Test only" : value}</option>)}</select></label>;
  return <section className={styles.page}>
    <WorkspacePageHeader eyebrow="INSTALLATION" title="Set up your workspace" description="Add app settings once, connect your social accounts, then approve and publish." />
    {!owner ? <div className={styles.message}>Only the installation owner can manage server connections. You can continue creating drafts in Agent.</div> : <>
      {error && <div role="alert" className={`${styles.message} ${styles.error}`}>{error}</div>}
      {notice && <div role="status" className={styles.message}>{notice}</div>}
      {view?.restartRequired && <div role="status" className={styles.message}>Saved · waiting to activate. Run node scripts/install.mjs apply on the server, then refresh this page before connecting an account.</div>}
      <div className={styles.layout}>
        <nav aria-label="Installation steps" className={styles.steps}>{[2, 3, 4, 1, 0].map((index, position) => <button key={steps[index]} type="button" className={styles.step} aria-current={step === index ? "step" : undefined} disabled={busy} onClick={() => chooseStep(index)}><span className={styles.number}>{position < 3 ? position + 1 : "·"}</span>{steps[index]}</button>)}</nav>
        <div className={styles.card}>
          {loading ? <WorkspaceLoading fullPage={false} title="Loading installation" description="Checking your saved settings." /> : !view ? <><h2>Sign in securely first</h2><p className={styles.intro}>The server installer creates the first owner account. Sign in with that account to configure services here. Keys are never available to shared creators.</p><a className="secondary-button" href="/help" target="_blank" rel="noreferrer">Read the installation guide</a></> : <>
            <h2>{steps[step]}</h2>
            {step === 0 && <details className={styles.message}><summary>Edit server addresses</summary><form key={`site-${view.version}`} onSubmit={save} onChange={() => setDirty(true)}><p className={styles.intro}>Use your local addresses while testing. Localhost and 127.0.0.1 allow HTTP; public installations require HTTPS. Social publishing also requires provider-approved return addresses and reachable media.</p><div className={styles.fields}>{field("WEB_PUBLIC_URL", "Application address", { required: true, url: true })}{field("API_PUBLIC_URL", "API address", { required: true, url: true })}{field("S3_PUBLIC_ENDPOINT", "Public media address", { required: true, url: true, hint: "Local HTTP is supported for testing. Real publishing needs a public HTTPS media address reachable by the social platform." })}{field("CORS_ORIGIN", "Allowed application origin", { required: true, url: true, hint: "Usually the same as your application address, without a trailing slash." })}</div><div className={styles.actions}><span className={styles.intro}>Addresses apply to this installation.</span><button className="new-button" disabled={busy}>{busy ? "Saving…" : "Save addresses"}</button></div></form></details>}
            {step === 1 && <><p className={styles.intro}>People create drafts using their own accounts. Keep service keys with the installation owner and give publishing access only to trusted reviewers.</p><div className={styles.checks}><div className={styles.check}>Individual sign-in<span className={styles.status}>{view.checks.sessions ? "Active" : "Needs setup"}</span></div><div className={styles.check}>Encrypted credentials<span className={styles.status}>{view.checks.encryption ? "Active" : "Needs setup"}</span></div><div className={styles.check}>Admin network restriction<span className={styles.status}>{view.checks.networkRestricted ? "Active" : "Not configured"}</span></div></div><PasswordSettings csrfToken={auth.csrfToken} /><a className="secondary-button" href="/organizations">Manage your team</a></>}
            {step === 2 && <><p className={styles.intro}>Set up each app once. Then connect your social account and review a post before publishing.</p>{provider === "Instagram & Facebook" && <p className={styles.intro}>Use a Facebook Page and its linked professional Instagram account. This setup uses Facebook Login.</p>}<div className={styles.providerTabs}>{providers.map(name => <button key={name} aria-pressed={provider === name} disabled={busy} onClick={() => { if (name !== provider && discardChanges()) setProvider(name); }}>{name}</button>)}</div><form key={`${provider}-${view.version}`} onSubmit={save} onChange={() => setDirty(true)}><div className={styles.fields}>
              {provider === "Instagram & Facebook" && <>{field("META_APP_ID", "Meta application ID", { required: true })}{field("META_APP_SECRET", "Meta application secret", { required: true, secret: true })}{field("META_GRAPH_API_VERSION", "Meta API version", { required: true, hint: "Use a version supported by your Meta application." })}</>}
              {provider === "YouTube" && <>{field("GOOGLE_CLIENT_ID", "Google client ID", { required: true })}{field("GOOGLE_CLIENT_SECRET", "Google client secret", { required: true, secret: true })}</>}
              {provider === "Images" && <>{mode("IMAGE_GENERATION_MODE", "Image generation", ["disabled", "openai"])}{field("OPENAI_IMAGE_MODEL", "Image model")}{field("OPENAI_IMAGE_API_KEY", "Image API key", { secret: true })}</>}
            </div>{provider === "Instagram & Facebook" && <details className={styles.message}><summary>Instagram publishing verification</summary><p>Required before enabling live Instagram publishing.</p><div className={styles.fields}>{field("META_WEBHOOK_VERIFY_TOKEN", "Webhook verification token", { secret: true })}</div></details>}{provider !== "Images" && <details className={styles.message}><summary>Setup guide</summary>{provider === "Instagram & Facebook" ? <><ol><li>Open your application in the <a href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Meta developer dashboard</a> and add Facebook Login.</li><li>Register the exact return addresses below, then save your application ID and secret here.</li><li>Open Social accounts and sign in with access to your Facebook Page. Instagram needs a professional account linked to that Page.</li></ol><p>Access beyond your application’s testers may require Meta review. See <a href="https://www.postman.com/meta/workspace/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00" target="_blank" rel="noreferrer">Meta’s Facebook Login guide</a>.</p></> : <><ol><li>In the <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a>, enable YouTube Data API and create an OAuth web client.</li><li>Add the exact YouTube return address below, then save your client ID and secret here.</li><li>Open Social accounts and connect the YouTube channel you want to publish to.</li></ol><p>YouTube requires a video. Testing access, consent verification and the YouTube upload audit can restrict public publishing. Read <a href="https://developers.google.com/identity/protocols/oauth2/web-server" target="_blank" rel="noreferrer">Google’s sign-in setup</a> and <a href="https://developers.google.com/youtube/v3/docs/videos/insert" target="_blank" rel="noreferrer">YouTube’s upload requirements</a>.</p></>}</details>}{provider !== "Images" && <div className={styles.callbacks}><p className={styles.intro}>Copy these exact return addresses into your developer application.</p>{(provider === "YouTube" ? [["YouTube", view.callbacks.youtube]] : [["Facebook Login", view.callbacks.facebook], ["Instagram through Facebook", view.callbacks.instagramFacebook]]).map(([label, value]) => <label key={label}>{label}<input aria-label={`${label} return address`} value={value} readOnly onFocus={event => event.currentTarget.select()} /></label>)}</div>}<div className={styles.actions}><span className={styles.status}>{appSetupStatus(view, provider)}</span><button className="new-button" disabled={busy}>{busy ? "Saving…" : "Save app settings"}</button></div></form><details className={styles.message}><summary>Remove saved credentials</summary><div className={styles.actions}><small>Turn off this service’s publishing before removing its credentials.</small><button type="button" className="secondary-button" disabled={busy || removalBlocked} onClick={() => void removeCredential()}>Remove service credentials</button></div></details><div className={styles.actions}><span>Next: sign in to your social account.</span><button type="button" className="secondary-button" disabled={busy} onClick={() => chooseStep(3)}>Continue to accounts</button></div></>}
            {step === 3 && <><p className={styles.intro}>Choose your brand in the sidebar. Then sign in with Facebook or Google and choose the Page or channel you want to use.</p><div className={styles.links}><a className={styles.link} href="/channels"><strong>Connect social accounts</strong><span>Instagram, Facebook and YouTube. Review each account’s connection status.</span></a><a className={styles.link} href="/agent-plugins"><strong>Connect a text agent</strong><span>Choose the runtime for research and writing.</span></a><a className={styles.link} href="/audio"><strong>Add a voice provider</strong><span>Connect audio services and set generation limits.</span></a></div></>}
            {step === 4 && <><p className={styles.intro}>Create a draft, check the facts and layout, then approve the exact version you want to publish. A live link in Published posts confirms the result.</p><div className={styles.links}><a className={styles.link} href="/agent"><strong>1. Create your brand template and draft</strong><span>Add your logo, references and writing style. Generate your first post.</span></a><a className={styles.link} href="/content"><strong>2. Review and approve</strong><span>Check sources, image, caption and destination before publishing.</span></a><a className={styles.link} href="/proof"><strong>3. Confirm publication</strong><span>Look for the live link. Configured, connected and published are separate steps.</span></a></div><form key={`publish-${view.version}`} onSubmit={save} onChange={() => setDirty(true)}><div className={`${styles.fields} ${styles.message}`}>{mode("INSTAGRAM_CONNECTOR_MODE", "Instagram publishing", ["mock", "official"])}{mode("FACEBOOK_CONNECTOR_MODE", "Facebook publishing", ["mock", "official"])}{mode("YOUTUBE_CONNECTOR_MODE", "YouTube publishing", ["mock", "official"])}{mode("ALLOW_LIVE_PUBLISH", "Allow approved posts to publish", ["false", "true"])}</div><div className={styles.actions}><span className={styles.status}>{view.activeValues.ALLOW_LIVE_PUBLISH === "true" ? "Publishing switch active" : "Publishing switch off"}</span><button className="new-button" disabled={busy}>{busy ? "Saving…" : "Save publishing setting"}</button></div></form></>}
          </>}
        </div>
      </div>
    </>}
  </section>;
}
