/**
 * Test config for the dsh-agents package: both halves live here, so the glob
 * covers .ts and .tsx specs. The default environment is node (the Host specs
 * open real servers and files); a browser spec opts in per file with
 * `// @vitest-environment jsdom`. Forks pool so a ledger owner lock written by
 * one spec cannot leak into another.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    pool: 'forks',
    // @deepseek-ai SDK packages ship browser bundles (CSS imports included);
    // keep them vite-transformed instead of node-externalized.
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
