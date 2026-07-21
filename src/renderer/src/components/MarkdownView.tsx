import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../api'

/** 富文本渲染（assistant 消息 / plan 内容）：GFM 表格、代码块（带复制）、外链走系统浏览器 */
export function MarkdownView({
  text,
  streaming = false
}: {
  text: string
  streaming?: boolean
}): JSX.Element {
  return (
    <div className="md-body text-sm leading-relaxed text-neutral-800">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-accent underline"
              onClick={(e) => {
                e.preventDefault()
                if (href) void api.openExternal(href)
              }}
            >
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? '')
            if (isBlock) return <code className={className}>{children}</code>
            return (
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12px]">
                {children}
              </code>
            )
          },
          pre: ({ children }) => <PreBlock>{children}</PreBlock>
        }}
      >
        {text}
      </Markdown>
      {streaming && (
        <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-neutral-800 align-middle" />
      )}
    </div>
  )
}

function PreBlock({ children }: { children: ReactNode }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const text = extractText(children)
  return (
    <div className="relative my-2 rounded-lg bg-neutral-900">
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
        className="absolute right-2 top-1.5 z-10 text-[10px] text-neutral-400 hover:text-white"
      >
        {copied ? '已复制' : '复制'}
      </button>
      <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-neutral-100">
        {children}
      </pre>
    </div>
  )
}

/** 从 React 节点树提取纯文本（供复制按钮） */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props
    return extractText(props?.children)
  }
  return ''
}
