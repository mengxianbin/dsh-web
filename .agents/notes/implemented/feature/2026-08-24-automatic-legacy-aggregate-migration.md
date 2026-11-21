# Agent Note: Automatic legacy aggregate migration

Status: implemented

## Problem

After the product rename, profiles still mounted on `@linxin666/dsh-web-ui-all` would fail or remain on the legacy package. A user upgrade that adds `@linxin666/dsh-web-all` without removing the legacy bundle has two `web-ui-*` patch layers and cannot boot. The transition needed a zero-user-action migration built into the product update path, not a manual remove-then-add command.

## Decision

The legacy aggregate migration is a deterministic, transactional replacement implemented in three layers (the rename decision is recorded in [the product rename note](../architecture/2026-08-24-product-rename-dsh-web.md)):

- The release pipeline dual-publishes the current `@linxin666/dsh-web-all` and a final `@linxin666/dsh-web-ui-all` package. The legacy tarball is built from the current aggregate package, rewrites the browser loader id and self row to the old npm identity, and carries `dsh.migrate` metadata describing the target package and version.
- The plugin-manager update path recognizes the legacy package, reports a migration update, and runs a CLI-backed migration job through the official `dsh plugin` writer. The job removes the legacy package through the official CLI, installs the current aggregate, restores the legacy layer position, runs `--dump-config`, and rolls back through the official remove/add path on failure. Its Windows process path invokes a trusted `dsh.cmd` through `cmd.exe` with validated arguments.
- The Doctor Launcher half left the family on 2026-09-23 with [the dsh-doctor removal](../simplification/2026-09-23-remove-dsh-doctor-and-describe-image.md), so the plugin-manager update path is the only migration entry point that ships. The migration map lives in `packages/dsh-plugin-manager/src/host/legacy-migration.ts`; [the shared-module consolidation](../simplification/2026-10-10-single-consumer-shared-modules-consolidated.md) found it had no second consumer and made that package its only home.

The Doctor `autoMigrate` setting that used to gate the startup path left the family with the Doctor package, and no other setting gates the migration.

## Alternatives considered

- A shim package that re-exports the current aggregate: rejected because the rename note already records that aggregate mount semantics do not survive re-export.
- Keeping both packages installed and coexisting: rejected because both patch layers output the same `web-ui-*` rows.
- A manual migration command only: rejected because the user chose fully automatic product-update migration.
- Running migration only inside plugin-manager: insufficient for boot failures because a broken legacy profile never reaches the GUI; Doctor Launcher covers the startup path.

## Consequences

- The migration now runs from the plugin-manager update path, so it is reachable once the profile boots into the GUI; a profile that cannot boot no longer has a startup-path migration.
- Direct `dsh web` calls are unaffected: the migration runs inside the GUI update path rather than before the host starts.
- Migration is pinned to an exact target version and never removes the legacy package unless the current package is available and the target bundle is composed successfully.
- The legacy npm package stays on npm for the dual-publish transition window and is then deprecated.
- The release notes record that the implementation has fresh-install, unit-test, and Linux mount-smoke evidence, but does not claim a real previous-version upgrade drill or a macOS / Windows upgrade matrix. Manual recovery uses a profile backup, target installation, legacy removal, and `--dump-config` verification.
