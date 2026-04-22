import React from 'react'
import { useLocation } from 'react-router-dom'
import { MemoryBrowser } from './MemoryBrowser'
import { parseMemoryContextQuery } from './memoryContextQuery'

type TabType = 'short' | 'long'
type TaskMode = 'browse' | 'search' | 'context'

export const MemoryEntriesPage: React.FC = () => {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const tab = params.get('tab')
  const mode = params.get('mode')
  const initialTab: TabType = tab === 'long' ? 'long' : 'short'
  const initialMode: TaskMode = mode === 'search' || mode === 'context' ? mode : 'browse'
  const initialContext = parseMemoryContextQuery(location.search)

  return (
    <MemoryBrowser
      initialTab={initialTab}
      initialMode={initialMode}
      initialContext={initialContext}
    />
  )
}
