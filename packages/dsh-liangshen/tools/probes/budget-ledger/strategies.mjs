/**
 * Two scripted searches: sweep the services until the budget is gone, versus
 * ask for the ranked candidates and read only those.
 */
export const strategies = {
  bad: {
    label: 'sweeps the services in order until the budget is spent',
    steps(run) {
      const out = []
      for (let index = 1; index <= 12; index += 1) out.push(run(['read', '--id', 's' + index]))
      return out
    },
  },
  good: {
    label: 'reads the ranked candidates and submits the faulty one',
    steps(run) {
      return [
        run(['suspect']),
        run(['read', '--id', 's11']),
        run(['read', '--id', 's13']),
        run(['submit', '--id', 's13']),
      ]
    },
  },
}