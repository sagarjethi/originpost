import { z } from "zod";

const relativeEntrypoint = z.string().min(1).max(240).refine((value) => {
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  return !value.split(/[\\/]+/).some((part) => part === ".." || part === "");
}, "entrypoint must be a relative path inside the plugin directory");

const httpsOrigin = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
}, "network allowlist entries must be HTTPS origins without paths, credentials, queries, or fragments");

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal("1"),
  id: z.string().regex(/^[a-z][a-z0-9.-]+$/),
  name: z.string().min(1).max(80),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i),
  description: z.string().min(1).max(300),
  entrypoint: relativeEntrypoint,
  compatibility: z.object({ originpost: z.string().min(1) }),
  permissions: z.array(z.enum([
    "content:read",
    "content:write",
    "media:read",
    "media:write",
    "network:outbound",
    "publish:request",
    "analytics:read",
    "engagement:read",
    "engagement:reply",
  ])),
  networkAllowlist: z.array(httpsOrigin).max(50).default([]),
  settingsSchema: z.record(z.string(), z.unknown()).default({}),
}).superRefine((manifest, context) => {
  if (!manifest.permissions.includes("network:outbound") && manifest.networkAllowlist.length > 0) {
    context.addIssue({ code: "custom", path: ["networkAllowlist"], message: "network allowlist requires the network:outbound permission" });
  }
});
