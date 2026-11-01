import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'], pool: process.platform === 'win32' ? 'forks' : 'threads', maxWorkers: 2, minWorkers: 1 } })
