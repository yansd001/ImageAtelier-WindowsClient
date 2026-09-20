import { useMemo, useState } from 'react'
import { CalendarDays, Folder, Plus, Images } from 'lucide-react'
import type { Task, Workspace } from '../types'
import { dateKey, UNASSIGNED, type DirectoryTab } from '../lib/gallery'

export function GalleryDirectory({ tasks, workspaces, tab, date, workspace, onTab, onDate, onWorkspace, onCreate }: {
  tasks: Task[]; workspaces: Workspace[]; tab: DirectoryTab; date: string; workspace: string
  onTab: (tab: DirectoryTab) => void; onDate: (date: string) => void; onWorkspace: (id: string) => void; onCreate: () => void
}) {
  const [query, setQuery] = useState('')
  const counts = useMemo(() => {
    const dates = new Map<string, number>()
    const spaces = new Map<string, number>()
    for (const task of tasks) {
      const day = dateKey(task.createdAt)
      dates.set(day, (dates.get(day) || 0) + 1)
      const id = task.workspaceId || UNASSIGNED
      spaces.set(id, (spaces.get(id) || 0) + 1)
    }
    return { dates: [...dates].sort(([a], [b]) => b.localeCompare(a)), spaces }
  }, [tasks])
  const entry = (id: string, label: string, count: number, all = false) => <button key={id} className={`directory-entry ${(tab === 'date' ? date : workspace) === id ? 'active' : ''}`} onClick={() => tab === 'date' ? onDate(id) : onWorkspace(id)} aria-current={(tab === 'date' ? date : workspace) === id ? 'true' : undefined}>
    {all ? <Images size={15} /> : tab === 'date' ? <CalendarDays size={15} /> : <Folder size={15} />}<span title={label}>{label}</span><small>{count}</small>
  </button>
  return <aside className="gallery-directory" aria-label="画廊目录">
    <div className="directory-heading"><strong>作品目录</strong><span>{tasks.length} 个作品</span></div>
    <div className="directory-tabs" role="tablist" aria-label="目录类型">
      <button role="tab" id="date-tab" aria-controls="directory-panel" aria-selected={tab === 'date'} className={tab === 'date' ? 'active' : ''} onClick={() => onTab('date')}><CalendarDays size={14} />日期</button>
      <button role="tab" id="workspace-tab" aria-controls="directory-panel" aria-selected={tab === 'workspace'} className={tab === 'workspace' ? 'active' : ''} onClick={() => onTab('workspace')}><Folder size={14} />工作区</button>
    </div>
    <div id="directory-panel" role="tabpanel" aria-labelledby={`${tab}-tab`}>
      {entry('', '全部作品', tasks.length, true)}
      {tab === 'date' ? <div className="directory-list">{counts.dates.map(([day, count]) => entry(day, day, count))}{!counts.dates.length && <p className="directory-hint">生成作品后将按日期归档</p>}</div> : <>
        {entry(UNASSIGNED, '未分配工作区', counts.spaces.get(UNASSIGNED) || 0)}
        <input className="input-control directory-search" aria-label="搜索工作区" placeholder="搜索工作区" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="directory-list">{workspaces.filter((item) => item.name.toLowerCase().includes(query.trim().toLowerCase())).map((item) => entry(item.id, item.name, counts.spaces.get(item.id) || 0))}</div>
        <button className="create-workspace-button" onClick={onCreate}><Plus size={15} />新建工作区</button>
      </>}
    </div>
  </aside>
}
