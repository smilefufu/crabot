import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ToastProvider } from './contexts/ToastContext'
import { Login } from './pages/Login'
import { Chat } from './pages/Chat'
import { ProviderManagement } from './pages/Providers/ProviderManagement'
import { ModuleList } from './pages/Modules/ModuleList'
import { ModuleDetail } from './pages/Modules/ModuleDetail'
import { AgentConfig } from './pages/Agents/AgentConfig'
import { ChannelConfig } from './pages/Channels/ChannelConfig'
import { ChannelPty } from './pages/Channels/ChannelPty'
import { GlobalSettings } from './pages/Settings/GlobalSettings'
import { MemoryV2Page } from './pages/Memory/v2/MemoryV2Page'
import { ShortTermBrowser } from './pages/Memory/ShortTermBrowser'
import { SceneProfileList } from './pages/Memory/SceneProfileList'
import { SceneProfileDetail } from './pages/Memory/SceneProfileDetail'
import { DialogObjectsPage } from './pages/DialogObjects'
import { MCPServerList } from './pages/MCPServers/MCPServerList'
import { PermissionTemplateList } from './pages/Permissions/PermissionTemplateList'
import { SkillList } from './pages/Skills/SkillList'
import { Traces } from './pages/Traces'
import { ScheduleList } from './pages/Schedules/ScheduleList'
import './App.css'

const PrivateRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" replace />
}

const AppRoutes: React.FC = () => {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/chat"
        element={
          <PrivateRoute>
            <Chat />
          </PrivateRoute>
        }
      />
      <Route
        path="/providers"
        element={
          <PrivateRoute>
            <ProviderManagement />
          </PrivateRoute>
        }
      />
      <Route
        path="/modules"
        element={
          <PrivateRoute>
            <ModuleList />
          </PrivateRoute>
        }
      />
      <Route
        path="/modules/:id"
        element={
          <PrivateRoute>
            <ModuleDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/agents/config"
        element={
          <PrivateRoute>
            <AgentConfig />
          </PrivateRoute>
        }
      />
      <Route
        path="/channels/config"
        element={
          <PrivateRoute>
            <ChannelConfig />
          </PrivateRoute>
        }
      />
      <Route
        path="/channels/pty"
        element={
          <PrivateRoute>
            <ChannelPty />
          </PrivateRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <PrivateRoute>
            <GlobalSettings />
          </PrivateRoute>
        }
      />
      <Route path="/memory" element={<Navigate to="/memory/long-term" replace />} />
      <Route
        path="/memory/long-term"
        element={
          <PrivateRoute>
            <MemoryV2Page />
          </PrivateRoute>
        }
      />
      <Route
        path="/memory/short-term"
        element={
          <PrivateRoute>
            <ShortTermBrowser />
          </PrivateRoute>
        }
      />
      <Route
        path="/memory/scenes"
        element={
          <PrivateRoute>
            <SceneProfileList />
          </PrivateRoute>
        }
      />
      <Route
        path="/memory/scenes/:key"
        element={
          <PrivateRoute>
            <SceneProfileDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/dialog-objects"
        element={
          <PrivateRoute>
            <DialogObjectsPage />
          </PrivateRoute>
        }
      />
      <Route path="/friends" element={<Navigate to="/dialog-objects" replace />} />
      <Route path="/friends/pending" element={<Navigate to="/dialog-objects" replace />} />
      <Route path="/friends/:id" element={<Navigate to="/dialog-objects" replace />} />
      <Route
        path="/permission-templates"
        element={
          <PrivateRoute>
            <PermissionTemplateList />
          </PrivateRoute>
        }
      />
      <Route
        path="/mcp-servers"
        element={
          <PrivateRoute>
            <MCPServerList />
          </PrivateRoute>
        }
      />
      <Route
        path="/skills"
        element={
          <PrivateRoute>
            <SkillList />
          </PrivateRoute>
        }
      />
      <Route
        path="/traces"
        element={
          <PrivateRoute>
            <Traces />
          </PrivateRoute>
        }
      />
      <Route path="/sessions" element={<Navigate to="/dialog-objects" replace />} />
      <Route
        path="/schedules"
        element={
          <PrivateRoute>
            <ScheduleList />
          </PrivateRoute>
        }
      />
      <Route path="/" element={<Navigate to="/chat" replace />} />
    </Routes>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <AppRoutes />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
