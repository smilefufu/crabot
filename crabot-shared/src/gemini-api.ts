/** Gemini native URL and API-key authentication; no transport or session policy. */
export function geminiModelId(model: string): string {
  const id = model.replace(/^models\//, '')
  if (!id || id === '.' || id === '..' || /[/?#]/.test(id)) throw new Error('Invalid Gemini model ID')
  return id
}

export function geminiApiUrl(endpoint: string, model?: string): string {
  const base = new URL(endpoint)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Gemini endpoint must be an HTTP base URL without credentials, query or fragment')
  }
  let path = base.pathname.replace(/\/+$/, '')
  if (!/\/v1(?:beta)?$/.test(path)) path += '/v1beta'
  base.pathname = path + '/models'
  if (model !== undefined) {
    base.pathname += '/' + encodeURIComponent(geminiModelId(model)) + ':streamGenerateContent'
    base.searchParams.set('alt', 'sse')
  }
  return base.toString()
}

export function geminiApiHeaders(endpoint: string, apikey: string): Record<string, string> {
  return new URL(endpoint).hostname === 'generativelanguage.googleapis.com'
    ? { 'x-goog-api-key': apikey }
    : { Authorization: `Bearer ${apikey}` }
}
