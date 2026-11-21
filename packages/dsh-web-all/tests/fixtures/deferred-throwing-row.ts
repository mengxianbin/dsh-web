/**
 * Family-row stand-in whose plugin declares an injected service, so cordis
 * defers its apply until that service exists — the shape EVERY real family
 * plugin has (the task board injects systemPrompt / typertGateway /
 * workspaceRegistry / webServer / agents / commands). When the service finally
 * appears the deferred apply runs and throws the ledger-lock error of issues
 * #1730/#1850: the module imported fine, and the failure lands on a fiber that
 * had ALREADY settled as pending when the shell mounted it.
 */
export const inject = ['lateSvc'] as const

export function apply(): void {
  throw new Error('task-board ledger is already owned by process 4242')
}
