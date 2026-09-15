# Local Codex writing and image review

A single-owner OriginPost installation can use its signed-in Codex CLI for writing, copy review and image review. This connection does not expose research, image generation, shell access or publishing. The hosted/multi-user path still uses separately configured providers.

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

## Execution contract

The listener binds only to `127.0.0.1`, requires bearer authentication, rejects browser-origin requests, and accepts only the model configured by the server owner. It permits one completion at a time; concurrent requests are rejected without starting another model run. Request images must be inline PNG/JPEG data, never remote URLs or arbitrary filesystem paths.

Each completion uses a private temporary directory, ephemeral execution, ignored user configuration, read-only sandboxing and explicitly disabled shell, browser, plugin, app, multi-agent and generation tools. The pinned runtime’s `skip_host_skill_discovery` flag is still under development; its exact startup notice is recognized, while unexpected errors and tool events reject the result. Temporary inputs are removed after success, failure, cancellation or timeout. Normal shutdown cancels the active child; a process/OS crash can still leave an uncertain result, so OriginPost must not retry paid work blindly.

Prompt text travels through stdin. The bridge does not save prompts, image bytes, diagnostic output or final answers to disk. It returns the final text, CLI session-derived receipt ID and reported token counts. UTF-8 output is assembled before decoding, preserving Gujarati characters across chunks. The 100-second process limit and bounded inputs/outputs are enforced; Chat Completions temperature and token-limit fields are not exact CLI sampling/budget controls.

This uses the local owner’s Codex account. Sessions-based multi-user OriginPost deployments reject this preset. Do not publish the bridge port or reuse a personal login as a public service. A shared deployment needs separate user credentials and isolation rather than this local connection.

## Verification

Run `pnpm test:local-codex`. Coverage includes authentication, browser-origin rejection, concurrency, unsupported request types, unexpected tool/error events, timeout cleanup and Gujarati output split across byte chunks. API tests cover server-owned routing and rejection of shared-account use. PostgreSQL tests cover profile persistence.

Live checks on 15 September 2026 read a three-colour PNG correctly and returned `UNAVAILABLE` when asked to read a private canary file. These checks do not establish full newsroom accuracy or image-generation output support. The integration follows the official [non-interactive CLI guide](https://learn.chatgpt.com/docs/non-interactive-mode) and [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

### Product acceptance on this development installation

The Docker API successfully tested the bridge through `host.docker.internal`, saved the Local Codex profile encrypted, and assigned it to the active brand. Its normal vision probe passed. A subsequent private Gujarati draft request through the content API succeeded with `gpt-6-astra`, recorded 9,716 input and 50 output tokens in the usage ledger, and created zero approvals or publishing targets. The draft is labelled as a private software test, not a news report. Both host and Docker API capability responses now report writing and image review configured. Live source research and image generation remain separate, unconfigured parts of the news-post workflow.
