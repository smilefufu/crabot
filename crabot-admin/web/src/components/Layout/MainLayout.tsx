import React from 'react'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { ConfigStatusBanner } from '../ConfigStatusBanner'

interface MainLayoutProps {
  children: React.ReactNode
}

export const MainLayout: React.FC<MainLayoutProps> = ({ children }) => {
  return (
    <div className="app-layout">
      <Sidebar />
      <div className="app-layout__content">
        <Header />
        <main className="app-layout__main">
          <ConfigStatusBanner />
          {children}
        </main>
      </div>
    </div>
  )
}
