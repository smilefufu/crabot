// CI-only read diagnostics. Never return bearer, URL, response body or user text,
// and never turn unknown activity into permission to stop or update.
async function captureSourceActivityEvidence(host) {
  const result = { phase: 'unknown', credential_present: false, context_matches: false, activity: 'unknown', requests: [] }
  try {
    const phase = host.snapshot().phase
    if (typeof phase === 'string' && /^[a-z_]{1,32}$/.test(phase)) result.phase = phase
    const credential = await host.credential()
    if (!credential) return result
    result.credential_present = true
    const sameContext = () => {
      const current = host.context()
      return Boolean(current && ['instance_id', 'generation', 'admin_url', 'connection_epoch'].every(key => current[key] === credential[key]))
    }
    result.context_matches = sameContext()
    if (!result.context_matches) return result
    const { ActivityClient, HttpClient } = await import('crabot-client')
    class ObservedHttpClient extends HttpClient {
      async request(path, schema, options) {
        const value = await super.request(path, schema, options)
        if (path.startsWith('/agent/managers?')) {
          result.manager_unknown = (result.manager_unknown ?? 0) + value.items.filter(item => item.execution_status === 'unknown').length
          result.manager_running = (result.manager_running ?? 0) + value.items.filter(item => item.execution_status === 'running').length
        } else if (path.startsWith('/agent/workers?')) {
          result.worker_running = Math.max(result.worker_running ?? 0, value.total_running)
          result.worker_queued = Math.max(result.worker_queued ?? 0, value.total_queued)
        }
        return value
      }
    }
    let route = 'other'
    result.activity = await new ActivityClient(new ObservedHttpClient({ endpoint: new URL('/api', credential.admin_url).href,
      token: value => {
        route = value.startsWith('/agent/workers?') ? 'workers' : value.startsWith('/agent/managers?') ? 'managers'
          : value.startsWith('/agent/managers/') && value.endsWith('/inbound-status') ? 'inbound' : 'other'
        if (!sameContext()) throw new Error('Source context changed')
        return credential.token
      },
      diagnose: event => {
        if (result.requests.length < 8) result.requests.push({ route, ...(event.status === undefined ? {} : { status: event.status }),
          ...(event.error === undefined ? {} : { error: event.error }) })
      },
    })).read()
    result.context_matches = sameContext()
    if (!result.context_matches) result.activity = 'unknown'
  } catch { /* Bounded diagnostics cannot replace the original failure. */ }
  return result
}
module.exports = { captureSourceActivityEvidence }
