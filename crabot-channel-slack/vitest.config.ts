import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'], poolOptions: { threads: { maxThreads: 2, minThreads: 1 } } } })
