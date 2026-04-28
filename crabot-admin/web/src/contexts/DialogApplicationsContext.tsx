import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { dialogObjectsService } from '../services/dialog-objects'
import { useAuth } from './AuthContext'

interface DialogApplicationsContextValue {
  count: number
  refresh: () => Promise<void>
}

const Ctx = createContext<DialogApplicationsContextValue | undefined>(undefined)

const POLL_INTERVAL_MS = 30_000

export const DialogApplicationsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth()
  const [count, setCount] = useState(0)

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const result = await dialogObjectsService.listApplications()
      setCount(result.items.length)
    } catch {
      // 静默失败：badge 是辅助提示，不应打断主流程
    }
  }, [isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated) {
      setCount(0)
      return
    }

    let intervalId: number | null = null
    const startPolling = () => {
      if (intervalId !== null) return
      intervalId = window.setInterval(refresh, POLL_INTERVAL_MS)
    }
    const stopPolling = () => {
      if (intervalId === null) return
      window.clearInterval(intervalId)
      intervalId = null
    }

    void refresh()
    if (document.visibilityState === 'visible') startPolling()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refresh()
        startPolling()
      } else {
        stopPolling()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [isAuthenticated, refresh])

  const value = useMemo(() => ({ count, refresh }), [count, refresh])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

const NOOP_VALUE: DialogApplicationsContextValue = {
  count: 0,
  refresh: async () => {},
}

export const useDialogApplications = (): DialogApplicationsContextValue => {
  return useContext(Ctx) ?? NOOP_VALUE
}
