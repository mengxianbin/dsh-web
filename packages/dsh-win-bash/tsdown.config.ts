/**
 * Standalone tsdown config for the dsh-win-bash plugin.
 *
 * This package is host-only (it ships no browser half): the node-half library
 * is built from src, and the shared client-bundle preset detects the missing
 * src/client/index.ts and emits no browser artifact. The preset is imported
 * rather than copied, per packages/AGENTS.md.
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('@linxin666/dsh-win-bash', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-sandbox',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-tools',
  ],
})
