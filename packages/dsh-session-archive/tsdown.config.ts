import { clientBundle } from '../../shared/tsdown.client.ts'

// The node half gains a second entry: the seal-state worker script
// (seal-light-host-state-1109 护栏 ②) ships as its own lib file so
// `computeSealInWorker` can spawn it beside the built plugin module.
// `@deepseek-ai/dsh-session` is a runtime value import (appendPluginRecord /
// pluginRecordOf) resolved from the Host's module table — external, never inlined.
export default clientBundle('@linxin666/dsh-session-archive', [
  'src/index.ts',
  'src/host/seal-compute-worker.ts',
], {
  libExternal: ['@deepseek-ai/dsh-session'],
})
