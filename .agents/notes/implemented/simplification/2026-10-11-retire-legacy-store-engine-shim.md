# Agent Note: Resolve client stores through the supported host platform

Status: implemented

## Problem

A dual-cohort shim catches store-module resolution errors and tries an indirect legacy runtime face. Its below-floor host promise conflicts with the family support boundary and leaves dead compatibility machinery in every store-consuming bundle.

## Decision

The [shared client preset](../../../../shared/tsdown.client.ts) treats the store exactly like every [platform seed module](../../../../shared/web-platform.ts): a direct external resolved by the host. The virtual module, generated fallback body and resolve/load special cases are absent. The [host-floor owner](../architecture/2026-09-01-dsh-host-floor-tracks-cohort.md) and [current cohort owner](../architecture/2026-09-29-sdk-cohort-0.2.0-rc.2.md) require a host supplying this module.

## Context & Efficiency Impact

One virtual module, a two-stage resolution branch, its catch/fallback and a legacy-engine compatibility obligation disappear. Platform externality, host-owned identity, purity checks, CSS behavior and the closure-factory loader stay intact. No compatibility replacement or prompt/tool-schema overhead is added. Satellite presets and the separate vendored try-on shell are not changed.

## Alternatives considered

Retain or capability-probe the old host: rejected because installs below the declared floor are not supported. Bundle a private store: rejected because it duplicates host ownership and identity. Raise the floor again: unnecessary because the current floor already supplies the module. A direct host external is the existing supported contract.

## Consequences

The [committed-bundle contract](../../../../scripts/client-bundle-contract.test.mjs) verifies the actual rebuilt client artifacts, rejecting shim/legacy markers and requiring the direct platform call; source fingerprints alone do not cover this preset. The rebuilt bundles were also exercised on a supported host: an isolated probe host booted from a throwaway `DSH_HOME` rendered this checkout's client bundles and the store-backed session-archive panel and usage card without a module-resolution error, while below-floor importability is intentionally not retained. This partially supersedes the engine workaround in the [mixed original owner](../bug-fix/2026-08-28-client-store-dual-cohort-engine-shim.md); its separate agent-preset declaration/injection rationale remains live and cross-linked.
