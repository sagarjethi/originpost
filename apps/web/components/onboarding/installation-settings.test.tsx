import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InstallationSettings, canShowInstallation, installationPatch, appSetupStatus, type InstallationView } from "./installation-settings";
import type { AuthView } from "../../lib/api-client";

const auth = (role: "owner" | "creator", workspaceId = "workspace"): AuthView => ({ mode: "sessions", user: { id: "user", email: "owner@example.test", displayName: "Owner" }, memberships: [{ workspaceId, workspaceSlug: workspaceId, workspaceName: "Workspace", userId: "user", role }] });
describe("installation setup access and credentials", () => {
  it("does not confuse a saved app with an active app or connected account", () => {
    const view: InstallationView = { version: 1, restartRequired: true, values: {}, secrets: { META_APP_SECRET: true }, activeValues: {}, activeSecrets: {}, checks: { sessions: true, encryption: true, networkRestricted: false }, callbacks: { instagram: "", facebook: "", instagramFacebook: "", youtube: "" } };
    expect(appSetupStatus(view, "Instagram & Facebook")).toBe("Saved · activation pending");
    expect(appSetupStatus({ ...view, restartRequired: false }, "Instagram & Facebook")).toBe("App setup needed");
    expect(appSetupStatus({ ...view, restartRequired: false, activeSecrets: { META_APP_SECRET: true } }, "Instagram & Facebook")).toBe("App settings active");
    expect(appSetupStatus({ ...view, restartRequired: false, activeSecrets: { OPENAI_IMAGE_API_KEY: true } }, "Images")).toBe("Image generation off");
    expect(appSetupStatus({ ...view, restartRequired: false, activeValues: { IMAGE_GENERATION_MODE: "openai" }, activeSecrets: { OPENAI_IMAGE_API_KEY: true } }, "Images")).toBe("App settings active");
  });
  it("does not borrow ownership from another workspace", () => {
    expect(canShowInstallation(auth("owner", "other"), "workspace")).toBe(false);
    expect(canShowInstallation(auth("owner"), "workspace")).toBe(true);
    const html = renderToStaticMarkup(<InstallationSettings auth={auth("creator")} workspaceId="workspace" />);
    expect(html).toContain("Only the installation owner");
    expect(html).not.toContain("Installation steps");
    expect(html).not.toContain("type=\"password\"");
  });
  it("shows owners a loading state without claiming configuration succeeded", () => {
    const html = renderToStaticMarkup(<InstallationSettings auth={auth("owner")} workspaceId="workspace" />);
    expect(html).toContain("Installation steps");
    expect(html).toContain("Loading installation");
    expect(html).not.toContain("Settings saved");
    expect(html).not.toContain("owner@example.test");
  });
  it("omits empty write-only credentials while preserving deliberate nonsecret settings", () => {
    const form = new FormData();
    form.set("META_APP_SECRET", "");
    form.set("OPENAI_IMAGE_API_KEY", "   ");
    form.set("META_WEBHOOK_VERIFY_TOKEN", "");
    form.set("META_APP_ID", "app-fixture");
    form.set("ALLOW_LIVE_PUBLISH", "false");
    expect(installationPatch(form)).toEqual({ META_APP_ID: "app-fixture", ALLOW_LIVE_PUBLISH: "false" });
  });
});
