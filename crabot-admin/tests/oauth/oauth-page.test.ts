import { describe, it, expect } from 'vitest'
import { oauthSuccessHtml, oauthErrorHtml } from '../../src/oauth/oauth-page.js'

describe('oauth-page', () => {
  describe('oauthSuccessHtml', () => {
    it('包含成功标题与传入的 message', () => {
      const html = oauthSuccessHtml('Login complete')
      expect(html).toContain('<title>Authentication successful</title>')
      expect(html).toContain('Authentication successful')
      expect(html).toContain('Login complete')
    })
  })

  describe('oauthErrorHtml', () => {
    it('包含失败标题与传入的 message', () => {
      const html = oauthErrorHtml('State mismatch.')
      expect(html).toContain('<title>Authentication failed</title>')
      expect(html).toContain('Authentication failed')
      expect(html).toContain('State mismatch.')
    })

    it('details 为可选，提供时渲染', () => {
      const html = oauthErrorHtml('msg', 'extra detail string')
      expect(html).toContain('extra detail string')
      expect(html).toContain('class="details"')
    })

    it('对 message 中的 HTML 特殊字符做转义，避免 XSS', () => {
      const html = oauthErrorHtml('<script>alert(1)</script>')
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    })
  })
})
