#!/usr/bin/env bun
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageType,
  Partials,
  type Message,
  type TextBasedChannel,
} from 'discord.js'
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { AgySessionManager } from './agy-session.ts'
import { chunkText } from './chunk.ts'
import {
  type AccessConfig,
  AccessStore,
  type GroupResponseMode,
  MAX_CHUNK_LIMIT,
  type PermissionMode,
  getStateDir,
  getStatePaths,
  issuePairingCode,
  loadRuntimeConfig,
  pruneExpiredPending,
  safeAttachmentName,
} from './config.ts'
import { DiscordToolbox } from './discord-tools.ts'
import { startDiscordMcpServer } from './mcp-server.ts'
import {
  evaluateGroupPolicy,
  needsMentionCheck,
  shouldSuppressFallbackReply,
} from './response-policy.ts'
import { SubagentManager, formatCompletedUpdatesBlock } from './subagent-manager.ts'

const stateDir = getStateDir()
const runtime = loadRuntimeConfig(stateDir)
const accessStore = new AccessStore(stateDir, runtime.staticMode)

const client = new Client({
  intents: [
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // DMs arrive as partial channels — messageCreate never fires without this.
  partials: [Partials.Channel],
})

const channelLabels = new Map<string, string>()

let sessions: AgySessionManager
let subagents: SubagentManager

const toolbox = new DiscordToolbox(
  client,
  accessStore,
  (targetChatId, parentChannelId, caller) => {
    if (caller.kind === 'subagent') {
      subagents?.markReplied(caller.subagentId)
    } else {
      sessions?.markReplied(targetChatId, parentChannelId)
    }
  },
)

const mcpBridge = startDiscordMcpServer(toolbox, {
  enableSubagents: runtime.subagentsEnabled,
})

sessions = new AgySessionManager(runtime, {
  stateDir,
  extraAddDirs: [mcpBridge.runtimeDir],
})

async function sendTextToChannel(
  chatId: string,
  text: string,
  access: AccessConfig,
  replyTo?: string,
): Promise<void> {
  const ch = await toolbox.fetchAllowedChannel(chatId)
  if (!isSendable(ch)) return
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const mode = access.chunkMode ?? 'newline'
  const replyMode = access.replyToMode ?? 'first'
  const chunks = chunkText(text, limit, mode)

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const shouldReplyTo =
      replyTo != null && replyMode !== 'off' && (replyMode === 'all' || i === 0)
    const sent = await ch.send({
      content: chunk,
      ...(shouldReplyTo
        ? {
            reply: { messageReference: replyTo, failIfNotExists: false },
            allowedMentions: { repliedUser: false },
          }
        : {}),
    })
    if (sent?.id) toolbox.noteSent(sent.id)
  }
}

