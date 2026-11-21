# @linxin666/dsh-client-ui-message-edit

English | [中文](README.zh.md)

Adds edit-and-resend for text-only user messages in the DSH Web GUI, using an exact history-prefix fork rather than modifying the source session.

## What it does

- Adds an **Edit and resend** entry to each Turn tail that contains an ordinary text-only user message, including historical Turns.
- Forks at the inclusive event boundary immediately before that message, retains and opens the child session, then queues the edited text once.
- Leaves the source session unchanged and warns that branching does not undo file writes, command execution, or other external side effects.
- Supports Ctrl/Cmd+Enter to resend and Escape to cancel; running or removed sessions and peers without fork access cannot submit.

## Install

### From npm (recommended)

```sh
dsh plugin --profile web add @linxin666/dsh-client-ui-message-edit@latest
```

### From the repository (development)

```sh
git clone https://github.com/zhu1090093659/dsh-web.git
cd dsh-web
pnpm install
pnpm -r build
dsh plugin --profile web add link:$(pwd)/packages/dsh-message-edit
```

## Config

The plugin has no settings. Disable its plugin row to remove the Turn-tail entry. The aggregate row id is `web-ui-message-edit`; the standalone row id is `ui-message-edit`.

## Known limitations

- Only ordinary user messages whose content blocks are all text are editable. Steering messages, injected context, empty messages, and messages containing images or files do not show the entry, so attachments are never silently dropped.
- Editing creates a new branch; it does not rewrite the original log or roll back side effects from later events.
- A fork failure leaves the source view unchanged. Once a child has been created, a later navigation or prompt failure does not delete that child.

## License

Apache-2.0.
