export const agents = [
  { id: "coordinator", name: "Origin", description: "Keeps the whole task moving", initials: "O" },
  { id: "research", name: "Research", description: "Sources, context, and facts", initials: "R" },
  { id: "writer", name: "Writer", description: "Headlines and post copy", initials: "W" },
  { id: "image", name: "Image", description: "Visual direction and artwork", initials: "I" },
  { id: "reviewer", name: "Reviewer", description: "A second look before publishing", initials: "✓" },
] as const;

export type AgentId = typeof agents[number]["id"];
export type ChatRequest = { id: string; text: string; sources: string[]; createdAt: string };
export type ChatDraft = { id: string; title: string; team: boolean; requests: ChatRequest[] };
export const MAX_REQUEST_LENGTH = 8000;

// This UI slice stores unsent requests only. Never persist simulated assistant runs
// or treat this tab-local record as an authoritative Agent Conversation.
export function draftStorageKey(userId: string, workspaceId: string, brandId: string): string {
  return `originpost:agent-requests:v1:${JSON.stringify([userId, workspaceId, brandId])}`;
}

export function sourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function restoreDrafts(raw: string | null): ChatDraft[] {
  try {
    const data: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((draft): draft is ChatDraft => {
      if (!draft || typeof draft !== "object") return false;
      const d = draft as ChatDraft;
      return typeof d.id === "string" && /^local-[a-z0-9-]{1,64}$/i.test(d.id)
        && typeof d.title === "string" && d.title.length <= 80 && typeof d.team === "boolean"
        && Array.isArray(d.requests) && d.requests.length <= 100 && d.requests.every(r =>
          r && typeof r.id === "string" && typeof r.text === "string" && r.text.length <= MAX_REQUEST_LENGTH
          && typeof r.createdAt === "string" && Number.isFinite(Date.parse(r.createdAt))
          && Array.isArray(r.sources) && r.sources.length <= 8 && r.sources.every(u => typeof u === "string" && sourceUrl(u) !== null));
    }).slice(0, 30);
  } catch { return []; }
}

export function mentionQuery(text: string, cursor: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([a-z]*)$/i.exec(text.slice(0, cursor));
  return match ? { start: cursor - match[1]!.length - 1, query: match[1]!.toLowerCase() } : null;
}

export function mentionedAgents(text: string, team: boolean): AgentId[] {
  const eligible = team ? agents : agents.slice(0, 1);
  return eligible.filter(agent => new RegExp(`(^|\\s)@${agent.name}(?=\\s|[.,!?]|$)`, "i").test(text)).map(agent => agent.id);
}
