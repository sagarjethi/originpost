export const operationalCheckIds = ["malware_protection", "webhook_delivery", "media_cleanup", "publishing_attention", "delivery_queue"] as const;

export type OperationalCheckId = (typeof operationalCheckIds)[number];
export type OperationalIncidentStatus = "warning" | "error";
export type OperationalIncidentTransition = "opened" | "changed" | "unchanged" | "resolved" | "already_resolved";

export interface OperationalIncident {
  workspaceId: string;
  checkId: OperationalCheckId;
  status: OperationalIncidentStatus;
  fingerprint: string;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt?: string | undefined;
}

export interface OperationalIncidentRepository {
  observe(input: {
    workspaceId: string;
    checkId: OperationalCheckId;
    status?: OperationalIncidentStatus | undefined;
    fingerprint?: string | undefined;
    observedAt: string;
  }): Promise<{ transition: OperationalIncidentTransition; incident: OperationalIncident | null }>;
}

export class InMemoryOperationalIncidentRepository implements OperationalIncidentRepository {
  private readonly incidents = new Map<string, OperationalIncident>();

  async observe(input: {
    workspaceId: string;
    checkId: OperationalCheckId;
    status?: OperationalIncidentStatus | undefined;
    fingerprint?: string | undefined;
    observedAt: string;
  }): Promise<{ transition: OperationalIncidentTransition; incident: OperationalIncident | null }> {
    const key = `${input.workspaceId}:${input.checkId}`;
    const current = this.incidents.get(key);
    if (!input.status || !input.fingerprint) {
      if (!current || current.resolvedAt) return { transition: "already_resolved", incident: current ? structuredClone(current) : null };
      const resolved = { ...current, lastSeenAt: input.observedAt, resolvedAt: input.observedAt };
      this.incidents.set(key, resolved);
      return { transition: "resolved", incident: structuredClone(resolved) };
    }
    if (!current || current.resolvedAt) {
      const opened: OperationalIncident = { workspaceId: input.workspaceId, checkId: input.checkId, status: input.status, fingerprint: input.fingerprint, openedAt: input.observedAt, lastSeenAt: input.observedAt };
      this.incidents.set(key, opened);
      return { transition: "opened", incident: structuredClone(opened) };
    }
    const changed = current.status !== input.status || current.fingerprint !== input.fingerprint;
    const next = { ...current, status: input.status, fingerprint: input.fingerprint, lastSeenAt: input.observedAt };
    this.incidents.set(key, next);
    return { transition: changed ? "changed" : "unchanged", incident: structuredClone(next) };
  }
}
