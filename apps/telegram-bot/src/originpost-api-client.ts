import type { ContentSummary, OriginPostCommandPort } from "@originpost/telegram";

type ContentItemResponse = ContentSummary & {
  drafts: Array<{ caption: string }>;
};

export class OriginPostApiClient implements OriginPostCommandPort {
  constructor(private readonly baseUrl: string, private readonly workspaceId: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    const body = await response.json().catch(() => ({})) as T & { message?: string | string[] };
    if (!response.ok) {
      const message = Array.isArray(body.message) ? body.message.join(" ") : body.message;
      throw new Error(message ?? `OriginPost API returned ${response.status}.`);
    }
    return body;
  }

  async status() {
    const [health, agents] = await Promise.all([
      this.request<{ status: string }>("/health"),
      this.request<{ hermes: { configured: boolean }; sourcing: { mode: string } }>("/v1/agents/status"),
    ]);
    return { api: health.status === "ok", sourcingMode: agents.sourcing.mode, hermesConfigured: agents.hermes.configured };
  }

  async listInbox(limit: number): Promise<ContentSummary[]> {
    const items = await this.request<ContentItemResponse[]>(`/v1/content-items?workspaceId=${encodeURIComponent(this.workspaceId)}`);
    return items.filter((item) => !["published", "archived"].includes(item.status)).slice(0, limit).map(({ id, title, status }) => ({ id, title, status }));
  }

  async createContent(input: { title: string; summary: string }): Promise<ContentSummary> {
    const item = await this.request<ContentItemResponse>("/v1/content-items", { method: "POST", body: JSON.stringify({ workspaceId: this.workspaceId, title: input.title, summary: input.summary, researchDepth: "standard", riskLevel: "low" }) });
    return { id: item.id, title: item.title, status: item.status };
  }

  async researchContent(contentItemId: string): Promise<ContentSummary> {
    const item = await this.request<ContentItemResponse>(`/v1/content-items/${encodeURIComponent(contentItemId)}/research?workspaceId=${encodeURIComponent(this.workspaceId)}`, { method: "POST", body: JSON.stringify({ depth: "standard", languages: ["Gujarati", "Hindi", "English"], region: "India", sourceLimit: 8, freshnessHours: 168 }) });
    return { id: item.id, title: item.title, status: item.status };
  }

  async createMonitor(input: { query: string; intervalMinutes: number; notifyDestinationId?: string }) {
    return this.request<{ id: string; name: string }>("/v1/monitors", { method: "POST", body: JSON.stringify({ workspaceId: this.workspaceId, name: input.query.slice(0, 120), query: input.query, intervalMinutes: input.intervalMinutes, depth: "standard", languages: ["Gujarati", "Hindi", "English"], region: "India", sourceLimit: 8, freshnessHours: 24, enabled: true, notifyDestinationId: input.notifyDestinationId }) });
  }

  async createCaption(input: { contentItemId: string; platform: "instagram" | "youtube"; language: string }): Promise<string> {
    const item = await this.request<ContentItemResponse>(`/v1/content-items/${encodeURIComponent(input.contentItemId)}/agent-draft?workspaceId=${encodeURIComponent(this.workspaceId)}`, { method: "POST", body: JSON.stringify({ platform: input.platform, format: input.platform === "youtube" ? "short" : "image", language: input.language, instruction: "Use simple language and only the saved sources." }) });
    const caption = item.drafts.at(-1)?.caption;
    if (!caption) throw new Error("The caption provider returned no draft.");
    return caption;
  }
}
