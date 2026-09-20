import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { Workspace } from '../types'

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input, select, button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current()
      if (event.key === 'Tab') {
        const elements = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]') ?? [])
        const first = elements[0], last = elements[elements.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); previous?.focus() }
  }, [])
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section ref={ref} className="gallery-dialog" role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><X size={18} /></button></div>{children}</section></div>
}

export function WorkspaceDialog({ workspaces, assignment, initialId = '', onSave, onClose }: { workspaces: Workspace[]; assignment?: number; initialId?: string; onSave: (id: string, newName: string) => void; onClose: () => void }) {
  const [selected, setSelected] = useState(initialId)
  const [name, setName] = useState('')
  const duplicate = workspaces.some((workspace) => workspace.name.toLowerCase() === name.trim().toLowerCase())
  return <Dialog title={assignment ? '设置作品工作区' : '新建工作区'} onClose={onClose}><form onSubmit={(event) => { event.preventDefault(); if (!duplicate && (assignment || name.trim())) onSave(selected, name.trim()) }}>
    {assignment && <><p>将 {assignment} 个作品归入工作区。</p><label className="field-label" htmlFor="assign-workspace">选择工作区</label><select id="assign-workspace" className="input-control" value={selected} onChange={(event) => { setSelected(event.target.value); setName('') }}><option value="">不分配工作区</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></>}
    <label className="field-label" htmlFor="workspace-name">{assignment ? '或新建工作区' : '工作区名称'}</label><input id="workspace-name" className="input-control" placeholder="例如：产品摄影" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} required={!assignment} />
    {duplicate && <p className="form-error">工作区名称已存在，请选择已有工作区或使用其他名称。</p>}
    <div className="modal-footer"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={duplicate || (!assignment && !name.trim())}>{name.trim() ? '创建并使用' : '保存'}</button></div>
  </form></Dialog>
}
