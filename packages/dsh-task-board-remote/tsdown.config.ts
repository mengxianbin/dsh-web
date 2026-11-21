/**
 * Standalone tsdown config for the dsh-task-board-remote plugin.
 *
 * This package is host-only (it ships no browser half): the node-half library is
 * built from src, and the shared client-bundle preset emits no browser artifact
 * when src/client/index.ts is absent. The preset is imported rather than copied,
 * per packages/AGENTS.md.
 */
import { clientBundle } from '../../shared/tsdown.client.ts'

export default clientBundle('@linxin666/dsh-task-board-remote', ['src/index.ts'], {})
