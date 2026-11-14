# Agent Note: Test the production market ZIP writer instead of a copy

Status: implemented

## Problem

A copied serializer can keep regression tests green after the production ZIP writer breaks. Maintaining both creates a synchronization obligation without an independent oracle.

## Decision

The [pure ZIP helper](../../../../scripts/lib/market-zip.cjs) is the only writer. The [market build](../../../../scripts/market-build) and [ZIP regression suite](../../../../scripts/market-zip.test.mjs) consume it; tests retain independent header parsers and extraction assertions. Both synthetic-tree fixtures copy the helper beside the build script.

## Context & Efficiency Impact

One duplicate writer and its keep-in-sync rule disappear. The production definition changes home, not format; residual glue is two imports and fixture-copy entries. Node CRC32, ordering, UTF-8 flags, file modes, timestamps, stored bytes and existing format limits stay unchanged. No archive dependency, ZIP64, compression framework or prompt/tool-schema overhead is introduced.

## Alternatives considered

Copy equality gates retain two producers plus another obligation. Regex/eval extraction couples tests to source spelling. Exporting the whole build executes unrelated module-scope asset resolution. The pure sibling helper avoids these costs; self-contained fixture packaging gives way to one additional copied file.

## Consequences

The [clean-checkout regression](../../../../scripts/market-build-clean.test.mjs) checks every committed download checksum after an actual full fixture build, while the direct suite pins empty and mixed UTF-8/binary bytes. A deliberate CRC offset defect must fail the suite. Missing sibling files fail fixture execution rather than silently exercising a copy. The separate clean-checkout ZIP-comparison exclusion remains unchanged: its intent needs another decision. There is no existing owning note to supersede.
