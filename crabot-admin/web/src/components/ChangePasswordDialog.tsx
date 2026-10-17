import React, { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { authService } from '../services/auth'
import { useToast } from '../contexts/ToastContext'
import { Button } from './Common/Button'
import { Input } from './Common/Input'
import { Modal } from './Common/Modal'
import { desktopBridge, isDesktop } from '../services/desktop-host'

interface Props {
  onClose: () => void
}

export const ChangePasswordDialog: React.FC<Props> = ({ onClose }) => {
  const { logout } = useAuth()
  const toast = useToast()
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(isDesktop ? null : true)
  useEffect(() => {
    if (!isDesktop) return
    let disposed = false
    void authService.getMe().then(me => { if (!disposed) setConfigured(me.password_configured !== false) },
      () => { if (!disposed) setError('无法读取浏览器密码状态，请关闭后重试。') })
    return () => { disposed = true }
  }, [])

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError('')
    if (newPwd.length < 4) { setError('新密码至少 4 位'); return }
    if (newPwd !== confirmPwd) { setError('两次输入的密码不一致'); return }

    setLoading(true)
    try {
      await authService.changePassword({ ...(configured ? { old_password: oldPwd } : {}), new_password: newPwd })
      if (isDesktop) {
        toast.success('浏览器访问密码已保存')
        void desktopBridge!.reconnect()
        onClose()
      } else {
        toast.success('密码已修改，请用新密码重新登录')
        logout()
      }
    } catch (err) {
      const e = err as Error & { body?: { error?: string } }
      if (e.body?.error === 'ADMIN_INVALID_OLD_PASSWORD') {
        setError('旧密码错误')
      } else {
        setError(e.message || '修改失败')
      }
      setLoading(false)
    }
  }

  return (
    <Modal
      open
      onClose={loading ? () => {} : onClose}
      title={isDesktop ? '浏览器访问密码' : '修改密码'}
      description={isDesktop ? '桌面无需密码。需要通过浏览器访问时，可在此设置密码；已有密码仍需验证旧密码。' : '为保护账号安全，修改成功后将自动登出，请用新密码重新登录。'}
      dismissOnBackdrop={!loading}
      dismissOnEscape={!loading}
      hideCloseButton={loading}
    >
      <form onSubmit={handleSubmit} className="change-pwd-form">
        {configured && <Input
          type="password"
          label="旧密码"
          autoComplete="current-password"
          value={oldPwd}
          onChange={(e) => setOldPwd(e.target.value)}
          disabled={loading}
          required
        />}
        <Input
          type="password"
          label="新密码"
          autoComplete="new-password"
          placeholder="至少 4 位"
          value={newPwd}
          onChange={(e) => setNewPwd(e.target.value)}
          disabled={loading}
          required
        />
        <Input
          type="password"
          label="确认新密码"
          autoComplete="new-password"
          value={confirmPwd}
          onChange={(e) => setConfirmPwd(e.target.value)}
          disabled={loading}
          required
        />
        {error && (
          <div className="change-pwd-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={loading}
          >
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={loading || configured === null || configured && !oldPwd || !newPwd || !confirmPwd}
          >
            {loading ? '提交中…' : '确定'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
