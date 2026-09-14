import { describe, expect, it } from "vitest";
import { connectionLabel, type AgentConnection } from "./agent-connections";

const account: AgentConnection = { id: "ig_1", platform: "instagram", displayName: "Brand", status: "healthy", diagnostic: { readiness: "healthy", checks: [] } };
describe("agent channel configuration labels", () => {
  it("never mistakes retained diagnostics on a disconnected account for an active connection", () => {
    expect(connectionLabel({ ...account, status: "disconnected" }).label).toBe("Disconnected");
  });
  it("identifies mock connectors even when the account status is healthy", () => {
    expect(connectionLabel({ ...account, diagnostic: { readiness: "warning", checks: [{ id: "mode", status: "warn", detail: "Test connector" }] } }).label).toBe("Test connection");
  });
  it("requires current diagnostic evidence before saying checks passed", () => {
    const { diagnostic: _diagnostic, ...unchecked } = account;
    expect(connectionLabel(unchecked).label).toBe("Not checked");
    expect(connectionLabel({ ...account, diagnostic: { readiness: "blocked", checks: [] } }).label).toBe("Setup needed");
    expect(connectionLabel(account).label).toBe("Checks passed");
  });
});
