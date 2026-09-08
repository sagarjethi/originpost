import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperationsHealthPanel } from "./operations-health-panel";
import type { AuthView } from "../../lib/api-client";

const auth: AuthView = { mode: "single-user", csrfToken: "csrf", user: { id: "owner", email: "owner@example.com", displayName: "Owner" }, memberships: [{ workspaceId: "workspace", workspaceName: "Workspace", workspaceSlug: "workspace", userId: "owner", role: "owner" }] };

describe("operations health panel", () => {
  it("keeps protected health inside the organization surface", () => {
    const html = renderToStaticMarkup(<OperationsHealthPanel auth={auth} workspaceId="workspace" />);
    expect(html).toContain('id="operations-health"');
    expect(html).toContain("Operations health");
    expect(html).toContain("Owner and manager visibility");
    expect(html).not.toContain("MEDIA_CLAMAV_HOST");
  });
});
