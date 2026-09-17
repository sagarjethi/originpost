# OriginPost project overview

OriginPost is a self-hosted workspace for creators, publishers, and social teams. It keeps sources, drafts, media, review decisions, schedules, and publishing results together. Brand identity and provider choices are configurable.

## Main areas

| Area | What it does |
| --- | --- |
| Home | Shows the queue and work needing attention. |
| Agent / Content | Researches sources, prepares drafts, and records revisions for review. |
| Boards | Organizes projects and team tasks. |
| Creative Studio / Library / Audio | Creates visuals, stores media, and prepares narration with configured providers. |
| Channels / Calendar | Connects brand accounts and schedules approved posts. |
| Proof / Analytics / Engagement | Keeps publication records and supports connected-account metrics and interactions where configured. |
| Organizations / Developer API | Manages workspace access and external integrations. |

## Typical workflow

1. Choose a workspace and brand; configure its identity and providers.
2. Bring a link, text, or source lead into the project.
3. Verify sources and create a draft using your template.
4. Review facts, media rights, image text, and the exact final version.
5. Choose a connected account, approve, and publish or schedule.
6. Keep the result and source evidence with the content.

## System and ownership

Next.js supplies the interface, NestJS serves the API, and a background worker handles queued work. PostgreSQL stores records, Redis supports queues, and S3-compatible storage holds private media. See [architecture](architecture.md).

The operator manages deployment, access, encryption keys, and backups. External AI and social services receive data only as needed for their configured operations. Publisher-specific names, logos, handles, and source lists belong in workspace data.

## Current limits

This is an alpha. Local mock connections let you explore without live social credentials. Live publishing and provider features need their own keys, permissions, and validation; a successful build does not establish those connections.

## Start here

- [Quick installation, keys, social setup, and production requirements](../README.md)
- [Local developer commands](local-developer-setup.md)
- [Full feature and configuration reference](technical-overview.md)
- [Account connections](channels.md) and [agent/templates](agent-chat-ui.md)
- [Production checks](public-release.md) and [backup/restore](disaster-recovery.md)
- [Project-wide agent instructions](../CLAUDE.md)
