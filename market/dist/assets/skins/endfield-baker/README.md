# Endfield Baker (终末地 · BAKER)

English | [中文](README.zh.md)

Endfield Baker turns the DSH web GUI into an *Arknights: Endfield* field terminal — a pure asset
skin (v2 `skin.json` + `skin.css` + `patches.css` + `assets/`), kept in this repository and
installed on demand into `$DSH_HOME/skins/endfield-baker/` by the Workshop.

## What it is

- **Pure assets**: `skin.css` (L1: `--dsw-*` token remap plus the `--ef-*` primitives),
  `patches.css` (L3: structural patches for the chat shell and the plugin pages),
  `assets/` (terminal artwork, signal bars, corner cuts), `preview/` (one store poster).
  No package.json, no build step, nothing executes.
- **One palette**: every colour lives in the `:root` block of `skin.css`. Light and dark share
  the same terminal palette; changing a scheme means editing one block.
- **Session area rebuilt**: the chat panel is redone as the BAKER comms screen — cyan header rail,
  signal-yellow selected row, cut-corner console cards for tool calls / thinking / context rows,
  a white capsule composer, and a frosted grey chat base plate over the industrial terminal
  background.
- **Shell and plugin pages**: dossier-style sidebar rows and workspace rows (monospace micro
  labels, one-pixel light borders), hairline grids and diagonal signal strips, plus structural
  patches for the task board, SSH, pet, and plugin settings pages. Patches for plugins you do not
  have installed simply stay dormant.

## Verification

Applied locally through the skin center and checked in both skins-visible states:

- `dsh-web` skin center, engine `0.2.0-rc.2`, skin id `endfield-baker`; `data-dsh-skin`
  asserted before every measurement, `GET /api/skin-center/v2/skins/endfield-baker/patches`
  returns 200.
- **Web**: chat shell, sidebar, settings, task board, plugin pages measured with a headless probe
  (computed styles and element rects) rather than by eye.
- **Desktop (Electron)**: the same asset directory applied in the desktop build and used by hand;
  no layout breakage found. The desktop build's CSS-module hashes differ from the web build, so the
  chat base plate and the rail handle are patched through `:is(<web hash>, <desktop hash>)`.
- Fixed in this version: the composer's frosted backplate used to create a containing block for the
  app's fixed-position floating bubble, which pushed the message area and composer up by roughly
  510 px while a task was running. The frost now lives on a child-free `::before`, so it can no
  longer capture fixed descendants.

## Credits and license

- Skin engineering by **Yuji6278** includes terminal-style layout, palette/token mapping, CSS composition, state adaptation and web/desktop compatibility work. The base theme is adapted from **blue-fantasy** (`powerdog996` / DreamSkin community); base code remains subject to its original license. This engineering work is distinct from the provenance and rights of individual images.
- Sources and processing are classified in [NOTICE](NOTICE): site decorations from https://chat.peilika.beer/ were extracted and adjusted in brightness, transparency or orientation; the two SVG variants were extracted and recoloured, **not redrawn**. Chat/header artwork was cropped and adjusted from a contributor-provided reference screenshot. According to the contributor's confirmed account, `new-session.png` was cut out from a screenshot; the precise original image and crop coordinates remain unverified. `endfield-dark.jpg` was drawn by a geometric script without external image pixels, using BAKER-inspired colours. These categories do not make the whole asset set contributor-original or AI-generated.
- The referenced work is ***Arknights: Endfield***. The source site's quoted intellectual-property statement attributes related images and game intellectual property to **Shanghai Hypergryph Network Technology Co., Ltd. (Hypergryph)**; other rights remain with their respective holders. The header contains anonymous human pictograms, not identifiable named game characters. The site's statement identifies stated ownership, not permission to redistribute.
- The official international-site [Fan Content and Streaming Guidelines](https://endfield.gryphline.com/en-us/news/4497) provide the public policy basis for the intended personal, non-profit fan creation: eligible individuals/non-incorporated groups may create, display and distribute compliant fan works, generally without advance contact. The policy also requires respect for third-party rights, prohibits misleading official presentation and prohibits direct copying/extraction of official materials lacking clear creativity. The skin's engineering creativity does not by itself establish compliance for each extracted image; the policy's application to these site assets and packaged UI fragments remains uncertain. It is not file-by-file official authorization.
- **CC BY-NC-SA 4.0** applies only to new contributions that the contributor has the right to license. It excludes third-party visual assets and does not override the base code's original license. The license text is in [LICENSE](LICENSE); source details, base-license facts and remaining gaps are in [NOTICE](NOTICE).
- This skin is an unofficial, personal, non-profit fan interface project. Based on the provisions for non-profit fan creations in GRYPHLINE’s Arknights: Endfield Fan Content and Streaming Guidelines, the contributor maintains that publication of this project falls within the fan-creation scope permitted by those guidelines and expressly assumes copyright and compliance responsibility for this contribution. The actual sources and processing methods of the assets have been disclosed individually. If a rights holder raises a substantiated objection, it will be promptly investigated, and measures such as correction, removal or cessation of distribution will be taken.

## Store preview

`preview.light` and `preview.dark` both reference the single physical poster [preview/light.jpg](preview/light.jpg). The two scheme entries share one terminal palette; they are not two distinct preview images. The two independent light/dark verification evidence images remain separate and are not replaced by this store poster.

## Known limitations

- Presentation-only: the skin mutates browser styles and never touches a model request.
- `patches.css` anchors on CSS-module hash class fragments, so an official rebuild can move an
  anchor; `dsh-skin validate` reports this as a warning by design.
- No `hooks.mjs` is declared, so the workspace row's inline "+ new session" button (which the
  design replaces with a menu entry) stays hidden and new sessions are started from the *New Baker*
  entry at the top of the sidebar.
