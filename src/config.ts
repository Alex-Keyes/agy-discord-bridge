import { randomBytes } from 'crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(__dirname, '..')

export type PermissionMode =
  | 'always-proceed'
  | 'accept-edits'
  | 'plan'
  | 'default'
  | 'dangerously-skip-permissions'

export type GroupResponseMode = 'always' | 'dynamic'

export interface GroupPolicy {
  requireMention: boolean
  allowFrom: string[]
  /** 'always' (default): reply to every delivered message. 'dynamic': observe all messages and decide whether to reply or output NO_REPLY. */
  responseMode?: GroupResponseMode
}

export interface PendingPairing {
  senderId: string
  username?: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export interface AccessConfig {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel ID (snowflake), not guild ID. One entry per guild channel. */
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingPairing>
  /** Case-insensitive regex strings that count as a mention in requireMention channels. */
  mentionPatterns?: string[]
  /** Emoji to react with on receipt. Empty string disables. Unicode char or <:name:id>. */
  ackReaction?: string
  /** Which chunks get Discord's reply reference when reply_to is passed: 'off' | 'first' | 'all'. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting (Discord hard cap: 2000). */
  textChunkLimit?: number
  /** Split strategy: 'newline' (paragraph/code-fence aware) | 'length' (hard cut). */
  chunkMode?: 'length' | 'newline'
}

export interface RuntimeConfig {
  token: string
  agyBin: string
  defaultCwd: string
  permissionMode: PermissionMode
  model?: string
  effort?: string
  idleTimeoutMs: number
  staticMode: boolean
  autoDownloadAttachments: boolean
}

export const MAX_CHUNK_LIMIT = 2000
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_PENDING_PAIRINGS = 3
export const MAX_PAIRING_REPLIES = 2
export const PAIRING_TTL_MS = 60 * 60 * 1000

export function getStateDir(): string {
  const override = process.env.DISCORD_STATE_DIR ?? process.env.AGY_DISCORD_STATE_DIR
  if (override?.trim()) {
    const trimmed = override.trim()
    if (trimmed.startsWith('~/')) {
      return join(homedir(), trimmed.slice(2))
    }
    return resolve(trimmed)
  }
  return join(homedir(), '.agy-discord')
}

export function getStatePaths(stateDir = getStateDir()) {
  return {
    stateDir,
    accessFile: join(stateDir, 'access.json'),
    approvedDir: join(stateDir, 'approved'),
    envFile: join(stateDir, '.env'),
    sessionsFile: join(stateDir, 'sessions.json'),
    inboxDir: join(stateDir, 'inbox'),
  }
}

export function defaultAccess(): AccessConfig {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

/**
 * Loads key=value pairs from .env files into process.env.
 * Precedence: real process.env > <repo>/.env > <STATE_DIR>/.env.
 */
export function loadEnvFiles(stateDir = getStateDir()): void {
  const candidates = [
    join(PROJECT_ROOT, '.env'),
    join(stateDir, '.env'),
  ]

  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      chmodSync(file, 0o600)
    } catch {
      // No-op on non-POSIX filesystems
    }
    try {
      const content = readFileSync(file, 'utf8')
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const key = line.slice(0, eq).trim()
        let val = line.slice(eq + 1).trim()
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1)
        }
        if (process.env[key] === undefined) {
          process.env[key] = val
        }
      }
    } catch {
      // Ignore unreadable .env
    }
  }
}

