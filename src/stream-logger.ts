import { closeSync, existsSync, openSync, readSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface AgyUsage {
  input_tokens?: number
  output_tokens?: number
  thinking_tokens?: number
  cache_read_tokens?: number
  total_tokens?: number
}

export interface AgyToolInfo {
  name?: string
  parameters?: Record<string, unknown>
}

export interface AgyStepUpdate {
  conversation_id?: string
  step_index?: number
  step_type?: string
  state?: string
  text_delta?: string
  thinking_delta?: string
  tool_name?: string
  tool_info?: AgyToolInfo
  duration_seconds?: number
  usage?: AgyUsage
}

export interface TurnDisplayMeta {
  channelLabel: string
  author: string
  preview: string
  modeLabel?: string
}

export interface StreamLoggerOptions {
  enabled: boolean
  showThinking: boolean
  color?: boolean
  write?: (chunk: string) => void
  brainDir?: string
}

function defaultUseColor(): boolean {
  if (process.env.NO_COLOR !== undefined) return false
  if (process.env.FORCE_COLOR === '1') return true
  return Boolean(process.stdout.isTTY)
}

function ansi(code: string, text: string, enabled: boolean): string {
  return enabled ? `\x1b[${code}m${text}\x1b[0m` : text
}

function truncateInline(val: string, maxLen = 100): string {
  const oneLine = val.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxLen) return oneLine
  return oneLine.slice(0, maxLen - 1) + '…'
}

/**
 * Produces a concise, single-line summary of a tool call for terminal display.
 */
export function formatToolSummary(toolName: string, params?: Record<string, unknown>): string {
  if (!params || Object.keys(params).length === 0) return toolName

  // MCP tool calls: show server.tool + key args
  if (toolName === 'call_mcp_tool') {
    const server = typeof params.ServerName === 'string' ? params.ServerName : ''
    const tool = typeof params.ToolName === 'string' ? params.ToolName : ''
    const label = server && tool ? `${server}.${tool}` : tool || server || toolName
    const inner =
      params.Arguments && typeof params.Arguments === 'object'
        ? (params.Arguments as Record<string, unknown>)
        : undefined
    if (inner) {
      const argBits = Object.entries(inner)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .slice(0, 3)
        .map(([k, v]) => `${k}=${truncateInline(typeof v === 'string' ? v : JSON.stringify(v), 50)}`)
      if (argBits.length > 0) return `${label}(${argBits.join(', ')})`
    }
    return label
  }

  const priorityKeys = [
    'CommandLine',
    'Path',
    'TargetFile',
    'AbsolutePath',
    'SearchPath',
    'Query',
    'query',
    'Pattern',
    'Url',
    'toolSummary',
    'Description',
    'Role',
    'text',
  ]

  for (const key of priorityKeys) {
    const val = params[key]
    if (typeof val === 'string' && val.trim()) {
      return `${toolName}(${truncateInline(val, 100)})`
    }
  }

  const firstEntry = Object.entries(params).find(([, v]) => v !== undefined && v !== null)
  if (!firstEntry) return toolName
  const [k, v] = firstEntry
  const formatted = typeof v === 'string' ? v : JSON.stringify(v)
  return `${toolName}(${k}=${truncateInline(formatted, 80)})`
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function formatUsageSummary(usage?: AgyUsage, durationSeconds?: number): string {
  const parts: string[] = []
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
    parts.push(`${durationSeconds.toFixed(1)}s`)
  }
  if (usage) {
    if (typeof usage.input_tokens === 'number') {
      parts.push(`in: ${formatTokenCount(usage.input_tokens)}`)
    }
    if (typeof usage.cache_read_tokens === 'number' && usage.cache_read_tokens > 0) {
      parts.push(`cached: ${formatTokenCount(usage.cache_read_tokens)}`)
    }
    if (typeof usage.thinking_tokens === 'number' && usage.thinking_tokens > 0) {
      parts.push(`think: ${formatTokenCount(usage.thinking_tokens)}`)
    }
    if (typeof usage.output_tokens === 'number') {
      parts.push(`out: ${formatTokenCount(usage.output_tokens)}`)
    }
  }
  return parts.join(' · ')
}

export interface TranscriptThinkingEntry {
  stepIndex: number
  thinking: string
}

/**
 * Incrementally tails an agy conversation's `transcript.jsonl` to surface
 * `PLANNER_RESPONSE.thinking` blocks that are not emitted in `stream-json`.
 */
