import { DiffEditor } from '@monaco-editor/react'
import type { ToolCallView } from '../../../shared/types'

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  rs: 'rust',
  py: 'python',
  json: 'json',
  css: 'css',
  html: 'html',
  md: 'markdown',
  toml: 'ini',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp'
}

function langOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

export function DiffView({ diff }: { diff: NonNullable<ToolCallView['diff']> }): JSX.Element {
  return (
    <div className="h-[280px] overflow-hidden rounded border border-surface-border">
      <DiffEditor
        original={diff.oldText}
        modified={diff.newText}
        language={langOf(diff.path)}
        theme="vs"
        options={{
          readOnly: true,
          originalEditable: false,
          renderSideBySide: true,
          minimap: { enabled: false },
          fontSize: 11,
          scrollBeyondLastLine: false,
          automaticLayout: true
        }}
      />
    </div>
  )
}
