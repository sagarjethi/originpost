import { describe, expect, it } from "vitest";
import { invitationTokenFromFragment, workspaceInvitationActionPath, workspaceInvitationsPath } from "./workspace-invitations";

describe("workspace invitation browser boundaries", () => {
  it("builds only the dedicated invitation routes", () => {
    expect(workspaceInvitationsPath("west coast/news")).toBe("/v1/workspaces/west%20coast%2Fnews/invitations");
    expect(workspaceInvitationActionPath("workspace", "invite/a", "resend")).toBe("/v1/workspaces/workspace/invitations/invite%2Fa/resend");
  });

  it("accepts a 32-byte base64url token only from a URL fragment", () => {
    const token = "a".repeat(43);
    expect(invitationTokenFromFragment(`#token=${token}`)).toBe(token);
    expect(invitationTokenFromFragment(`?token=${token}`)).toBe("");
    expect(invitationTokenFromFragment("#token=too-short")).toBe("");
  });
});
