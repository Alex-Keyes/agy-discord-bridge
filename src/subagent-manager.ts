import { randomBytes } from 'crypto'
import { existsSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { PermissionMode, RuntimeConfig } from './config.ts'
import type {
  SubagentSpawnRequest,
  SubagentSpawnResult,
  SubagentToolHandler,
} from './discord-tools.ts'
import { shouldSuppressFallbackReply } from './response-policy.ts'
import {
  type AgyStepUpdate,
  type AgyUsage,
  TerminalStreamLogger,
} from './stream-logger.ts'

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface SubagentRecord {
  readonly id: string
  readonly chatId: string
  readonly role: string
  readonly task: string
  readonly replyTo?: string
  readonly cwd: string
  readonly permissionMode: PermissionMode
  readonly model?: string
  readonly effort?: string
  status: SubagentStatus
  readonly createdAt: number
  startedAt?: number
  finishedAt?: number
  durationSeconds?: number
  conversationId?: string
  repliedViaTool: boolean
  summary?: string
  error?: string
}

export interface CompletedSubagentUpdate {
  id: string
  role: string
  status: 'completed' | 'failed' | 'cancelled'
  durationSeconds?: number
  summary: string
}

interface AgyInitEvent {
  event: 'init'
  conversation_id?: string
}

interface AgyStepUpdateEvent {
  event: 'step_update'
  step_update?: AgyStepUpdate
}

interface AgyResultEvent {
  event: 'result'
  result?: {
    conversation_id?: string
    status?: string
    response?: string
    error?: string
    duration_seconds?: number
    usage?: AgyUsage
  }
}

type AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | { event: string }

interface ActiveWorker {
  record: SubagentRecord
  proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  workerDir: string
  logger: TerminalStreamLogger
  textBuffer: string
  stderrLines: string[]
  settled: boolean
  stopTyping?: () => void
  timeoutTimer?: ReturnType<typeof setTimeout>
}

export interface SubagentManagerDeps {
  runtime: RuntimeConfig
  createWorkerRuntimeDir(subagentId: string): string
  getChatDefaults(chatId: string): {
    cwd: string
    permissionMode: PermissionMode
    channelLabel?: string
  }
  deliverText(chatId: string, text: string, replyTo?: string): Promise<void>
  deliverError(chatId: string, text: string, replyTo?: string): Promise<void>
  startTyping?(chatId: string): () => void
  spawnProcess?(cmd: string[], cwd: string): Bun.Subprocess<'pipe', 'pipe', 'pipe'>
}

const MAX_RECENT_HISTORY = 30
const MAX_PENDING_UPDATES_PER_CHAT = 10

function escapeXmlAttr(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function summarizeText(text: string, maxLen = 220): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLen) return compact
  return compact.slice(0, maxLen - 1) + '…'
}

export function buildWorkerArgs(
  record: SubagentRecord,
  workerDir: string,
): string[] {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--add-dir',
    workerDir,
  ]

  if (record.model) {
    args.push('--model', record.model)
  }

  if (record.effort) {
    args.push('--effort', record.effort)
  }

  switch (record.permissionMode) {
    case 'always-proceed':
      args.push('--settings', JSON.stringify({ toolPermission: 'always-proceed' }))
      break
    case 'accept-edits':
      args.push('--mode', 'accept-edits')
      break
    case 'plan':
      args.push('--mode', 'plan')
      break
    case 'dangerously-skip-permissions':
      args.push('--dangerously-skip-permissions')
      break
    case 'default':
      break
  }

  return args
}

