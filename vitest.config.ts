import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/support/git-isolation.ts'],
  },
})