export function loadRuntimeConfig(stateDir = getStateDir()): RuntimeConfig {
  loadEnvFiles(stateDir)

  const token = process.env.DISCORD_BOT_TOKEN?.trim()
  if (!token) {
    const { envFile } = getStatePaths(stateDir)
    throw new Error(
      `DISCORD_BOT_TOKEN is required.\n` +
        `Run: bun run configure <YOUR_BOT_TOKEN>\n` +
        `Or set DISCORD_BOT_TOKEN in ${envFile} or ${join(PROJECT_ROOT, '.env')}.`,
    )
  }

  const rawPerm = (process.env.AGY_PERMISSION_MODE ?? 'always-proceed').trim()
  const validModes: PermissionMode[] = [
    'always-proceed',
    'accept-edits',
    'plan',
    'default',
    'dangerously-skip-permissions',
  ]
  const permissionMode: PermissionMode = validModes.includes(rawPerm as PermissionMode)
    ? (rawPerm as PermissionMode)
    : 'always-proceed'

  const idleRaw = Number(process.env.AGY_IDLE_TIMEOUT_MS ?? 30 * 60 * 1000)
  const idleTimeoutMs = Number.isFinite(idleRaw) && idleRaw >= 0 ? idleRaw : 30 * 60 * 1000

  const cwdEnv = process.env.AGY_CWD?.trim()
  const defaultCwd = cwdEnv
    ? cwdEnv.startsWith('~/')
      ? join(homedir(), cwdEnv.slice(2))
      : resolve(cwdEnv)
    : process.cwd()

  return {
    token,
    agyBin: process.env.AGY_BIN?.trim() || 'agy',
    defaultCwd,
    permissionMode,
    model: process.env.AGY_MODEL?.trim() || undefined,
    effort: process.env.AGY_EFFORT?.trim() || undefined,
    idleTimeoutMs,
    staticMode: process.env.DISCORD_ACCESS_MODE === 'static',
    autoDownloadAttachments: process.env.DISCORD_AUTO_DOWNLOAD_ATTACHMENTS === 'true',
  }
}

export function ensureStateDir(stateDir = getStateDir()): void {
  const { inboxDir } = getStatePaths(stateDir)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  mkdirSync(inboxDir, { recursive: true })
}

