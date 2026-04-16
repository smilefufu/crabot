import React from 'react'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { ConfigStatusBanner } from '../ConfigStatusBanner'

interface MainLayoutProps {
  children: React.ReactNode
}

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  return (
    <div style={{ display: 'flex' }}>
      <Sidebar />
      <div style={{ marginLeft: 'var(--sidebar-width)', width: 'calc(100% - var(--sidebar-width))' }}>
        <Header />
        <main style={{ marginTop: 'var(--header-height)', padding: '2rem' }}>
          <ConfigStatusBanner />
          {children}
        </main>
      </div>
    </div>
  )
}
