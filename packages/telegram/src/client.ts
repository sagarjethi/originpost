import type { TelegramUpdate } from "./types.js";

type TelegramEnvelope<T> = { ok: boolean; result?: T; description?: string };

export class TelegramBotClient {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    if (!token.trim()) throw new Error("A Telegram bot token is required.");
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const envelope = await response.json() as TelegramEnvelope<T>;
    if (!response.ok || !envelope.ok || envelope.result === undefined) throw new Error(envelope.description ?? `Telegram ${method} failed.`);
    return envelope.result;
  }

  getUpdates(offset: number, timeout = 25): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", { offset, timeout, allowed_updates: ["message"] });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
  }

  async registerCommands(): Promise<void> {
    await this.call("setMyCommands", { commands: [
      { command: "inbox", description: "Show the latest inbox items" },
      { command: "new", description: "Create content: title | notes" },
      { command: "research", description: "Research a content item by ID" },
      { command: "monitor", description: "Monitor: minutes | search query" },
      { command: "caption", description: "Caption: item ID | platform | language" },
      { command: "status", description: "Show OriginPost service status" },
      { command: "help", description: "Show command examples" },
    ] });
  }
}