export function readAccessFile(stateDir = getStateDir()): AccessConfig {
  const { accessFile } = getStatePaths(stateDir)
  try {
    const raw = readFileSync(accessFile, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AccessConfig>
    return {
      dmPolicy: parsed.dmPolicy ?? 'pairing',
      allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [],
      groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
      pending: parsed.pending && typeof parsed.pending === 'object' ? parsed.pending : {},
      mentionPatterns: Array.isArray(parsed.mentionPatterns) ? parsed.mentionPatterns : undefined,
      ackReaction: parsed.ackReaction,
      replyToMode: parsed.replyToMode,
      textChunkLimit: parsed.textChunkLimit,
      chunkMode: parsed.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    // Corrupt JSON: move aside instead of crashing or silently losing the file.
    try {
      renameSync(accessFile, `${accessFile}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write(`agy-discord: ${accessFile} is corrupt, moved aside. Starting fresh.\n`)
    return defaultAccess()
  }
}

export function saveAccessFile(access: AccessConfig, stateDir = getStateDir()): void {
  const { accessFile } = getStatePaths(stateDir)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const tmp = `${accessFile}.tmp`
  writeFileSync(tmp, JSON.stringify(access, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, accessFile)
}

export function pruneExpiredPending(access: AccessConfig, now = Date.now()): boolean {
  let changed = false
  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.expiresAt < now) {
      delete access.pending[code]
      changed = true
    }
  }
  return changed
}

/**
 * Manages runtime access loading with support for DISCORD_ACCESS_MODE=static.
 */
export class AccessStore {
  readonly stateDir: string
  readonly staticMode: boolean
  private readonly bootSnapshot: AccessConfig | null

  constructor(stateDir = getStateDir(), staticMode = process.env.DISCORD_ACCESS_MODE === 'static') {
    this.stateDir = stateDir
    this.staticMode = staticMode
    if (staticMode) {
      const a = readAccessFile(stateDir)
      if (a.dmPolicy === 'pairing') {
        process.stderr.write(
          'agy-discord: static mode — dmPolicy "pairing" downgraded to "allowlist"\n',
        )
        a.dmPolicy = 'allowlist'
      }
      a.pending = {}
      this.bootSnapshot = a
    } else {
      this.bootSnapshot = null
    }
  }

  load(): AccessConfig {
    return this.bootSnapshot ?? readAccessFile(this.stateDir)
  }

  save(access: AccessConfig): void {
    if (this.staticMode) return
    saveAccessFile(access, this.stateDir)
  }
}

export function issuePairingCode(
  access: AccessConfig,
  senderId: string,
  username: string,
  chatId: string,
  now = Date.now(),
): { action: 'pair'; code: string; isResend: boolean } | { action: 'drop' } {
  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.senderId === senderId) {
      if ((entry.replies ?? 1) >= MAX_PAIRING_REPLIES) {
        return { action: 'drop' }
      }
      entry.replies = (entry.replies ?? 1) + 1
      return { action: 'pair', code, isResend: true }
    }
  }

  if (Object.keys(access.pending).length >= MAX_PENDING_PAIRINGS) {
    return { action: 'drop' }
  }

  const code = randomBytes(3).toString('hex')
  access.pending[code] = {
    senderId,
    username,
    chatId,
    createdAt: now,
    expiresAt: now + PAIRING_TTL_MS,
    replies: 1,
  }
  return { action: 'pair', code, isResend: false }
}

/**
 * Writes an approval marker in <STATE_DIR>/approved/<senderId> containing
 * the DM channel ID so the running bridge sends a confirmation message.
 */
export function writeApprovalMarker(
  senderId: string,
  dmChannelId: string,
  stateDir = getStateDir(),
): void {
  const { approvedDir } = getStatePaths(stateDir)
  mkdirSync(approvedDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(approvedDir, senderId), dmChannelId + '\n', { mode: 0o600 })
}

/**
 * Prevents uploading the bridge's own state files (.env, access.json, sessions.json)
 * while still allowing files inside <STATE_DIR>/inbox/.
 */
export function assertSendable(filePath: string, stateDir = getStateDir()): void {
  let real: string
  try {
    real = realpathSync(filePath)
  } catch {
    return // statSync will report ENOENT properly
  }

  // Block <PROJECT_ROOT>/.env as well
  try {
    const projectEnv = realpathSync(join(PROJECT_ROOT, '.env'))
    if (real === projectEnv) {
      throw new Error(`refusing to send channel credentials: ${filePath}`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('refusing to send')) throw err
  }

  let stateReal: string
  try {
    stateReal = realpathSync(stateDir)
  } catch {
    return
  }
  const inboxReal = join(stateReal, 'inbox')
  if (
    (real === stateReal || real.startsWith(stateReal + sep)) &&
    !real.startsWith(inboxReal + sep)
  ) {
    throw new Error(`refusing to send channel state: ${filePath}`)
  }
}

/**
 * Sanitizes uploader-controlled attachment filenames so delimiters cannot
 * break out of structured prompt metadata or newline-joined tool output.
 */
export function safeAttachmentName(name: string | null | undefined, fallbackId: string): string {
  return (name ?? fallbackId).replace(/[\[\]\r\n;]/g, '_')
}

/**
 * Writes or updates DISCORD_BOT_TOKEN in <STATE_DIR>/.env with 0600 permissions.
 */
export function saveBotToken(token: string, stateDir = getStateDir()): string {
  const { envFile } = getStatePaths(stateDir)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  const lines: string[] = existsSync(envFile)
    ? readFileSync(envFile, 'utf8').split('\n').filter(l => l.length > 0)
    : []

  let replaced = false
  const updated = lines.map(line => {
    if (/^\s*DISCORD_BOT_TOKEN\s*=/.test(line)) {
      replaced = true
      return `DISCORD_BOT_TOKEN=${token}`
    }
    return line
  })
  if (!replaced) updated.push(`DISCORD_BOT_TOKEN=${token}`)

  const tmp = `${envFile}.tmp`
  writeFileSync(tmp, updated.join('\n') + '\n', { mode: 0o600 })
  renameSync(tmp, envFile)
  try {
    chmodSync(envFile, 0o600)
  } catch {}
  return envFile
}

export function clearBotToken(stateDir = getStateDir()): boolean {
  const { envFile } = getStatePaths(stateDir)
  if (!existsSync(envFile)) return false
  const kept = readFileSync(envFile, 'utf8')
    .split('\n')
    .filter(line => line.length > 0 && !/^\s*DISCORD_BOT_TOKEN\s*=/.test(line))
  if (kept.length === 0) {
    rmSync(envFile, { force: true })
  } else {
    writeFileSync(envFile, kept.join('\n') + '\n', { mode: 0o600 })
  }
  return true
}

export function readStoredToken(stateDir = getStateDir()): { token?: string; source?: string } {
  if (process.env.DISCORD_BOT_TOKEN?.trim()) {
    return { token: process.env.DISCORD_BOT_TOKEN.trim(), source: 'environment' }
  }
  for (const candidate of [join(PROJECT_ROOT, '.env'), getStatePaths(stateDir).envFile]) {
    if (!existsSync(candidate)) continue
    try {
      for (const line of readFileSync(candidate, 'utf8').split('\n')) {
        const m = line.match(/^\s*DISCORD_BOT_TOKEN\s*=\s*(.+?)\s*$/)
        if (m) {
          const val = m[1]!.replace(/^["']|["']$/g, '')
          if (val) return { token: val, source: candidate }
        }
      }
    } catch {}
  }
  return {}
}
