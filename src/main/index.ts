import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { BackendManager } from './backend'
import { registerIpc } from './ipc'

let win: BrowserWindow | null = null

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Grok Desktop',
    backgroundColor: '#0d0d0f',
    titleBarStyle: 'hiddenInset', // macOS：保留红绿灯，内容区延伸到标题栏
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const manager = new BackendManager(
    (ev) => {
      try {
        if (win && !win.webContents.isDestroyed()) {
          win.webContents.send('backend:event', ev)
        }
      } catch {
        /* 窗口销毁瞬间的事件丢弃 */
      }
    },
    (ev) => {
      try {
        if (win && !win.webContents.isDestroyed()) {
          win.webContents.send('pty:event', ev)
        }
      } catch {
        /* 窗口销毁瞬间的事件丢弃 */
      }
    }
  )
  await manager.init()
  registerIpc(manager)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    win = null
    manager.dispose()
  })
}

app.whenReady().then(() => {
  void createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
