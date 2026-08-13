import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ToastProvider } from './contexts/ToastContext'
import { DialogApplicationsProvider } from './contexts/DialogApplicationsContext'
import { Login } from './pages/Login'
import { SetupPassword } from './pages/SetupPassword'
import { Chat } from './pages/Chat'
import { ProviderManagement } from './pages/Providers/ProviderManagement'
import { ModuleList } from './pages/Modules/ModuleList'
import { ModuleDetail } from './pages/Modules/ModuleDetail'
import { AgentConfig } from './pages/Agents/AgentConfig'
import { ChannelConfig } from './pages/Channels/ChannelConfig'
import { NewChannel } from './pages/Channels/NewChannel'
import { NewChannelOnboarding } from './pages/Channels/NewChannelOnboarding'
import { GlobalSettings } from './pages/Settings/GlobalSettings'
import { MemoryV2Page } from './pages/Memory/v2/MemoryV2Page'
import { ShortTermBrowser } from './pages/Memory/ShortTermBrowser'
import { SceneProfileList } from './pages/Memory/SceneProfileList'
import { SceneProfileDetail } from './pages/Memory/SceneProfileDetail'
import { DialogObjectsPage } from './pages/DialogObjects'
import { MCPServerList } from './pages/MCPServers/MCPServerList'
import { PermissionTemplateList } from './pages/Permissions/PermissionTemplateList'
import { SkillList } from './pages/Skills/SkillList'
import { SubagentList } from './pages/Subagents/SubagentList'
import { Traces } from './pages/Traces'
import { ManagerDetail } from './pages/Traces/ManagerDetail'
import { WorkerDetail } from './pages/Traces/WorkerDetail'
import { ScheduleList } from './pages/Schedules/ScheduleList'
import { OpenClawImportWizard } from './pages/OpenClawImport/OpenClawImportWizard'
import { BackupExportPage } from './pages/Backup/BackupExportPage'
import './App.css'

const PrivateRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isTemp } = useAuth()
  const location = useLocation()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  if (isTemp === null) return <div style={{ padding: 24 }}>加载中...</div>
  if (isTemp === true && location.pathname !== '/setup-password') {
    return <Navigate to="/setup-password" replace />
  }
  return <>{children}</>
}

const AppRoutes: React.FC = () => {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/setup-password"
        element={
          <PrivateRoute>
            <SetupPassword />
          </PrivateRoute>
        }
      />
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
        path="/channels/new"
        element={
          <PrivateRoute>
            <NewChannel />
          </PrivateRoute>
        }
      />
      <Route
        path="/channels/new/:implId/:methodId"
        element={
          <PrivateRoute>
            <NewChannelOnboarding />
          </PrivateRoute>
        }
      />
      <Route
        path="/migrate/openclaw"
        element={
          <PrivateRoute>
            <OpenClawImportWizard />
          </PrivateRoute>
        }
      />
      <Route
        path="/backup"
        element={
          <PrivateRoute>
            <BackupExportPage />
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
        path="/subagents"
        element={
          <PrivateRoute>
            <SubagentList />
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
      <Route
        path="/traces/managers/:managerKey"
        element={
          <PrivateRoute>
            <ManagerDetail />
          </PrivateRoute>
        }
      />
      <Route
        path="/traces/workers/:workerId"
        element={
          <PrivateRoute>
            <WorkerDetail />
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
          <DialogApplicationsProvider>
            <AppRoutes />
          </DialogApplicationsProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}

export default App
