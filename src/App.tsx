import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Settings, Search, Heart, Trash2, X, ChevronLeft, ChevronRight, ChevronDown, Download, Image as ImageIcon, LoaderCircle, AlertCircle, Check, Upload, Paperclip, ArrowRight, RefreshCw, Github, Pencil, Folder, Plus, ListChecks } from 'lucide-react'
import type { GenerationParams, Provider, ReferenceImage, Settings as AppSettings, Task, Workspace } from './types'
import { defaultParams, defaultSettings } from './types'
import { fetchAvailableModels, generateImages } from './lib/imageApi'
import { hydrateTasks, initializeStorage, saveGallery, saveLastWorkspace, saveModelSelections, saveSettings } from './lib/storage'
import { createBackup, createImageZip, downloadBlob, readBackup, readImage } from './lib/archive'
import { dateKey, filterTasks, mergeGallery, UNASSIGNED, type DirectoryTab } from './lib/gallery'
import { GalleryDirectory } from './components/GalleryDirectory'
import { Dialog, WorkspaceDialog } from './components/GalleryDialogs'
import { TaskCard, useImageSources } from './components/TaskCard'

const emptyProviderState = <T,>(value: T): Record<Provider, T> => ({ openai: value, gemini: value })

function uid() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}` }
const EMPTY_IMAGES: string[] = []
const PAGE_SIZE = 48

interface ComposerDraft {
  provider: Provider
  model: string
  prompt: string
  params: GenerationParams
  referenceImages: ReferenceImage[]
  workspaceId: string
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(`读取参考图失败：${file.name}`))
    reader.readAsDataURL(file)
  })
}

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings)
  const [tasks, setTasks] = useState<Task[]>([])
  const [tasksLoaded, setTasksLoaded] = useState(false)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState('')
  const [directoryTab, setDirectoryTab] = useState<DirectoryTab>('date')
  const [selectedDate, setSelectedDate] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null)
  const [workspaceDialog, setWorkspaceDialog] = useState<{ taskIds?: string[]; forComposer?: boolean } | null>(null)
  const [busy, setBusy] = useState('')
  const [storageError, setStorageError] = useState('')
  const importInputRef = useRef<HTMLInputElement>(null)
  const [provider, setProvider] = useState<Provider>('openai')
  const [selectedModels, setSelectedModels] = useState(() => emptyProviderState(''))
  const [availableModels, setAvailableModels] = useState<Record<Provider, string[]>>(() => emptyProviderState([]))
  const [modelsFetched, setModelsFetched] = useState<Record<Provider, boolean>>(() => emptyProviderState(false))
  const [modelsLoading, setModelsLoading] = useState<Record<Provider, boolean>>(() => emptyProviderState(false))
  const [prompt, setPrompt] = useState('')
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([])
  const referenceInputRef = useRef<HTMLInputElement>(null)
  const promptInputRef = useRef<HTMLTextAreaElement>(null)
  const composerRef = useRef<HTMLElement>(null)
  const galleryScrollRef = useRef<HTMLDivElement>(null)
  const [params, setParams] = useState<GenerationParams>(defaultParams)
  const [editSession, setEditSession] = useState<{ taskId: string; previousDraft: ComposerDraft } | null>(null)
  const [search, setSearch] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [lightbox, setLightbox] = useState<{ taskId: string; index: number } | null>(null)
  const [referenceLightboxIndex, setReferenceLightboxIndex] = useState<number | null>(null)
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    void initializeStorage().then((state) => {
      if (cancelled) return
      const stored = state.gallery
      setSettings(state.settings)
      setSelectedModels(state.modelSelections)
      setTasks(stored.tasks.map((task) => task.status === 'running' ? { ...task, status: 'error', error: '上次生成已中断，可以重试' } : task))
      setWorkspaces(stored.workspaces)
      const last = state.lastWorkspace
      setSelectedWorkspace(stored.workspaces.some((workspace) => workspace.id === last) ? last : '')
      setTasksLoaded(true)
    }).catch((error) => { if (!cancelled) setStorageError(error instanceof Error ? error.message : '后端画廊读取失败，请检查 Go 服务后刷新页面。') })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!tasksLoaded) return
    let cancelled = false
    const hasInlineImages = tasks.some((task) => task.images.some((image) => image.startsWith('data:')) || task.referenceImages?.some((image) => image.dataUrl.startsWith('data:')))
    void saveGallery(tasks, workspaces).then((metadata) => {
      if (cancelled) return
      setStorageError('')
      // Release full image strings after persistence. Only mounted cards hydrate them.
      if (hasInlineImages) setTasks((current) => current === tasks ? metadata : current)
    }).catch((error) => { if (!cancelled) setStorageError(`保存失败：${error instanceof Error ? error.message : '请检查后端服务和磁盘空间'}。请先导出备份，避免刷新后丢失新作品。`) })
    return () => { cancelled = true }
  }, [tasks, workspaces, tasksLoaded])
  useEffect(() => {
    if (tasksLoaded) {
      void saveLastWorkspace(selectedWorkspace).catch((error) => setStorageError(`无法保存上次选择的工作区：${error.message}`))
    }
  }, [selectedWorkspace, tasksLoaded])
  useEffect(() => {
    if (tasksLoaded) void saveModelSelections(selectedModels).catch((error) => setStorageError(`无法保存模型选择：${error.message}`))
  }, [selectedModels, tasksLoaded])
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const filteredTasks = useMemo(() => filterTasks(tasks, { tab: directoryTab, date: selectedDate, workspace: workspaceFilter, favoritesOnly, search }), [tasks, directoryTab, selectedDate, workspaceFilter, favoritesOnly, search])
  useEffect(() => {
    setSelectedIds(new Set())
    setVisibleCount(PAGE_SIZE)
    galleryScrollRef.current?.scrollTo({ top: 0 })
  }, [directoryTab, selectedDate, workspaceFilter, favoritesOnly, search])
  const selectedTasks = filteredTasks.filter((task) => selectedIds.has(task.id))
  const selectedImageCount = selectedTasks.reduce((count, task) => count + task.images.length, 0)
  const directoryLabel = directoryTab === 'date' ? selectedDate || '全部日期' : workspaceFilter === UNASSIGNED ? '未分配工作区' : workspaces.find((workspace) => workspace.id === workspaceFilter)?.name || '全部工作区'
  const generating = tasks.filter((task) => task.status === 'running').length
  const hasApiKey = Boolean(settings[provider].apiKey.trim() || settings.global.apiKey.trim())
  const model = selectedModels[provider]

  const setProviderModel = (target: Provider, value: string) => {
    setSelectedModels((current) => ({ ...current, [target]: value }))
  }

  async function pullModels() {
    const target = provider
    if (!hasApiKey) {
      setNotice({ type: 'error', text: 'API 密钥未配置，请先打开设置填写 API Key' })
      return
    }
    setModelsLoading((current) => ({ ...current, [target]: true }))
    try {
      const next = await fetchAvailableModels(target)
      setAvailableModels((current) => ({ ...current, [target]: next }))
      setModelsFetched((current) => ({ ...current, [target]: true }))
      setNotice(next.length
        ? { type: 'success', text: `已拉取 ${next.length} 个生图模型` }
        : { type: 'error', text: `没有找到同时包含 ${target === 'openai' ? 'gpt' : 'gemini'} 和 image 的模型` })
    } catch (error) {
      setNotice({ type: 'error', text: error instanceof Error ? error.message : '模型列表拉取失败' })
    } finally {
      setModelsLoading((current) => ({ ...current, [target]: false }))
    }
  }

  const changeProvider = (next: Provider) => {
    setProvider(next)
    setParams(next === 'openai' ? defaultParams : { ...defaultParams, aspectRatio: '16:9', imageSize: '1K' })
  }

  const updateParam = <K extends keyof GenerationParams>(key: K, value: GenerationParams[K]) => setParams((current) => ({ ...current, [key]: value }))

  async function editTask(source: Task) {
    let task: Task
    try { [task] = await hydrateTasks([source]) }
    catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '参考图读取失败' }); return }
    const previousDraft: ComposerDraft = editSession?.previousDraft ?? {
      provider,
      model,
      prompt,
      params: { ...params },
      referenceImages: [...referenceImages],
      workspaceId: selectedWorkspace,
    }
    setEditSession({ taskId: task.id, previousDraft })
    setProvider(task.provider)
    setProviderModel(task.provider, task.model)
    setPrompt(task.prompt)
    setParams({ ...task.params })
    setReferenceImages([...(task.referenceImages ?? [])])
    setSelectedWorkspace(task.workspaceId || '')
    setReferenceLightboxIndex(null)
    setLightbox(null)
    window.requestAnimationFrame(() => {
      if (window.matchMedia('(max-width: 720px)').matches) composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      promptInputRef.current?.focus()
      promptInputRef.current?.setSelectionRange(task.prompt.length, task.prompt.length)
    })
  }

  function cancelEditing() {
    if (!editSession) return
    const draft = editSession.previousDraft
    setProvider(draft.provider)
    setProviderModel(draft.provider, draft.model)
    setPrompt(draft.prompt)
    setParams({ ...draft.params })
    setReferenceImages([...draft.referenceImages])
    setSelectedWorkspace(draft.workspaceId)
    setReferenceLightboxIndex(null)
    setEditSession(null)
  }

  async function submit() {
    if (!tasksLoaded || busy) return
    if (!prompt.trim()) { setNotice({ type: 'error', text: '请先输入提示词' }); return }
    if (!hasApiKey) { setNotice({ type: 'error', text: 'API 密钥未配置，请先打开设置填写 API Key' }); return }
    if (!model.trim()) { setNotice({ type: 'error', text: '请输入或选择生图模型' }); return }
    const task: Task = { id: uid(), prompt: prompt.trim(), provider, model, params: { ...params }, referenceImages: [...referenceImages], images: [], status: 'running', createdAt: Date.now(), favorite: false, workspaceId: selectedWorkspace || undefined }
    setTasks((current) => [task, ...current])
    galleryScrollRef.current?.scrollTo({ top: 0 })
    setSearch('')
    setFavoritesOnly(false)
    if (directoryTab === 'date' && selectedDate) setSelectedDate(dateKey(task.createdAt))
    if (directoryTab === 'workspace' && workspaceFilter) setWorkspaceFilter(task.workspaceId || UNASSIGNED)
    setPrompt('')
    setReferenceImages([])
    setEditSession(null)
    try {
      const images = await generateImages(provider, model, task.prompt, task.params, task.referenceImages ?? [])
      setTasks((current) => current.map((item) => item.id === task.id ? { ...item, images, status: 'done' } : item))
      setNotice({ type: 'success', text: generationCompleteMessage(images.length, task.params.count) })
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败'
      setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'error', error: message } : item))
    }
  }

  async function retryTask(task: Task) {
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, images: [], status: 'running', error: undefined } : item))
    try {
      const [hydrated] = await hydrateTasks([task])
      const images = await generateImages(task.provider, task.model, task.prompt, task.params, hydrated.referenceImages ?? [])
      setTasks((current) => current.map((item) => item.id === task.id ? { ...item, images, status: 'done', error: undefined } : item))
      setNotice({ type: 'success', text: `重试${generationCompleteMessage(images.length, task.params.count)}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败'
      setTasks((current) => current.map((item) => item.id === task.id ? { ...item, status: 'error', error: message } : item))
    }
  }

  function toggleFavorite(id: string) { setTasks((current) => current.map((task) => task.id === id ? { ...task, favorite: !task.favorite } : task)) }
  function removeTasks(ids: string[]) {
    const removed = new Set(ids)
    setTasks((current) => current.filter((task) => !removed.has(task.id)))
    setSelectedIds((current) => new Set([...current].filter((id) => !removed.has(id))))
    if (lightbox && removed.has(lightbox.taskId)) setLightbox(null)
    if (editSession && removed.has(editSession.taskId)) setEditSession(null)
    setDeleteIds(null)
    setNotice({ type: 'success', text: `已删除 ${ids.length} 个作品` })
  }
  function toggleSelection(id: string) {
    setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }
  function saveWorkspace(id: string, newName: string) {
    if (!tasksLoaded) return
    const workspaceId = newName ? uid() : id
    if (newName) setWorkspaces((current) => [...current, { id: workspaceId, name: newName, createdAt: Date.now() }])
    if (workspaceDialog?.taskIds) {
      const ids = new Set(workspaceDialog.taskIds)
      setTasks((current) => current.map((task) => ids.has(task.id) ? { ...task, workspaceId: workspaceId || undefined } : task))
      setSelectedIds(new Set())
    } else if (workspaceDialog?.forComposer) setSelectedWorkspace(workspaceId)
    else { setDirectoryTab('workspace'); setWorkspaceFilter(workspaceId) }
    setWorkspaceDialog(null)
    setNotice({ type: 'success', text: newName ? `已创建工作区“${newName}”` : '作品工作区已更新' })
  }
  function copyPrompt(value: string) { void navigator.clipboard?.writeText(value); setNotice({ type: 'success', text: '提示词已复制' }) }
  async function downloadTaskImages(task: Task) {
    if (task.images.length > 1) await downloadSelected([task])
    else if (task.images[0]) await downloadImageDirect(task.images[0], `image-${task.id}-1`, (text) => setNotice({ type: 'error', text }))
  }
  async function downloadSelected(items: Task[]) {
    if (busy) return
    setBusy('正在打包图片…')
    try { downloadBlob(await createImageZip(items), `ImageAtelier-images-${dateKey(Date.now())}.zip`); setNotice({ type: 'success', text: '图片已打包，下载已开始' }) }
    catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '图片打包失败' }) }
    finally { setBusy('') }
  }
  async function exportGallery() {
    if (busy || !tasksLoaded) return
    setBusy('正在导出全部作品与工作区…')
    try { downloadBlob(await createBackup({ tasks, workspaces }), `ImageAtelier-backup-${dateKey(Date.now())}.zip`); setNotice({ type: 'success', text: '备份已生成，下载已开始' }) }
    catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '导出失败' }) }
    finally { setBusy('') }
  }
  async function importGallery(file?: File) {
    if (importInputRef.current) importInputRef.current.value = ''
    if (!file || busy || !tasksLoaded) return
    if (generating) { setNotice({ type: 'error', text: '请等待当前生成任务完成后再导入' }); return }
    setBusy('正在校验并导入备份…')
    try {
      const incoming = await readBackup(file)
      const merged = mergeGallery({ tasks, workspaces }, incoming)
      // Save first so a failed import leaves the visible gallery unchanged.
      const metadata = await saveGallery(merged.tasks, merged.workspaces)
      setTasks(metadata)
      setWorkspaces(merged.workspaces)
      setNotice({ type: 'success', text: `已导入 ${merged.added} 个作品${merged.skipped ? `，跳过 ${merged.skipped} 个重复作品` : ''}` })
    } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '导入失败' }) }
    finally { setBusy('') }
  }

  async function addReferenceFileArray(files: File[]) {
    if (!files.length) return
    const remaining = Math.max(0, 8 - referenceImages.length)
    if (!remaining) { setNotice({ type: 'error', text: '最多上传 8 张参考图' }); return }
    try {
      const next = await Promise.all(files.slice(0, remaining).map(async (file) => ({ id: uid(), name: file.name || `pasted-image-${uid()}.png`, dataUrl: await readFileAsDataUrl(file) })))
      setReferenceImages((current) => [...current, ...next])
      if (files.length > remaining) setNotice({ type: 'error', text: '最多上传 8 张参考图，已忽略超出部分' })
    } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '读取参考图失败' }) }
  }

  async function addReferenceFiles(files: FileList | null) {
    await addReferenceFileArray(files ? Array.from(files) : [])
    if (referenceInputRef.current) referenceInputRef.current.value = ''
  }

  async function handlePromptPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pastedImages = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (!pastedImages.length) return
    event.preventDefault()
    await addReferenceFileArray(pastedImages)
  }

  async function updateSettings(next: AppSettings) {
    if (!tasksLoaded || busy) return
    setBusy('正在保存配置…')
    try {
      await saveSettings(next)
      setSettings(next)
      setAvailableModels(emptyProviderState([]))
      setModelsFetched(emptyProviderState(false))
      setSettingsOpen(false)
      setNotice({ type: 'success', text: '配置已保存' })
    } catch (error) { setNotice({ type: 'error', text: error instanceof Error ? error.message : '配置保存失败' }) }
    finally { setBusy('') }
  }

  const lightboxTask = lightbox ? tasks.find((task) => task.id === lightbox.taskId) : undefined
  const lightboxSources = useImageSources(lightboxTask?.images ?? EMPTY_IMAGES)
  const lightboxImage = lightbox ? lightboxSources.images[lightbox.index] : undefined

  return (
    <div className="app-shell">
      <header className="topbar" inert={Boolean(busy)}>
        <div className="brand"><div className="brand-mark"><img src="./logo.png" alt="烟神殿" /></div><div><strong>烟神殿生图工具</strong><span>多模型生图画廊</span></div></div>
        <div className="topbar-actions"><div className="status-pill"><span className={generating ? 'status-dot busy' : hasApiKey ? 'status-dot' : 'status-dot missing'} />{generating ? `${generating} 个任务生成中` : hasApiKey ? '工作区已就绪' : 'API 密钥未配置'}</div><a className="github-link" href="https://github.com/yansd001/ImageAtelier" target="_blank" rel="noreferrer"><Github size={16} /><span>yansd001/ImageAtelier</span></a><button className="icon-button" onClick={() => setSettingsOpen(true)} disabled={!tasksLoaded} title="配置 API"><Settings size={18} /></button></div>
      </header>
      <div className={`workspace ${tasks.length > 0 ? 'has-tasks' : ''}`} inert={Boolean(busy)}>
        <GalleryDirectory tasks={tasks} workspaces={workspaces} tab={directoryTab} date={selectedDate} workspace={workspaceFilter} onTab={setDirectoryTab} onDate={setSelectedDate} onWorkspace={setWorkspaceFilter} onCreate={() => setWorkspaceDialog({})} />
        <div className="gallery-content">
        {storageError && <div className="storage-error" role="alert"><AlertCircle size={16} />{storageError}</div>}
        <main className="gallery-main">
          <div className="gallery-toolbar"><div><h2>画廊 <span>{filteredTasks.length}</span></h2><p className="gallery-scope">{directoryLabel}</p></div><div className="toolbar-actions"><div className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索提示词" /></div><button className={`filter-button ${favoritesOnly ? 'selected' : ''}`} onClick={() => setFavoritesOnly((value) => !value)}><Heart size={16} fill={favoritesOnly ? 'currentColor' : 'none'} />收藏</button><button className={`secondary-button ${selectionMode ? 'active' : ''}`} onClick={() => { setSelectionMode(!selectionMode); setSelectedIds(new Set()) }}><ListChecks size={15} />{selectionMode ? '退出选择' : '批量选择'}</button></div></div>
          <div className="gallery-data-toolbar"><span>按目录浏览和整理你的作品</span><div><input type="file" accept=".zip,application/zip" className="hidden-file-input" ref={importInputRef} onChange={(event) => void importGallery(event.target.files?.[0])} /><button className="secondary-button" disabled={!tasksLoaded || Boolean(busy)} onClick={() => void exportGallery()} title="导出全部原图、参考图、提示词、参数和工作区"><Download size={14} />导出备份</button><button className="secondary-button" disabled={!tasksLoaded || Boolean(busy) || generating > 0} onClick={() => importInputRef.current?.click()} title={generating ? '生成完成后可导入' : '导入 ZIP 备份，与当前画廊合并，重复作品会跳过'}><Upload size={14} />导入备份</button></div></div>
          {selectionMode && <div className="batch-toolbar"><label><input type="checkbox" checked={filteredTasks.length > 0 && selectedTasks.length === filteredTasks.length} onChange={(event) => setSelectedIds(event.target.checked ? new Set(filteredTasks.map((task) => task.id)) : new Set())} />全选当前结果</label><span>已选 {selectedTasks.length} 个作品 · {selectedImageCount} 张图片</span><div><button className="secondary-button" disabled={!selectedTasks.length} onClick={() => setWorkspaceDialog({ taskIds: selectedTasks.map((task) => task.id) })}><Folder size={14} />设置工作区</button><button className="secondary-button" disabled={!selectedImageCount} onClick={() => void downloadSelected(selectedTasks)}><Download size={14} />打包下载</button><button className="secondary-button danger" disabled={!selectedTasks.length} onClick={() => setDeleteIds(selectedTasks.map((task) => task.id))}><Trash2 size={14} />删除</button></div></div>}
          <div className="gallery-scroll" ref={galleryScrollRef} role="region" aria-label="画廊作品" tabIndex={0}>
          {!tasksLoaded ? <div className="empty-state">{storageError ? '画廊暂时无法读取' : '正在读取作品目录…'}</div> : filteredTasks.length === 0 ? <EmptyState hasTasks={tasks.length > 0} /> : <div className="task-grid">{filteredTasks.slice(0, visibleCount).map((task) => <TaskCard key={task.id} task={task} workspaceName={workspaces.find((workspace) => workspace.id === task.workspaceId)?.name} selectionMode={selectionMode} selected={selectedIds.has(task.id)} onSelect={() => toggleSelection(task.id)} onAssign={() => setWorkspaceDialog({ taskIds: [task.id] })} onOpen={(index) => setLightbox({ taskId: task.id, index })} onFavorite={() => toggleFavorite(task.id)} onEdit={() => void editTask(task)} onDelete={() => setDeleteIds([task.id])} onCopy={() => copyPrompt(task.prompt)} onRetry={() => void retryTask(task)} onDownload={() => void downloadTaskImages(task)} />)}</div>}
          {filteredTasks.length > visibleCount && <button className="secondary-button load-more" onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}>加载更多作品（已显示 {visibleCount} / {filteredTasks.length}）</button>}
          </div>
        </main>
        <section className={`composer-panel bottom-composer ${editSession ? 'is-editing' : ''}`} ref={composerRef}>
        <div className="composer-modelbar">
          <div className="modelbar-provider"><div className="segmented"><button className={provider === 'openai' ? 'active' : ''} onClick={() => changeProvider('openai')}>OpenAI</button><button className={provider === 'gemini' ? 'active' : ''} onClick={() => changeProvider('gemini')}>Gemini</button></div></div>
          <label className="modelbar-model"><ModelComboBox key={provider} value={model} onChange={(value) => setProviderModel(provider, value)} options={availableModels[provider]} fetched={modelsFetched[provider]} /></label>
          <button type="button" className="pull-models-button" onClick={() => void pullModels()} disabled={modelsLoading[provider]}><RefreshCw size={14} className={modelsLoading[provider] ? 'spin' : ''} />{modelsLoading[provider] ? '拉取中' : '拉取模型'}</button>
          <div className="composer-workspace"><Folder size={15} /><label htmlFor="generation-workspace">作品工作区</label><select id="generation-workspace" className="input-control" title="自动记住上次选择" value={selectedWorkspace} onChange={(event) => setSelectedWorkspace(event.target.value)}><option value="">不选择工作区</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><button className="icon-button" title="新建生成工作区" onClick={() => setWorkspaceDialog({ forComposer: true })}><Plus size={16} /></button></div>
        </div>
        {editSession && <div className="composer-editing-bar"><span><Pencil size={14} /><span><strong>编辑后重新生成</strong><small>已恢复原任务的模型、参数、工作区和参考图</small></span></span><button type="button" onClick={cancelEditing} title="取消编辑" aria-label="取消编辑"><X size={16} /></button></div>}
        {referenceImages.length > 0 && <div className="reference-above-input"><div className="reference-strip">{referenceImages.map((image, index) => <div className="reference-thumb" key={image.id}><div className="reference-preview-button" role="button" tabIndex={0} onPointerUp={(event) => { event.stopPropagation(); setReferenceLightboxIndex(index) }} onClick={(event) => { event.stopPropagation(); setReferenceLightboxIndex(index) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setReferenceLightboxIndex(index) } }} title="查看参考图"><img src={image.dataUrl} alt={image.name} /></div><button type="button" className="reference-remove-button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setReferenceImages((current) => current.filter((item) => item.id !== image.id)) }} title="移除参考图"><X size={12} /></button></div>)}</div></div>}
        <textarea ref={promptInputRef} className="bottom-prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} onPaste={(event) => void handlePromptPaste(event)} placeholder="描述你想生成的图片，可直接粘贴图片作为参考图..." rows={2} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void submit() } }} />
        <div className="bottom-controls"><div className="bottom-parameter-area">{provider === 'openai' ? <OpenAIParams params={params} updateParam={updateParam} /> : <GeminiParams params={params} updateParam={updateParam} />}</div><div className="bottom-reference-area"><input ref={referenceInputRef} className="hidden-file-input" type="file" accept="image/*" multiple onChange={(event) => void addReferenceFiles(event.target.files)} /><button className="attachment-button" onClick={() => referenceInputRef.current?.click()} title="上传参考图"><Paperclip size={18} /></button></div><button className={`generate-icon-button ${prompt.trim() && model.trim() && hasApiKey && tasksLoaded ? 'ready' : ''}`} onClick={() => void submit()} disabled={!tasksLoaded} title={!tasksLoaded ? '正在加载画廊' : !hasApiKey ? 'API 密钥未配置' : !model.trim() ? '请输入或选择生图模型' : prompt.trim() ? editSession ? '重新生成图片' : '生成图片' : '请输入提示词'}>{editSession ? <RefreshCw size={20} /> : <ArrowRight size={21} />}</button></div>
        </section>
        </div>
      </div>
      {workspaceDialog && <WorkspaceDialog workspaces={workspaces} assignment={workspaceDialog.taskIds?.length} initialId={workspaceDialog.taskIds?.length === 1 ? tasks.find((task) => task.id === workspaceDialog.taskIds?.[0])?.workspaceId : ''} onSave={saveWorkspace} onClose={() => setWorkspaceDialog(null)} />}
      {deleteIds && <Dialog title="删除作品" onClose={() => setDeleteIds(null)}><p>确定删除选中的 {deleteIds.length} 个作品及其中的 {tasks.filter((task) => deleteIds.includes(task.id)).reduce((count, task) => count + task.images.length, 0)} 张图片吗？</p><p className="dialog-hint">作品及参考图将从画廊移除，删除后无法恢复。{tasks.some((task) => deleteIds.includes(task.id) && task.status === 'running') && '正在生成的结果也不会保留。'}</p><div className="modal-footer"><button className="secondary-button" onClick={() => setDeleteIds(null)}>取消</button><button className="primary-button danger-button" onClick={() => removeTasks(deleteIds)}>确认删除</button></div></Dialog>}
      {busy && <div className="busy-overlay" role="status" aria-live="polite"><LoaderCircle size={24} className="spin" /><span>{busy}</span></div>}
      {settingsOpen && <SettingsModal settings={settings} onSave={(next) => { void updateSettings(next) }} onClose={() => setSettingsOpen(false)} />}
      {lightbox && lightboxImage && lightboxTask && <Lightbox task={lightboxTask} index={lightbox.index} src={lightboxImage} onClose={() => setLightbox(null)} onChange={(index) => setLightbox({ taskId: lightboxTask.id, index })} onEdit={() => void editTask(lightboxTask)} onDownloadError={(text) => setNotice({ type: 'error', text })} />}
      {referenceLightboxIndex !== null && referenceImages[referenceLightboxIndex] && <ReferenceLightbox images={referenceImages} index={referenceLightboxIndex} onClose={() => setReferenceLightboxIndex(null)} onChange={setReferenceLightboxIndex} />}
      {notice && <div className={`toast ${notice.type}`}><span>{notice.type === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}</span>{notice.text}<button onClick={() => setNotice(null)}><X size={14} /></button></div>}
    </div>
  )
}

