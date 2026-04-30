import { describe, it, expect } from 'vitest'
import { buildCreateFriendBody, buildUpdateFriendBody } from './friend.js'

describe('buildCreateFriendBody', () => {
  it('master 权限最小输入', () => {
    expect(buildCreateFriendBody({ name: '老板', permission: 'master' })).toEqual({
      display_name: '老板',
      permission: 'master',
    })
  })

  it('normal 权限带 permission_template', () => {
    expect(
      buildCreateFriendBody({ name: '同事', permission: 'normal', permissionTemplate: 'standard' })
    ).toEqual({
      display_name: '同事',
      permission: 'normal',
      permission_template_id: 'standard',
    })
  })

  it('字段名是 display_name 不是 name（admin 协议）', () => {
    const body = buildCreateFriendBody({ name: 'X', permission: 'normal' })
    expect(body).toHaveProperty('display_name')
    expect(body).not.toHaveProperty('name')
  })

  it('--name 为空报错', () => {
    expect(() => buildCreateFriendBody({ name: '   ', permission: 'master' })).toThrow(/name 不能为空/)
  })

  it('非法 permission 报错', () => {
    expect(() => buildCreateFriendBody({ name: 'X', permission: 'admin' })).toThrow(/permission 必须是/)
  })
})

describe('buildUpdateFriendBody', () => {
  it('单字段 name 更新', () => {
    expect(buildUpdateFriendBody({ name: '新名字' })).toEqual({
      display_name: '新名字',
    })
  })

  it('单字段 permission 更新', () => {
    expect(buildUpdateFriendBody({ permission: 'master' })).toEqual({
      permission: 'master',
    })
  })

  it('permission_template_id 更新', () => {
    expect(buildUpdateFriendBody({ permissionTemplate: 'guest' })).toEqual({
      permission_template_id: 'guest',
    })
  })

  it('多字段同时更新', () => {
    expect(
      buildUpdateFriendBody({ name: 'X', permission: 'normal', permissionTemplate: 'standard' })
    ).toEqual({
      display_name: 'X',
      permission: 'normal',
      permission_template_id: 'standard',
    })
  })

  it('字段名是 display_name 不是 name（admin 协议）', () => {
    const body = buildUpdateFriendBody({ name: 'X' })
    expect(body).toHaveProperty('display_name')
    expect(body).not.toHaveProperty('name')
  })

  it('什么都不传报错', () => {
    expect(() => buildUpdateFriendBody({})).toThrow(/至少需要提供/)
  })

  it('非法 permission 报错', () => {
    expect(() => buildUpdateFriendBody({ permission: 'admin' })).toThrow(/permission 必须是/)
  })
})
