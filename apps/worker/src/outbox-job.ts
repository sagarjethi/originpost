export function publishJobId(targetId: string, recoveryKey: unknown): string {
  return typeof recoveryKey === "string" && /^[a-f0-9]{32}$/i.test(recoveryKey)
    ? `${targetId}-recovery-${recoveryKey}`
    : targetId;
}
