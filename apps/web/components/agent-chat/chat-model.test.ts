import { describe, expect, it } from "vitest";
import { draftStorageKey, mentionQuery, mentionedAgents, restoreDrafts, sourceUrl } from "./chat-model";

describe("tab-local agent request boundary", () => {
  const draft = { id: "local-123", title: "A launch", team: true, requests: [{ id: "r1", text: "@Writer a caption", createdAt: "2026-09-14T10:00:00Z", sources: ["https://example.com/brief"] }] };
  it("partitions storage by person, workspace, and brand without delimiter collisions", () => {
    const original = draftStorageKey("a", "b", "c");
    for (const key of [draftStorageKey("x", "b", "c"), draftStorageKey("a", "x", "c"), draftStorageKey("a", "b", "x")]) expect(key).not.toBe(original);
    expect(draftStorageKey("a:b", "c", "d")).not.toBe(draftStorageKey("a", "b:c", "d"));
  });
  it("restores valid requests but rejects corrupted records and unsafe links", () => {
    expect(restoreDrafts(JSON.stringify([draft]))).toEqual([draft]);
    expect(restoreDrafts("broken")).toEqual([]);
    expect(restoreDrafts(JSON.stringify([null, { ...draft, requests: [null] }, { ...draft, requests: [{ ...draft.requests[0], sources: ["javascript:alert(1)"] }] }, draft]))).toEqual([draft]);
    expect(sourceUrl("https://user:password@example.com")).toBeNull();
    expect(sourceUrl("data:text/html,example")).toBeNull();
    expect(sourceUrl(" https://example.com/brief ")).toBe("https://example.com/brief");
  });
  it("offers mentions at the cursor without treating an email as an agent", () => {
    expect(mentionQuery("Ask @wr tomorrow", 7)).toEqual({ start: 4, query: "wr" });
    expect(mentionQuery("hello@example", 13)).toBeNull();
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
  });
  it("recognizes only eligible whole agent handles, never arbitrary bot names", () => {
    expect(mentionedAgents("@Writer please ask @Image. @Writer again", true)).toEqual(["writer", "image"]);
    expect(mentionedAgents("@Writer @Origin", false)).toEqual(["coordinator"]);
    expect(mentionedAgents("@WriterBot someone@Image.com @Admin", true)).toEqual([]);
  });
});