function generationCompleteMessage(successCount: number, requestedCount: number) {
  const requested = Math.min(4, Math.max(1, Math.floor(Number(requestedCount) || 1)))
  return successCount < requested
    ? `图片生成完成，成功 ${successCount}/${requested} 张（失败图片已跳过）`
    : `图片生成完成，共 ${successCount} 张`
}

function OpenAIParams({ params, updateParam }: { params: GenerationParams; updateParam: <K extends keyof GenerationParams>(key: K, value: GenerationParams[K]) => void }) {
  return <div className="params-grid"><Param label="尺寸"><ParamSelect value={params.size} onChange={(value) => updateParam('size', value)} options={['1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '1152x2048', '3840x2160', '2160x3840', 'auto']} /></Param><Param label="质量"><ParamSelect value={params.quality} onChange={(value) => updateParam('quality', value as GenerationParams['quality'])} options={['auto', 'low', 'medium', 'high']} /></Param><Param label="背景"><ParamSelect value={params.background} onChange={(value) => updateParam('background', value as GenerationParams['background'])} options={['auto', 'transparent', 'opaque']} /></Param><Param label="输出格式"><ParamSelect value={params.outputFormat} onChange={(value) => updateParam('outputFormat', value as GenerationParams['outputFormat'])} options={['png', 'jpeg', 'webp']} /></Param><Param label="生成数量"><input className="input-control" type="number" min={1} max={4} value={params.count} onChange={(event) => updateParam('count', Math.min(4, Math.max(1, Number(event.target.value) || 1)))} /></Param></div>
}

function GeminiParams({ params, updateParam }: { params: GenerationParams; updateParam: <K extends keyof GenerationParams>(key: K, value: GenerationParams[K]) => void }) {
  return <div className="params-grid"><Param label="画面比例"><ParamSelect value={params.aspectRatio} onChange={(value) => updateParam('aspectRatio', value)} options={['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']} /></Param><Param label="图像分辨率"><ParamSelect value={params.imageSize} onChange={(value) => updateParam('imageSize', value as GenerationParams['imageSize'])} options={['1K', '2K', '4K']} /></Param><Param label="生成数量"><input className="input-control" type="number" min={1} max={4} value={params.count} onChange={(event) => updateParam('count', Math.min(4, Math.max(1, Number(event.target.value) || 1)))} /></Param></div>
}

function Param({ label, children }: { label: string; children: React.ReactNode }) { return <label className="param"><span>{label}</span>{children}</label> }

async function downloadImageDirect(src: string, filename: string, onError: (message: string) => void) {
  try {
    const image = await readImage(src)
    downloadBlob(new Blob([image.bytes as BlobPart], { type: image.mime }), `${filename.replace(/\.(png|jpe?g|webp)$/i, '')}.${image.extension}`)
  } catch (error) {
    onError(error instanceof Error ? error.message : '图片下载失败，请检查后端服务或图片文件')
  }
}

const parameterLabels: Record<string, string> = {
  auto: '自动',
  '1024x1024': '1024x1024 正方形',
  '1536x1024': '1536x1024 横版',
  '1024x1536': '1024x1536 竖版',
  '2048x2048': '2048x2048 2K正方形',
  '2048x1152': '2048x1152 2K横版',
  '1152x2048': '1152x2048 2K竖版',
  '3840x2160': '3840x2160 4K横版',
  '2160x3840': '2160x3840 4K竖版',
  low: '低',
  medium: '中',
  high: '高',
  transparent: '透明',
  opaque: '不透明',
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WEBP',
}

function ParamSelect({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: string[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const displayLabel = (option: string) => parameterLabels[option] ?? option
  return <div className="param-select" ref={ref}><button type="button" className="param-select-trigger" onClick={() => setOpen((current) => !current)}><span>{displayLabel(value)}</span><ChevronDown size={14} className={open ? 'rotate' : ''} /></button>{open && <div className="param-select-menu">{options.map((option) => <button type="button" key={option} className={option === value ? 'selected' : ''} onClick={() => { onChange(option); setOpen(false) }}>{displayLabel(option)}</button>)}</div>}</div>
}

function ModelComboBox({ value, onChange, options, fetched }: { value: string; onChange: (value: string) => void; options: string[]; fetched: boolean }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) { setOpen(false); setQuery('') } }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])
  const filtered = options.filter((option) => option.toLowerCase().includes(query.trim().toLowerCase()))
  const emptyText = !fetched ? '请先拉取模型，或直接输入模型名称' : options.length ? '无匹配模型，可直接使用当前输入' : '未拉取到符合当前提供商筛选规则的模型，可直接输入'
  return <div className="model-combobox" ref={ref}><div className="model-combobox-input-wrap"><input role="combobox" aria-label="生图模型" aria-expanded={open} aria-controls="model-options" aria-autocomplete="list" value={value} onFocus={() => { setQuery(''); setOpen(true) }} onChange={(event) => { setQuery(event.target.value); onChange(event.target.value); setOpen(true) }} onKeyDown={(event) => { if (event.key === 'Escape' || event.key === 'Enter') setOpen(false); if (event.key === 'ArrowDown') { event.preventDefault(); setQuery(''); setOpen(true) } }} placeholder="输入或选择模型" /><button type="button" onClick={() => { setQuery(''); setOpen((current) => !current) }} title="展开模型列表" aria-expanded={open}><ChevronDown size={14} className={open ? 'rotate' : ''} /></button></div>{open && <div className="model-combobox-menu" id="model-options" role="listbox">{filtered.length ? filtered.map((option) => <button type="button" role="option" aria-selected={option === value} key={option} className={option === value ? 'selected' : ''} onClick={() => { onChange(option); setQuery(''); setOpen(false) }}>{option}</button>) : <div className="model-combobox-empty">{emptyText}</div>}</div>}</div>
}

