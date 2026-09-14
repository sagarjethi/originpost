import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentChat } from "./agent-chat";

describe("agent UI preview", () => {
  it("states the execution boundary and labels its actionable controls", () => {
    const html = renderToStaticMarkup(<AgentChat userId="user" workspaceId="workspace" brandId="brand" brandName="Sample brand" onNavigate={() => {}} />);
    expect(html).toContain("Agents are not connected");
    expect(html).toContain('aria-label="Save request"');
    expect(html).toContain('aria-label="Conversation participants"');
    expect(html).toContain("Explore an example conversation");
    expect(html).not.toContain("Published successfully");
  });
});
