export type ScheduleConflictView = {
  kinds: Array<"exact_content_duplicate" | "account_time_overlap">;
  minutesApart: number;
};

export function scheduleConflictHeadline(conflict: ScheduleConflictView): string {
  if (conflict.kinds.includes("exact_content_duplicate") && conflict.kinds.includes("account_time_overlap")) return "Exact approved content is already scheduled nearby";
  if (conflict.kinds.includes("exact_content_duplicate")) return "Exact approved content is already scheduled";
  return "Another post is scheduled nearby";
}

export function scheduleConflictReady(input: { requiresConfirmation: boolean; acknowledgementSha256: string } | null, acknowledgedSha256: string): boolean {
  return Boolean(input) && (!input!.requiresConfirmation || input!.acknowledgementSha256 === acknowledgedSha256);
}
