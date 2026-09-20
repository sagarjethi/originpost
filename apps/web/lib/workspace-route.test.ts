import { describe, expect, it } from "vitest";
import { resolveWorkspaceLocation, workspaceHref, workspacePageSlugs, workspaceRouteForPath, workspaceRoutes } from "./workspace-route";

describe("workspace routes", () => {
  it("gives every workspace page one unique, human-readable path", () => {
    expect(new Set(workspaceRoutes.map((route) => route.path)).size).toBe(workspaceRoutes.length);
    expect(workspaceRouteForPath("/boards/")?.nav).toBe("Boards");
    expect(workspaceRouteForPath("/calendar")?.nav).toBe("Calendar");
    expect(workspacePageSlugs).toContain("creative-studio");
    expect(workspacePageSlugs).toContain("agent");
    expect(workspacePageSlugs).toContain("setup");
    expect(resolveWorkspaceLocation("/setup", "").route.nav).toBe("Setup");
    expect(resolveWorkspaceLocation("/agent", "?conversation=local-123").route.nav).toBe("Agent");
  });

  it("restores page, content filter, and selected item from a refreshed URL", () => {
    expect(resolveWorkspaceLocation("/boards", "")).toMatchObject({ route: { nav: "Boards", module: "boards" }, legacy: false });
    expect(resolveWorkspaceLocation("/calendar", "").filter).toBe("scheduled");
    expect(resolveWorkspaceLocation("/content", "?filter=review&item=content_123")).toMatchObject({ route: { nav: "Content" }, filter: "review", itemId: "content_123" });
  });

  it("keeps old query links working while identifying them for canonical replacement", () => {
    expect(resolveWorkspaceLocation("/", "?module=library")).toMatchObject({ route: { nav: "Library", path: "/library" }, legacy: true });
    expect(resolveWorkspaceLocation("/", "?item=content_123")).toMatchObject({ route: { nav: "Content", path: "/content" }, itemId: "content_123", legacy: true });
    expect(resolveWorkspaceLocation("/", "?channel=connected")).toMatchObject({ route: { nav: "Channels", path: "/channels" }, legacy: true });
  });

  it("builds canonical links without leaking unrelated page state", () => {
    expect(workspaceHref("Boards")).toBe("/boards");
    expect(workspaceHref("Content", { filter: "review", itemId: "content one" })).toBe("/content?filter=review&item=content+one");
    expect(workspaceHref("Creative Studio", { itemId: "content_123" })).toBe("/creative-studio?item=content_123");
  });
});
