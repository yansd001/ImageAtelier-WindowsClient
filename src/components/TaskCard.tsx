import { useEffect, useState } from 'react'
import { LoaderCircle, AlertCircle, RefreshCw, Paperclip, Heart, Pencil, Copy, Download, Trash2, Folder } from 'lucide-react'
import type { Task } from '../types'
import { hydrateImage } from '../lib/storage'

export function useImageSources(sources: string[]) {
  const [result, setResult] = useState<{ sources: string[]; images: string[]; error?: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    Promise.all(sources.map(hydrateImage)).then((images) => {
      if (!cancelled) setResult({ sources, images })
    }).catch((error) => { if (!cancelled) setResult({ sources, images: [], error: error instanceof Error ? error.message : '图片加载失败' }) })
    return () => { cancelled = true }
  }, [sources])
  return result?.sources === sources ? result : { images: [], error: undefined }
}

export function TaskCard({ task, workspaceName, selectionMode, selected, onSelect, onAssign, onOpen, onFavorite, onEdit, onDelete, onCopy, onRetry, onDownload }: {
  task: Task; workspaceName?: string; selectionMode: boolean; selected: boolean; onSelect: () => void; onAssign: () => void
  onOpen: (index: number) => void; onFavorite: () => void; onEdit: () => void; onDelete: () => void; onCopy: () => void; onRetry: () => void; onDownload: () => void
}) {
  const { images, error } = useImageSources(task.images)
  const requestedCount = Math.min(4, Math.max(1, Math.floor(Number(task.params.count) || 1)))
  const resultLabel = task.images.length < requestedCount ? `已生成 ${task.images.length}/${requestedCount} 张图片` : `已生成 ${task.images.length} 张图片`
  return <article className={`task-card ${selected ? 'is-selected' : ''}`}>
    {selectionMode && <label className="task-selection"><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`选择作品：${task.prompt}`} /><span>选择作品</span></label>}
    <div className="image-grid">{task.status === 'running' ? <div className="task-loading"><LoaderCircle size={26} className="spin" /><span>生成中...</span></div> : task.status === 'error' || error ? <div className="task-error"><AlertCircle size={25} /><span>{error || task.error}</span>{task.status === 'error' && !selectionMode && <button className="retry-button" onClick={onRetry}><RefreshCw size={13} />重试</button>}</div> : !images.length ? <div className="task-loading">{task.images.length ? <><LoaderCircle size={20} className="spin" /><span>加载图片...</span></> : <span>暂无图片</span>}</div> : images.map((image, index) => <button className="image-tile" key={`${task.id}-${index}`} onClick={() => selectionMode ? onSelect() : onOpen(index)} aria-label={selectionMode ? `选择作品：${task.prompt}` : `查看图片：${task.prompt}`}><img src={image} alt={task.prompt} loading="lazy" /></button>)}</div>
    <div className="task-body"><div className="task-topline"><span className={`provider-tag ${task.provider}`}>{task.provider === 'openai' ? 'OpenAI' : 'Gemini'}</span><span className="task-model">{task.model}</span>{(task.referenceImages?.length ?? 0) > 0 && <span className="reference-count" title={`${task.referenceImages?.length} 张参考图`}><Paperclip size={11} />{task.referenceImages?.length}</span>}<span className="task-time">{new Date(task.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
      <p className="task-prompt">{task.prompt}</p>{task.status === 'done' && task.images.length > 0 && <div className="task-result-count">{resultLabel}</div>}
      <button className="task-workspace" onClick={onAssign} title="设置工作区"><Folder size={12} /><span>{workspaceName || '未分配工作区'}</span></button>
      {!selectionMode && <div className="task-actions"><button onClick={onFavorite} title="收藏" className={task.favorite ? 'is-favorite' : ''}><Heart size={15} fill={task.favorite ? 'currentColor' : 'none'} /></button><button onClick={onEdit} title="编辑后重新生成"><Pencil size={15} /></button><button onClick={onCopy} title="复制提示词"><Copy size={15} /></button>{task.images.length > 0 && <button onClick={onDownload} title={task.images.length > 1 ? '打包下载全部图片' : '下载图片'}><Download size={15} /></button>}<button onClick={onDelete} title="删除"><Trash2 size={15} /></button></div>}
    </div>
  </article>
}
