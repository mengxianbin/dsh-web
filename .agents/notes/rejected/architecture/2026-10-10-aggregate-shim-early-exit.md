# Agent Note: Aggregate boot shim early exit (C1) — no provably safe early exit at a meaningful scale

Status: rejected — every provably safe early exit needs a shared hub contract change, and the measured upper bound stays below 0.1 ms per flush at realistic match counts

## Problem

Every body-mutation batch — one per animation frame carrying childList mutations — makes the aggregate boot shim re-scan the frame. `applyShims()` (`packages/dsh-web-all/src/client/index.ts:412`) runs the three `COLUMN_SHIMS` document queries (`:414-415`), one `document.querySelector('[class*="sidebarCol"]')` (`:424`), and then `stampSemanticParts(frame)` (`:430`) with four frame-wide `querySelectorAll` groups (`:335-338`, the composer group matching `textarea[data-phase]` and `[contenteditable="true"]` among others) plus three header/scrollport queries (`:340-345`). Its `changed` return value is discarded at `:482` and in the subscription callback (`:506-509`). A CDP CPU-profile fit of the real page measures the flush cost as linear in the frame's match count: slope 2.615e-4 ms/match, intercept 0.023 ms, R² 0.991 (206 matches → 0.098 ms, 806 → 0.213 ms, 3206 → 0.868 ms). The rescan is therefore the whole optimizable part, worth slope × matches per flush.

## Proposal (declined)

Cache "this frame is already fully stamped" and skip the rescan for batches that added nothing requiring a stamp. The proposal carried one hard requirement: the final DOM attribute set must stay equal under every real sequence — newly created frames, React-rebuilt frames, mid-batch removals, and growing match counts.

## Evidence

Attribute-derived matches break the premise. The shared hub observes only `{ childList: true, subtree: true }` (`shared/client/body-mutations.ts:111`), and the shim subscribes through the invalidation-only path (`:59-63`, `:47-52`), so it receives no `addedNodes`. More decisively, an element that starts matching a shim selector because of an **attribute** write is invisible to any added-nodes-only pass. Measured on the real probe page (Playwright driving system Chrome against the isolated host, script `/tmp/dsh-perf-survey/client/c1-attr-probe.mjs`, raw output `/tmp/dsh-perf-survey/client/out/c1-attr-probe.json`):

1. insert a `<textarea>` carrying no `data-phase` → flush → not stamped (it is not yet a match);
2. set `data-phase="idle"` on that existing node (attribute-only) → the node now matches the composer selector, and it stays unstamped across five frames — attribute batches never reach the hub;
3. append one unrelated node (childList) → flush → the textarea becomes `data-dsh-responsive-part="composer"`.

Step 3 happens only because that batch re-scans the whole frame. An incremental pass over `addedNodes` would leave the node unstamped and change the final attribute set; the same shape covers `[contenteditable="true"]` and every other React attribute toggle on an existing element.

The only route to `addedNodes` is switching the shim to the hub's records path (`subscribeBodyMutations`, `:66-72`). That flips `needsRecords` (`:47-52`) to true, which makes the hub retain every mutation record and detached subtree for the whole page (`:105-109`) — a shared cost borne by the other two subscribers (dsh-usage, dsh-plugin-manager) and a direct reversal of the optimization the module's own header documents. It still would not cover attribute-derived matches.

Making the hub observe attributes as well is the complete fix and the wrong trade: every class/attribute write would then produce a callback batch (mobile-adapt alone toggles body classes on a 600 ms tick), i.e. a per-attribute-write callback stream bought to save at most 0.26 ms per flush.

Scale check (slope × matches per flush, the upper bound that assumes a cost-free incremental path): 100 matches → 0.026 ms; 300 → 0.079 ms; 1000 → 0.262 ms — 0.16%, 0.47% and 1.57% of a 60 Hz frame budget, and 53%, 77% and 92% of the shim's own flush cost. The realistic range (a conversation's code blocks plus sidebar treeitems) is 100-300 matches, i.e. below 0.1 ms per flush, and the childList-driven flush rate during real streaming is unmeasured — the only measured idle rate, 2.1 batches/s, is attribute-only and never reaches the hub.

The pinning contract also rules out the cheaper alternative of coalescing the rescan: `packages/dsh-web-all/tests/responsive-contract.spec.ts:17` requires new content to be stamped within the same frame.

## Alternatives considered

- **Records path plus an addedNodes incremental stamp**: declined — leaves attribute-derived matches unstamped (measured above) and pays a hub-wide record-retention cost shared with dsh-usage and dsh-plugin-manager.
- **Cache the frame element only** (the `resolvedFrame` pattern `ensureMobileDismiss` already uses, `:480-486`): safe, but it saves one document query while the four frame-wide `querySelectorAll` groups — the measured cost — remain. Insufficient on its own.
- **Coalesce or debounce the rescan**: declined — it breaks the same-frame stamping contract pinned at `responsive-contract.spec.ts:17`, and delayed stamping changes when the responsive CSS starts applying.
- **Install a dedicated frame observer in the shim**: declined — reintroduces exactly the per-plugin body observer the shared hub exists to remove.
- **Narrow the selector scopes** (scan the sidebar pane for treeitems and the conversation pane for composer/code instead of the whole frame): the only remaining safe direction. It lowers the per-flush constant without any added-nodes signal and leaves the final attribute set unchanged. Not implemented here because it needs its own A/B measurement with the same CDP fit and a real-browser attribute-set diff — a separate task.
- **A deterministic guard asserting "no added nodes ⇒ O(1) queries"**: declined as self-defeating — that assertion would pin the very skip that step 3 of the measurement shows to be wrong.

## Remaining uncertainty

- Real-session match counts are extrapolated from injected blocks in an isolated host without model credentials; 1000 or more matches would need a very large sidebar together with a long conversation.
- The childList-driven flush rate during real streaming is unmeasured; the only measured rate is the idle, attribute-only 2.1 batches/s.
- The attribute-derived path was demonstrated with an injected node rather than a real turn. `textarea[data-phase]` and `[contenteditable="true"]` are both plausible live toggles, and one real turn would settle it.
- The slope was measured on synthetic blocks without layout; deeper real subtrees could move the constant, not the linearity.
