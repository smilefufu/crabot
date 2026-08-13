/**
 * P6-A §10：/traces 主入口 —— v3 Managers / Workers 双 tab。
 * legacy conversation-unit / raw trace 主视图已退役；trace 清理走专用维护面（CleanupDialogs）。
 */
import React, { useState } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { ManagersView } from './ManagersView'
import { WorkersView } from './WorkersView'
import { ManualCleanupDialog } from './CleanupDialogs'

type Tab = 'managers' | 'workers'

export const Traces: React.FC = () => {
  const [tab, setTab] = useState<Tab>('managers')
  const [cleanupOpen, setCleanupOpen] = useState(false)

  return (
    <MainLayout>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant={tab === 'managers' ? 'primary' : 'secondary'} onClick={() => setTab('managers')}>
            Managers
          </Button>
          <Button variant={tab === 'workers' ? 'primary' : 'secondary'} onClick={() => setTab('workers')}>
            Workers
          </Button>
        </div>
        <Button variant="secondary" onClick={() => setCleanupOpen(true)}>
          Trace 清理
        </Button>
      </div>
      {tab === 'managers' ? <ManagersView /> : <WorkersView />}
      <ManualCleanupDialog open={cleanupOpen} onClose={() => setCleanupOpen(false)} onDeleted={() => setCleanupOpen(false)} />
    </MainLayout>
  )
}

export default Traces
