# Workspace AI runtimes

OriginPost can use a workspace-controlled OpenAI-compatible text provider for first-draft assistance. This module is separate from sourced research: Hermes remains the research provider and keeps source links, claims, dates, and research history. Image and video generation also remain separate modules.

## Owner workflow

Open **Agent plugins → Workspace AI Runtime**.

1. Add OpenAI, OpenRouter, Ollama, or a custom OpenAI-compatible endpoint.
2. Save the exact text-model identifier and, when required, a provider key.
3. Run **Test**. OriginPost calls the provider's `/models` endpoint and fails when the chosen model is not available.
4. Assign a healthy runtime to the active brand.
5. In Content Studio, choose platform, format, language, and an optional direction, then select **Create AI revision**.

Every generated draft is a new immutable revision. It still requires normal source checking, human review, exact-revision approval, and scheduling.

An owner may choose **Use server default**. This removes the brand assignment. Hermes is used only when it is configured and the brand has no runtime assignment. When an assigned runtime fails, OriginPost records the failure and returns an action message; it never silently switches models or sends the prompt to another provider.

## Secret and data handling

- Provider keys use AES-256-GCM with workspace/profile additional authenticated data and the deployment's `CREDENTIAL_ENCRYPTION_KEY`.
- The browser receives only `credentialConfigured: true|false`; it never receives the encrypted envelope or clear key.
- Keys are sent only in the `Authorization: Bearer` header. They are never placed in provider URLs, audits, logs, or run records.
- The run ledger stores the profile, brand, model, outcome, request/response SHA-256 digests, available token counts, latency, and a bounded safe error code.
- Prompt text, response text, provider keys, and raw provider bodies are not stored in the run ledger.
- API responses are bounded to 1 MiB, redirects are rejected, and requests have timeouts.

## Endpoint safety

OpenAI and OpenRouter always use their server-defined public base URLs. The browser cannot replace them.

Ollama and custom endpoints must be absolute HTTP(S) base URLs without embedded credentials, query text, or fragments. Private, loopback, link-local, and private-DNS destinations are blocked by default to prevent server-side request forgery.

To intentionally use Ollama, LM Studio, vLLM, or another trusted private service, the deployment owner must set:

```env
AGENT_ALLOW_PRIVATE_ENDPOINTS=true
```

This is a broad server trust decision. Do not enable it for a public multi-tenant deployment unless network egress is separately restricted. In Docker Desktop, an Ollama-compatible base URL commonly uses `http://host.docker.internal:11434/v1`; a native local API can normally use `http://127.0.0.1:11434/v1`.

Production HTTP endpoints remain blocked unless this explicit private-endpoint gate is enabled. Hosted custom providers should use HTTPS.

## Routes

- `GET /v1/agent-runtimes?workspaceId=&brandId=`
- `POST /v1/agent-runtimes`
- `PATCH /v1/agent-runtimes/:id` with `If-Match`
- `DELETE /v1/agent-runtimes/:id` with `If-Match`
- `POST /v1/agent-runtimes/:id/test`
- `POST /v1/agent-runtimes/:id/assign`
- `DELETE /v1/agent-runtimes/assignments/:brandId`
- `GET /v1/agent-runtimes/:id/runs`

Profiles with usage history cannot be deleted because their identifier anchors the immutable run ledger. Disable them instead. An unused profile can still be deleted, which also removes its encrypted credential.
- `POST /v1/content-items/:id/agent-draft` with the current Content Item version in `If-Match`

Only a human workspace owner can add, change, test, assign, unassign, disable, enable, or remove a runtime. Workspace members with content-edit permission may use the brand's current assignment to create a draft revision.

## Release gates

- Set a unique 32-byte `CREDENTIAL_ENCRYPTION_KEY` and keep it in the deployment secret manager.
- Keep `AGENT_ALLOW_PRIVATE_ENDPOINTS=false` unless private egress is intentionally required.
- Verify the exact model and endpoint with **Test** before assignment.
- Review provider retention/training terms before sending editorial material.
- Treat model output as an unapproved draft. Source verification and human approval remain mandatory.
- Monitor failed runs, latency, and token usage from the ledger; do not add an automatic provider fallback without a new explicit policy and approval flow.
