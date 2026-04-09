import React, { useState, useEffect, useCallback } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { Drawer } from '../../components/Common/Drawer'
import { useToast } from '../../contexts/ToastContext'
import { permissionTemplateService } from '../../services/permission-template'
import { PermissionTemplateForm } from './PermissionTemplateForm'
import type { PermissionTemplate } from '../../types'
import { TOOL_CATEGORIES, TOOL_CATEGORY_LABELS } from '../../types'

export const PermissionTemplateList: React.FC = () => {
  const toast = useToast()
  const [templates, setTemplates] = useState<PermissionTemplate[]>([])
  const [loading, setLoading] = useState(true)

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<PermissionTemplate | undefined>(undefined)

  // Delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const result = await permissionTemplateService.list({ page_size: 100 })
      setTemplates(result.items)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载权限模板失败')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const openCreate = () => {
    setEditingTemplate(undefined)
    setDrawerOpen(true)
  }

  const openEdit = (t: PermissionTemplate) => {
    setEditingTemplate(t)
    setDrawerOpen(true)
  }

  const handleDrawerSave = () => {
    setDrawerOpen(false)
    load()
  }

  const handleDelete = async (id: string) => {
    setDeleting(true)
    try {
      await permissionTemplateService.delete(id)
      toast.success('已删除')
      setConfirmDeleteId(null)
      await load()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '删除失败'
      if (msg.includes('TEMPLATE_IN_USE') || msg.includes('in use')) {
        toast.error('该模板正在被使用，无法删除')
      } else {
        toast.error(msg)
      }
      setConfirmDeleteId(null)
    } finally {
      setDeleting(false)
    }
  }

  const getEnabledCategories = (t: PermissionTemplate): string[] => {
    if (!t.tool_access) return []
    return TOOL_CATEGORIES
      .filter(cat => t.tool_access[cat])
      .map(cat => TOOL_CATEGORY_LABELS[cat])
  }

  if (loading) {
    return <MainLayout><Loading /></MainLayout>
  }

  return (
    <MainLayout>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
        }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>权限模板</h1>
          <Button variant="primary" onClick={openCreate}>创建模板</Button>
        </div>

        {/* List */}
        {templates.length === 0 ? (
          <Card>
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
              暂无权限模板
            </div>
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {templates.map(t => {
              const enabledCategories = getEnabledCategories(t)
              const scopesDisplay = t.memory_scopes.length > 0
                ? t.memory_scopes.join(', ')
                : '无限制'

              return (
                <Card key={t.id}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {/* Name + badges */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                        <span style={{ fontWeight: 600, fontSize: '1rem' }}>{t.name}</span>
                        {t.is_system && (
                          <span style={{
                            fontSize: '0.75rem',
                            padding: '0.1rem 0.5rem',
                            background: 'rgba(139, 92, 246, 0.15)',
                            color: '#8b5cf6',
                            borderRadius: '4px',
                          }}>
                            系统
                          </span>
                        )}
                      </div>

                      {/* Description */}
                      {t.description && (
                        <div style={{
                          fontSize: '0.85rem',
                          color: 'var(--text-secondary)',
                          marginBottom: '0.5rem',
                        }}>
                          {t.description}
                        </div>
                      )}

                      {/* Tool access tags */}
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '0.375rem' }}>
                        {enabledCategories.length > 0 ? (
                          enabledCategories.map(label => (
                            <span key={label} style={{
                              fontSize: '0.7rem',
                              padding: '0.125rem 0.4rem',
                              background: 'rgba(59, 130, 246, 0.1)',
                              color: 'var(--primary)',
                              borderRadius: '4px',
                            }}>
                              {label}
                            </span>
                          ))
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                            无工具权限
                          </span>
                        )}
                      </div>

                      {/* Storage + Memory summary */}
                      <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                        {t.storage && (
                          <span>文件: {t.storage.workspace_path} ({t.storage.access})</span>
                        )}
                        <span>Memory: {scopesDisplay}</span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0, marginLeft: '1rem' }}>
                      <Button
                        variant="secondary"
                        onClick={() => openEdit(t)}
                        style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}
                      >
                        {t.is_system ? '查看' : '编辑'}
                      </Button>
                      {!t.is_system && (
                        confirmDeleteId === t.id ? (
                          <div style={{ display: 'flex', gap: '0.25rem' }}>
                            <Button
                              variant="danger"
                              onClick={() => handleDelete(t.id)}
                              disabled={deleting}
                              style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}
                            >
                              确认
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => setConfirmDeleteId(null)}
                              style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}
                            >
                              取消
                            </Button>
                          </div>
                        ) : (
                          <Button
                            variant="danger"
                            onClick={() => setConfirmDeleteId(t.id)}
                            style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}
                          >
                            删除
                          </Button>
                        )
                      )}
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>

      {/* Create / Edit Drawer */}
      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} width={480}>
        <PermissionTemplateForm
          template={editingTemplate}
          onSave={handleDrawerSave}
          onCancel={() => setDrawerOpen(false)}
        />
      </Drawer>
    </MainLayout>
  )
}
