import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStoragePermission } from './storage-permission.js'

test('storage accepts only null, an explicit all scope, or one legacy directory', () => {
  for (const value of [null, { scope: 'all', access: 'read' }, { scope: 'all', access: 'readwrite' }, { workspace_path: '/project', access: 'readwrite' }]) assert.equal(isStoragePermission(value), true)
  for (const value of [undefined, {}, [], { scope: 'all' }, { scope: 'some', access: 'readwrite' }, { scope: 'all', workspace_path: '/', access: 'readwrite' }, { workspace_path: '', access: 'read' }, { workspace_path: '/ok', access: 'write' }, { scope: 'all', access: 'read', extra: true }]) assert.equal(isStoragePermission(value), false)
})
