import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PostingQueueProfilePanel } from "./posting-queue-profile";

const account = { id: "account-1", platform: "youtube" as const, displayName: "News channel", status: "healthy" };

describe("PostingQueueProfilePanel", () => {
  it("renders all seven account-clock days and manager guidance", () => {
    const markup = renderToStaticMarkup(<PostingQueueProfilePanel auth={{ mode: "single-user", user: { id: "owner", email: "owner@example.test", displayName: "Owner" }, memberships: [{ workspaceId: "workspace-1", workspaceName: "Workspace", workspaceSlug: "workspace", userId: "owner", role: "owner" }] }} workspaceId="workspace-1" brandId="brand-1" accounts={[account]} />);
    expect(markup).toContain("ACCOUNT POSTING QUEUE");
    expect(markup).toContain("IANA time zone");
    expect(markup).toContain("monday posting times");
    expect(markup).toContain("sunday posting times");
    expect(markup).toContain("DST gaps are never shifted silently");
    expect(markup).toContain("preview this account’s free slots before saving");
    expect(markup).toContain("Save account queue");
  });

  it("keeps queue profile editing read-only for viewers", () => {
    const markup = renderToStaticMarkup(<PostingQueueProfilePanel auth={{ mode: "sessions", user: { id: "viewer", email: "viewer@example.test", displayName: "Viewer" }, memberships: [{ workspaceId: "workspace-1", workspaceName: "Workspace", workspaceSlug: "workspace", userId: "viewer", role: "viewer" }] }} workspaceId="workspace-1" brandId="brand-1" accounts={[account]} />);
    expect(markup).toContain("Read-only · an owner or manager can change this account clock.");
    expect(markup.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(10);
    expect(markup).not.toContain("viewer@example.test");
  });
});
