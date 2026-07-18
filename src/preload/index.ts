import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  ApprovalMode,
  AskUserResponse,
  BackendEvent,
  BootstrapInfo,
  FileMatch,
  FileMention,
  GrokApi,
  PtyEvent,
  PtyTabInfo,
  ThreadSummary
} from '../shared/types'

const api: GrokApi = {
  getBootstrap: (): Promise<BootstrapInfo> => ipcRenderer.invoke('bootstrap'),
  newThread: (project?: string, cwd?: string): Promise<ThreadSummary> =>
    ipcRenderer.invoke('thread:new', project, cwd),
  prewarm: (cwd: string): Promise<void> => ipcRenderer.invoke('thread:prewarm', cwd),
  loadThread: (threadId: string): Promise<void> => ipcRenderer.invoke('thread:load', threadId),
  renameThread: (threadId: string, title: string): Promise<void> =>
    ipcRenderer.invoke('thread:rename', threadId, title),
  deleteThread: (threadId: string): Promise<void> => ipcRenderer.invoke('thread:delete', threadId),
  sendPrompt: (threadId: string, text: string, mentions?: FileMention[]): Promise<void> =>
    ipcRenderer.invoke('prompt:send', threadId, text, mentions),
  cancel: (threadId: string): Promise<void> => ipcRenderer.invoke('prompt:cancel', threadId),
  respondPermission: (requestId: string, optionId: string | null): Promise<void> =>
    ipcRenderer.invoke('permission:respond', requestId, optionId),
  setApprovalMode: (mode: ApprovalMode): Promise<void> =>
    ipcRenderer.invoke('app:setApprovalMode', mode),
  setModel: (threadId: string | null, modelId: string): Promise<void> =>
    ipcRenderer.invoke('models:set', threadId, modelId),
  setMode: (threadId: string, modeId: string): Promise<void> =>
    ipcRenderer.invoke('session:setMode', threadId, modeId),
  setEffort: (threadId: string, effortId: string): Promise<void> =>
    ipcRenderer.invoke('session:setEffort', threadId, effortId),
  respondPlanApproval: (requestId: string, outcome: string, feedback?: string): Promise<void> =>
    ipcRenderer.invoke('plan:respond', requestId, outcome, feedback),
  respondAskUser: (requestId: string, response: AskUserResponse): Promise<void> =>
    ipcRenderer.invoke('ask:respond', requestId, response),
  logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke('settings:read'),
  updateSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke('settings:write', patch),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickDirectory'),
  ptyCreate: (cwd: string, cols: number, rows: number): Promise<PtyTabInfo> =>
    ipcRenderer.invoke('pty:create', cwd, cols, rows),
  ptyWrite: (id: string, data: string): Promise<void> => ipcRenderer.invoke('pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  ptyDispose: (id: string): Promise<void> => ipcRenderer.invoke('pty:dispose', id),
  onPtyEvent: (cb: (ev: PtyEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: PtyEvent): void => cb(ev)
    ipcRenderer.on('pty:event', listener)
    return () => ipcRenderer.removeListener('pty:event', listener)
  },
  searchFiles: (cwd: string, query: string): Promise<FileMatch[]> =>
    ipcRenderer.invoke('search:files', cwd, query),
  onEvent: (cb: (ev: BackendEvent) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: BackendEvent): void => cb(ev)
    ipcRenderer.on('backend:event', listener)
    return () => ipcRenderer.removeListener('backend:event', listener)
  }
}

contextBridge.exposeInMainWorld('grok', api)
