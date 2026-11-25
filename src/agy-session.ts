import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import {
  ensureStateDir,
  getStateDir,
  getStatePaths,
  type PermissionMode,
  type RuntimeConfig,
} from './config.ts'
import {
  type AgyStepUpdate,
  type AgyUsage,
  TerminalStreamLogger,
  type TurnDisplayMeta,
} from './stream-logger.ts'

export type { TurnDisplayMeta } from './stream-logger.ts'

export interface SavedSession {
  conversationId: string
  cwd: string
  permissionMode?: PermissionMode
  updatedAt: string
}

type SessionStore = Record<string, SavedSession>

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
    num_turns?: number
    usage?: AgyUsage
  }
}

type AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent | { event: string }

export interface TurnResult {
  response: string
  conversationId?: string
  status: string
  durationSeconds?: number
  /** True if the agent already delivered a reply via the `discord` MCP `reply` tool during this turn. */
  repliedViaTool: boolean
}

interface PendingTurn {
  prompt: string
  displayMeta?: TurnDisplayMeta
  resolve: (result: TurnResult) => void
  reject: (err: Error) => void
  textBuffer: string
  repliedViaTool: boolean
}

function loadStore(stateDir: string): SessionStore {
  ensureStateDir(stateDir)
  const { sessionsFile } = getStatePaths(stateDir)
  if (!existsSync(sessionsFile)) return {}
  try {
    return JSON.parse(readFileSync(sessionsFile, 'utf8')) as SessionStore
  } catch {
    return {}
  }
}

