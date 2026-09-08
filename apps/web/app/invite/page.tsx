"use client";

import { ArrowRight, Check, KeyRound, ShieldCheck, UserPlus } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { apiFetch, type AuthView } from "@/lib/api-client";
import { invitationTokenFromFragment } from "@/lib/workspace-invitations";
import styles from "./invite.module.css";

type InvitationPreview = { workspaceName: string; role: "owner" | "manager" | "creator" | "viewer"; emailHint: string; expiresAt: string; deliveryState: "link_ready" };

async function responseMessage(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({})) as { message?: string | string[] };
  return Array.isArray(body.message) ? body.message.join(" ") : body.message ?? fallback;
}

export default function WorkspaceInvitationPage() {
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [auth, setAuth] = useState<AuthView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    const rawToken = invitationTokenFromFragment(window.location.hash);
    window.history.replaceState(null, "", "/invite");
    if (!rawToken) { setError("This invitation link is incomplete or invalid."); return; }
    setToken(rawToken);
    void Promise.all([
      apiFetch("/public/v1/invitations/preview", { method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: rawToken }) }),
      apiFetch("/v1/auth/me", { cache: "no-store" }),
    ]).then(async ([previewResponse, authResponse]) => {
      if (!previewResponse.ok) throw new Error(await responseMessage(previewResponse, "This invitation is unavailable."));
      setPreview(await previewResponse.json() as InvitationPreview);
      if (authResponse.ok) setAuth(await authResponse.json() as AuthView);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "This invitation is unavailable."));
  }, []);

  function finish() { window.location.assign("/?module=organizations"); }

  async function acceptExisting(csrfToken = auth?.csrfToken) {
    if (!token || !csrfToken) return;
    setBusy("accept"); setError("");
    try {
      const response = await apiFetch("/v1/auth/invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }, csrfToken);
      if (!response.ok) throw new Error(await responseMessage(response, "Could not accept this invitation."));
      finish();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not accept this invitation."); setBusy(""); }
  }

  async function signInAndAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("signin"); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const login = await apiFetch("/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: form.get("email"), password: form.get("password") }) });
      if (!login.ok) throw new Error(await responseMessage(login, "Could not sign in."));
      const view = await login.json() as AuthView;
      setAuth(view);
      const accepted = await apiFetch("/v1/auth/invitations/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }, view.csrfToken);
      if (!accepted.ok) throw new Error(await responseMessage(accepted, "Could not accept this invitation."));
      finish();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not sign in and accept this invitation."); setBusy(""); }
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("register"); setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await apiFetch("/public/v1/invitations/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, displayName: form.get("displayName"), password: form.get("password") }) });
      if (!response.ok) throw new Error(await responseMessage(response, "Could not create your account."));
      finish();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create your account."); setBusy(""); }
  }

  return <main className={styles.shell}>
    <section className={styles.card}>
      <header><span className={styles.mark}>O</span><div><strong>OriginPost</strong><small>Secure workspace invitation</small></div><ShieldCheck size={20} /></header>
      {!preview ? <div className={styles.state}><ShieldCheck size={30} /><h1>{error ? "Invitation unavailable" : "Checking invitation…"}</h1><p>{error || "Validating the one-time link without storing it in the page URL."}</p>{error ? <a href="/">Open OriginPost</a> : null}</div> : <>
        <div className={styles.hero}><p>WORKSPACE INVITATION</p><h1>Join {preview.workspaceName}</h1><span>You are joining as <strong>{preview.role}</strong> with <strong>{preview.emailHint}</strong>.</span><small>Link expires {new Date(preview.expiresAt).toLocaleString()}.</small></div>
        {error ? <div className={styles.error} role="alert">{error}</div> : null}
        {auth ? <section className={styles.choice}><Check size={22} /><div><h2>Signed in as {auth.user.displayName}</h2><p>OriginPost will verify that this account uses the invited email before adding access.</p></div><button onClick={() => void acceptExisting()} disabled={Boolean(busy)}>Join workspace <ArrowRight size={15} /></button></section> : <div className={styles.columns}>
          <form onSubmit={signInAndAccept}><KeyRound size={22} /><h2>I already use OriginPost</h2><p>Sign in with the email that received this invitation.</p><label>Email<input name="email" type="email" autoComplete="username" required maxLength={254} /></label><label>Password<input name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} /></label><button disabled={Boolean(busy)}>{busy === "signin" ? "Signing in…" : "Sign in and join"}</button></form>
          <form onSubmit={register}><UserPlus size={22} /><h2>Create my account</h2><p>Your email and role come from the invitation and cannot be changed here.</p><label>Your name<input name="displayName" autoComplete="name" required minLength={2} maxLength={100} /></label><label>Create password<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} pattern="(?=.*[A-Za-z])(?=.*[0-9]).{12,128}" /></label><small>Use 12–128 characters with at least one letter and number.</small><button disabled={Boolean(busy)}>{busy === "register" ? "Creating account…" : "Create account and join"}</button></form>
        </div>}
        <footer>The invitation grants access only after acceptance. OriginPost does not send email or create a second workspace.</footer>
      </>}
    </section>
  </main>;
}
