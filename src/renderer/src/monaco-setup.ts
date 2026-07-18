import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

// DiffEditor 只需要基础 editor worker（无语言服务）
;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new editorWorker()
}

// 使用打包内的 monaco，不走 CDN（桌面离线可用）
loader.config({ monaco })