function startChannelTyping(chatId: string): () => void {
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null

  const pulse = () => {
    if (stopped) return
    const cached = client.channels.cache.get(chatId)
    if (cached && cached.isTextBased() && isSendable(cached)) {
      void cached.sendTyping().catch(() => {})
    }
  }

  pulse()
  timer = setInterval(pulse, 8000)

  return () => {
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

subagents = new SubagentManager({
  runtime,
  createWorkerRuntimeDir: id => mcpBridge.createWorkerRuntimeDir(id),
  getChatDefaults: chatId => {
    const st = sessions.get(chatId).getStatus()
    return {
      cwd: st.cwd,
      permissionMode: st.permissionMode,
      channelLabel: channelLabels.get(chatId),
    }
  },
  deliverText: async (chatId, text, replyTo) => {
    await sendTextToChannel(chatId, text, accessStore.load(), replyTo)
  },
  deliverError: async (chatId, text, replyTo) => {
    await sendTextToChannel(chatId, text, accessStore.load(), replyTo)
  },
  startTyping: chatId => startChannelTyping(chatId),
})

toolbox.setSubagentHandler(runtime.subagentsEnabled ? subagents : null)

const VALID_MODES: PermissionMode[] = [
  'always-proceed',
  'accept-edits',
  'plan',
  'default',
  'dangerously-skip-permissions',
]

function isSendable(
  ch: TextBasedChannel,
): ch is TextBasedChannel & { send: Function; sendTyping: Function } {
  return 'send' in ch && typeof ch.send === 'function'
}

type GateResult =
  | {
      action: 'deliver'
      access: AccessConfig
      responseMode: GroupResponseMode
      mentioned: boolean
      isDynamicAmbient: boolean
    }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

function createRefFetcher(msg: Message): () => Promise<Message | null> {
  let fetched = false
  let cached: Message | null = null
  return async () => {
    if (!msg.reference?.messageId) return null
    if (!fetched) {
      fetched = true
      try {
        cached = await msg.fetchReference()
      } catch {
        cached = null
      }
    }
    return cached
  }
}

async function isMentioned(
  msg: Message,
  getRef: () => Promise<Message | null>,
  extraPatterns?: string[],
): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true

  // Reply to one of our messages counts as an implicit mention.
  const refId = msg.reference?.messageId
  if (refId) {
    if (toolbox.recentSentIds.has(refId)) return true
    const ref = await getRef()
    if (ref?.author.id === client.user?.id) return true
  }

  const text = msg.content
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

async function gate(msg: Message, getRef: () => Promise<Message | null>): Promise<GateResult> {
  const access = accessStore.load()
  const pruned = pruneExpiredPending(access)
  if (pruned) accessStore.save(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const senderId = msg.author.id
  const isDM = msg.channel.type === ChannelType.DM

  if (isDM) {
    if (access.allowFrom.includes(senderId)) {
      return {
        action: 'deliver',
        access,
        responseMode: 'always',
        mentioned: true,
        isDynamicAmbient: false,
      }
    }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }

    const res = issuePairingCode(access, senderId, msg.author.username, msg.channelId)
    if (res.action === 'pair') {
      accessStore.save(access)
    }
    return res
  }

  // Threads inherit their parent channel's opt-in policy while keeping their own agy conversation.
  const policyChannelId = msg.channel.isThread()
    ? (msg.channel.parentId ?? msg.channelId)
    : msg.channelId
  const policy = access.groups[policyChannelId]
  if (!policy) return { action: 'drop' }

  const mentioned = needsMentionCheck(policy)
    ? await isMentioned(msg, getRef, access.mentionPatterns)
    : false
  const decision = evaluateGroupPolicy(policy, senderId, mentioned)
  if (decision.action === 'drop') return { action: 'drop' }

  return {
    action: 'deliver',
    access,
    responseMode: decision.responseMode,
    mentioned: decision.mentioned,
    isDynamicAmbient: decision.isDynamicAmbient,
  }
}

/**
 * Polls <STATE_DIR>/approved/<senderId> written by `bun run access pair` or
 * `/discord:access pair` and sends a confirmation DM to the newly paired user.
 */
function checkApprovals(): void {
  const { approvedDir } = getStatePaths(stateDir)
  let files: string[]
  try {
    files = readdirSync(approvedDir)
  } catch {
    return
  }
  if (files.length === 0) return

  for (const senderId of files) {
    const file = join(approvedDir, senderId)
    let dmChannelId: string
    try {
      dmChannelId = readFileSync(file, 'utf8').trim()
    } catch {
      rmSync(file, { force: true })
      continue
    }
    if (!dmChannelId) {
      rmSync(file, { force: true })
      continue
    }

    void (async () => {
      try {
        const ch = await toolbox.fetchTextChannel(dmChannelId)
        if (isSendable(ch)) {
          const sent = await ch.send('Paired! Say hi to Antigravity.')
          if (sent?.id) toolbox.noteSent(sent.id)
        }
      } catch (err) {
        process.stderr.write(`[bridge] failed to send approval confirm: ${err}\n`)
      } finally {
        rmSync(file, { force: true })
      }
    })()
  }
}

if (!runtime.staticMode) {
  setInterval(checkApprovals, 5000).unref()
}

function escapeXmlAttr(val: string): string {
  return val.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function buildInboundPrompt(
  msg: Message,
  cleanedText: string,
  getRef: () => Promise<Message | null>,
  options?: {
    responseMode?: GroupResponseMode
    mentioned?: boolean
    subagentUpdatesBlock?: string
  },
): Promise<string> {
  const attrs: Array<[string, string]> = [
    ['source', 'discord'],
    ['chat_id', msg.channelId],
    ['message_id', msg.id],
    ['user', msg.author.username],
    ['user_id', msg.author.id],
    ['ts', msg.createdAt.toISOString()],
  ]

  if (msg.channel.type !== ChannelType.DM && 'name' in msg.channel && msg.channel.name) {
    attrs.push(['channel_name', `#${msg.channel.name}`])
  }

  if (options?.responseMode === 'dynamic') {
    attrs.push(['mode', 'dynamic'])
    attrs.push(['mentioned', options.mentioned ? 'true' : 'false'])
  }

  const downloadedNote: string[] = []
  if (msg.attachments.size > 0) {
    const attachments = [...msg.attachments.values()]
    const atts = attachments.map(att => {
      const kb = (att.size / 1024).toFixed(0)
      return `${safeAttachmentName(att.name, att.id)} (${att.contentType ?? 'unknown'}, ${kb}KB)`
    })
    if (runtime.autoDownloadAttachments) {
      const results = await Promise.all(
        attachments.map(async att => {
          try {
            const localPath = await toolbox.downloadAttachment(att)
            return `- ${localPath} (${safeAttachmentName(att.name, att.id)})`
          } catch (err) {
            console.error(`[bridge] Auto-download failed for attachment ${att.id}:`, err)
            return null
          }
        }),
      )
      for (const note of results) {
        if (note) downloadedNote.push(note)
      }
    }
    attrs.push(['attachment_count', String(atts.length)])
    attrs.push(['attachments', atts.join('; ')])
  }

  if (msg.reference?.messageId) {
    attrs.push(['reply_to_message_id', msg.reference.messageId])
  }

  const attrStr = attrs.map(([k, v]) => `${k}="${escapeXmlAttr(v)}"`).join(' ')
  const bodyLines: string[] = []

  if (msg.reference?.messageId) {
    const ref = await getRef()
    if (ref) {
      const refPreview = ref.content.replace(/[\r\n]+/g, ' ⏎ ').slice(0, 600)
      bodyLines.push(`[Replying to @${ref.author.username} (${ref.id}): ${refPreview}]`)
    }
  }

  if (downloadedNote.length > 0) {
    bodyLines.push('[Auto-downloaded attachments:]', ...downloadedNote)
  }

  bodyLines.push(cleanedText || (msg.attachments.size > 0 ? '(attachment)' : ''))

  const channelBlock = `<channel ${attrStr}>\n${bodyLines.join('\n')}\n</channel>`
  return options?.subagentUpdatesBlock
    ? `${options.subagentUpdatesBlock}\n\n${channelBlock}`
    : channelBlock
}

async function sendFallbackReply(msg: Message, text: string, access: AccessConfig): Promise<void> {
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const mode = access.chunkMode ?? 'newline'
  const replyMode = access.replyToMode ?? 'first'
  const chunks = chunkText(text, limit, mode)

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!
    const shouldReplyTo = replyMode !== 'off' && (replyMode === 'all' || i === 0)
    if (shouldReplyTo) {
      const sent = await msg.reply({ content: chunk, allowedMentions: { repliedUser: false } })
      toolbox.noteSent(sent.id)
    } else if (isSendable(msg.channel)) {
      const sent = await msg.channel.send(chunk)
      if (sent?.id) toolbox.noteSent(sent.id)
    }
  }
}

async function handleCommand(msg: Message, text: string): Promise<boolean> {
  if (!text.startsWith('!agy')) return false
  const parts = text.slice(4).trim().split(/\s+/).filter(Boolean)
  const sub = (parts[0] ?? 'help').toLowerCase()
  const chatId = msg.channelId

  if (sub === 'help') {
    const sent = await msg.reply(
      [
        '**Antigravity Discord Bridge Commands**',
        '- `!agy status` — Show conversation ID, CWD, permission mode, and active subagents',
        '- `!agy workers [all]` (or `!agy subagents`) — List active, queued, and recent subagents',
        '- `!agy reset` (or `!agy new`) — Start a fresh conversation and cancel channel subagents',
        '- `!agy stop [id|all]` — Cancel active turn, a specific subagent ID, or everything (`all`)',
        '- `!agy cwd <path>` — Switch working directory and start a fresh conversation',
        `- \`!agy mode <${VALID_MODES.join('|')}\>\` — Change permission mode for this channel`,
      ].join('\n'),
    )
    toolbox.noteSent(sent.id)
    return true
  }

  if (sub === 'status') {
    const st = sessions.get(chatId).getStatus()
    const saAll = subagents.getSummary()
    const saChat = subagents.getSummary(chatId)
    const activeLines = saChat.running.map(r => {
      const elapsed = r.startedAt ? Math.max(0, Math.round((Date.now() - r.startedAt) / 1000)) : 0
      return `  - \`${r.id}\` (${r.role}, ${elapsed}s)`
    })
    const sent = await msg.reply(
      [
        `**Status** (${st.running ? (st.busy ? 'working' : 'idle') : 'stopped'})`,
        `- **CWD**: \`${st.cwd}\``,
        `- **Permission mode**: \`${st.permissionMode}\``,
        `- **Conversation**: \`${st.conversationId ?? 'new'}\``,
        `- **Queued turns**: ${st.queued}`,
        `- **Subagents**: ${runtime.subagentsEnabled ? `${saAll.running.length}/${saAll.maxConcurrent} running (${saChat.running.length} in this chat, ${saAll.queued.length} queued)` : 'disabled'}`,
        ...activeLines,
        st.uptimeSeconds !== undefined ? `- **Process uptime**: ${st.uptimeSeconds}s` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    toolbox.noteSent(sent.id)
    return true
  }

  if (sub === 'workers' || sub === 'subagents') {
    const scope = parts[1]?.toLowerCase() === 'all' ? undefined : chatId
    const summary = subagents.list(scope)
    const sent = await msg.reply(`\`\`\`\n${summary.slice(0, 1900)}\n\`\`\``)
    toolbox.noteSent(sent.id)
    return true
  }

  if (sub === 'reset' || sub === 'new') {
    sessions.reset(chatId)
    const cancelled = subagents.cancelForChat(chatId)
    const suffix = cancelled > 0 ? ` Cancelled ${cancelled} background subagent(s).` : ''
    const sent = await msg.reply(
      `Started a fresh Antigravity conversation for this channel.${suffix}`,
    )
    toolbox.noteSent(sent.id)
    return true
  }

  if (sub === 'stop' || sub === 'cancel') {
    const target = parts[1]?.trim()
    if (target && target.toLowerCase() !== 'all') {
      const res = subagents.cancel(target)
      const sent = await msg.reply(res.message)
      toolbox.noteSent(sent.id)
      return true
    }
    sessions.get(chatId).stop()
    if (target?.toLowerCase() === 'all') {
      const cancelled = subagents.cancelForChat(chatId)
      const sent = await msg.reply(
        `Stopped the active Antigravity turn and cancelled ${cancelled} subagent(s).`,
      )
      toolbox.noteSent(sent.id)
      return true
    }
    const stillRunning = subagents.getSummary(chatId).running.length
    const hint =
      stillRunning > 0
        ? ` (${stillRunning} background subagent(s) still running — use \`!agy stop all\` or \`!agy stop <id>\` to cancel them.)`
        : ''
    const sent = await msg.reply(`Stopped the active Antigravity turn.${hint}`)
    toolbox.noteSent(sent.id)
    return true
  }

  if (sub === 'cwd') {
    const rawTarget = parts.slice(1).join(' ')
    if (!rawTarget) {
      const sent = await msg.reply(`Current CWD: \`${sessions.get(chatId).cwd}\``)
      toolbox.noteSent(sent.id)
      return true
    }
    const expanded = rawTarget.startsWith('~/')
      ? join(homedir(), rawTarget.slice(2))
      : rawTarget
    const target = resolve(expanded)
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      const sent = await msg.reply(`Directory does not exist: \`${target}\``)
      toolbox.noteSent(sent.id)
      return true
    }
    sessions.reset(chatId, target)
    const sent = await msg.reply(`Switched CWD to \`${target}\` and started a fresh conversation.`)
    toolbox.noteSent(sent.id)
    return true
  }

  if (sub === 'mode') {
    const mode = parts[1] as PermissionMode | undefined
    if (!mode || !VALID_MODES.includes(mode)) {
      const sent = await msg.reply(
        `Usage: \`!agy mode <${VALID_MODES.join('|')}>\`. Current: \`${sessions.get(chatId).permissionMode}\``,
      )
      toolbox.noteSent(sent.id)
      return true
    }
    const currentCwd = sessions.get(chatId).cwd
    sessions.reset(chatId, currentCwd, mode)
    const sent = await msg.reply(`Switched permission mode to \`${mode}\` (fresh session).`)
    toolbox.noteSent(sent.id)
    return true
  }

  const sent = await msg.reply(`Unknown command \`!agy ${sub}\`. Run \`!agy help\`.`)
  toolbox.noteSent(sent.id)
  return true
}

client.once('clientReady', readyClient => {
  const access = accessStore.load()
  const groupCount = Object.keys(access.groups).length
  console.log(`[bridge] Logged in as ${readyClient.user.tag} (${readyClient.user.id})`)
  const streamMode = runtime.streamLog
    ? runtime.showThinking
      ? 'live+thinking'
      : 'live'
    : 'off'
  const subagentMode = runtime.subagentsEnabled
    ? `on (max ${runtime.maxSubagents}, coord=${runtime.coordinatorEffort ?? 'default'}, worker=${runtime.subagentEffort ?? 'default'})`
    : 'off'
  console.log(
    `[bridge] State: ${stateDir} | CWD: ${runtime.defaultCwd} | Mode: ${runtime.permissionMode} | Subagents: ${subagentMode} | Stream: ${streamMode} | Static: ${runtime.staticMode} | Channels: ${groupCount}`,
  )
  console.log(`[bridge] Discord MCP server listening on ${mcpBridge.url}`)
})

client.on('error', err => {
  process.stderr.write(`[bridge] Discord client error: ${err}\n`)
})

client.on('messageCreate', msg => {
  if (msg.author.bot) return
  if (msg.type === MessageType.ThreadStarterMessage) return
  handleInbound(msg).catch(err => {
    process.stderr.write(`[bridge] handleInbound failed: ${err}\n`)
  })
})

async function handleInbound(msg: Message): Promise<void> {
  const getRef = createRefFetcher(msg)
  const result = await gate(msg, getRef)

  if (result.action === 'drop') return

  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    try {
      const sent = await msg.reply(
        `${lead} — approve on the host:\n\n` +
          `\`\`\`\nbun run access pair ${result.code}\n\`\`\`\n` +
          `Or in an interactive \`agy\` session (if the plugin is installed):\n` +
          `\`/discord:access pair ${result.code}\``,
      )
      toolbox.noteSent(sent.id)
    } catch (err) {
      process.stderr.write(`[bridge] failed to send pairing code: ${err}\n`)
    }
    return
  }

  const access = result.access
  const botId = client.user?.id

  if (msg.channel.type === ChannelType.DM) {
    toolbox.noteDmChannel(msg.channelId, msg.author.id)
  }

  const cleanedText = botId
    ? msg.content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim()
    : msg.content.trim()

  if (await handleCommand(msg, cleanedText)) return
  if (!cleanedText && msg.attachments.size === 0) return

  const isDynamicAmbient = result.isDynamicAmbient

  // Ack reaction (fire-and-forget; suppressed for unmentioned ambient messages in dynamic mode)
  if (access.ackReaction && !isDynamicAmbient) {
    void msg.react(access.ackReaction).catch(() => {})
  }

  // Typing indicator loop while agy works (runs in dynamic mode too so users can see the message was received)
  let typingTimer: ReturnType<typeof setInterval> | null = null
  if (isSendable(msg.channel)) {
    void msg.channel.sendTyping().catch(() => {})
    typingTimer = setInterval(() => {
      if (isSendable(msg.channel)) {
        void msg.channel.sendTyping().catch(() => {})
      }
    }, 8000)
  }

  try {
    const channelLabel =
      msg.channel.type === ChannelType.DM
        ? 'DM'
        : 'name' in msg.channel && msg.channel.name
          ? `#${msg.channel.name}`
          : msg.channelId
    channelLabels.set(msg.channelId, channelLabel)

    const completedUpdates = subagents.drainCompletedUpdates(msg.channelId)
    const subagentUpdatesBlock = formatCompletedUpdatesBlock(completedUpdates)

    const prompt = await buildInboundPrompt(msg, cleanedText, getRef, {
      responseMode: result.responseMode,
      mentioned: result.mentioned,
      subagentUpdatesBlock: subagentUpdatesBlock || undefined,
    })
    const modeLabel =
      result.responseMode === 'dynamic'
        ? result.mentioned
          ? 'dynamic, mentioned'
          : 'dynamic'
        : undefined
    const session = sessions.get(msg.channelId)
    const turnResult = await session.send(prompt, {
      channelLabel,
      author: msg.author.username,
      preview: cleanedText || (msg.attachments.size > 0 ? '(attachment)' : ''),
      modeLabel,
    })

    // Only auto-post final text if the agent did not already send via `reply` and did not opt to stay silent.
    if (
      !shouldSuppressFallbackReply(turnResult, {
        isDynamic: result.responseMode === 'dynamic',
      })
    ) {
      const text = turnResult.response.trim() || '(completed with no text output)'
      await sendFallbackReply(msg, text, access)
      session.logDeliveryOutcome('posted to Discord')
    } else if (turnResult.repliedViaTool) {
      session.logDeliveryOutcome('replied via Discord tool')
    } else {
      session.logDeliveryOutcome('silent (NO_REPLY)', true)
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[bridge] Error handling message ${msg.id}:`, errMsg)
    if (!isDynamicAmbient) {
      await msg.react('❌').catch(() => {})
      await sendFallbackReply(
        msg,
        `Error from Antigravity:\n\`\`\`\n${errMsg.slice(0, 1500)}\n\`\`\``,
        access,
      ).catch(() => {})
    }
  } finally {
    if (typingTimer) clearInterval(typingTimer)
  }
}

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[bridge] Received ${signal}, shutting down...`)
  subagents.disposeAll()
  sessions.disposeAll()
  mcpBridge.close()
  setTimeout(() => process.exit(0), 2000)
  void Promise.resolve(client.destroy()).finally(() => process.exit(0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', err => {
  process.stderr.write(`[bridge] Unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`[bridge] Uncaught exception: ${err}\n`)
})

await client.login(runtime.token)
