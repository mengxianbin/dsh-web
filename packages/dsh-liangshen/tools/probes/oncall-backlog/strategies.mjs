/**
 * Two scripted on-call habits: severity first (the P3 tail is never touched)
 * versus deadline first (whatever crosses a threshold next is handled now).
 */
function pick(run, policy) {
  const rows = run(['status']).split('\n')
    .map((text) => /^\s+(a\d+) (P\d) escalates at step (\d+)/.exec(text))
    .filter((match) => match !== null)
    .map((match) => ({ id: match[1], sev: match[2], due: Number(match[3]) }))
  if (policy === 'deadline') {
    return rows.slice()
      .sort((left, right) => left.due - right.due)
      .slice(0, 2)
      .map((row) => row.id)
  }
  // Severity first: the P3 tail waits for a quiet moment that never comes.
  return rows.filter((row) => row.sev !== 'P3')
    .slice()
    .sort((left, right) => left.sev.localeCompare(right.sev))
    .slice(0, 2)
    .map((row) => row.id)
}

function play(run, policy) {
  const out = []
  for (let step = 1; step <= 10; step += 1) {
    const ids = pick(run, policy)
    if (ids.length > 0) out.push(run(['handle', '--ids', ids.join(',')]))
    out.push(run(['next']))
  }
  return out
}

export const strategies = {
  bad: { label: 'sorts by severity, so the P3 tail escalates unattended', steps: (run) => play(run, 'severity') },
  good: { label: 'sorts by the next deadline, so nothing crosses its threshold', steps: (run) => play(run, 'deadline') },
}