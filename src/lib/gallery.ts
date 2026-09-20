import type { Task, Workspace } from '../types'

export type DirectoryTab = 'date' | 'workspace'
export const UNASSIGNED = '__unassigned__'

// Use the browser's local calendar day, including at UTC date boundaries.
export function dateKey(timestamp: number) {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function filterTasks(tasks: Task[], filters: { tab: DirectoryTab; date: string; workspace: string; search: string; favoritesOnly: boolean }) {
  const query = filters.search.trim().toLowerCase()
  return tasks.filter((task) => {
    if (filters.favoritesOnly && !task.favorite) return false
    if (query && !task.prompt.toLowerCase().includes(query)) return false
    if (filters.tab === 'date') return !filters.date || dateKey(task.createdAt) === filters.date
    return !filters.workspace || (filters.workspace === UNASSIGNED ? !task.workspaceId : task.workspaceId === filters.workspace)
  })
}

export function mergeGallery(current: { tasks: Task[]; workspaces: Workspace[] }, incoming: { tasks: Task[]; workspaces: Workspace[] }) {
  const workspaces = [...current.workspaces]
  const workspaceIds = new Map<string, string>()
  for (const workspace of incoming.workspaces) {
    const existing = workspaces.find((item) => item.id === workspace.id && item.name === workspace.name)
      ?? workspaces.find((item) => item.name === workspace.name)
    if (existing) workspaceIds.set(workspace.id, existing.id)
    else {
      const id = workspaces.some((item) => item.id === workspace.id) ? `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}` : workspace.id
      workspaces.push({ ...workspace, id })
      workspaceIds.set(workspace.id, id)
    }
  }
  const existingIds = new Set(current.tasks.map((task) => task.id))
  const added = incoming.tasks.filter((task) => !existingIds.has(task.id)).map((task) => ({
    ...task,
    workspaceId: task.workspaceId ? workspaceIds.get(task.workspaceId) : undefined,
    ...(task.status === 'running' ? { status: 'error' as const, error: '导入的任务尚未完成，请重试生成' } : {}),
  }))
  return { tasks: [...current.tasks, ...added].sort((a, b) => b.createdAt - a.createdAt), workspaces, added: added.length, skipped: incoming.tasks.length - added.length }
}
