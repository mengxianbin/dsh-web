/**
 * Host-only build config for the session-revive plugin: node-half lib/ only
 * (no src/client entry, so the shared preset skips the browser face).
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('dsh-session-revive', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-session',
  ],
})
