import { defineConfig } from 'vitest/config'

/**
 * This package is pure host logic: the suites drive the mounted row over a fake
 * context and the method table over a fake board face, so node is the whole
 * environment and nothing needs a DOM.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    pool: 'forks',
  },
})
