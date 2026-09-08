# OriginPost Board approvals (Hermes dashboard backend plugin)

This is a hidden, version-pinned Hermes 0.21 dashboard backend extension. It adds no Hermes tab and is not an OriginPost catalog plugin. OriginPost calls it only from the built-in Hermes panel inside a Board.

Install only after upgrading the Hermes runtime to exactly `0.21.0`:

```sh
mkdir -p ~/.hermes/plugins/originpost-board-approvals
cp -R integrations/hermes/originpost-board-approvals/dashboard ~/.hermes/plugins/originpost-board-approvals/
```

Restart `hermes dashboard`. The normal Hermes dashboard authentication protects routes below `/api/plugins/originpost-board-approvals/`. Keep the dashboard bound to a trusted private interface.

The extension accepts only OriginPost profile handles, selects the profile through Hermes' context-local home override, lists bounded metadata, requires an exact record SHA-256 plus an idempotency key for one-record decisions, and never offers an `approve all` operation. It deliberately fails closed on any Hermes version other than `0.21.0`.
