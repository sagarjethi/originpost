"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Bot, Check, Camera, Globe, Layers3, RefreshCw, UsersRound, Video } from "lucide-react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import { requestDeadline } from "../../lib/request-deadline";
import styles from "./agent-connections.module.css";

export type AgentConnection = {
  id: string;
  platform: string;
  displayName: string;
  status: string;
  diagnostic?: { readiness: "healthy" | "warning" | "blocked"; checks: Array<{ id: string; status: string; detail: string }> };
};
type Capability = { text: boolean; research: boolean; image: { generation: boolean }; reason?: string | null };
type Snapshot = { scope: string; accounts: AgentConnection[] | null; capability: Capability | null; accountsError: boolean; capabilityError: boolean };

/** Connection checks describe configuration, never approval or delivery of a post. */
export function connectionLabel(account: AgentConnection): { label: string; tone: "good" | "warning" | "neutral" } {
  if (account.status === "disconnected") return { label: "Disconnected", tone: "neutral" };
  if (account.diagnostic?.checks.some((check) => check.id === "mode" && check.status === "warn")) return { label: "Test connection", tone: "warning" };
  if (account.diagnostic?.readiness === "blocked" || ["setup_required", "refresh_failed"].includes(account.status)) return { label: "Setup needed", tone: "warning" };
  if (account.diagnostic?.readiness === "warning" || account.status === "expiring") return { label: "Check connection", tone: "warning" };
  if (account.status === "healthy" && account.diagnostic?.readiness === "healthy") return { label: "Checks passed", tone: "good" };
  return { label: "Not checked", tone: "neutral" };
}

const platforms = [
  { id: "instagram", name: "Instagram", icon: Camera },
  { id: "facebook", name: "Facebook", icon: UsersRound },
  { id: "youtube", name: "YouTube", icon: Video },
];

export function AgentConnections({ auth, workspaceId, brandId, onNavigate }: {
  auth: AuthView; workspaceId: string; brandId: string; onNavigate: (page: string) => void;
}) {
  const scope = JSON.stringify([auth.user.id, workspaceId, brandId]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const current = snapshot?.scope === scope ? snapshot : null;
  useEffect(() => {
    const deadline = requestDeadline();
    let active = true;
    const query = new URLSearchParams({ workspaceId, brandId });
    const get = async <T,>(path: string): Promise<T> => {
      const response = await apiFetch(`${path}?${query}`, { cache: "no-store", signal: deadline.signal }, auth.csrfToken);
      if (!response.ok) throw new Error("Connection status unavailable");
      return response.json() as Promise<T>;
    };
    setLoading(true);
    void Promise.allSettled([get<AgentConnection[]>("/v1/channels/accounts"), get<Capability>("/v1/agent-posts/capability")]).then(([accounts, capability]) => {
      deadline.dispose();
      if (!active) return;
      setSnapshot({ scope, accounts: accounts.status === "fulfilled" && Array.isArray(accounts.value) ? accounts.value : null, capability: capability.status === "fulfilled" ? capability.value : null, accountsError: accounts.status === "rejected" || !Array.isArray(accounts.value), capabilityError: capability.status === "rejected" });
      setLoading(false);
    });
    const focus = () => setRefresh((value) => value + 1);
    window.addEventListener("focus", focus);
    return () => { active = false; deadline.cancel(); window.removeEventListener("focus", focus); };
  }, [scope, workspaceId, brandId, auth.csrfToken, refresh]);

  const additional = [...new Set((current?.accounts ?? []).map((account) => account.platform))].filter((id) => !platforms.some((platform) => platform.id === id));
  const rows = [...platforms, ...additional.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1), icon: Globe }))];
  return <aside className={styles.panel} aria-label="Agent connections and setup">
    <section className={styles.section}>
      <div className={styles.heading}><h2>Connected channels</h2><button type="button" className={styles.refresh} aria-label="Refresh connection status" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={14} className={loading ? styles.spin : undefined} /></button></div>
      <p className={styles.intro}>Accounts for this brand</p>
      {current?.accountsError ? <p className={styles.error} role="status">Connection status is unavailable. Refresh to try again.</p> : null}
      <div className={styles.channels}>{rows.map(({ id, name, icon: Icon }) => {
        const accounts = current?.accounts?.filter((account) => account.platform === id) ?? [];
        return <div className={styles.channel} key={id}><span className={styles.icon}><Icon size={17} /></span><div className={styles.channelBody}><strong>{name}</strong>{accounts.length ? accounts.map((account) => { const state = connectionLabel(account); return <div key={account.id} className={styles.account}><span title={account.displayName}>{account.displayName}</span><small data-tone={state.tone}>{state.label}</small></div>; }) : <small>{!current || loading ? "Checking…" : current.accountsError ? "Status unavailable" : "No account connected"}</small>}</div><button type="button" className={styles.open} aria-label={`Set up ${name}`} onClick={() => onNavigate("Channels")}><ArrowUpRight size={15} /></button></div>;
      })}</div>
      <button type="button" className={styles.action} onClick={() => onNavigate("Channels")}>Manage channels <ArrowUpRight size={14} /></button>
      <p className={styles.note}>Each post still needs format checks and approval before publishing. YouTube requires a video.</p>
    </section>
    <section className={styles.section}>
      <div className={styles.heading}><h2>Agent setup</h2><Bot size={15} /></div>
      {current?.capabilityError ? <p className={styles.error} role="status">Agent availability could not be checked.</p> : <div className={styles.capabilities}>{([
        ["Research", current?.capability?.research],
        ["Writing", current?.capability?.text],
        ["Image creation", current?.capability?.image.generation],
      ] as const).map(([name, ready]) => <div key={name}><span>{name}</span><small data-tone={ready ? "good" : "neutral"}>{ready ? <><Check size={12} />Configured</> : ready === false ? "Setup needed" : "Checking…"}</small></div>)}</div>}
      <button type="button" className={styles.action} onClick={() => onNavigate("Agent plugins")}>Configure text and vision <ArrowUpRight size={14} /></button>
    {auth.memberships.some(member => member.workspaceId === workspaceId && member.role === "owner") && <a className={styles.action} href="/setup?provider=images">Configure image generation <ArrowUpRight size={14} /></a>}
    </section>
    <section className={styles.project}>
      <Layers3 size={19} /><div><h2>Project memory & skills</h2><p>Manage focused work and approved Hermes skills in Boards.</p><button type="button" onClick={() => onNavigate("Boards")}>Open Boards <ArrowUpRight size={13} /></button></div>
    </section>
  </aside>;
}
