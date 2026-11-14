/**
 * Family-row stand-in whose plugin body fails during start on the ASYNC path:
 * the module imports fine, apply returns a promise, and that promise rejects
 * after the first await — the shape a real plugin takes when it awaits a
 * resource it cannot acquire (the task board's ledger lock, issue #1730/#1850).
 * Its synchronous twin is fixtures/throwing-row.ts.
 */
export async function apply(): Promise<void> {
  await Promise.resolve()
  throw new Error('task-board ledger is already owned by process 4242')
}
