import type { ExecutionObservation } from 'crabot-shared/dist/execution-observation.js'

export function ExecutionFacts({ observation }: { observation?: ExecutionObservation }) {
  return <section aria-label="执行事实" style={{ margin: '24px 0' }}>
    <h2 style={{ fontSize: 16 }}>该执行化身的工具装配记录</h2>
    {!observation || observation.state === 'legacy_unknown'
      ? <p>历史工具未知：未找到该化身记录，不能从当前配置补推。</p>
      : <div>
        <p>已记录 · {observation.source} · {observation.observed_at} · 策略版本 {observation.policy_version}</p>
        <p>工具：{observation.tools?.join('、') || (observation.tools === null ? '原生工具未知' : '无')}</p>
        <p>子 Agent：{observation.child_profiles.join('、') || '无'}；MCP：{observation.mcp_servers.join('、') || '无'}</p>
        <p>Skill：{observation.skills.join('、') || '无'}</p>
        <p>{observation.constraints.join(' ')}</p>
        <small>记录版本：{observation.revision}</small>
      </div>}
    <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>权限修改只影响新派发的 Worker；既有 Worker 和子 Agent 使用父 Worker 的固定主体快照。</p>
  </section>
}