export function buildWorkerPrompt(record: SubagentRecord): string {
  const attrs = [
    `subagent_id="${escapeXmlAttr(record.id)}"`,
    `role="${escapeXmlAttr(record.role)}"`,
    `chat_id="${escapeXmlAttr(record.chatId)}"`,
  ]
  if (record.replyTo) {
    attrs.push(`reply_to="${escapeXmlAttr(record.replyTo)}"`)
  }
  const replyTarget = record.replyTo
    ? `chat_id="${record.chatId}" (threading under reply_to="${record.replyTo}")`
    : `chat_id="${record.chatId}"`

  return [
    `<subagent_task ${attrs.join(' ')}>`,
    `You are handling a delegated background task for Discord ${replyTarget}.`,
    `Return a clear, concise Discord-ready answer as your final response (automatically posted by the bridge), or call discord.reply directly if attaching files or posting interim progress.`,
    '',
    'Task:',
    record.task,
    '</subagent_task>',
  ].join('\n')
}

export function formatCompletedUpdatesBlock(updates: CompletedSubagentUpdate[]): string {
  if (updates.length === 0) return ''
  const lines = updates.map(u => {
    const dur =
      typeof u.durationSeconds === 'number' ? `, ${u.durationSeconds.toFixed(1)}s` : ''
    return `- [${u.id}] (${u.role}, ${u.status}${dur}): ${u.summary}`
  })
  return `<subagent_updates>\n${lines.join('\n')}\n</subagent_updates>`
}

/**
 * Runs asynchronous, parallel `agy` worker subagents for Discord chats so
 * channel coordinator sessions stay responsive and unblocked.
 */
export class SubagentManager implements SubagentToolHandler {
  private readonly deps: SubagentManagerDeps
  private readonly queue: SubagentRecord[] = []
  private readonly active = new Map<string, ActiveWorker>()
  private readonly recent: SubagentRecord[] = []
  private readonly pendingUpdatesByChat = new Map<string, CompletedSubagentUpdate[]>()
  private readonly inFlightDeliveries = new Set<Promise<void>>()
  private readonly idleWaiters: Array<() => void> = []

  constructor(deps: SubagentManagerDeps) {
    this.deps = deps
  }

  get maxConcurrent(): number {
    return this.deps.runtime.maxSubagents
  }

  spawn(req: SubagentSpawnRequest): SubagentSpawnResult {
    const defaults = this.deps.getChatDefaults(req.chatId)
    let cwd = defaults.cwd
    if (req.cwd) {
      const expanded = req.cwd.startsWith('~/')
        ? join(homedir(), req.cwd.slice(2))
        : req.cwd
      const resolved = resolve(expanded)
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
        throw new Error(`subagent cwd does not exist or is not a directory: ${resolved}`)
      }
      cwd = resolved
    }

    const id = `sa-${randomBytes(3).toString('hex')}`
    const role = (req.role?.trim() || 'Worker').slice(0, 60)
    const record: SubagentRecord = {
      id,
      chatId: req.chatId,
      role,
      task: req.task,
      replyTo: req.replyTo,
      cwd,
      permissionMode: defaults.permissionMode,
      model: req.model || this.deps.runtime.subagentModel || this.deps.runtime.model,
      effort: req.effort || this.deps.runtime.subagentEffort || this.deps.runtime.effort,
      status: 'queued',
      createdAt: Date.now(),
      repliedViaTool: false,
    }

    this.queue.push(record)
    this.pumpQueue()

