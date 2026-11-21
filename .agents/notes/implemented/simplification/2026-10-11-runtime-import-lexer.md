# Agent Note: Use a library lexer for tracked runtime-import checks

Status: implemented

## Problem

Hand-written lexical states must follow JavaScript strings, regexes, templates, comments and module syntax. Scanner errors can misclassify dependency obligations even though the package dependency policy itself is small.

## Decision

The [runtime dependency gate](../../../../scripts/runtime-deps-check.mjs) synchronously calls `es-module-lexer/js` and projects decoded string `record.n` values. `importSpecifiers` remains the adapter seam consumed by the gate and its [behavior tests](../../../../scripts/runtime-deps-check.test.mjs). The explicit root development dependency and lockfile importer pin the parser; tracked-package/file selection and all dependency exemptions remain unchanged.

## Context & Efficiency Impact

The lexical state machine and its grammar-maintenance obligation disappear in favor of a small adapter and one development dependency. Runtime packages gain no dependency and prompt/tool schemas gain no overhead. The library performs grammar work; the repository still owns manifest policy, artifact selection and adapter tests.

## Alternatives considered

Keep adding scanner states: rejected because regex/template/escape cases multiply the same obligation. Introduce another regex: rejected because it cannot reliably separate syntax from prose. Use a full parser: stronger validation, but unnecessary machinery for module-specifier extraction. The synchronous JavaScript entry avoids an async initialization contract.

## Consequences

Side effects, re-exports, commented/template dynamic imports, attributes and escaped specifiers use language semantics. Computed/interpolated imports and CommonJS require calls remain outside the gate. Lexer-detectable malformed input throws with its artifact path; this is not a complete JavaScript syntax validator. Parsing remains sequential and is not a working-tree glob. Adapter scenarios and the tracked-artifact gate are the retained proof obligations. No earlier decision is superseded.
