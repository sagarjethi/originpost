import "dotenv/config";
import { createPostgresClient, PostgresTelegramReceiptRepository } from "@originpost/db";
import { handleTelegramCommand, TelegramBotClient } from "@originpost/telegram";
import { OriginPostApiClient } from "./originpost-api-client.js";

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
const allowedChatIds = new Set((process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const workspaceId = process.env.TELEGRAM_WORKSPACE_ID?.trim() || "default";

if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!allowedChatIds.size) throw new Error("TELEGRAM_ALLOWED_CHAT_IDS must contain at least one trusted chat ID.");

const bot = new TelegramBotClient(token);
const api = new OriginPostApiClient(process.env.ORIGINPOST_API_URL ?? "http://127.0.0.1:4000", workspaceId);
const sql = createPostgresClient(databaseUrl);
const receipts = new PostgresTelegramReceiptRepository(sql);
const abortController = new AbortController();
let offset = 0;

function shutdown() {
  abortController.abort();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await bot.registerCommands();
console.log("OriginPost Telegram adapter is ready.");

while (!abortController.signal.aborted) {
  try {
    const updates = await bot.getUpdates(offset, 25);
    if (abortController.signal.aborted) break;
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      const chatId = message ? String(message.chat.id) : "";
      if (!message?.text || !allowedChatIds.has(chatId)) continue;
      const claimed = await receipts.claim(workspaceId, update.update_id, chatId);
      if (!claimed) continue;
      try {
        const response = await handleTelegramCommand({ updateId: update.update_id, chatId, ...(message.from ? { userId: String(message.from.id) } : {}), text: message.text }, api);
        await bot.sendMessage(chatId, response);
        await receipts.complete(workspaceId, update.update_id);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : "The command failed.";
        await receipts.fail(workspaceId, update.update_id, messageText);
        await bot.sendMessage(chatId, `Could not finish that command.\n${messageText.slice(0, 500)}`).catch(() => undefined);
      }
    }
  } catch (error) {
    console.error("Telegram polling error:", error instanceof Error ? error.message : "Unknown error");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

await sql.end({ timeout: 5 });
