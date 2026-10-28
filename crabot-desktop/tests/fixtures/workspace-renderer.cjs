// Synthetic CI data only; uses the actual React page, SDK and authenticated HTTP.
module.exports = async function workspaceInventory(window, action) {
  if (!['create', 'usage', 'verify'].includes(action)) throw new Error('Unknown workspace fixture action')
  const run = async function (action) {
    const state = await window.crabotDesktop.getState()
    if (state.phase !== 'ready') throw Error('Desktop session unavailable')
    const wait = async (description, read) => {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)) }
      throw Error('Workspace UI timed out: ' + description)
    }
    const button = text => [...document.querySelectorAll('button')].find(value => value.textContent?.trim() === text && !value.disabled)
    if (location.pathname !== '/workspaces') (await wait('navigation', () => document.querySelector('a[href="/workspaces"]'))).click()
    await wait('workspace page', () => button('添加项目工作区'))
    const name = 'CI中文项目', description = '长期项目工作区验证'
    if (action === 'create') {
      button('添加项目工作区').click()
      const input = await wait('project input', () => [...document.querySelectorAll('label')].find(value => value.textContent.startsWith('项目名称'))?.querySelector('input'))
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, name)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const purpose = [...document.querySelectorAll('label')].find(value => value.textContent.startsWith('用途说明')).querySelector('textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(purpose, description)
      purpose.dispatchEvent(new Event('input', { bubbles: true }))
      ;(await wait('save project', () => button('保存工作区'))).click()
    }
    const row = await wait('project row', () => [...document.querySelectorAll('.workspace-row')].find(value => value.textContent.includes(name)))
    row.click()
    await wait('workspace details', () => document.querySelector('.workspace-facts'))
    if (action === 'usage') (await wait('refresh usage', () => button('刷新空间统计'))).click()
    const result = await wait('authoritative workspace snapshot', async () => {
      const response = await fetch(new URL('/api/workspaces', state.admin_url))
      if (!response.ok) throw Error('Workspace HTTP failed: ' + response.status)
      const snapshot = await response.json(), project = snapshot.items.find(item => item.workspace.name === name)
      if (!project || project.workspace.description !== description) return false
      if (action === 'usage' && (project.usage.status !== 'complete' || project.usage.logical_bytes !== 123)) return false
      return { workspace: project.workspace, usage: project.usage, project_count: snapshot.items.filter(item => item.workspace.kind === 'project').length,
        default_count: snapshot.items.filter(item => item.workspace.kind === 'default').length }
    })
    await wait('details show project purpose', () => document.querySelector('textarea')?.value === description)
    return result
  }
  return window.webContents.executeJavaScript('(' + run.toString() + ')(' + JSON.stringify(action) + ')')
}
