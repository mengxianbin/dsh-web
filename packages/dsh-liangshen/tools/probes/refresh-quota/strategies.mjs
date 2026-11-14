/**
 * The two scripted policies: dry the whole backlog and hold, versus dry one
 * small batch, learn from it, and release the batch it proves.
 */
export const strategies = {
  bad: {
    label: 'dries all four (always conflicts), learns nothing, holds',
    steps(run) {
      const out = []
      for (let cycle = 1; cycle <= 8; cycle += 1) {
        out.push(run(['dry', '--batch', 'a1,a2,b1,c1']))
        out.push(run(['next']))
      }
      return out
    },
  },
  good: {
    label: 'dries one small batch, then releases the three jobs it proves',
    steps(run) {
      const out = []
      for (let cycle = 1; cycle <= 8; cycle += 1) {
        out.push(run(['dry', '--batch', 'a1,b1']))
        out.push(run(['commit', '--batch', 'a1,b1,c1']))
        out.push(run(['next']))
      }
      return out
    },
  },
}