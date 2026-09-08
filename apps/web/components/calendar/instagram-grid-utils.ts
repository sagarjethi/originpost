export type InstagramGridTileStatus = "queued" | "publishing" | "published" | "action_required" | "acknowledged";

export function instagramGridStatusLabel(status: InstagramGridTileStatus): string {
  if (status === "queued") return "Scheduled";
  if (status === "publishing") return "Publishing";
  if (status === "published") return "Published";
  if (status === "action_required") return "Needs action";
  return "Handoff acknowledged";
}

export function instagramGridStatusTone(status: InstagramGridTileStatus): "planned" | "live" | "attention" {
  if (status === "published" || status === "acknowledged") return "live";
  if (status === "action_required") return "attention";
  return "planned";
}

export function instagramGridDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(date);
}
