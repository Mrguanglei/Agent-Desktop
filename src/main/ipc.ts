import { app, dialog, ipcMain, shell, BrowserWindow } from 'electron'
import type {
  AppSettings,
  ApprovalMode,
  BootstrapInfo,
  FileMatch,
  FileMention,
  PtyTabInfo,
  ThreadSummary
} from '../shared/types'
import type { BackendManager } from './backend'

export function registerIpc(manager: BackendManager): void {
  ipcMain.handle('bootstrap', (): BootstrapInfo => manager.bootstrap())
  ipcMain.handle('thread:new', (_e, project?: string): Promise<ThreadSummary> =>
    manager.newThread(project)
  )
  ipcMain.handle('thread:load', (_e, threadId: string): Promise<void> =>
    manager.loadThread(threadId)
  )
  ipcMain.handle('thread:rename', (_e, threadId: string, title: string): Promise<void> =>
    manager.renameThread(threadId, title)
  )
  ipcMain.handle('thread:delete', (_e, threadId: string): Promise<void> =>
    manager.deleteThread(threadId)
  )
  ipcMain.handle(
    'prompt:send',
    (_e, threadId: string, text: string, mentions?: FileMention[]): Promise<void> =>
      manager.sendPrompt(threadId, text, mentions)
  )
  ipcMain.handle('prompt:cancel', (_e, threadId: string): Promise<void> =>
    manager.cancel(threadId)
  )
  ipcMain.handle(
    'permission:respond',
    (_e, requestId: string, optionId: string | null): void =>
      manager.respondPermission(requestId, optionId)
  )
  ipcMain.handle('app:setApprovalMode', (_e, mode: ApprovalMode): void =>
    manager.setApprovalMode(mode)
  )
  ipcMain.handle(
    'models:set',
    (_e, threadId: string | null, modelId: string): Promise<void> =>
      manager.setModel(threadId, modelId)
  )
  ipcMain.handle('session:setMode', (_e, threadId: string, modeId: string): Promise<void> =>
    manager.setMode(threadId, modeId)
  )
  ipcMain.handle('session:setEffort', (_e, threadId: string, effortId: string): Promise<void> =>
    manager.setEffort(threadId, effortId)
  )
  ipcMain.handle(
    'plan:respond',
    (_e, requestId: string, outcome: string, feedback?: string): void =>
      manager.respondPlanApproval(requestId, outcome, feedback)
  )
  ipcMain.handle('ask:respond', (_e, requestId: string, response: unknown): void =>
    manager.respondAskUser(requestId, response as never)
  )
  ipcMain.handle('auth:logout', (): Promise<void> => manager.logout())
  ipcMain.handle(
    'pty:create',
    (_e, cwd: string, cols: number, rows: number): PtyTabInfo =>
      manager.ptyCreateUser(cwd, cols, rows)
  )
  ipcMain.handle('pty:write', (_e, id: string, data: string): void => manager.ptyWrite(id, data))
  ipcMain.handle(
    'pty:resize',
    (_e, id: string, cols: number, rows: number): void => manager.ptyResize(id, cols, rows)
  )
  ipcMain.handle('pty:dispose', (_e, id: string): void => manager.ptyDispose(id))
  ipcMain.handle(
    'search:files',
    (_e, cwd: string, query: string): Promise<FileMatch[]> => manager.searchFiles(cwd, query)
  )
  ipcMain.handle('settings:read', (): AppSettings => manager.getSettings())
  ipcMain.handle(
    'settings:write',
    (_e, patch: Partial<AppSettings>): AppSettings => manager.updateSettings(patch)
  )
  ipcMain.handle('dialog:pickDirectory', async (): Promise<string | null> => {
    const win = BrowserWindow.getAllWindows()[0]
    const opts = {
      title: '选择默认工作目录',
      defaultPath: app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  ipcMain.handle('app:openExternal', (_e, url: string): Promise<void> => {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return Promise.reject(new Error(`blocked protocol: ${u.protocol}`))
    }
    return shell.openExternal(url)
  })
}
