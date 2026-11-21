# Agent Note: The Token Bank mints from every provider

Status: implemented

## Problem

The Token 银行 tab minted whale yuan from the DeepSeek official family only, so any profile whose usage sat anywhere else saw an empty note while the ledger plainly recorded its tokens. Issue #1831 surfaced it with one gateway route: the fix enumerated that single route id beside the official family, which left the next profile — someone paying for Kimi For Coding, GLM Coding Plan or MiniMax, or relaying through another provider — still facing an empty note. The mint set was a code-level list of route ids, so every new provider needed a release to mint, and any route rename silently emptied the bank again.

## Decision

`voucherData()` in `packages/dsh-usage/src/client/voucher.ts` sums tokens and calls over every row of the window's `providers`. The `EXTRA_MINT_ROUTE_IDS` whitelist and the `mintsWhaleYuan()` predicate are deleted: the bank mints what the profile spent, so there is no route enumeration left to fall out of date. A zero-token ledger still returns `undefined` — a zero-denomination note is never minted.

`cost` stays gated on `isDeepSeekProviderRoute()`:

```ts
for (const row of window.providers) {
  tokens += totalTokens(row.totals)
  calls += row.totals.calls
  if (isDeepSeekProviderRoute(row.provider)) cost += row.totals.cost
}
```

### Accounting decisions stay apart from probe decisions

The standing rule from the [account-route note](../bug-fix/2026-09-30-usage-account-route-family-without-probe.md) is that accounting decisions read `isDeepSeekProviderRoute()` while probing, credential fallback and alias folding read `adapterFor()`, so the two can never widen together. Minting is an accounting decision over ledger rows, and widening it touches no adapter: putting a gateway route into an adapter would hand it the balance probe and the credential fallback it must not have. The concrete form of the rule today is a test that mints a relay route's rows while asserting `adapterFor()` claims none of them.

### Spend stays the priced family's

Subscription and relay routes ship no price book, so fold-time stamping already gives their rows `cost` 0 and summing every row adds 0 on real data. The line is gated anyway: the boundary is structural instead of incidental, and a fixture carrying a non-zero non-official `cost` proves it. The spend line therefore still reads "spent on the official balance" and never widens into a subscription total.

### Bank copy

zh and en hint / empty-state copy describe the "all models" scope, and the ru mirror lives in `packages/dsh-i18n/src/client/ru/usage.ts`. No proportional breakdown was added: the mint covers every provider, but the note keeps its single cumulative figure and carries no "of which subscription N tokens" line.

## Alternatives considered

- **Keeping the whitelist and appending the new route ids.** Rejected: every provider needs a code change and a release to mint, the whitelist silently stops matching when a package renames its route id (that note accepted exactly this failure mode), and a subscription-only profile keeps seeing an empty bank. Once the goal is "mint everything", a list of route ids can only be a list of exceptions.
- **A configurable `bankMintRoutes: string[]` setting.** Rejected: it widens the change surface into the config schema and the settings card, and a misconfigured route silently mints tokens against no price book. With every ledger row minting, the setting has nothing left to decide except "mint less than you spent".
- **Adding non-official routes to the DEEPSEEK adapter's `familyOnlyIds`.** Rejected: `familyOnlyIds` models a route that authenticates without an API key but still belongs to the priced family. A subscription route has no price book at all, so the adapter would make the pricing and probe paths treat it as DeepSeek.
- **Drawing a subscription share of the minted total on the note.** Rejected by the owner: mint everything, but write no "of which subscription N tokens" line. The note stays a single accumulated figure plus its spend line.
- **Deriving the face value from spend instead of tokens.** Rejected, unchanged from the bank's original decision: the token count is what the user asks for, and spend already has its own line.

## Consequences

- A profile buying subscription plans or relaying elsewhere now mints; the empty state appears only when the ledger holds no tokens at all. `faceValue()` still lifts any non-zero total to a minimum denomination of 1.
- Because spend stays official-family only, a subscription-only profile mints a note whose spend line reads ¥0.00 until an official balance observation exists. The copy says "estimated spend" and the package README states the split, so the note never claims the subscription's price.
- "Mint family" is no longer a term in the code, the tests or the copy: the package README (en / zh), the root README pair, the zh / en / ru bank copy, and the [Token Bank note](2026-09-10-whale-yuan-voucher-token-bank.md) all speak of every provider, with the official-family restriction stated only for the spend line.
- Supersession: this note consolidates the fully superseded whitelist note (2026-10-07, "The Token Bank mints an explicit route whitelist") — the route-id-rather-than-adapter-family rationale, the standing accounting / probe split, and the structural cost gate move here — and that note's triplet is deleted; no other file linked to it.

## Testing

- `packages/dsh-usage/tests/voucher.spec.ts`: every-provider summation (a subscription-only window minting from its own tokens, relay rows adding tokens and calls but no spend, the official aliases still folding into one note), the zero-token and absent-window `undefined`, the cache buckets joining the face value, and the "minting grants no adapter" guarantee.
- `packages/dsh-usage/tests/section-card.spec.tsx`: the bank's empty state on an empty ledger, a whole-ledger note whose tokens merge an official row with a subscription row while the spend line keeps the official estimate, and a relay row minting beside the official family without entering the spend line.