export class TranscriptThinkingTailer {
  private readonly brainDir: string
  private conversationId?: string
  private byteOffset = 0
  private readonly printedSteps = new Set<number>()

  constructor(brainDir = join(homedir(), '.gemini', 'antigravity-cli', 'brain')) {
    this.brainDir = brainDir
  }

  private getPath(conversationId: string): string {
    return join(this.brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl')
  }

  /**
   * Binds to a conversation ID. When `skipExisting` is true (e.g. resuming an existing
   * conversation), seeks to EOF so historical reasoning isn't replayed.
   */
  attach(conversationId: string, skipExisting: boolean): void {
    if (this.conversationId === conversationId) return
    this.conversationId = conversationId
    this.printedSteps.clear()
    this.byteOffset = 0
    if (skipExisting) {
      const path = this.getPath(conversationId)
      try {
        if (existsSync(path)) {
          this.byteOffset = statSync(path).size
        }
      } catch {
        this.byteOffset = 0
      }
    }
  }

  reset(): void {
    this.conversationId = undefined
    this.byteOffset = 0
    this.printedSteps.clear()
  }

  /**
   * Reads any newly appended complete JSONL lines and returns unprinted thinking blocks.
   */
  poll(minStepIndex?: number): TranscriptThinkingEntry[] {
    if (!this.conversationId) return []
    const path = this.getPath(this.conversationId)
    if (!existsSync(path)) return []

    let size: number
    try {
      size = statSync(path).size
    } catch {
      return []
    }

    if (size < this.byteOffset) {
      this.byteOffset = 0
    }
    if (size === this.byteOffset) return []

    const toRead = size - this.byteOffset
    const buf = Buffer.alloc(toRead)
    let fd: number | null = null
    let bytesRead = 0
    try {
      fd = openSync(path, 'r')
      bytesRead = readSync(fd, buf, 0, toRead, this.byteOffset)
    } catch {
      return []
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {}
      }
    }

    if (bytesRead <= 0) return []
    const chunk = buf.subarray(0, bytesRead)
    const lastNewline = chunk.lastIndexOf(0x0a) // '\n'
    if (lastNewline === -1) return []

    const completeText = chunk.subarray(0, lastNewline).toString('utf8')
    this.byteOffset += lastNewline + 1

    const entries: TranscriptThinkingEntry[] = []
    for (const rawLine of completeText.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as {
          step_index?: unknown
          type?: unknown
          thinking?: unknown
        }
        const stepIndex = typeof parsed.step_index === 'number' ? parsed.step_index : -1
        const thinking = typeof parsed.thinking === 'string' ? parsed.thinking.trim() : ''
        if (!thinking || stepIndex < 0) continue
        if (minStepIndex !== undefined && stepIndex < minStepIndex) continue
        if (this.printedSteps.has(stepIndex)) continue
        this.printedSteps.add(stepIndex)
        entries.push({ stepIndex, thinking })
      } catch {
        // Ignore malformed or partial JSON lines
      }
    }
    return entries
  }
}

/**
 * Formats and streams live agy session activity (incoming Discord messages,
 * thinking blocks, tool calls, streamed response text, and turn summaries)
 * to the bridge terminal.
 */
export class TerminalStreamLogger {
  private readonly enabled: boolean
  private readonly showThinking: boolean
  private readonly color: boolean
  private readonly write: (chunk: string) => void
  private readonly tailer: TranscriptThinkingTailer

  private streamingText = false
  private streamingThinking = false
  private turnMinStepIndex?: number
  private lastTurnHadText = false
  private lastStreamedStepIndex?: number

  constructor(options: StreamLoggerOptions) {
    this.enabled = options.enabled
    this.showThinking = options.showThinking
    this.color = options.color ?? defaultUseColor()
    this.write = options.write ?? (chunk => process.stdout.write(chunk))
    this.tailer = new TranscriptThinkingTailer(options.brainDir)
  }

  attachConversation(conversationId: string, skipExisting: boolean): void {
    if (!this.enabled || !this.showThinking) return
    this.tailer.attach(conversationId, skipExisting)
  }

  resetConversation(): void {
    this.tailer.reset()
    this.flushOpenStreams()
  }

