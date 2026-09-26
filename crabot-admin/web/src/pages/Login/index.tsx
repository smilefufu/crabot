import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { providerService } from '../../services/provider'
import { agentService } from '../../services/agent'
import { useAuth } from '../../contexts/AuthContext'
import { Input } from '../../components/Common/Input'
import { Button } from '../../components/Common/Button'

export const Login: React.FC = () => {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { login } = useAuth()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      await login(password)
      let destination = '/chat'
      try {
        const [globalConfig, agentConfig] = await Promise.all([
          providerService.getGlobalConfig(),
          agentService.getConfig(),
        ])
        const defaultModel = agentConfig.model_config?.default
        const hasModel = (defaultModel?.provider_id && defaultModel.model_id)
          || (globalConfig.default_llm_provider_id && globalConfig.default_llm_model_id)
        if (!hasModel) destination = '/providers'
      } catch {
        // 配置查询暂时不可用不影响已成功的登录，默认进入聊天。
      }
      navigate(destination, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-brand">
          <h1 className="login-title">Crabot</h1>
          <p className="login-subtitle">AI Employee Administration</p>
        </div>

        <div className="login-card">
          <form onSubmit={handleSubmit}>
            {error && (
              <div className="error-message">{error}</div>
            )}

            <Input
              type="password"
              label="访问密码"
              placeholder="请输入管理员密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />

            <Button
              type="submit"
              variant="primary"
              disabled={loading || !password}
            >
              {loading ? '验证中…' : '进入系统'}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
