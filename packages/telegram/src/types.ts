export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface ContentSummary {
  id: string;
  title: string;
  status: string;
}

export interface OriginPostCommandPort {
  status(): Promise<{ api: boolean; sourcingMode: string; hermesConfigured: boolean }>;
  listInbox(limit: number): Promise<ContentSummary[]>;
  createContent(input: { title: string; summary: string }): Promise<ContentSummary>;
  researchContent(contentItemId: string): Promise<ContentSummary>;
  createMonitor(input: { query: string; intervalMinutes: number; notifyDestinationId?: string }): Promise<{ id: string; name: string }>;
  createCaption(input: { contentItemId: string; platform: "instagram" | "youtube"; language: string }): Promise<string>;
}

export interface TelegramCommandContext {
  updateId: number;
  chatId: string;
  userId?: string;
  text: string;
}
