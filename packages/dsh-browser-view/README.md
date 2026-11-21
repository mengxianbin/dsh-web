# dsh-browser-view · Live Browser View for DeepSeek Harness (DSH)

English | [中文](README.zh.md)

<p align="center">
  <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.1--rc.3-4c6ef5?style=flat-square&amp;labelColor=454a54" alt="DSH">
  &nbsp;
  <img src="https://img.shields.io/badge/license-BSD--3--Clause-blue?style=flat-square" alt="License">
</p>

> A browser the agent drives, watched from a tab beside the chat. The host half owns a dedicated Chromium over the devtools protocol; the browser half contributes one right-sidebar tab type, so the page stays in view while the agent verifies it.

This package is an external plugin for DeepSeek Harness (DSH), structured as a cordis bundle: `src/index.ts` is the host half (Chrome process, CDP sessions, tab registry, WebSocket fan-out, agent tools) and `src/client/` is the browser half (the sidebar tab body and its chip).

## What it does

- **A live tab, not a screenshot poll**: CDP `Page.startScreencast` frames arrive over one WebSocket and are painted as they come. The tab shows the active page, its URL and title, and what the agent last did.
- **Eleven agent tools**: `browser_navigate`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_snapshot`, `browser_screenshot`, `browser_console`, `browser_network`, `browser_tabs`, `browser_close` (closes only the tabs this session opened).
- **Evidence in the conversation**: every `browser_screenshot` result carries the image, so the transcript keeps the picture the agent acted on instead of only a sentence about it.
- **One dedicated browser**: the plugin launches its own Chromium with a throwaway profile. It never attaches to a browser you are signed into.
- **Signs itself in to this host's own GUI**: a fresh profile has no session cookie, so the viewer would only ever see the 401 challenge. When a navigation lands on that challenge over loopback, the plugin asks the host's connection service for the same ticketed URL `dsh web` printed, and retries once. The cookie that mints lives in the throwaway profile and dies with it.

## How it works

```text
agent tool call ──► host half ──► CDP ──► dedicated Chromium
                        │
                        └─ screencast frames ──► WebSocket ──► sidebar tab body
```

The host half starts Chrome lazily on the first tool call or the first tab mount, pins a viewport, and keeps a ring of console entries and network requests per tab so a verification can be read back without re-running the page. A top-level document replacement clears both rings; a same-document navigation (hash, query, SPA pushState) keeps them.

## Interface seats

| Seat | Kind | What lands there |
| --- | --- | --- |
| `sidebar.right.pane.tab` | keyed, session | the tab body |
| `sidebar.right.pane.tab.title` | keyed, session | the chip text and glyph |

The conversation header carries no entry for this tab: the column's own tab strip and the guide capsule already open it, and a third place to click was only crowding that row.

The tab type is registered with `ctx.sidebarRightTabs.register` and opened with `ctx.sidebarRight.openTabIn`. Its kind is `browser-view`, deliberately **not** `browser`: the shipped `@deepseek-ai/dsh-client-ui-sidebar-browser` owns that kind, and a second registration in the extension band takes a kind over, which would shadow the shipped tab out of existence.

The single-occupant `rightbar` / `rightbar.session` seats are still not touched: they belong to the column itself, not to the tabs inside it.

## Security model

- **Loopback only**: the panel socket is fenced to loopback requests; a non-local client is rejected before the upgrade.
- **Throwaway profile**: Chrome runs on a fresh `--user-data-dir` under the system temp directory with a random debugging port, so no cookie, session or extension of the user's real browser is reachable.
- **Headless by default**: nothing pops up on the desktop; the tab is the only view.
- **Process lifetime**: the Chromium child is killed when the plugin disposes. Nothing is left running behind a closed session.
- **Token handling**: the launch token is minted per navigation, held in memory, and never written to disk; the retry only happens on a loopback target whose document is DSH's own challenge, so no other local service is ever handed the token.

## Known limits

- The tab is a **view**. Input comes from the agent through the tools; it does not forward your mouse or keyboard.
- The tab lives inside the right sidebar, so it needs that column; a layout that hides the column hides the tab.
- Frames are produced when the page changes, so a static page holds the last frame instead of streaming duplicates.
- Switching chips keeps the body mounted (`keepMounted`), so the socket survives; the frame still waits for the next change.
- The token top-up only covers the site root, because DSH answers the challenge with a 303 to `./` for `GET /` alone.
- One browser process per host; tabs are isolated CDP targets, not separate profiles.
- Chrome must be installed at a standard location (or named by `CHROME_PATH`).

## Install

```sh
dsh plugin --profile web add link:<this repo>/packages/dsh-browser-view
```

The plugin row is read at startup, so a DSH restart is required after installing or changing it.

## Development

```sh
pnpm --filter @linxin666/dsh-client-ui-browser-view typecheck
pnpm --filter @linxin666/dsh-client-ui-browser-view test
pnpm --filter @linxin666/dsh-client-ui-browser-view build
```
