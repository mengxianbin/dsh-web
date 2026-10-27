/**
 * Host-only build config for the MiMo re-login plugin: node-half lib/ only
 * (no src/client entry, so the shared preset skips the browser face).
 * `@deepseek-ai/dsh-credentials` stays bundled (the credentialRef brand and
 * grammar helpers inline), mirroring dsh-usage.
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('dsh-mimo-relogin', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
  ],
})
