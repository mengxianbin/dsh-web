/**
 * Host-only build config for the auto-route plugin: node-half lib/ only
 * (no src/client entry, so the shared preset skips the browser face).
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('dsh-auto-route', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-host-webserver',
  ],
})
