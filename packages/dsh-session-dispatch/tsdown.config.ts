/**
 * Host-only build config for the session-dispatch plugin: node-half lib/ only
 * (no src/client entry, so the shared preset skips the browser face).
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('dsh-session-dispatch', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-host-webserver',
    // `@deepseek-ai/dsh-session` is a runtime value import (pluginRecordOf /
    // SessionSeq) resolved from the Host's module table — external, never
    // inlined (same stance as the archive plugin). The live writer uses the
    // Session's own public `append` for the cross-copy seam (sessionclass-retry-1126).
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-workspace',
  ],
})
