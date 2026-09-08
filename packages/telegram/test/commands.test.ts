import { describe, expect, it, vi } from "vitest";
import { handleTelegramCommand, type OriginPostCommandPort } from "../src/index.js";

function port(): OriginPostCommandPort {
  return {
    status: vi.fn(async () => ({ api: true, sourcingMode: "mock", hermesConfigured: false })),
    listInbox: vi.fn(async () => [{ id: "content-1", title: "Source-backed update", status: "inbox" }]),
    createContent: vi.fn(async ({ title }) => ({ id: "content-2", title, status: "inbox" })),
    researchContent: vi.fn(async (id) => ({ id, title: "Research item", status: "researching" })),
    createMonitor: vi.fn(async ({ query }) => ({ id: "monitor-1", name: query })),
    createCaption: vi.fn(async () => "A checked caption."),
  };
}

const context = { updateId: 1, chatId: "10", text: "" };

describe("Telegram commands", () => {
  it("creates content from a compact command", async () => {
    const result = await handleTelegramCommand({ ...context, text: "/new Local update | Needs verification" }, port());
    expect(result).toContain("content-2");
  });

  it("validates monitor intervals", async () => {
    const result = await handleTelegramCommand({ ...context, text: "/monitor 5 | latest news" }, port());
    expect(result).toContain("between 10 and 1440");
  });

  it("lists stable command examples for unknown input", async () => {
    const result = await handleTelegramCommand({ ...context, text: "hello" }, port());
    expect(result).toContain("/caption content_item_id");
  });
});
