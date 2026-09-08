import type { OriginPostCommandPort, TelegramCommandContext } from "./types.js";

const help = `OriginPost commands

/inbox — latest content waiting for work
/new Headline | Short notes
/research content_item_id
/monitor 15 | latest verified Gujarat news
/caption content_item_id | instagram | Gujarati
/status — API and sourcing status

Monitors create inbox suggestions only. They never auto-approve or auto-publish.`;

function parts(value: string): string[] {
  return value.split("|").map((part) => part.trim());
}

function bodyAfterCommand(text: string): string {
  return text.trim().replace(/^\/\w+(?:@\w+)?\s*/u, "").trim();
}

export async function handleTelegramCommand(context: TelegramCommandContext, port: OriginPostCommandPort): Promise<string> {
  const command = context.text.trim().split(/\s+/u)[0]?.split("@")[0]?.toLowerCase() ?? "";
  const body = bodyAfterCommand(context.text);

  if (command === "/start" || command === "/help") return help;
  if (command === "/status") {
    const status = await port.status();
    return `OriginPost API: ${status.api ? "ready" : "offline"}\nSourcing: ${status.sourcingMode}\nHermes: ${status.hermesConfigured ? "configured" : "not connected"}`;
  }
  if (command === "/inbox") {
    const items = await port.listInbox(6);
    if (!items.length) return "The inbox is clear.";
    return `Latest inbox items\n\n${items.map((item, index) => `${index + 1}. ${item.title}\n${item.status} · ${item.id}`).join("\n\n")}`;
  }
  if (command === "/new") {
    const [title = "", summary = ""] = parts(body);
    if (title.length < 2) return "Use: /new Headline | Short notes";
    const item = await port.createContent({ title: title.slice(0, 180), summary: summary.slice(0, 2000) });
    return `Added to inbox\n${item.title}\n${item.id}`;
  }
  if (command === "/research") {
    if (body.length < 3) return "Use: /research content_item_id";
    const item = await port.researchContent(body);
    return `Research queued\n${item.title}\n${item.id}`;
  }
  if (command === "/monitor") {
    const [minutesValue = "", query = ""] = parts(body);
    const intervalMinutes = Number(minutesValue);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 10 || intervalMinutes > 1440 || query.length < 3) return "Use: /monitor 15 | latest verified Gujarat news\nMinutes must be between 10 and 1440.";
    const monitor = await port.createMonitor({ query: query.slice(0, 500), intervalMinutes, notifyDestinationId: context.chatId });
    return `Monitor started\n${monitor.name}\n${monitor.id}`;
  }
  if (command === "/caption") {
    const [contentItemId = "", platformValue = "", language = "English"] = parts(body);
    if (contentItemId.length < 3 || !["instagram", "youtube"].includes(platformValue)) return "Use: /caption content_item_id | instagram | Gujarati";
    const caption = await port.createCaption({ contentItemId, platform: platformValue as "instagram" | "youtube", language: language.slice(0, 40) });
    return `Draft caption\n\n${caption}`;
  }
  return help;
}
