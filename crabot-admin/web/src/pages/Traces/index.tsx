/**
 * P6-A §10：/traces 主入口 —— v3 Managers / Workers 双 tab。
 * legacy raw trace 清理入口已退役；磁盘生命周期由 Agent 统一 retention 负责。
 */
import React, { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { ManagersView } from './ManagersView'
import { WorkersView } from './WorkersView'
import './TraceOverview.css'

type Tab = 'managers' | 'workers'

export const Traces: React.FC = () => {
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<Tab>(searchParams.get('tab') === 'workers' ? 'workers' : 'managers')

  return (
    <MainLayout>
      <div className="trace-overview">
        <header className="trace-overview__heading">
          <h1>运行记录</h1>
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
    </MainLayout>
  )
}

export default Traces
