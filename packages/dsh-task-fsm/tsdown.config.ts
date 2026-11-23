import { clientBundle } from '../../shared/tsdown.client.ts'

// Node half only: the browser half (src/client/index.ts) is picked up
// automatically by clientBundle's client pass — passing it here would run
// the client's module CSS through the lib build, which has no CSS pipeline.
export default clientBundle('dsh-task-fsm', ['src/index.ts'])
