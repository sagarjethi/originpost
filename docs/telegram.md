# Telegram command adapter

The Telegram adapter is an optional self-hosted process. It is a thin control surface over the OriginPost API, not a separate content workflow.

## Safety model

- The process refuses to start without `TELEGRAM_ALLOWED_CHAT_IDS`.
- Messages from chats outside the allow-list are ignored.
- Bot tokens stay in `.env` and never enter content, audit detail, or source code.
- Every Telegram update is claimed in PostgreSQL before a command runs. Completed updates cannot run twice after a restart.
- `/monitor` creates inbox suggestions only. It cannot approve or publish.
- `/caption` uses the configured agent provider and returns a draft only.

## Configuration

Create a bot with Telegram's official BotFather, send it one message, and obtain the numeric `chat.id` through the official Bot API. Keep the token out of screenshots, shell history, logs, and documentation.

```env
ORIGINPOST_API_URL=http://127.0.0.1:4000
TELEGRAM_BOT_TOKEN=replace-with-your-bot-token
TELEGRAM_ALLOWED_CHAT_IDS=123456789
TELEGRAM_WORKSPACE_ID=default
```

Multiple trusted chats may be comma-separated. Run migrations before starting the adapter:

```bash
pnpm db:migrate
pnpm --filter @originpost/telegram-bot dev
```

## Commands

```text
/inbox
/new Ahmedabad update | Check the official release and local reports
/research content_item_id
/monitor 15 | latest verified Gujarat news
/caption content_item_id | instagram | Gujarati
/status
/help
```

`/monitor` saves the Telegram chat as the notification destination. The worker sends a short message only when the same chat is still present in `TELEGRAM_ALLOWED_CHAT_IDS`.

## Failure behavior

The adapter uses Telegram long polling. A claimed update has a five-minute lease. A failed or expired receipt may be retried; a completed receipt is permanent. API failures return a short error to the same allowed chat. The adapter does not contain social platform credentials and does not call publishing connectors directly.
