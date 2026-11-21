import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.{spec,test}.{ts,tsx}'],
    pool: 'forks',
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
