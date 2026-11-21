# Agent Note: the skill center narrows, folds and imports skills instead of painting every row

Status: implemented

## Problem

The Skill Center listed seven source groups flat, and every row carried its full
description, its when-to-use line, invocation marks, an enable switch, an edit
action and a delete action. That is the right row for one skill and the wrong
page for sixty: the list is the panel's primary surface, yet the only way to
narrow it was a keyword search plus a workspace picker, so finding one skill in
a busy catalog meant scanning past system-bundled and runtime entries the user
does not manage day to day.

The other half of the problem was intake. Creating a skill meant typing every
field by hand, and bringing in skills that already existed somewhere else meant
recreating each SKILL.md one at a time — with no way to keep a migrated copy
consistent with its source.

## Decision

- **Three facets stack on the search box.** Source group, enabled/disabled state
  and row mark ("Provided by plugin" / "No local file" / "symlinked") live in
  `src/client/skill-filter.ts` beside the existing workspace and query axes.
  The dimensions intersect; selections *within* one dimension union, so ticking
  two sources or two marks widens the result instead of emptying it. The facet
  panel sits behind one toolbar toggle that reports how many selections are
  narrowing the list, so the default view gains no density.
- **The group header is the fold control.** Only project and user roots are open
  on first use; system-bundled, custom-directory and runtime groups start folded
  and keep their row count in the header. A group's rows unmount while folded,
  which also keeps a large catalog cheap to render.
- **View state is browser state.** `src/client/panel-prefs.ts` owns the facets
  and the per-group fold decisions in `localStorage`, because the layout
  unmounts this page whenever another panel takes the center column: component
  state would be lost on every panel switch. The stored document is treated as
  untrusted input and validated field by field, so a document written by an
  older version loses only the field it cannot read; a browser that refuses
  storage keeps working without persistence. Folds are recorded per group as an
  override of the default, so a source group this build does not know about
  still opens or closes by its own kind.
- **Import is a separate creation surface.** `POST /api/dsh-skill-explorer/import`
  (`src/import.ts`) batch-creates skills from a host directory the user names or
  from a `.zip` archive the browser read and posted as base64. Candidates are
  validated with the same acceptance rule the scan applies (`isSkillName` +
  `parseFrontmatter`), and the file is written verbatim, so frontmatter fields
  beyond the ones the create form knows (`disable-model-invocation`,
  `user-invocable`, the `input` block) survive a migration.
- **Conflicts resolve by the official source rank.** A same-name skill at a
  stronger source outranks the target root and the imported file would never be
  the one the model receives, so that candidate is reported `shadowed` instead
  of written; the same source means the name is taken in that root
  (`exists`). A weaker source is shadowed by the import, so it is written.
- **"Duplicate as template" reads the existing read route.** The row action
  fetches the skill through `GET /read` (which resolves the row's own path
  through a fresh scan) and hands a draft to the create tab through the panel
  controller, because the create tab mounts only while it is selected. No new
  route is needed and the draft can only come from a skill the panel is
  displaying.

## Where the import boundary sits

The existing write routes keep their rule unchanged: every one of them mutates
only a path that a fresh scan resolved for the name the panel displayed, so a
client path is an identity claim and never a location. Import cannot work that
way — it creates files that no scan has seen yet — so it gets its own explicit
boundary instead of widening theirs:

- the only content it reads is `<dir>/<name>/SKILL.md`, `<dir>/<name>.md`
  (one level, the shapes the panel's own scan accepts) or the posted archive;
- symbolic links and dot entries in a source directory are skipped rather than
  followed, so an import cannot be pointed at content through a planted link;
- it writes only `<skill root>/<name>/SKILL.md` under the documented user or
  project root, with `O_EXCL`, and never rewrites an existing file — a plan
  built while a name looked free still loses to the file that appeared first;
- the request is bounded (archive 4MB, 512 entries, 64KB per SKILL.md, 4MB of
  expanded text), and a candidate the official provider would discard is
  skipped rather than imported;
- it sits behind the same loopback fence as the rest of the family, so the
  directory form is only ever a path on the machine serving the request.

## Why the archive is decoded on the host

The browser could decode a zip itself with `DecompressionStream('deflate-raw')`,
but that would put the archive format in the half that cannot be unit-tested
outside a DOM and leave the inflate step unverifiable. Decoding on the host
means `node:zlib` does the inflation, the reader is a pure function over a
buffer, and both the accepted layouts (stored, deflate, nested paths) and the
refused ones (zip64, encrypted entries, an unknown method, an escaping path) are
tested against archives the tests build byte-for-byte. The wire cost is base64
expansion on a payload that is text and small in practice.

## Alternatives considered

- **An always-visible facet bar.** Rejected: the complaint this answers is
  density, and a permanent second toolbar re-creates it. The toggle costs one
  click and restores itself open when stored facets are active, so a narrowed
  list is never unexplained.
- **Leaving every source group open.** Rejected: the sources the user does not
  manage (system bundled, runtime registrations) outnumber the ones they do on a
  configured install, and opening them all is exactly the flat wall the issue
  describes. The folded header keeps the count visible, so nothing is hidden
  silently.
- **Storing the facets on the host beside the provider toggles.** Rejected: the
  host's stored state is shared by every browser and every paired device, and a
  facet is a view preference of the person looking at the page, not a fact about
  the installation. Two windows would also fight over one value.
- **Importing through the create route, one candidate at a time.** Rejected: it
  would make a batch import N round trips with no way to report what happened to
  the whole set, and the create route refuses an existing name with a 409 that
  cannot distinguish "same source" from "shadowed".
- **Following symlinks when scanning a source directory.** Rejected: the panel's
  scan follows links because a link expresses the user's mount intent, but an
  import *copies*, so following a link would silently duplicate content into a
  root the link's target was never meant to reach.
- **Asking a zip library for the archive.** Rejected for a 130-line reader over a
  format that has not changed: the dependency would be the package's only
  runtime import of its kind, and the subset a skills archive uses (stored and
  deflate, one disk, no encryption) is small enough to own and test.
- **Offering to overwrite a shadowed candidate.** Rejected: the user would have
  to choose between two skills the panel presents as one name, and the rank rule
  already says which one the model receives.

## Consequences

- Folding can hide rows that a keyword search alone would have shown. The empty
  state distinguishes "no skills at all" from "nothing under the current
  filter", and every folded group states its size, so the case is recoverable
  without opening every group.
- Facets are per browser profile: they survive a panel remount and a refresh,
  not a different browser or an incognito window.
- Import never overwrites, so re-importing a skill that changed upstream means
  deleting or renaming the local copy first. That is the deliberate trade for an
  operation that writes many files at once.
- An archive using zip64 or encryption is refused rather than partially
  imported; the error names the entry so the user can re-export it.
- The `.zip` reader and the import planner are first-party code with their own
  spec (`tests/import.spec.ts`), including the source-rank table's two failure
  directions.
- The panel now carries three tab-level surfaces (skills, create, import) and a
  duplicate path into the create form. The tab and draft state still live in the
  panel controller for the reason the center-column family already documents.
