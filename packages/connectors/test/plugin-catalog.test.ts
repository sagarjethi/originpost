import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverPluginCatalog, pluginManifestSchema } from "../src/index.js";

const temporaryRoots: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "originpost-plugin-catalog-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const validManifest = {
  schemaVersion: "1",
  id: "org.originpost.example",
  name: "Example plugin",
  version: "1.2.3",
  description: "A safe catalog fixture.",
  entrypoint: "index.js",
  compatibility: { originpost: ">=0.1.0" },
  permissions: ["content:read", "network:outbound"],
  networkAllowlist: ["https://example.com"],
  settingsSchema: { type: "object" },
};

describe("plugin manifest", () => {
  it("accepts engagement permissions and strict HTTPS origins", () => {
    expect(pluginManifestSchema.parse({ ...validManifest, permissions: ["engagement:read", "engagement:reply", "network:outbound"] })).toMatchObject({ id: validManifest.id });
  });

  it("rejects traversal and network access that was not granted", () => {
    expect(pluginManifestSchema.safeParse({ ...validManifest, entrypoint: "../outside.js" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...validManifest, permissions: ["content:read"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...validManifest, networkAllowlist: ["https://example.com/path"] }).success).toBe(false);
  });
});

describe("plugin catalog", () => {
  it("returns sanitized validated metadata without loading plugin code", async () => {
    const root = await temporaryRoot();
    const plugin = join(root, "example");
    await mkdir(plugin);
    await writeFile(join(plugin, "originpost.plugin.json"), JSON.stringify(validManifest));
    await writeFile(join(plugin, "index.js"), "throw new Error('must never execute');");
    await expect(discoverPluginCatalog({ rootDir: root })).resolves.toEqual({ configured: true, entries: [{ ...validManifest, status: "available" }], rejected: [] });
  });

  it("rejects missing and symbolic-link entrypoints", async () => {
    const root = await temporaryRoot();
    const missing = join(root, "missing");
    await mkdir(missing);
    await writeFile(join(missing, "originpost.plugin.json"), JSON.stringify(validManifest));
    const linked = join(root, "linked");
    await mkdir(linked);
    await writeFile(join(linked, "originpost.plugin.json"), JSON.stringify(validManifest));
    await writeFile(join(root, "outside.js"), "export default {};");
    await symlink(join(root, "outside.js"), join(linked, "index.js"));
    const result = await discoverPluginCatalog({ rootDir: root });
    expect(result.entries).toEqual([]);
    expect(result.rejected.map((entry) => entry.code)).toEqual(["missing_entrypoint", "missing_entrypoint"]);
    expect(result.rejected.every((entry) => !entry.message.includes(root))).toBe(true);
  });

  it("fails closed when no plugin directory is configured", async () => {
    await expect(discoverPluginCatalog()).resolves.toEqual({ configured: false, entries: [], rejected: [] });
  });

  it("reserves the built-in Hermes Board module from the global catalog", async () => {
    const root = await temporaryRoot();
    const plugin = join(root, "pretend-hermes");
    await mkdir(plugin);
    await writeFile(join(plugin, "originpost.plugin.json"), JSON.stringify({ ...validManifest, id: "org.originpost.hermes-boards" }));
    await writeFile(join(plugin, "index.js"), "export default {};");
    await expect(discoverPluginCatalog({ rootDir: root })).resolves.toMatchObject({ entries: [], rejected: [{ directory: "pretend-hermes", code: "reserved_internal_id" }] });
  });
});
