import { describe, expect, it } from "vitest";
import {
  connectedAccountStatusPresentation,
  defaultPlatformFormat,
  externalPostIdPlaceholder,
  facebookPageMediaError,
  instagramStoryMediaError,
  liveUrlPlaceholder,
  platformAccountKind,
  platformBadge,
  platformFormats,
  platformLabel,
  parseFacebookPageSelection,
  parseInstagramFacebookSelection,
  parseMetaMessagingSelection,
  parseProviderGrantViews,
} from "./platform-ui";

describe("publishing platform UI contract", () => {
  it("names Facebook as a Page everywhere", () => {
    expect(platformLabel("facebook")).toBe("Facebook Page");
    expect(platformAccountKind("facebook")).toBe("Page");
    expect(platformBadge("facebook")).toBe("FB");
    expect(liveUrlPlaceholder("facebook")).toContain("facebook.com");
    expect(externalPostIdPlaceholder("facebook")).toContain("_");
  });

  it("exposes only text and single-image formats for Facebook Pages", () => {
    expect(platformFormats("facebook")).toEqual(["text", "image"]);
    expect(defaultPlatformFormat("facebook")).toBe("text");
    expect(facebookPageMediaError("text", [])).toBeNull();
    expect(facebookPageMediaError("image", ["image"])).toBeNull();
    expect(facebookPageMediaError("text", ["image"])).toContain("cannot include media");
    expect(facebookPageMediaError("image", [])).toContain("exactly one");
    expect(facebookPageMediaError("image", ["video"])).toContain("exactly one");
    expect(facebookPageMediaError("carousel", ["image", "image"])).toContain("text posts and single-image posts only");
  });

  it("exposes Instagram Stories and requires one checked image or video", () => {
    expect(platformFormats("instagram")).toEqual(["image", "carousel", "reel", "story"]);
    expect(instagramStoryMediaError("image", [])).toBeNull();
    expect(instagramStoryMediaError("story", [])).toContain("exactly one");
    expect(instagramStoryMediaError("story", [{ kind: "image", inspectionStatus: "ready" }])).toBeNull();
    expect(instagramStoryMediaError("story", [{ kind: "video", inspectionStatus: "ready" }])).toBeNull();
    expect(instagramStoryMediaError("story", [{ kind: "image", inspectionStatus: "pending" }])).toContain("finish its Library check");
    expect(instagramStoryMediaError("story", [{ kind: "image", inspectionStatus: "ready" }, { kind: "video", inspectionStatus: "ready" }])).toContain("exactly one");
  });

  it("does not mislabel an unknown platform as Facebook or YouTube", () => {
    expect(platformLabel("new-network")).toBe("Unknown platform");
    expect(platformBadge("new-network")).toBe("—");
  });

  it("does not call a blocked test account healthy", () => {
    expect(connectedAccountStatusPresentation("healthy", "blocked")).toEqual({ label: "Action needed", className: "setup_required" });
    expect(connectedAccountStatusPresentation("healthy", "warning")).toEqual({ label: "Review needed", className: "expiring" });
    expect(connectedAccountStatusPresentation("healthy", "healthy")).toEqual({ label: "healthy", className: "healthy" });
    expect(connectedAccountStatusPresentation("disconnected", "blocked")).toEqual({ label: "Disconnected", className: "disconnected" });
  });

  it("keeps only sanitized Page identity fields from a selection response", () => {
    const selection = parseFacebookPageSelection({
      selectionId: "selection-1",
      expiresAt: "2026-08-29T12:00:00.000Z",
      pages: [{ externalAccountId: "page-1", displayName: "Main Page", accessToken: "must-not-render", nested: { token: "secret" } }],
      accessToken: "also-secret",
    }, "fallback");
    expect(selection).toEqual({ selectionId: "selection-1", expiresAt: "2026-08-29T12:00:00.000Z", pages: [{ externalAccountId: "page-1", displayName: "Main Page" }] });
    expect(JSON.stringify(selection)).not.toContain("secret");
    expect(JSON.stringify(selection)).not.toContain("token");
  });

  it("keeps only safe Meta private-message account identity fields", () => {
    const selection = parseMetaMessagingSelection({
      selectionId: "selection-private-1",
      expiresAt: "2026-09-07T12:00:00.000Z",
      candidates: [{
        targetKey: "instagram_linked_page:ig-1",
        connectionMode: "instagram_linked_page",
        externalBusinessAccountId: "ig-1",
        displayName: "@originpost",
        pageName: "OriginPost Page",
        username: "originpost",
        accountId: "account-1",
        accessToken: "must-not-render",
        endpointPageId: "page-1",
      }, { connectionMode: "unsupported", accessToken: "also-secret" }],
      accessToken: "outer-secret",
    }, "fallback");
    expect(selection).toEqual({
      selectionId: "selection-private-1",
      expiresAt: "2026-09-07T12:00:00.000Z",
      candidates: [{
        targetKey: "instagram_linked_page:ig-1",
        connectionMode: "instagram_linked_page",
        externalBusinessAccountId: "ig-1",
        displayName: "@originpost",
        pageName: "OriginPost Page",
        username: "originpost",
        accountId: "account-1",
      }],
    });
    expect(JSON.stringify(selection)).not.toContain("secret");
    expect(JSON.stringify(selection)).not.toContain("token");
    expect(JSON.stringify(selection)).not.toContain("endpointPageId");
  });

  it("sanitizes Facebook-Login Instagram selection and provider-grant views", () => {
    const selection = parseInstagramFacebookSelection({ selectionId: "selection-ig", expiresAt: "2026-09-07T12:00:00.000Z", accounts: [{ externalAccountId: "ig-1", username: "originpost", displayName: "OriginPost", pageId: "page-1", pageName: "OriginPost Page", accessToken: "secret" }] }, "fallback");
    expect(selection.accounts).toEqual([{ externalAccountId: "ig-1", username: "originpost", displayName: "OriginPost", pageId: "page-1", pageName: "OriginPost Page" }]);
    const grants = parseProviderGrantViews([{ id: "grant-1", provider: "meta", authorizationKind: "facebook_login", status: "active", scopes: ["pages_show_list", 123], version: 2, accountIds: ["account-1"], updatedAt: "2026-09-07T12:00:00.000Z", subjectLookupHmac: "must-not-render", clientId: "must-not-render" }]);
    expect(grants).toEqual([{ id: "grant-1", provider: "meta", authorizationKind: "facebook_login", status: "active", scopes: ["pages_show_list"], version: 2, accountIds: ["account-1"], updatedAt: "2026-09-07T12:00:00.000Z" }]);
    expect(JSON.stringify({ selection, grants })).not.toContain("secret");
    expect(JSON.stringify(grants)).not.toContain("subjectLookupHmac");
    expect(JSON.stringify(grants)).not.toContain("clientId");
  });
});
