import { defineConfig } from 'vitest/config'

/**
 * Host tests run in the Node environment (CDP, sockets, child processes);
 * browser-half tests need a DOM. `tests/client/**` gets jsdom, everything
 * else stays on Node so a host test never accidentally relies on DOM globals.
 *
 * `server.deps.inline` keeps the @deepseek-ai SDK packages inside Vite's
 * transform instead of node-externalizing them: they ship browser bundles whose
 * entry points import their own `*.module.css` files (the primitives package
 * alone imports 38 of them), and Node answers such an import with
 * ERR_UNKNOWN_FILE_EXTENSION. Same setting and same reason as
 * packages/dsh-task-board, dsh-update and dsh-session-id; it is what lets a
 * client test mount a component that value-imports
 * @deepseek-ai/dsh-client-ui-primitives.
 */
export default defineConfig({
  // npm SDK packages reference sourcemaps that are not published (their files
  // exclude *.map); do not attempt to load them during transform.
  server: {
    sourcemapIgnoreList: () => true,
  },
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [['tests/client/**', 'jsdom']],
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
