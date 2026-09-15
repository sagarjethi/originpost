# Local Codex research, writing and image review

A single-owner OriginPost installation can use its signed-in Codex CLI for writing, copy review and image review. Public-web research is a separate, opt-in route. This connection does not expose image generation, shell access or publishing. The hosted/multi-user path still uses separately configured providers.

```text
OriginPost runtime settings
        ↓ encrypted local bridge token
Local bridge on this Mac
        ↓ fresh, tool-disabled Codex process
Text + supplied image pixels
        ↓ final answer and token counts
OriginPost checks → editor approval
```

## Start the connection

The reviewed executable is **Codex CLI 0.153.4**. Sign in through `codex login`, then verify with `codex login status`. This bridge refuses other versions until its tool boundary is reviewed again.

Keep a private environment file outside the repository containing:

```dotenv
ORIGINPOST_CODEX_EXECUTABLE=/absolute/path/to/codex
ORIGINPOST_CODEX_MODEL=your-tested-model-id
ORIGINPOST_CODEX_PORT=8765
ORIGINPOST_CODEX_TOKEN=a-long-random-local-bridge-token
```

Use a randomly generated token of at least 32 characters and restrict the file to its owner. This is a local transport token, not an OpenAI API key. Never copy Codex OAuth credentials into OriginPost.

Start the bridge from the repository:

```sh
node --env-file=/absolute/private/path/local-codex.env scripts/local-codex/start.mjs
```

For the host API, configure `LOCAL_CODEX_BASE_URL=http://127.0.0.1:8765/v1`. For this repository’s Docker Compose API, configure `DOCKER_LOCAL_CODEX_BASE_URL=http://host.docker.internal:8765/v1`. Restart the API after changing its environment. Keep `AGENT_ALLOW_PRIVATE_ENDPOINTS` disabled: the Local Codex preset has a separate, narrowly constrained server-owned route.

In **AI runtimes**, add **Local Codex**, enter the exact bridge model for text and vision, and save the local bridge token. Use **Test text + image input**, then assign the tested connection to the brand. The test sends a small colour sample and consumes Codex usage. It verifies image input, not editorial accuracy.

## Enable source research

Set `ORIGINPOST_CODEX_RESEARCH_ENABLED=true` in the private bridge environment and `LOCAL_CODEX_RESEARCH_ENABLED=true` in OriginPost’s environment. Restart the bridge, API and worker. The API and worker use the same server-owned route and the brand’s tested runtime credential. Research stays disabled by default. An unhealthy assigned local runtime stops the request rather than silently substituting mock research.

```text
News link or text → Codex searches public sources
                 → OriginPost separately retrieves each quoted page
                 → Matched / mismatch / unavailable source evidence
                 → Independent copy review → image review → editor approval
```

Research enables only the CLI web-search tool, requires a recorded web action and has a 180-second model timeout. A web action alone does not prove a page was read. The worker independently fetches public HTTP(S) pages through its DNS-checked transport, with a 45-second overall limit, three concurrent fetches and a 2 MiB page limit. It compares a normalized exact excerpt of at least 30 characters against page text and stores the response SHA-256, final URL and check time. Unsupported or blocked pages remain unavailable; mismatches cannot support agent-post claims. A quote match proves text presence, not the truth of every claim, independent reporting, rendered visibility or image reuse rights. The separate copy review still checks whether the claims follow from the evidence.

A failed local model request is not automatically retried by the research or monitor job. Inspect the failed run before explicitly starting another request. A later scheduled monitoring run is a new observation.

## Execution contract

The listener binds only to `127.0.0.1`, requires bearer authentication, rejects browser-origin requests, and accepts only the model configured by the server owner. It permits one completion at a time; concurrent requests are rejected without starting another model run. Request images must be inline PNG/JPEG data, never remote URLs or arbitrary filesystem paths.

Writing and vision keep web access disabled; research alone permits web-search events. Each completion uses a private temporary directory, ephemeral execution, ignored user configuration, read-only sandboxing and explicitly disabled shell, browser, plugin, app, multi-agent and generation tools. The pinned runtime’s `skip_host_skill_discovery` flag is still under development; its exact startup notice is recognized, while unexpected errors and tool events reject the result. Temporary inputs are removed after success, failure, cancellation or timeout. Normal shutdown cancels the active child; a process/OS crash can still leave an uncertain result, so OriginPost must not retry paid work blindly.

Prompt text travels through stdin. The bridge does not save prompts, image bytes, diagnostic output or final answers to disk. It returns the final text, CLI session-derived receipt ID and reported token counts. UTF-8 output is assembled before decoding, preserving Gujarati characters across chunks. The 100-second writing/vision limit, 180-second research limit and bounded inputs/outputs are enforced; Chat Completions temperature and token-limit fields are not exact CLI sampling/budget controls.

This uses the local owner’s Codex account. Sessions-based multi-user OriginPost deployments reject this preset. Do not publish the bridge port or reuse a personal login as a public service. A shared deployment needs separate user credentials and isolation rather than this local connection.

## Verification

Run `pnpm test:local-codex`. Coverage includes authentication, browser-origin rejection, concurrency, unsupported request types, unexpected tool/error events, timeout cleanup and Gujarati output split across byte chunks. API tests cover server-owned routing and rejection of shared-account use. PostgreSQL tests cover profile persistence.

Live checks on 15 September 2026 read a three-colour PNG correctly and returned `UNAVAILABLE` when asked to read a private canary file. These checks do not establish full newsroom accuracy or image-generation output support. The integration follows the official [non-interactive CLI guide](https://learn.chatgpt.com/docs/non-interactive-mode) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

### Product acceptance on this development installation

The Docker API successfully tested the bridge through `host.docker.internal`, saved the Local Codex profile encrypted, and assigned it to the active brand. Its normal vision probe passed. A subsequent private Gujarati draft request through the content API succeeded with `gpt-6-astra`, recorded 9,716 input and 50 output tokens in the usage ledger, and created zero approvals or publishing targets. The draft is labelled as a private software test, not a news report. Both host and Docker API capability responses now report writing and image review configured. Image generation remains a separate part of the workflow. The opt-in research path is covered by bridge, source-excerpt, runtime-selection and receipt-binding tests; live acceptance is recorded separately after deployment.


A live research request through the Docker API and worker also passed on 15 September 2026. Codex opened NASA’s official RSS directory; the worker independently fetched it, matched a short exact quote, and stored the body hash and final URL. Reading the item back from PostgreSQL preserved its original zero-confidence lead and a new matched receipt for the same URL. The supported claim referenced the new source, and the saved item passed the Codex research gate. No publication date was invented, and approvals and publishing targets remained zero. This verifies the research connection and evidence persistence; it does not establish broad source coverage, image accuracy or a successful social publication. A worker/API encryption-key format mismatch found during this check was fixed and covered for both hex and base64 keys.
