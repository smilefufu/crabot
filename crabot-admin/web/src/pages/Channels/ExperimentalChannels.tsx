import { useId, useState, type ReactNode } from 'react'
import { Button } from '../../components/Common/Button'

export function ExperimentalChannels({ count, initiallyOpen = false, children }: { count: number; initiallyOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen)
  const id = useId()
  if (!count) return null
  return <div className="collaboration-experimental">
    <Button type="button" variant="secondary" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <span aria-hidden="true">{open ? '⌄' : '›'}</span> 更多协作方式（{count}）<span className="collaboration-muted">实验性</span>
    </Button>
    {open && <div id={id}>
      <p className="collaboration-muted">以下方式仍在完善，配置较复杂，适合熟悉相关部署的用户。</p>
      {children}
    </div>}
  </div>
}