    if (record.status === 'running') {
      return { id, role, status: 'running' }
    }
    const pos = this.queue.findIndex(r => r.id === id) + 1
    return { id, role, status: 'queued', queuePosition: pos > 0 ? pos : 1 }
  }

  markReplied(subagentId: string): void {
    const worker = this.active.get(subagentId)
    if (worker) {
      worker.record.repliedViaTool = true
    }
  }

  getSummary(chatId?: string): {
    running: SubagentRecord[]
    queued: SubagentRecord[]
    recent: SubagentRecord[]
    maxConcurrent: number
  } {
    const matches = (r: SubagentRecord) => !chatId || r.chatId === chatId
    return {
      running: [...this.active.values()].map(w => w.record).filter(matches),
      queued: this.queue.filter(matches),
      recent: this.recent.filter(matches),
      maxConcurrent: this.maxConcurrent,
    }
  }

  list(chatId?: string): string {
    const { running, queued, recent, maxConcurrent } = this.getSummary(chatId)
    if (running.length === 0 && queued.length === 0 && recent.length === 0) {
      return chatId
        ? `No active or recent subagents for chat ${chatId}.`
        : 'No active or recent subagents.'
    }

    const lines: string[] = [
      `Subagents (${running.length}/${maxConcurrent} running, ${queued.length} queued):`,
    ]

    if (running.length > 0) {
      lines.push('', 'Running:')
      for (const r of running) {
        const elapsed = r.startedAt ? Math.max(0, Math.round((Date.now() - r.startedAt) / 1000)) : 0
        lines.push(`- ${r.id} [${r.role}] chat=${r.chatId} (${elapsed}s): ${summarizeText(r.task, 90)}`)
      }
    }

    if (queued.length > 0) {
      lines.push('', 'Queued:')
      for (let i = 0; i < queued.length; i++) {
        const r = queued[i]!
        lines.push(`- #${i + 1} ${r.id} [${r.role}] chat=${r.chatId}: ${summarizeText(r.task, 90)}`)
      }
    }

    if (recent.length > 0) {
      lines.push('', 'Recent:')
      for (const r of recent.slice(0, 8)) {
        const dur = typeof r.durationSeconds === 'number' ? ` ${r.durationSeconds.toFixed(1)}s` : ''
        const note = r.summary || r.error || ''
        lines.push(
          `- ${r.id} [${r.role}] ${r.status}${dur}${note ? `: ${summarizeText(note, 90)}` : ''}`,
        )
      }
    }

    return lines.join('\n')
  }

  cancel(subagentId: string): { cancelled: boolean; message: string } {
    const qIdx = this.queue.findIndex(r => r.id === subagentId)
    if (qIdx !== -1) {
      const [record] = this.queue.splice(qIdx, 1)
      if (record) {
        record.status = 'cancelled'
        record.finishedAt = Date.now()
        record.summary = 'Cancelled while queued'
        this.recordCompletion(record)
        this.notifyIdleIfNeeded()
      }
      return { cancelled: true, message: `Cancelled queued subagent ${subagentId}.` }
    }

    const worker = this.active.get(subagentId)
    if (!worker) {
      return { cancelled: false, message: `No active or queued subagent found with ID "${subagentId}".` }
    }

    this.finishWorker(worker, 'cancelled', { summary: 'Cancelled by request' })
    return { cancelled: true, message: `Cancelled running subagent ${subagentId} (${worker.record.role}).` }
  }

  cancelForChat(chatId: string): number {
    let count = 0
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.chatId === chatId) {
        const [record] = this.queue.splice(i, 1)
        if (record) {
          record.status = 'cancelled'
          record.finishedAt = Date.now()
          record.summary = 'Cancelled by chat command'
          this.recordCompletion(record)
          count++
        }
      }
    }

    for (const worker of [...this.active.values()]) {
      if (worker.record.chatId === chatId) {
        this.finishWorker(worker, 'cancelled', { summary: 'Cancelled by chat command' })
        count++
      }
    }

    this.notifyIdleIfNeeded()
    return count
  }

  drainCompletedUpdates(chatId: string): CompletedSubagentUpdate[] {
    const list = this.pendingUpdatesByChat.get(chatId)
    if (!list || list.length === 0) return []
    this.pendingUpdatesByChat.delete(chatId)
    return list
  }

  waitForIdle(): Promise<void> {
    if (
      this.active.size === 0 &&
      this.queue.length === 0 &&
      this.inFlightDeliveries.size === 0
    ) {
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.idleWaiters.push(resolve)
    })
  }

  disposeAll(): void {
    this.queue.length = 0
    for (const worker of [...this.active.values()]) {
      this.cleanupWorkerProcess(worker)
      this.active.delete(worker.record.id)
    }
    this.notifyIdleIfNeeded()
  }

  private pumpQueue(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.startWorker(next)
    }
    this.notifyIdleIfNeeded()
  }

  private startWorker(record: SubagentRecord): void {
    record.status = 'running'
    record.startedAt = Date.now()

    let workerDir: string
    try {
      workerDir = this.deps.createWorkerRuntimeDir(record.id)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      record.status = 'failed'
      record.finishedAt = Date.now()
      record.error = errMsg
      this.recordCompletion(record)
      void this.deps
        .deliverError(record.chatId, `Subagent \`${record.id}\` (${record.role}) failed to start: ${errMsg}`, record.replyTo)
        .catch(() => {})
      this.pumpQueue()
      return
    }

    const args = buildWorkerArgs(record, workerDir)
    const cmd = [this.deps.runtime.agyBin, ...args]

    let proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
    try {
      proc = this.deps.spawnProcess
        ? this.deps.spawnProcess(cmd, record.cwd)
        : Bun.spawn(cmd, {
            cwd: record.cwd,
            stdin: 'pipe',
            stdout: 'pipe',
            stderr: 'pipe',
            env: process.env,
          })
    } catch (err) {
      try {
        rmSync(workerDir, { recursive: true, force: true })
      } catch {}
      const errMsg = err instanceof Error ? err.message : String(err)
      record.status = 'failed'
      record.finishedAt = Date.now()
      record.error = errMsg
      this.recordCompletion(record)
      void this.deps
        .deliverError(record.chatId, `Subagent \`${record.id}\` (${record.role}) failed to spawn: ${errMsg}`, record.replyTo)
        .catch(() => {})
      this.pumpQueue()
      return
    }

    const logger = new TerminalStreamLogger({
      enabled: this.deps.runtime.streamLog,
      showThinking: this.deps.runtime.showThinking,
    })

    const defaults = this.deps.getChatDefaults(record.chatId)
    const channelLabel = defaults.channelLabel ?? record.chatId
    logger.onTurnStart({
      channelLabel: `${channelLabel} · subagent ${record.id}`,
      author: record.role,
      preview: record.task,
    })

    const worker: ActiveWorker = {
      record,
      proc,
      workerDir,
      logger,
      textBuffer: '',
      stderrLines: [],
      settled: false,
      stopTyping: this.deps.startTyping?.(record.chatId),
    }

    if (this.deps.runtime.subagentTimeoutMs > 0) {
      worker.timeoutTimer = setTimeout(() => {
        if (worker.settled) return
        const mins = Math.round(this.deps.runtime.subagentTimeoutMs / 60_000)
        const timeoutMsg = `timed out after ${mins > 0 ? `${mins}m` : `${this.deps.runtime.subagentTimeoutMs}ms`}`
        this.finishWorker(worker, 'failed', { error: timeoutMsg, notifyDiscord: true })
      }, this.deps.runtime.subagentTimeoutMs)
    }

    this.active.set(record.id, worker)

    void this.readStdout(worker)
    void this.readStderr(worker)
    void this.watchExit(worker)

    try {
      const payload =
        JSON.stringify({
          event: 'user',
          message: { content: buildWorkerPrompt(record) },
        }) + '\n'
      proc.stdin.write(payload)
      proc.stdin.flush()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.finishWorker(worker, 'failed', { error: errMsg, notifyDiscord: true })
    }
  }

  private async readStdout(worker: ActiveWorker): Promise<void> {
    const reader = worker.proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let idx = buffer.indexOf('\n')
        while (idx !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (line) this.handleLine(worker, line)
          idx = buffer.indexOf('\n')
        }
      }
      if (buffer.trim()) this.handleLine(worker, buffer.trim())
    } catch (err) {
      if (!worker.settled) {
        console.error(`[subagent:${worker.record.id}] stdout read error:`, err)
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async readStderr(worker: ActiveWorker): Promise<void> {
    const reader = worker.proc.stderr.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx = buffer.indexOf('\n')
        while (idx !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (line) {
            worker.stderrLines.push(line)
            if (worker.stderrLines.length > 30) worker.stderrLines.shift()
            console.error(`[subagent:${worker.record.id}:stderr] ${line}`)
          }
          idx = buffer.indexOf('\n')
        }
      }
    } catch {
      // ignore on shutdown
    } finally {
      reader.releaseLock()
    }
  }

  private async watchExit(worker: ActiveWorker): Promise<void> {
    const exitCode = await worker.proc.exited
    if (worker.settled) return

    const tail = worker.stderrLines.slice(-5).join('\n')
    const msg = `subagent process exited unexpectedly (code ${exitCode})${tail ? `:\n${tail}` : ''}`
    this.finishWorker(worker, 'failed', { error: msg, notifyDiscord: true })
  }

  private handleLine(worker: ActiveWorker, line: string): void {
    if (worker.settled) return

    let evt: AgyEvent
    try {
      evt = JSON.parse(line) as AgyEvent
    } catch {
      return
    }

    if (evt.event === 'init') {
      const init = evt as AgyInitEvent
      if (init.conversation_id) {
        worker.record.conversationId = init.conversation_id
        worker.logger.attachConversation(init.conversation_id, false)
      }
      return
    }

    if (evt.event === 'step_update') {
      const update = (evt as AgyStepUpdateEvent).step_update
      if (update?.conversation_id) {
        worker.record.conversationId = update.conversation_id
      }
      if (update) {
        worker.logger.onStepUpdate(update)
      }
      if (update?.step_type === 'agent_response' && typeof update.text_delta === 'string') {
        worker.textBuffer += update.text_delta
      }
      return
    }

    if (evt.event === 'result') {
      const res = (evt as AgyResultEvent).result
      if (res?.conversation_id) {
        worker.record.conversationId = res.conversation_id
      }

      const status = res?.status ?? 'UNKNOWN'
      const text = (res?.response ?? worker.textBuffer ?? '').trim()

      if (status !== 'SUCCESS' && !text && !worker.record.repliedViaTool) {
        const errMsg = res?.error || `agy returned status ${status}`
        this.finishWorker(worker, 'failed', {
          error: errMsg,
          durationSeconds: res?.duration_seconds,
          notifyDiscord: true,
        })
        return
      }

      const finalText =
        res?.error && status !== 'SUCCESS'
          ? `${text}\n\n_(status: ${status} — ${res.error})_`
          : text

      worker.logger.onTurnResult(finalText, res?.usage, res?.duration_seconds)
      this.finishWorker(worker, 'completed', {
        responseText: finalText,
        durationSeconds: res?.duration_seconds,
      })
    }
  }

  private finishWorker(
    worker: ActiveWorker,
    outcome: 'completed' | 'failed' | 'cancelled',
    details: {
      responseText?: string
      summary?: string
      error?: string
      durationSeconds?: number
      notifyDiscord?: boolean
    },
  ): void {
    if (worker.settled) return
    worker.settled = true

    this.active.delete(worker.record.id)
    this.cleanupWorkerProcess(worker)

    const now = Date.now()
    worker.record.status = outcome
    worker.record.finishedAt = now
    worker.record.durationSeconds =
      details.durationSeconds ??
      (worker.record.startedAt ? (now - worker.record.startedAt) / 1000 : undefined)

    if (outcome === 'completed') {
      const text = details.responseText ?? ''
      const suppress = shouldSuppressFallbackReply(
        { response: text, repliedViaTool: worker.record.repliedViaTool },
        { isDynamic: false },
      )

      worker.record.summary = worker.record.repliedViaTool
        ? text
          ? summarizeText(text)
          : 'Replied directly via Discord tool'
        : suppress
          ? 'Completed silently (NO_REPLY)'
          : summarizeText(text || '(completed with no text output)')

      this.recordCompletion(worker.record)

      if (!suppress) {
        const body = text.trim() || '(subagent completed with no text output)'
        this.trackDelivery(
          this.deps
            .deliverText(worker.record.chatId, body, worker.record.replyTo)
            .then(() => {
              worker.logger.onDeliveryOutcome(`posted to Discord (${worker.record.id})`)
            })
            .catch(err => {
              console.error(`[subagent:${worker.record.id}] delivery failed:`, err)
            }),
        )
      } else if (worker.record.repliedViaTool) {
        worker.logger.onDeliveryOutcome(`replied via Discord tool (${worker.record.id})`)
      } else {
        worker.logger.onDeliveryOutcome(`silent (NO_REPLY) (${worker.record.id})`, true)
      }
    } else if (outcome === 'failed') {
      const errMsg = details.error || 'unknown subagent error'
      worker.record.error = errMsg
      worker.record.summary = `Failed: ${summarizeText(errMsg, 180)}`
      this.recordCompletion(worker.record)
      worker.logger.onDeliveryOutcome(`failed (${worker.record.id}): ${summarizeText(errMsg, 80)}`)

      if (details.notifyDiscord) {
        const notice = `Subagent \`${worker.record.id}\` (${worker.record.role}) failed:\n\`\`\`\n${errMsg.slice(0, 1200)}\n\`\`\``
        this.trackDelivery(
          this.deps.deliverError(worker.record.chatId, notice, worker.record.replyTo).catch(() => {}),
        )
      }
    } else {
      worker.record.summary = details.summary ?? 'Cancelled'
      this.recordCompletion(worker.record)
      worker.logger.onDeliveryOutcome(`cancelled (${worker.record.id})`, true)
    }

    this.pumpQueue()
  }

  private trackDelivery(promise: Promise<void>): void {
    this.inFlightDeliveries.add(promise)
    void promise.finally(() => {
      this.inFlightDeliveries.delete(promise)
      this.notifyIdleIfNeeded()
    })
  }

  private cleanupWorkerProcess(worker: ActiveWorker): void {
    if (worker.timeoutTimer) {
      clearTimeout(worker.timeoutTimer)
      worker.timeoutTimer = undefined
    }
    if (worker.stopTyping) {
      try {
        worker.stopTyping()
      } catch {}
      worker.stopTyping = undefined
    }

    try {
      worker.proc.stdin.end()
    } catch {}
    try {
      worker.proc.kill('SIGTERM')
    } catch {}

    try {
      rmSync(worker.workerDir, { recursive: true, force: true })
    } catch {}
  }

  private recordCompletion(record: SubagentRecord): void {
    this.recent.unshift(record)
    if (this.recent.length > MAX_RECENT_HISTORY) {
      this.recent.length = MAX_RECENT_HISTORY
    }

    if (
      record.status === 'completed' ||
      record.status === 'failed' ||
      record.status === 'cancelled'
    ) {
      const updates = this.pendingUpdatesByChat.get(record.chatId) ?? []
      updates.push({
        id: record.id,
        role: record.role,
        status: record.status,
        durationSeconds: record.durationSeconds,
        summary: record.summary ?? record.error ?? record.status,
      })
      if (updates.length > MAX_PENDING_UPDATES_PER_CHAT) {
        updates.shift()
      }
      this.pendingUpdatesByChat.set(record.chatId, updates)
    }
  }

  private notifyIdleIfNeeded(): void {
    if (
      this.active.size > 0 ||
      this.queue.length > 0 ||
      this.inFlightDeliveries.size > 0
    ) {
      return
    }
    while (this.idleWaiters.length > 0) {
      this.idleWaiters.shift()?.()
    }
  }
}
