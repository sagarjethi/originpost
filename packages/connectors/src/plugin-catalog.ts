import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pluginManifestSchema } from "./plugin-schema.js";
import type { OriginPostPluginManifest } from "./types.js";

export interface PluginCatalogEntry extends OriginPostPluginManifest {
  status: "available";
}

export interface RejectedPluginManifest {
  directory: string;
  code: "invalid_manifest" | "manifest_too_large" | "unsafe_entrypoint" | "missing_entrypoint" | "read_failed" | "reserved_internal_id";
  message: string;
}

export interface PluginCatalogSnapshot {
  configured: boolean;
  entries: PluginCatalogEntry[];
  rejected: RejectedPluginManifest[];
}

export interface PluginCatalogOptions {
  rootDir?: string | undefined;
  maxPlugins?: number | undefined;
  maxManifestBytes?: number | undefined;
}

function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function rejection(directory: string, code: RejectedPluginManifest["code"], message: string): RejectedPluginManifest {
  return { directory: basename(directory), code, message };
}

export async function discoverPluginCatalog(options: PluginCatalogOptions = {}): Promise<PluginCatalogSnapshot> {
  if (!options.rootDir) return { configured: false, entries: [], rejected: [] };
  const rootDir = resolve(options.rootDir);
  const maxPlugins = Math.min(Math.max(options.maxPlugins ?? 100, 1), 500);
  const maxManifestBytes = Math.min(Math.max(options.maxManifestBytes ?? 65_536, 1_024), 1_048_576);
  let children;
  try {
    children = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return { configured: true, entries: [], rejected: [rejection(rootDir, "read_failed", "The configured plugin directory cannot be read.")] };
  }

  const entries: PluginCatalogEntry[] = [];
  const rejected: RejectedPluginManifest[] = [];
  const directories = children.filter((child) => child.isDirectory() && !child.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, maxPlugins);
  for (const directoryEntry of directories) {
    const pluginDir = resolve(rootDir, directoryEntry.name);
    const manifestPath = resolve(pluginDir, "originpost.plugin.json");
    try {
      const manifestStat = await lstat(manifestPath);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
        rejected.push(rejection(pluginDir, "read_failed", "The plugin manifest must be a regular file."));
        continue;
      }
      if (manifestStat.size > maxManifestBytes) {
        rejected.push(rejection(pluginDir, "manifest_too_large", "The plugin manifest exceeds the configured size limit."));
        continue;
      }
      const parsedJson = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      const parsed = pluginManifestSchema.safeParse(parsedJson);
      if (!parsed.success) {
        rejected.push(rejection(pluginDir, "invalid_manifest", parsed.error.issues[0]?.message ?? "The plugin manifest is invalid."));
        continue;
      }
      if (parsed.data.id === "org.originpost.hermes-boards") {
        rejected.push(rejection(pluginDir, "reserved_internal_id", "This identifier belongs to a built-in Board module and cannot be installed globally."));
        continue;
      }
      const entrypoint = resolve(pluginDir, parsed.data.entrypoint);
      if (!inside(pluginDir, entrypoint) || dirname(entrypoint) === rootDir) {
        rejected.push(rejection(pluginDir, "unsafe_entrypoint", "The plugin entrypoint must stay inside its plugin directory."));
        continue;
      }
      const entrypointStat = await lstat(entrypoint).catch(() => null);
      if (!entrypointStat?.isFile() || entrypointStat.isSymbolicLink()) {
        rejected.push(rejection(pluginDir, "missing_entrypoint", "The declared plugin entrypoint is missing or unsafe."));
        continue;
      }
      entries.push({ ...parsed.data, status: "available" });
    } catch {
      rejected.push(rejection(pluginDir, "read_failed", "The plugin manifest could not be read."));
    }
  }
  return { configured: true, entries, rejected };
}
