import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { it, expect } from 'vitest'
import type { StoragePermission } from '../types'
import { StoragePermissionEditor } from './StoragePermissionEditor'
function Fixture() {
  const [value, setValue] = useState<StoragePermission | null>(null)
  return <><StoragePermissionEditor value={value} onChange={setValue} /><output data-testid="value">{JSON.stringify(value)}</output></>
}
it('roundtrips default, explicit all/readwrite and directory without a hidden stale path', () => {
  render(<Fixture />)
  expect(screen.getByTestId('value').textContent).toBe('null')
  fireEvent.click(screen.getByLabelText('授权额外目录'))
  fireEvent.change(screen.getByLabelText('额外目录路径'), { target: { value: '/project' } })
  fireEvent.change(screen.getByLabelText('目录授权模式'), { target: { value: 'all' } })
  fireEvent.change(screen.getByLabelText('访问级别'), { target: { value: 'readwrite' } })
  expect(JSON.parse(screen.getByTestId('value').textContent!)).toEqual({ scope: 'all', access: 'readwrite' })
  expect(screen.queryByLabelText('额外目录路径')).toBeNull()
  fireEvent.change(screen.getByLabelText('目录授权模式'), { target: { value: 'directory' } })
  expect(JSON.parse(screen.getByTestId('value').textContent!)).toEqual({ workspace_path: '', access: 'readwrite' })
  fireEvent.click(screen.getByLabelText('授权额外目录'))
  expect(screen.getByTestId('value').textContent).toBe('null')
})
