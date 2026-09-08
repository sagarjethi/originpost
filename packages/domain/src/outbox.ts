import type { OutboxMessageInput, OutboxTopic } from "./types.js";

export function createOutboxMessage(input: {
  workspaceId: string;
  topic: OutboxTopic;
  dedupeKey: string;
  payload: Record<string, unknown>;
  availableAt?: string;
  now?: string;
}): OutboxMessageInput {
  const now = input.now ?? new Date().toISOString();
  return {
    id: `outbox_${crypto.randomUUID()}`,
    workspaceId: input.workspaceId,
    topic: input.topic,
    dedupeKey: input.dedupeKey,
    payload: structuredClone(input.payload),
    availableAt: input.availableAt ?? now,
    createdAt: now,
  };
}
