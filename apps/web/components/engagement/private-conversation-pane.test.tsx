import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EngagementTypeTabs } from "./engagement-type-tabs";
import { PrivateConversationPane, PrivateConversationStatusBanner, PrivateMessageBubble, PrivateReconciliationForm } from "./private-conversation-pane";

describe("private conversation components", () => {
  it("renders the public/private inbox switch and an API-unavailable state", () => {
    const tabs = renderToStaticMarkup(<EngagementTypeTabs value="messages" onChange={vi.fn()} />);
    expect(tabs).toContain("Public comments");
    expect(tabs).toContain("Private messages");
    expect(tabs).toContain('aria-current="page"');

    const unavailable = renderToStaticMarkup(<PrivateConversationStatusBanner state={{ state: "contract_unverified" }} />);
    expect(unavailable).toContain("Messaging contract not verified");
    expect(unavailable).toContain("provider contract is verified");
  });

  it("escapes private text and renders attachments as placeholders without remote media", () => {
    const markup = renderToStaticMarkup(<PrivateMessageBubble
      platform="instagram"
      participant={{ displayName: "Customer" }}
      message={{
        id: "message-1",
        direction: "incoming",
        kind: "text",
        body: '<img src="https://tracker.invalid/x"> hello',
        availability: "available",
        firstSeenAt: new Date().toISOString(),
        attachments: [{ id: "attachment-1", kind: "image", availability: "available", mimeType: "image/jpeg" }],
      }}
    />);
    expect(markup).toContain("&lt;img src=&quot;https://tracker.invalid/x&quot;&gt; hello");
    expect(markup).toContain("Image not imported");
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("tracker.invalid/x\"");
    expect(markup).not.toContain("href=");
  });

  it("renders explicit uncertain reconciliation without a retry action", () => {
    const markup = renderToStaticMarkup(<PrivateReconciliationForm note="" providerEvidenceAvailable={false} onNoteChange={vi.fn()} onConfirmSent={vi.fn()} onConfirmNotSent={vi.fn()} busy={false} />);
    expect(markup).toContain("Check the live provider conversation first");
    expect(markup).toContain("does not have verified send evidence");
    expect(markup).toContain("Confirm sent");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Confirm sent/s);
    expect(markup).toContain("Confirm not sent");
    expect(markup).not.toContain("Provider message ID");
    expect(markup).not.toContain("Retry");
  });

  it("enables confirm sent only when sanitized provider evidence is available", () => {
    const markup = renderToStaticMarkup(<PrivateReconciliationForm note="Checked live conversation" providerEvidenceAvailable onNoteChange={vi.fn()} onConfirmSent={vi.fn()} onConfirmNotSent={vi.fn()} busy={false} />);
    expect(markup).toContain("verified hidden provider evidence");
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*>.*Confirm sent/s);
    expect(markup).not.toContain("Provider message ID");
  });

  it("renders a privacy-safe initial loading shell", () => {
    const markup = renderToStaticMarkup(<PrivateConversationPane
      auth={{ mode: "single-user", user: { id: "owner-1", email: "owner@example.test", displayName: "Owner" }, memberships: [{ workspaceId: "workspace-1", workspaceName: "Workspace", workspaceSlug: "workspace", userId: "owner-1", role: "owner" }] }}
      workspaceId="workspace-1"
      brandId="brand-1"
      onShowComments={vi.fn()}
    />);
    expect(markup).toContain("Private conversations, handled carefully");
    expect(markup).toContain("Loading private messages");
    expect(markup).not.toContain("owner@example.test");
  });
});