function EmptyState({ hasTasks }: { hasTasks: boolean }) { return <div className="empty-state"><div className="empty-icon"><ImageIcon size={24} /></div><h3>{hasTasks ? '没有匹配的作品' : '开始你的第一次创作'}</h3><p>{hasTasks ? '试试切换日期、工作区，或清除搜索和收藏筛选。' : '在下方输入提示词，生成的图片会出现在这里。'}</p></div> }

function SettingsModal({ settings, onSave, onClose }: { settings: AppSettings; onSave: (settings: AppSettings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings)
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="settings-modal"><div className="modal-header"><div><span className="eyebrow">SETTINGS</span><h2>API 配置</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><p className="modal-subtitle">Base URL 只需要填写域名，例如 https://code.yansd666.com。提供商配置留空时自动使用全局配置。</p><div className="settings-provider"><div className="provider-title"><span className="provider-dot global" />全局配置</div><label>Base URL<input className="input-control" value={draft.global.baseUrl} onChange={(event) => setDraft({ ...draft, global: { ...draft.global, baseUrl: event.target.value } })} placeholder="https://code.yansd666.com" /></label><label>API Key<input className="input-control" type="password" value={draft.global.apiKey} onChange={(event) => setDraft({ ...draft, global: { ...draft.global, apiKey: event.target.value } })} placeholder="所有提供商共用的 Key" /></label></div><div className="settings-provider"><div className="provider-title"><span className="provider-dot openai" />OpenAI <small>可选覆盖</small></div><label>Base URL<input className="input-control" value={draft.openai.baseUrl} onChange={(event) => setDraft({ ...draft, openai: { ...draft.openai, baseUrl: event.target.value } })} placeholder="留空则使用全局域名" /></label><label>API Key<input className="input-control" type="password" value={draft.openai.apiKey} onChange={(event) => setDraft({ ...draft, openai: { ...draft.openai, apiKey: event.target.value } })} placeholder="留空则使用全局 Key" /></label></div><div className="settings-provider"><div className="provider-title"><span className="provider-dot gemini" />Gemini <small>可选覆盖</small></div><label>Base URL<input className="input-control" value={draft.gemini.baseUrl} onChange={(event) => setDraft({ ...draft, gemini: { ...draft.gemini, baseUrl: event.target.value } })} placeholder="留空则使用全局域名" /></label><label>API Key<input className="input-control" type="password" value={draft.gemini.apiKey} onChange={(event) => setDraft({ ...draft, gemini: { ...draft.gemini, apiKey: event.target.value } })} placeholder="留空则使用全局 Key" /></label></div><div className="modal-footer"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" onClick={() => onSave(draft)}>保存配置</button></div></section></div>
}

function Lightbox({ task, src, index, onClose, onChange, onEdit, onDownloadError }: { task: Task; src: string; index: number; onClose: () => void; onChange: (index: number) => void; onEdit: () => void; onDownloadError: (message: string) => void }) {
  const hasNav = task.images.length > 1
  return <div className="lightbox" onClick={onClose}><button type="button" className="lightbox-close" onClick={onClose}><X size={20} /></button>{hasNav && <button type="button" className="lightbox-nav left" onClick={(event) => { event.stopPropagation(); onChange((index - 1 + task.images.length) % task.images.length) }}><ChevronLeft size={24} /></button>}<img src={src} alt={task.prompt} onClick={(event) => event.stopPropagation()} />{hasNav && <button type="button" className="lightbox-nav right" onClick={(event) => { event.stopPropagation(); onChange((index + 1) % task.images.length) }}><ChevronRight size={24} /></button>}<div className="lightbox-caption"><span>{index + 1} / {task.images.length}</span><button type="button" className="lightbox-action" onClick={(event) => { event.stopPropagation(); onEdit() }}><Pencil size={15} />编辑后重新生成</button><button type="button" className="lightbox-action" onClick={(event) => { event.stopPropagation(); void downloadImageDirect(src, `image-${task.id}-${index + 1}.png`, onDownloadError) }}><Download size={15} />下载</button></div></div>
}

function ReferenceLightbox({ images, index, onClose, onChange }: { images: ReferenceImage[]; index: number; onClose: () => void; onChange: (index: number) => void }) {
  const hasNav = images.length > 1
  return createPortal(<div className="lightbox reference-lightbox-layer" onClick={onClose}><button type="button" className="lightbox-close" onClick={onClose}><X size={20} /></button>{hasNav && <button type="button" className="lightbox-nav left" onClick={(event) => { event.stopPropagation(); onChange((index - 1 + images.length) % images.length) }}><ChevronLeft size={24} /></button>}<img src={images[index].dataUrl} alt={images[index].name} onClick={(event) => event.stopPropagation()} />{hasNav && <button type="button" className="lightbox-nav right" onClick={(event) => { event.stopPropagation(); onChange((index + 1) % images.length) }}><ChevronRight size={24} /></button>}<div className="lightbox-caption"><span>{index + 1} / {images.length}</span><span>{images[index].name}</span></div></div>, document.body)
}
