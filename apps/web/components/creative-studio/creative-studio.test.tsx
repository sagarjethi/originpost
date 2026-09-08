import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CreativeStudio } from "./creative-studio";

describe("CreativeStudio", () => {
  it("renders a clearly marked layout preview and viewer-safe controls", () => {
    const markup = renderToStaticMarkup(<CreativeStudio
      auth={{ mode: "sessions", user: { id: "user-1", email: "viewer@example.com", displayName: "Viewer" }, memberships: [{ workspaceId: "workspace-1", workspaceName: "Workspace", workspaceSlug: "workspace", userId: "user-1", role: "viewer" }] }}
      workspaceId="workspace-1"
      brandId="brand-1"
    />);

    expect(markup).toContain("Layout preview");
    expect(markup).toContain("Draft guide · not final pixels");
    expect(markup).toContain("Read-only view");
    expect(markup).toContain("1080×1350");
    expect(markup).not.toContain("New visual");
    expect(markup).toContain("disabled=\"\"");
  });
});
