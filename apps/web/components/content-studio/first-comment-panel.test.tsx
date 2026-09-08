import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FirstCommentPanel } from "./first-comment-panel";

describe("FirstCommentPanel", () => {
  it("renders a proof-led, optional first-comment workspace only for Meta targets", () => {
    const markup = renderToStaticMarkup(<FirstCommentPanel
      auth={{ mode: "single-user", user: { id: "owner-1", email: "owner@example.test", displayName: "Owner" }, memberships: [{ workspaceId: "workspace-1", workspaceName: "Workspace", workspaceSlug: "workspace", userId: "owner-1", role: "owner" }] }}
      workspaceId="workspace-1"
      contentItemId="content-1"
      targets={[{ id: "target-instagram", platform: "instagram", draftId: "draft-1", status: "queued" }, { id: "target-youtube", platform: "youtube", draftId: "draft-2", status: "queued" }]}
    />);
    expect(markup).toContain("First comment");
    expect(markup).toContain("wait for the exact post proof");
    expect(markup).toContain("Instagram · queued");
    expect(markup).not.toContain("YouTube · queued");
    expect(markup).not.toContain("owner@example.test");
  });

  it("stays hidden when no Instagram or Facebook target exists", () => {
    const markup = renderToStaticMarkup(<FirstCommentPanel
      auth={{ mode: "single-user", user: { id: "owner-1", email: "owner@example.test", displayName: "Owner" }, memberships: [] }}
      workspaceId="workspace-1"
      contentItemId="content-1"
      targets={[{ id: "target-youtube", platform: "youtube", draftId: "draft-1", status: "queued" }]}
    />);
    expect(markup).toBe("");
  });
});
