import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { authService } from '../services/auth'
import { isDesktop } from '../services/desktop-host'

interface AuthContextType {
  isAuthenticated: boolean
  isTemp: boolean | null
  login: (password: string) => Promise<void>
  refreshMe: () => Promise<void>
  markPasswordChanged: () => void
  logout: () => void
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(authService.isAuthenticated())
  const [isTemp, setIsTemp] = useState<boolean | null>(isDesktop ? false : null)

  const refreshMe = useCallback(async () => {
    if (isDesktop) { setIsTemp(false); return }
    if (!authService.isAuthenticated()) {
      setIsTemp(null)
      return
    }
    try {
      const me = await authService.getMe()
      setIsTemp(me.is_temp)
    } catch (e) {
      // api.ts 已经在 401 时自动 logout 跳 /login；这里只兜底网络/5xx
      setIsTemp(null)
    }
  }, [])

  useEffect(() => {
    setIsAuthenticated(authService.isAuthenticated())
    void refreshMe()
  }, [refreshMe])

  const login = async (password: string) => {
    const resp = await authService.login(password)
    setIsAuthenticated(true)
    setIsTemp(resp.is_temp)
  }

  const markPasswordChanged = () => {
    setIsTemp(false)
  }

  const logout = () => {
    authService.logout()
    if (isDesktop) return
    setIsAuthenticated(false)
    setIsTemp(null)
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, isTemp, login, refreshMe, markPasswordChanged, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
