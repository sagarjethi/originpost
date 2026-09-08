export function workspaceInvitationsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/invitations`;
}

export function workspaceInvitationActionPath(workspaceId: string, invitationId: string, action: "resend" | "revoke"): string {
  return `${workspaceInvitationsPath(workspaceId)}/${encodeURIComponent(invitationId)}/${action}`;
}

export function invitationTokenFromFragment(fragment: string): string {
  if (!fragment.startsWith("#")) return "";
  const token = new URLSearchParams(fragment.slice(1)).get("token") ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
}
