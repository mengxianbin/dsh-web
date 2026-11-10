/**
 * The two scripted readings of the same rule, so the probe can prove it
 * discriminates before any model is charged for it.
 */
export const strategies = {
  bad: {
    label: 'reads at most 2 as 2 movements, never tests it',
    steps(run) {
      const out = []
      for (let cycle = 1; cycle <= 4; cycle += 1) {
        out.push(run(['check', '--moves', 'm1,m2']))
        out.push(run(['admit', '--moves', 'm1,m2']))
        out.push(run(['next']))
      }
      return out
    },
  },
  good: {
    label: 'spends one call on three movements, sees it pass, admits three',
    steps(run) {
      const out = []
      for (let cycle = 1; cycle <= 4; cycle += 1) {
        out.push(run(['check', '--moves', 'm1,m2,m3']))
        out.push(run(['admit', '--moves', 'm1,m2,m3']))
        out.push(run(['next']))
      }
      return out
    },
  },
}