/**
 * localStorage 工具函数
 */

const TOKEN_KEY = 'crabot_admin_token'
const TOKEN_EXPIRES_KEY = 'crabot_admin_token_expires'

export const storage = {
  getToken(): string | null {
    const token = localStorage.getItem(TOKEN_KEY)
    const expires = localStorage.getItem(TOKEN_EXPIRES_KEY)

    if (!token || !expires) {
      return null
    }

    // 检查是否过期
    if (new Date(expires) < new Date()) {
      this.clearToken()
      return null
    }

    return token
  },

  setToken(token: string, expiresAt: string): void {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(TOKEN_EXPIRES_KEY, expiresAt)
  },

  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(TOKEN_EXPIRES_KEY)
  },

  isAuthenticated(): boolean {
    return this.getToken() !== null
  },
}
