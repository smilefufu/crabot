/**
 * P6-A §10：/traces 主入口 —— v3 Managers / Workers 双 tab。
 * legacy conversation-unit / raw trace 主视图已退役；trace 清理走专用维护面（CleanupDialogs）。
 */
import React, { useState } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { ManagersView } from './ManagersView'
import { WorkersView } from './WorkersView'
import { ManualCleanupDialog } from './CleanupDialogs'
import './TraceOverview.css'

type Tab = 'managers' | 'workers'

export const Traces: React.FC = () => {
  const [tab, setTab] = useState<Tab>('managers')
  const [cleanupOpen, setCleanupOpen] = useState(false)

  return (
    <MainLayout>
      <div className="trace-overview">
        <header className="trace-overview__heading">
          <h1>运行记录</h1>
          <button className="trace-overview__cleanup" type="button" onClick={() => setCleanupOpen(true)}>清理记录</button>
        </header>
        <div className="trace-overview__tabs" role="tablist" aria-label="运行记录视图">
          <button className={tab === 'managers' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'managers'} onClick={() => setTab('managers')}>
            会话
          </button>
          <button className={tab === 'workers' ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === 'workers'} onClick={() => setTab('workers')}>
            执行器
          </button>
        </div>
        <div className="trace-overview__content" role="tabpanel" aria-label={tab === 'managers' ? '会话' : '执行器'}>
          {tab === 'managers' ? <ManagersView /> : <WorkersView />}
        </div>
      </div>
      <ManualCleanupDialog open={cleanupOpen} onClose={() => setCleanupOpen(false)} onDeleted={() => setCleanupOpen(false)} />
    </MainLayout>
  )
}

export default Traces
