import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { ExecutionFacts } from './ExecutionFacts'
import type { ExecutionObservation } from 'crabot-shared/dist/execution-observation.js'

it('missing history is unknown and never describes current permissions as historical tools', () => {
  render(<ExecutionFacts />)
  expect(screen.getByText(/历史工具未知/)).toBeInTheDocument()
  expect(screen.queryByText(/已记录/)).not.toBeInTheDocument()
})
it('displays the selected child observation and the provision limit', () => {
  const observation: ExecutionObservation = { schema_version: 1, policy_version: 1, state: 'assembled', role: 'child', impl: 'builtin',
    source: 'builtin_request', observed_at: '2026-10-10T00:00:00Z', revision: 'a'.repeat(64), worker_id: 'w-fixture',
    incarnation_id: 'parent', subagent_id: 'child', tools: ['Read'], child_profiles: [], mcp_servers: ['scrapling'],
    skills: ['fixture-skill'], native_tools: null, constraints: ['child role limit'] }
  render(<ExecutionFacts observation={observation} />)
  expect(screen.getByText('工具：Read')).toBeInTheDocument()
  expect(screen.getByText(/scrapling/)).toBeInTheDocument()
  expect(screen.getByText(/fixture-skill/)).toBeInTheDocument()
  expect(screen.getByText('child role limit')).toBeInTheDocument()
})
