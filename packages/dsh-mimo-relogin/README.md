# dsh-mimo-relogin

English | [中文](README.zh.md)

## Summary

Host-only kit that keeps the dsh-usage MiMo balance probe fed with a fresh `MIMO_PLATFORM_COOKIE`. It serves one loopback page (`GET /api/mimo-relogin/page`) with three actions and a paste fallback:

- **Silent renewal** (`POST /api/mimo-relogin/renew`) replays the platform's own ticket chain headlessly — `genLoginUrl` → `account.xiaomi.com/pass/serviceLogin` → platform `/sts` — rotating `api-platform_serviceToken` from the stored `MIMO_ACCOUNT_COOKIES` without opening a browser. Proven live on 2026-10-27: the chain completes with no form while the 30-day `passToken` lives, and lands on the credential form (HTTP 409, `verdict: interactive`) once it does not. This caps manual re-logins at roughly one per `passToken` lifetime.
- **Capture** (`POST /api/mimo-relogin/capture`) reads both cookie jars from the chrome-debug instance (port 9224 by convention) over CDP and stores them — only after the harvested platform jar passes `GET /api/v1/balance`.
- **Open window** (`POST /api/mimo-relogin/open`) attaches to a running debug window (one new tab) or launches the dedicated debug Chrome at the platform.
- **Paste** (`POST /api/mimo-relogin/paste`) is the manual floor: `slot=platform|account` plus a single-line Cookie header; the platform half carries the same balance-probe gate as capture (a value that does not answer the probe is never stored).

Every route passes the shared loopback fence first; cookie values never reach logs or responses (names and lengths only). After a successful store the kit pokes dsh-usage's `/api/dsh-usage/refresh` so the sidebar glance shows the new balance within seconds.

A resident **auto-renew** loop (FORK mimo-relogin-l3, 2026-10-29) replays the same silent renewal on a timer: the first attempt lands 60s after apply (so every restart leaves a first-run log in `dsh-web.log`), then at most once per 24 hours (the configured interval is clamped to a 24-hour floor). While the 30-day `passToken` lives this is fully unattended; on `verdict: interactive` the loop pauses — no automatic retry, the page stays the entry point — and re-arms after the next successful manual renew / capture / account paste. Every outcome logs with a `[dsh-mimo-relogin] auto-renew:` prefix; the schedule is per-process, so a restart re-arms it.

The kit writes two managed credentials (provider-managed store, which outranks the environment layer, so no restart is needed): `MIMO_PLATFORM_COOKIE` (probe fuel for the dsh-usage MiMo adapter) and `MIMO_ACCOUNT_COOKIES` (renewal fuel — contains the account-domain SSO cookies including `passToken`; treat it with the same care as any sign-in secret).

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | Disable the kit entirely. |
| `chromePath` | `C:\Program Files\Google\Chrome\Application\chrome.exe` | Chrome executable for the cold-start path. |
| `chromeProfile` | `D:\tech\m-note\.local\chrome-profile` | Dedicated debug profile (chrome-debug's by convention; keep it separate from the daily browser). |
| `cdpPort` | `9224` | Debug port (chrome-debug's convention). |
| `platformUrl` | `https://platform.xiaomimimo.com/` | Platform origin the kit logs in to and probes. |
| `autoRenew` | `true` | Run the resident auto-renew loop (pauses on `verdict: interactive`). |
| `autoRenewIntervalHours` | `24` | Hours between automatic renewals; clamped to a 24-hour floor. |

## Install

Link-only, host-only — no `dsh.client` face, nothing appears in the browser roster, no npm release:

```sh
dsh plugin --profile <name> add link:<repo>/packages/dsh-mimo-relogin
```

## Routes

| route | method | fence | purpose |
| --- | --- | --- | --- |
| `/api/mimo-relogin/page` | any | loopback | The HTML page (CSP-restricted, inline assets only). |
| `/api/mimo-relogin/status` | any | loopback | Debug-port liveness plus stored-credential flags (booleans only). |
| `/api/mimo-relogin/renew` | POST | loopback | Headless ticket-chain renewal; 409 when the chain wants a form or account cookies are absent, 502 on a failed chain or balance probe. |
| `/api/mimo-relogin/capture` | POST | loopback | CDP jar harvest with the balance-probe gate; 503 when the debug window is down, 409 when it never signed in. |
| `/api/mimo-relogin/open` | POST | loopback | Attach-or-launch the debug window at the platform. |
| `/api/mimo-relogin/paste` | POST | loopback | Manual credential write with slot validation and (for `platform`) the probe gate. |

## Known limitations and Deferred Work

- The renewal chain depends on the platform's internal `genLoginUrl`/`serviceLogin`/`/sts` shapes; a platform-side change surfaces as `verdict: failed` with a hop list on the page rather than a silent breakage.
- The debug profile path default points at this machine's chrome-debug convention; override `chromeProfile` per machine.
- Cookie values are stored in the managed credentials file in plaintext (as every credential in that store is); the account jar carries a 30-day SSO root and should be rotated by re-login whenever the chain reports `interactive`.
- The auto-renew schedule is per-process: a restart resets the 24h cadence, and an `interactive` pause lasts until a successful manual store or the next restart.
- The page copy is Chinese (host-half strings are audit warnings by design); the i18n audit reports host-half CJK as warnings only.
