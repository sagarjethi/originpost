# Plugins and services

OriginPost plugins are explicit, permissioned modules. A plugin cannot silently gain access to content, media, publishing, analytics, or the network.

This document describes the discovery-only third-party catalog. The compiled first-party `org.originpost.hermes-boards` module is governed by the Board lifecycle and appears only inside a Board; it is not a catalog entry and cannot be installed or enabled from the **Agent plugins** screen. See [Boards](boards.md).

Each plugin declares:

- a stable ID and semantic version;
- its OriginPost compatibility range;
- a single entrypoint;
- requested permissions;
- permitted outbound hosts;
- a settings schema.

Installation flow:

1. Validate the manifest.
2. Verify the package signature when signed distribution is available.
3. Show the requested permissions to an Owner.
4. Install disabled.
5. Run a health check in isolation.
6. Let an Owner enable it for selected workspaces.
7. Record every action in the audit log.

The example manifest is at `plugins/example-signal-monitor/originpost.plugin.json`.

## Safe local catalog

Set `PLUGIN_DIRECTORY` to a server-owned directory. Each direct child folder may contain one `originpost.plugin.json` and its declared entrypoint. The catalog accepts only a bounded versioned manifest, a relative entrypoint that remains inside the plugin folder, declared permissions, and exact HTTPS network origins. Manifest and entrypoint symbolic links are rejected.

`GET /v1/plugins/catalog` returns sanitized metadata for the **Agent plugins** screen. Invalid bundles remain disabled, and the browser receives only a rejection count and safe reason—not an absolute server path. Discovery reads the manifest and checks that the entrypoint is a regular file; it never imports or executes that file.

A catalog entry marked `available` means only that the manifest passed these structural checks. It does not mean the plugin is trusted or enabled. Runtime isolation, signed packages, per-workspace grants, protected settings, resource limits, and an execution ledger must land before an install or enable command is added.
