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

let sessions: AgySessionManager

const toolbox = new DiscordToolbox(client, accessStore, (targetChatId, parentChannelId) => {
  sessions?.markReplied(targetChatId, parentChannelId)
})

const mcpBridge = startDiscordMcpServer(toolbox)

sessions = new AgySessionManager(runtime, {
  stateDir,
  extraAddDirs: [mcpBridge.runtimeDir],
})

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

async function isMentioned(msg: Message, extraPatterns?: string[]): Promise<boolean> {
  if (client.user && msg.mentions.has(client.user)) return true

  // Reply to one of our messages counts as an implicit mention.
  const refId = msg.reference?.messageId
  if (refId) {
    if (toolbox.recentSentIds.has(refId)) return true
    try {
      const ref = await msg.fetchReference()
      if (ref.author.id === client.user?.id) return true
    } catch {}
  }

  const text = msg.content
  for (const pat of extraPatterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {}
  }
  return false
}

async function gate(msg: Message): Promise<GateResult> {
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
    ? await isMentioned(msg, access.mentionPatterns)
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
  options?: { responseMode?: GroupResponseMode; mentioned?: boolean },
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
    const atts: string[] = []
    for (const att of msg.attachments.values()) {
      const kb = (att.size / 1024).toFixed(0)
      atts.push(`${safeAttachmentName(att.name, att.id)} (${att.contentType ?? 'unknown'}, ${kb}KB)`)
      if (runtime.autoDownloadAttachments) {
        try {
          const localPath = await toolbox.downloadAttachment(att)
          downloadedNote.push(`- ${localPath} (${safeAttachmentName(att.name, att.id)})`)
        } catch (err) {
          console.error(`[bridge] Auto-download failed for attachment ${att.id}:`, err)
        }
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
    try {
      const ref = await msg.fetchReference()
      const refPreview = ref.content.replace(/[\r\n]+/g, ' ⏎ ').slice(0, 600)
      bodyLines.push(`[Replying to @${ref.author.username} (${ref.id}): ${refPreview}]`)
    } catch {}
  }

  if (downloadedNote.length > 0) {
    bodyLines.push('[Auto-downloaded attachments:]', ...downloadedNote)
  }

  bodyLines.push(cleanedText || (msg.attachments.size > 0 ? '(attachment)' : ''))

  return `<channel ${attrStr}>\n${bodyLines.join('\n')}\n</channel>`
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
        '- `!agy status` — Show conversation ID, working directory, and permission mode',
        '- `!agy reset` (or `!agy new`) — Start a fresh conversation for this channel/thread',
        '- `!agy stop` — Cancel an in-flight turn',
        '- `!agy cwd <path>` — Switch working directory and start a fresh conversation',
        `- \`!agy mode <${VALID_MODES.join('|')}\>\` — Change permission mode for this channel`,
      ].join('\n'),
    )
    toolbox.noteSent(sent.id)
    return true
  }

  if (sub === 'status') {
    const st = sessions.get(chatId).getStatus()
    const sent = await msg.reply(
      [
        `**Status** (${st.running ? (st.busy ? 'working' : 'idle') : 'stopped'})`,
        `- **CWD**: \`${st.cwd}\``,
        `- **Permission mode**: \`${st.permissionMode}\``,
        `- **Conversation**: \`${st.conversationId ?? 'new'}\``,
        `- **Queued turns**: ${st.queued}`,
        st.uptimeSeconds !== undefined ? `- **Process uptime**: ${st.uptimeSeconds}s` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    toolbox.noteSent(sent.id)
    return true
  }

  if (sub === 'reset' || sub === 'new') {
    sessions.reset(chatId)
    const sent = await msg.reply('Started a fresh Antigravity conversation for this channel.')
    toolbox.noteSent(sent.id)
    return true
  }

  if (sub === 'stop' || sub === 'cancel') {
    sessions.get(chatId).stop()
    const sent = await msg.reply('Stopped the active Antigravity turn.')
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
  console.log(
    `[bridge] State: ${stateDir} | CWD: ${runtime.defaultCwd} | Mode: ${runtime.permissionMode} | Static: ${runtime.staticMode} | Channels: ${groupCount}`,
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
  const result = await gate(msg)

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

  // Typing indicator loop while agy works (suppressed for unmentioned ambient messages in dynamic mode)
  let typingTimer: ReturnType<typeof setInterval> | null = null
  if (isSendable(msg.channel) && !isDynamicAmbient) {
    void msg.channel.sendTyping().catch(() => {})
    typingTimer = setInterval(() => {
      if (isSendable(msg.channel)) {
        void msg.channel.sendTyping().catch(() => {})
      }
    }, 8000)
  }

  try {
    const prompt = await buildInboundPrompt(msg, cleanedText, {
      responseMode: result.responseMode,
      mentioned: result.mentioned,
    })
    const session = sessions.get(msg.channelId)
    const turnResult = await session.send(prompt)

    // Only auto-post final text if the agent did not already send via `reply` and did not opt to stay silent.
    if (
      !shouldSuppressFallbackReply(turnResult, {
        isDynamic: result.responseMode === 'dynamic',
      })
    ) {
      const text = turnResult.response.trim() || '(completed with no text output)'
      await sendFallbackReply(msg, text, access)
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