function saveStore(store: SessionStore, stateDir: string): void {
  ensureStateDir(stateDir)
  const { sessionsFile } = getStatePaths(stateDir)
  const tmp = `${sessionsFile}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, sessionsFile)
}

class ChatSession {
  readonly chatId: string
  cwd: string
  permissionMode: PermissionMode
  conversationId?: string

  private readonly runtime: RuntimeConfig
  private readonly extraAddDirs: string[]
  private readonly onPersist: (session: SavedSession) => void
  private readonly streamLogger: TerminalStreamLogger

  private proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | null = null
  private queue: PendingTurn[] = []
  private activeTurn: PendingTurn | null = null
  private stderrLines: string[] = []
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private startedAt: number | null = null

  constructor(
    chatId: string,
    runtime: RuntimeConfig,
    extraAddDirs: string[],
    saved: SavedSession | undefined,
    onPersist: (session: SavedSession) => void,
  ) {
    this.chatId = chatId
    this.runtime = runtime
    this.extraAddDirs = extraAddDirs
    this.cwd = saved?.cwd ?? runtime.defaultCwd
    this.permissionMode = saved?.permissionMode ?? runtime.permissionMode
    this.conversationId = saved?.conversationId
    this.onPersist = onPersist
    this.streamLogger = new TerminalStreamLogger({
      enabled: runtime.streamLog,
      showThinking: runtime.showThinking,
    })
    if (this.conversationId) {
      this.streamLogger.attachConversation(this.conversationId, true)
    }
  }

  getStatus(): {
    chatId: string
    cwd: string
    permissionMode: PermissionMode
    conversationId?: string
    running: boolean
    busy: boolean
    queued: number
    uptimeSeconds?: number
  } {
    return {
      chatId: this.chatId,
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      conversationId: this.conversationId,
      running: this.proc !== null,
      busy: this.activeTurn !== null,
      queued: this.queue.length,
      uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : undefined,
    }
  }

  markRepliedViaTool(): void {
    if (this.activeTurn) {
      this.activeTurn.repliedViaTool = true
    }
  }

  logDeliveryOutcome(outcome: string, isSilent = false): void {
    this.streamLogger.onDeliveryOutcome(outcome, isSilent)
  }

  async send(prompt: string, displayMeta?: TurnDisplayMeta): Promise<TurnResult> {
    try {
      return await this.enqueueTurn(prompt, displayMeta)
    } catch (err) {
      if (this.conversationId && err instanceof Error && err.message.includes('exited unexpectedly')) {
        console.warn(`[agy:${this.chatId}] Resume failed for ${this.conversationId}; retrying fresh session`)
        this.conversationId = undefined
        this.streamLogger.resetConversation()
        return await this.enqueueTurn(prompt, displayMeta)
      }
      throw err
    }
  }

  private enqueueTurn(prompt: string, displayMeta?: TurnDisplayMeta): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, displayMeta, resolve, reject, textBuffer: '', repliedViaTool: false })
      this.pumpQueue()
    })
  }

  reset(newCwd?: string, newMode?: PermissionMode): void {
    this.killProcess('Session reset by user')
    this.conversationId = undefined
    this.streamLogger.resetConversation()
    if (newCwd) this.cwd = newCwd
    if (newMode) this.permissionMode = newMode
  }

  stop(): void {
    this.killProcess('Turn cancelled by user')
  }

  dispose(): void {
    this.killProcess('Bridge shutting down')
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    if (this.runtime.idleTimeoutMs <= 0) return
    this.idleTimer = setTimeout(() => {
      if (!this.activeTurn && this.queue.length === 0 && this.proc) {
        console.log(
          `[agy:${this.chatId}] Closing idle process (conversation ${this.conversationId ?? 'none'} saved)`,
        )
        this.killProcess('Idle timeout')
      }
    }, this.runtime.idleTimeoutMs)
  }

  private buildArgs(): string[] {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json']

    for (const dir of this.extraAddDirs) {
      args.push('--add-dir', dir)
    }

    if (this.conversationId) {
      args.push('--conversation', this.conversationId)
    }

    const model = this.runtime.coordinatorModel ?? this.runtime.model
    if (model) {
      args.push('--model', model)
    }

    const effort = this.runtime.coordinatorEffort ?? this.runtime.effort
    if (effort) {
      args.push('--effort', effort)
    }

    switch (this.permissionMode) {
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

  private ensureProcess(): Bun.Subprocess<'pipe', 'pipe', 'pipe'> {
    if (this.proc) return this.proc

    const args = this.buildArgs()
    console.log(
      `[agy:${this.chatId}] Spawning ${this.runtime.agyBin} in ${this.cwd} (mode=${this.permissionMode}, resume=${this.conversationId ?? 'new'})`,
    )

    this.stderrLines = []
    this.startedAt = Date.now()

    const proc = Bun.spawn([this.runtime.agyBin, ...args], {
      cwd: this.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })

    this.proc = proc
    void this.readStdout(proc)
    void this.readStderr(proc)
    void this.watchExit(proc)

    return proc
  }

  private pumpQueue(): void {
    if (this.activeTurn || this.queue.length === 0) return

    this.clearIdleTimer()
    const turn = this.queue.shift()!
    this.activeTurn = turn

    try {
      const proc = this.ensureProcess()
      this.streamLogger.onTurnStart(turn.displayMeta)
      const payload =
        JSON.stringify({
          event: 'user',
          message: { content: turn.prompt },
        }) + '\n'
      proc.stdin.write(payload)
      proc.stdin.flush()
    } catch (err) {
      this.activeTurn = null
      turn.reject(err instanceof Error ? err : new Error(String(err)))
      this.pumpQueue()
    }
  }

  private async readStdout(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    const reader = proc.stdout.getReader()
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
          if (line) this.handleLine(line)
          idx = buffer.indexOf('\n')
        }
      }
      if (buffer.trim()) this.handleLine(buffer.trim())
    } catch (err) {
      if (this.proc === proc) {
        console.error(`[agy:${this.chatId}] stdout read error:`, err)
      }
    } finally {
      reader.releaseLock()
    }
  }

  private async readStderr(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    const reader = proc.stderr.getReader()
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
            this.stderrLines.push(line)
            if (this.stderrLines.length > 30) this.stderrLines.shift()
            console.error(`[agy:${this.chatId}:stderr] ${line}`)
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

  private async watchExit(proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>): Promise<void> {
    const exitCode = await proc.exited
    if (this.proc !== proc) return

    this.proc = null
    this.startedAt = null
    this.clearIdleTimer()

    const tail = this.stderrLines.slice(-5).join('\n')
    const msg = `agy exited unexpectedly (code ${exitCode})${tail ? `:\n${tail}` : ''}`

    if (this.activeTurn) {
      const failed = this.activeTurn
      this.activeTurn = null
      failed.reject(new Error(msg))
    }

    if (this.queue.length > 0) {
      this.pumpQueue()
    }
  }

  private handleLine(line: string): void {
    let evt: AgyEvent
    try {
      evt = JSON.parse(line) as AgyEvent
    } catch {
      console.warn(`[agy:${this.chatId}] Non-JSON stdout: ${line.slice(0, 200)}`)
      return
    }

    if (evt.event === 'init') {
      const init = evt as AgyInitEvent
      if (init.conversation_id) {
        this.recordConversationId(init.conversation_id)
        this.streamLogger.attachConversation(init.conversation_id, false)
      }
      return
    }

    if (evt.event === 'step_update') {
      const update = (evt as AgyStepUpdateEvent).step_update
      if (update?.conversation_id) {
        this.recordConversationId(update.conversation_id)
      }
      if (update) {
        this.streamLogger.onStepUpdate(update)
      }
      if (
        this.activeTurn &&
        update?.step_type === 'agent_response' &&
        typeof update.text_delta === 'string'
      ) {
        this.activeTurn.textBuffer += update.text_delta
      }
      return
    }

    if (evt.event === 'result') {
      const res = (evt as AgyResultEvent).result
      if (res?.conversation_id) {
        this.recordConversationId(res.conversation_id)
      }

      const turn = this.activeTurn
      this.activeTurn = null

      if (turn) {
        const status = res?.status ?? 'UNKNOWN'
        const text = (res?.response ?? turn.textBuffer ?? '').trim()

        if (status !== 'SUCCESS' && !text && !turn.repliedViaTool) {
          turn.reject(new Error(res?.error || `agy returned status ${status}`))
        } else {
          const finalText =
            res?.error && status !== 'SUCCESS'
              ? `${text}\n\n_(status: ${status} — ${res.error})_`
              : text
          this.streamLogger.onTurnResult(finalText, res?.usage, res?.duration_seconds)
          turn.resolve({
            response: finalText,
            conversationId: this.conversationId,
            status,
            durationSeconds: res?.duration_seconds,
            repliedViaTool: turn.repliedViaTool,
          })
        }
      }

      if (this.queue.length > 0) {
        this.pumpQueue()
      } else {
        this.armIdleTimer()
      }
    }
  }

  private recordConversationId(id: string): void {
    if (!id) return
    this.conversationId = id
    this.onPersist({
      conversationId: id,
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      updatedAt: new Date().toISOString(),
    })
  }

  private killProcess(reason: string): void {
    this.clearIdleTimer()
    const proc = this.proc
    this.proc = null
    this.startedAt = null

    if (proc) {
      try {
        proc.stdin.end()
      } catch {}
      try {
        proc.kill('SIGTERM')
      } catch {}
    }

    if (this.activeTurn) {
      const turn = this.activeTurn
      this.activeTurn = null
      turn.reject(new Error(reason))
    }

    while (this.queue.length > 0) {
      const queued = this.queue.shift()!
      queued.reject(new Error(reason))
    }
  }
}

export class AgySessionManager {
  private readonly runtime: RuntimeConfig
  private readonly stateDir: string
  private readonly extraAddDirs: string[]
  private readonly store: SessionStore
  private readonly sessions = new Map<string, ChatSession>()

  constructor(
    runtime: RuntimeConfig,
    options?: { stateDir?: string; extraAddDirs?: string[] },
  ) {
    this.runtime = runtime
    this.stateDir = options?.stateDir ?? getStateDir()
    this.extraAddDirs = options?.extraAddDirs ?? []
    this.store = loadStore(this.stateDir)
  }

  get(chatId: string): ChatSession {
    let session = this.sessions.get(chatId)
    if (!session) {
      session = new ChatSession(
        chatId,
        this.runtime,
        this.extraAddDirs,
        this.store[chatId],
        saved => {
          this.store[chatId] = saved
          saveStore(this.store, this.stateDir)
        },
      )
      this.sessions.set(chatId, session)
    }
    return session
  }

  markReplied(chatId: string, parentChannelId?: string | null): void {
    const direct = this.sessions.get(chatId)
    if (direct) {
      direct.markRepliedViaTool()
      return
    }
    if (parentChannelId) {
      this.sessions.get(parentChannelId)?.markRepliedViaTool()
    }
  }

  reset(chatId: string, newCwd?: string, newMode?: PermissionMode): void {
    const session = this.get(chatId)
    session.reset(newCwd, newMode)
    delete this.store[chatId]
    saveStore(this.store, this.stateDir)
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose()
    }
    this.sessions.clear()
  }
}
