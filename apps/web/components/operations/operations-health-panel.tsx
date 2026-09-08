"use client";

import { AlertCircle, CheckCircle2, CircleAlert, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, type AuthView } from "../../lib/api-client";
import styles from "./operations-health-panel.module.css";

type OperationsCheck = {
  id: string;
  label: string;
  status: "healthy" | "warning" | "error" | "disabled";
  summary: string;
  detail: string;
  evidence: Record<string, number | string | boolean | null>;
};

type OperationsHealth = {
  workspaceId: string;
  status: "healthy" | "warning" | "error";
  checkedAt: string;
  checks: OperationsCheck[];
};

function isHealth(value: unknown): value is OperationsHealth {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OperationsHealth>;
  return typeof candidate.workspaceId === "string" && typeof candidate.checkedAt === "string" && ["healthy", "warning", "error"].includes(candidate.status ?? "") && Array.isArray(candidate.checks);
}

function checkIcon(status: OperationsCheck["status"]) {
  if (status === "error") return <AlertCircle size={18} />;
  if (status === "warning") return <CircleAlert size={18} />;
  return <CheckCircle2 size={18} />;
}

function checkedTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(time) : "just now";
}

export function OperationsHealthPanel({ auth, workspaceId }: { auth: AuthView; workspaceId: string }) {
  const [health, setHealth] = useState<OperationsHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await apiFetch(`/v1/operations/health?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: "no-store" }, auth.csrfToken);
      const body = await response.json().catch(() => undefined) as unknown;
      if (!response.ok || !isHealth(body)) throw new Error("Could not load operational health.");
      setHealth(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load operational health.");
    } finally { setLoading(false); }
  }, [auth.csrfToken, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  return <section className={`${styles.panel} panel`} id="operations-health" aria-labelledby="operations-health-title">
    <header className={styles.header}>
      <div className={styles.heading}><span className={health?.status === "error" ? styles.errorMark : health?.status === "warning" ? styles.warningMark : styles.healthyMark}><ShieldCheck size={19} /></span><div><h2 id="operations-health-title">Operations health</h2><p>Owner and manager visibility for protected delivery and media infrastructure.</p></div></div>
      <div className={styles.actions}>{health ? <span className={`${styles.overall} ${styles[health.status]}`}>{health.status}</span> : null}<button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? styles.spin : ""} size={14} /> {loading ? "Checking…" : "Check now"}</button></div>
    </header>
    {error ? <div className={styles.failure} role="alert"><AlertCircle size={16} /><span>{error}</span><button onClick={() => void load()}>Retry</button></div> : null}
    {health ? <div className={styles.grid}>{health.checks.map((check) => <article className={`${styles.check} ${styles[check.status]}`} key={check.id}>
      <span className={styles.icon}>{checkIcon(check.status)}</span><div><small>{check.label}</small><strong>{check.summary}</strong><p>{check.detail}</p></div>
    </article>)}</div> : loading ? <div className={styles.empty}><RefreshCw className={styles.spin} size={20} /><p>Checking durable queues, publishing, media cleanup, webhooks, and malware protection.</p></div> : null}
    {health ? <footer className={styles.footer}><span>Last checked {checkedTime(health.checkedAt)}</span><span>Alerts appear in the action center only for owners and managers.</span></footer> : null}
  </section>;
}
