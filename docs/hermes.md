# Hermes Agent integration

OriginPost connects to Hermes through Hermes Agent's official OpenAI-compatible API server. Hermes remains a separate process and keeps its own skills, memory, gateway, and messaging channels.

## Hermes setup

```bash
hermes gateway setup
hermes gateway start
```

Enable the API server in Hermes and set:

```env
HERMES_API_URL=http://127.0.0.1:8642
HERMES_API_KEY=replace-with-your-api-server-key
HERMES_MODEL=hermes-agent
AGENT_MODE=hermes
```

OriginPost calls Hermes through `/v1/responses`. Each Content Item gets a workspace-scoped conversation name, so follow-up research stays connected without mixing workspaces.

The sourcing worker asks Hermes to use its web search and extraction tools, prefer primary sources, check dates, and cross-check important claims. OriginPost then stores:

- the direct source URL, publisher, date, excerpt, and confidence;
- each checked claim and the source IDs that support it;
- the Hermes provider, model, response ID, and tools used;
- queued, running, completed, or failed state in the audit history.

Start with `AGENT_MODE=mock`. The mock provider never performs live research and uses `example.invalid` links, which makes local tests safe and repeatable.

OriginPost never stores Telegram bot secrets in source code. The optional Telegram adapter calls the same NestJS API commands as the web app, so source, approval, and proof rules stay the same. Hermes remains the replaceable research and caption provider behind those commands.

Reference: [Hermes Agent](https://github.com/NousResearch/hermes-agent) and its [API server documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server).
