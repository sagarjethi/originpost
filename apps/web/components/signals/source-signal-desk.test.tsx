import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceSignalDesk } from "./source-signal-desk";

const user = { id: "test-user", email: "test@example.test", displayName: "Test editor" };
const membership = (workspaceId: string, role: "owner" | "manager" | "creator") => ({ workspaceId, workspaceName: workspaceId, workspaceSlug: workspaceId, userId: user.id, role });

it("offers source management without provider administration to managers", () => {
  const auth = { mode: "sessions" as const, user, memberships: [membership("news", "manager")] };
  const html = renderToStaticMarkup(<SourceSignalDesk auth={auth} workspaceId="news" brandId="gujarat" brandName="Gujarat News" />);
  expect(html).toContain("Add news sources");
  expect(html).toContain("Luma Mumbai events");
  expect(html).not.toContain('href="/setup');
});

it("does not reuse another workspace owner role for source or provider management", () => {
  const auth = { mode: "sessions" as const, user, memberships: [membership("other", "owner"), membership("news", "creator")] };
  const html = renderToStaticMarkup(<SourceSignalDesk auth={auth} workspaceId="news" brandId="gujarat" brandName="Gujarat News" />);
  expect(html).toContain("Gujarat News");
  expect(html).not.toContain("Add news sources");
  expect(html).not.toContain("Luma Mumbai events");
  expect(html).not.toContain('href="/setup');
});
