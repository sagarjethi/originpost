# OriginPost

**Turn a news story into a reviewed social post—with the sources kept alongside it.**

OriginPost is a shared workspace for publishers, creators, and social-media teams. Collect news, check it, write a caption, create a branded image, and review the post before publishing.

![Six steps: find a story, check sources, create the post, review together, publish, and keep proof](docs/images/source-to-post.svg)

## How you use it

1. **Bring a story.** Paste a news link or text in Agent, or collect updates from your chosen news feeds.
2. **Check what is true.** Open the original sources. Confirm names, dates, numbers, and important claims. A feed headline is a lead, not a verified fact.
3. **Make it yours.** Choose your project's template, original logo, writing style, colours, and example images.
4. **Review the result.** Read the caption and text inside the image. Check image rights, authenticity, and any AI disclosure. Ask for changes in the same project chat.
5. **Publish and keep the receipt.** Use a connected Instagram, Facebook Page, or YouTube account. The final draft must pass review and the platform's checks. YouTube requires a video.

## Your daily news desk

Create sections such as **Gujarat, India, World, Business, or Science**, then add publisher-provided RSS/Atom feeds. Choose checks every 10 minutes, 30 minutes, 2 hours, or daily.

- **Newest published:** sort by the publication time reported by the source.
- **Newly found:** see what OriginPost discovered most recently.
- **Recent news:** filter to the last 2 hours, 24 hours, or 7 days.
- **Your sections:** filter by a saved source collection and search headlines or publishers.

Unknown dates stay visibly unknown. Repeated checks do not make an old story look newly published. The collector reads your configured feeds; it cannot promise every story from every website. Source failures and monitor history are available in Automations.

**Sourcing matters twice:** verify the report before writing, then compare the final text and image against that evidence before release. A second publisher repeating the same wire report is not independent corroboration. A publicly visible image is not automatically available to reuse.

[How sourcing works](docs/source-signal-desk.md) · [Checked source catalog and critical verification rules](docs/research/2026-09-15-news-source-catalog.md)

## Set up your brand once

![Illustrative template showing original logo, visual, headline, source credit, and social handle](docs/images/template-guide.svg)

Templates keep logo placement, image references, writing skills, colours, and footer text together. The original logo is placed after image generation. Example captions and similar-post images guide style; they do not supply verified facts.

Each new version stays in the project chat, so you can compare the changes. Boards organize projects and team tasks.

![OriginPost desktop admin dashboard](docs/images/admin-desktop.jpg)

Desktop capture of the local owner account. The displayed queue contains local testing records.

[Agent and template guide](docs/agent-chat-ui.md) · [Boards and team work](docs/boards.md)

## Can I use images made in Codex?

**Yes, Codex supports interactive image creation and image references.** OriginPost also has a server image-generation connection. They are separate execution paths.

You can use a Codex-created file through the existing Library and Creative Studio workflow, keeping its provenance and AI disclosure. A direct Codex-to-OriginPost chat handoff that automatically continues a template run is still being developed; tagging Codex alone does not currently publish a post. The final post still needs a connected account and review.

[Verified Codex capabilities and integration plan](docs/research/2026-09-15-codex-image-workflow.md)

## What needs connecting?

| To do this | Set up this |
| --- | --- |
| Collect news automatically | Your feed URLs and the background worker |
| Research and write with an agent | A tested text/research runtime |
| Generate new images | The server image provider, or a Codex-created file |
| Publish to social media | The relevant social account and publishing permissions |
| Work with a team | Team sign-in and workspace invitations |

This is an **alpha**. Local test connections are simulations and are labeled as such. A successful code build does not mean live accounts or providers are connected.

## Run it locally

For the person setting up the software: install Node.js 22+, pnpm 10+, and Docker, then run:

```bash
cp .env.example .env
docker compose up -d postgres redis minio
pnpm install
pnpm db:migrate
pnpm dev
```

Open [localhost:3000](http://localhost:3000). Keep `.env` private. Default local mode is for a trusted machine; use the deployment guide before making the service public.

[Full setup and feature reference](docs/technical-overview.md) · [Connect social accounts](docs/channels.md) · [Deployment and release](docs/public-release.md) · [Architecture](docs/architecture.md)

## License

OriginPost is open source under [AGPL-3.0-only](LICENSE).