  onTurnStart(meta?: TurnDisplayMeta): void {
    if (!this.enabled) return
    this.flushOpenStreams()
    this.turnMinStepIndex = undefined
    this.lastTurnHadText = false
    this.lastStreamedStepIndex = undefined

    const now = new Date().toTimeString().slice(0, 8)
    const label = meta
      ? `${meta.channelLabel} · @${meta.author}${meta.modeLabel ? ` (${meta.modeLabel})` : ''}`
      : 'turn'
    const rule = ansi('2', '─'.repeat(60), this.color)
    const header = `${ansi('2', `[${now}]`, this.color)} ${ansi('1;36', label, this.color)}`
    this.write(`\n${rule}\n${header}\n`)
    if (meta?.preview) {
      const preview = truncateInline(meta.preview, 220)
      this.write(`${ansi('36', '>', this.color)} ${preview}\n`)
    }
  }

  onStepUpdate(update: AgyStepUpdate): void {
    if (!this.enabled) return

    if (update.conversation_id) {
      // If we weren't attached yet (brand-new conversation), attach from byte 0.
      this.attachConversation(update.conversation_id, false)
    }

    if (update.step_type === 'user_input' && typeof update.step_index === 'number') {
      this.turnMinStepIndex = update.step_index
      return
    }

    if (update.step_type === 'tool') {
      this.flushOpenStreams()
      this.emitNewThinking()

      const name = update.tool_name || update.tool_info?.name || 'tool'
      if (update.state === 'ACTIVE') {
        const summary = formatToolSummary(name, update.tool_info?.parameters)
        this.write(`${ansi('33', '⚙', this.color)} ${ansi('33', summary, this.color)}\n`)
      } else if (update.state === 'DONE') {
        const dur =
          typeof update.duration_seconds === 'number'
            ? ` (${update.duration_seconds.toFixed(1)}s)`
            : ''
        this.write(`${ansi('2;32', `✓ ${name}${dur}`, this.color)}\n`)
      }
      return
    }

    if (update.step_type === 'agent_response') {
      // If future agy versions emit streaming thinking_delta directly, render it live.
      if (this.showThinking && typeof update.thinking_delta === 'string' && update.thinking_delta) {
        if (this.streamingText) this.flushOpenStreams()
        if (!this.streamingThinking) {
          this.write(`\n${ansi('2;35', '💭 Thinking:', this.color)}\n`)
          this.streamingThinking = true
        }
        this.write(ansi('2;3', update.thinking_delta, this.color))
      }

      if (typeof update.text_delta === 'string' && update.text_delta) {
        if (this.streamingThinking) this.flushOpenStreams()
        // Flush any completed thinking block before streaming the reply text.
        if (this.lastStreamedStepIndex !== update.step_index) {
          this.emitNewThinking()
          this.lastStreamedStepIndex = update.step_index
        }
        if (!this.streamingText) {
          this.write('\n')
          this.streamingText = true
          this.lastTurnHadText = true
        }
        this.write(update.text_delta)
      }

      if (update.state === 'DONE') {
        if (this.streamingText) {
          this.flushOpenStreams()
        }
        this.emitNewThinking()
      }
    }
  }

  onTurnResult(
    response: string,
    usage?: AgyUsage,
    durationSeconds?: number,
  ): void {
    if (!this.enabled) return
    this.flushOpenStreams()
    this.emitNewThinking()

    // If the response wasn't streamed via text_delta, print it now so nothing is missed.
    if (!this.lastTurnHadText && response.trim()) {
      this.write(`\n${response.trim()}\n`)
    }

    const stats = formatUsageSummary(usage, durationSeconds)
    if (stats) {
      this.write(`${ansi('2', `  (${stats})`, this.color)}\n`)
    }
  }

  onDeliveryOutcome(outcome: string, isSilent = false): void {
    if (!this.enabled) return
    this.flushOpenStreams()
    const icon = isSilent ? '⊘' : '↳'
    const style = isSilent ? '2;36' : '2;32'
    this.write(`${ansi(style, `${icon} ${outcome}`, this.color)}\n`)
  }

  private emitNewThinking(): void {
    if (!this.showThinking) return
    const entries = this.tailer.poll(this.turnMinStepIndex)
    for (const entry of entries) {
      const indented = entry.thinking
        .split('\n')
        .map(line => `  ${line}`)
        .join('\n')
      this.write(
        `\n${ansi('2;35', '💭 Thinking:', this.color)}\n${ansi('2;3', indented, this.color)}\n`,
      )
    }
  }

  private flushOpenStreams(): void {
    if (this.streamingText || this.streamingThinking) {
      this.write('\n')
      this.streamingText = false
      this.streamingThinking = false
    }
  }
}
