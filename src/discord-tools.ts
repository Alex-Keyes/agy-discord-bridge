import {
  ChannelType,
  type Attachment,
  type Client,
  type Emoji,
  type TextBasedChannel,
} from 'discord.js'
import { mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { chunkText } from './chunk.ts'
import {
  type AccessStore,
  MAX_ATTACHMENT_BYTES,
  MAX_CHUNK_LIMIT,
  assertSendable,
  getStatePaths,
  safeAttachmentName,
} from './config.ts'

const MAX_EMOJIS_LISTED = 200
const RECENT_SENT_CAP = 200

export interface DiscordToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const DISCORD_TOOL_DEFINITIONS: DiscordToolDefinition[] = [
  {
    name: 'reply',
    description:
      'Reply on Discord. Pass chat_id from the inbound <channel> block. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or other files.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        text: { type: 'string' },
        reply_to: {
          type: 'string',
          description:
            'Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch_messages.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Absolute file paths to attach (images, logs, etc). Max 10 files, 25MB each.',
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description:
      'Add an emoji reaction to a Discord message. Unicode emoji work directly; custom emoji need the <:name:id> form from list_emojis.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        emoji: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
  },
  {
    name: 'list_emojis',
    description:
      "List the custom emoji the bot can use in a chat, ready to paste into react or reply (<:name:id>, or <a:name:id> when animated). A server channel lists that server's emoji; a DM lists those of servers with an opted-in channel. The bot application's own emoji are always included. Unicode emoji aren't listed.",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        query: {
          type: 'string',
          description: 'Only emoji whose name contains this text (case-insensitive).',
        },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'edit_message',
    description:
      "Edit a message the bot previously sent. Useful for interim progress updates. Edits don't trigger push notifications — send a new reply when a long task completes so the user's device pings.",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['chat_id', 'message_id', 'text'],
    },
  },
  {
    name: 'download_attachment',
    description:
      'Download attachments from a specific Discord message to the local inbox. Use after seeing attachment_count on an inbound message or +Natt in fetch_messages. Returns local file paths ready to read.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
      },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'fetch_messages',
    description:
      "Fetch recent messages from a Discord channel. Returns oldest-first with message IDs. Discord's search API isn't exposed to bots, so this is the only way to look back.",
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        limit: {
          type: 'number',
          description: 'Max messages (default 20, Discord caps at 100).',
        },
      },
      required: ['channel'],
    },
  },
  {
    name: 'create_thread',
    description:
      "Start a public thread in a server text or announcement channel. Use when someone asks for a thread, or to move a long side topic out of the channel. Returns the thread ID — post in it with reply, passing that ID as chat_id. @mention someone in the thread (<@user_id>) to add them to it. The parent channel's access rules, including its mention requirement, apply inside the thread.",
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The parent channel.' },
        name: { type: 'string', description: 'Thread title, 1-100 characters.' },
        message_id: {
          type: 'string',
          description:
            'Message in the parent channel to start the thread from, usually the one you are answering. Prefer this; omit it only for a standalone thread.',
        },
      },
      required: ['chat_id', 'name'],
    },
  },
]

export class DiscordToolbox {
  readonly recentSentIds = new Set<string>()
  readonly dmChannelUsers = new Map<string, string>()

  private readonly client: Client
  private readonly accessStore: AccessStore
  private readonly onReplySent?: (chatId: string, parentChannelId?: string | null) => void

  constructor(
    client: Client,
    accessStore: AccessStore,
    onReplySent?: (chatId: string, parentChannelId?: string | null) => void,
  ) {
    this.client = client
    this.accessStore = accessStore
    this.onReplySent = onReplySent
  }

  noteSent(id: string): void {
    this.recentSentIds.add(id)
    if (this.recentSentIds.size > RECENT_SENT_CAP) {
      const oldest = this.recentSentIds.values().next().value
      if (oldest) this.recentSentIds.delete(oldest)
    }
  }

  noteDmChannel(chatId: string, userId: string): void {
    this.dmChannelUsers.set(chatId, userId)
  }

  async fetchTextChannel(id: string): Promise<TextBasedChannel> {
    const ch = await this.client.channels.fetch(id)
    if (!ch || !ch.isTextBased()) {
      throw new Error(`channel ${id} not found or not text-based`)
    }
    return ch
  }

  /**
   * Outbound gate: tools can only target chats the inbound gate would accept.
   */
  async fetchAllowedChannel(id: string): Promise<TextBasedChannel> {
    const ch = await this.fetchTextChannel(id)
    const access = this.accessStore.load()
    if (access.dmPolicy === 'disabled') {
      throw new Error('Discord access is currently disabled')
    }
    if (ch.type === ChannelType.DM) {
      const userId = ch.recipientId ?? this.dmChannelUsers.get(id)
      if (userId && access.allowFrom.includes(userId)) return ch
    } else {
      const key = ch.isThread() ? (ch.parentId ?? ch.id) : ch.id
      if (key in access.groups) return ch
    }
    throw new Error(`channel ${id} is not allowlisted — add via bun run access or /discord:access`)
  }

  async downloadAttachment(att: Attachment): Promise<string> {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `attachment too large: ${(att.size / 1024 / 1024).toFixed(1)}MB, max ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`,
      )
    }
    const res = await fetch(att.url)
    if (!res.ok) {
      throw new Error(`failed to fetch attachment (${res.status})`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const name = att.name ?? att.id
    const rawExt = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : 'bin'
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, '') || 'bin'
    const { inboxDir } = getStatePaths(this.accessStore.stateDir)
    mkdirSync(inboxDir, { recursive: true })
    const outPath = join(inboxDir, `${Date.now()}-${att.id}.${ext}`)
    writeFileSync(outPath, buf)
    return outPath
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    try {
      switch (name) {
        case 'reply':
          return await this.toolReply(args)
        case 'fetch_messages':
          return await this.toolFetchMessages(args)
        case 'react':
          return await this.toolReact(args)
        case 'list_emojis':
          return await this.toolListEmojis(args)
        case 'edit_message':
          return await this.toolEditMessage(args)
        case 'download_attachment':
          return await this.toolDownloadAttachment(args)
        case 'create_thread':
          return await this.toolCreateThread(args)
        default:
          return {
            content: [{ type: 'text', text: `unknown tool: ${name}` }],
            isError: true,
          }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        content: [{ type: 'text', text: `${name} failed: ${msg}` }],
        isError: true,
      }
    }
  }

  private async toolReply(args: Record<string, unknown>) {
    const chat_id = String(args.chat_id ?? '')
    const text = String(args.text ?? '')
    const reply_to = args.reply_to ? String(args.reply_to) : undefined
    const files = Array.isArray(args.files) ? args.files.map(String) : []

    const ch = await this.fetchAllowedChannel(chat_id)
    if (!('send' in ch) || typeof ch.send !== 'function') {
      throw new Error('channel is not sendable')
    }

    if (files.length > 10) {
      throw new Error('Discord allows max 10 attachments per message')
    }
    for (const f of files) {
      assertSendable(f, this.accessStore.stateDir)
      const st = statSync(f)
      if (st.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 25MB)`,
        )
      }
    }

    const access = this.accessStore.load()
    const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
    const mode = access.chunkMode ?? 'newline'
    const replyMode = access.replyToMode ?? 'first'
    const chunks = chunkText(text, limit, mode)
    const sentIds: string[] = []

    try {
      for (let i = 0; i < chunks.length; i++) {
        const shouldReplyTo =
          reply_to != null &&
          replyMode !== 'off' &&
          (replyMode === 'all' || i === 0)
        const sent = await ch.send({
          content: chunks[i]!,
          ...(i === 0 && files.length > 0 ? { files } : {}),
          ...(shouldReplyTo
            ? { reply: { messageReference: reply_to, failIfNotExists: false } }
            : {}),
        })
        this.noteSent(sent.id)
        sentIds.push(sent.id)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
    }

    const parentId = ch.isThread() ? ch.parentId : null
    this.onReplySent?.(ch.id, parentId)

    const summary =
      sentIds.length === 1
        ? `sent (id: ${sentIds[0]})`
        : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
    return { content: [{ type: 'text' as const, text: summary }] }
  }

  private async toolFetchMessages(args: Record<string, unknown>) {
    const ch = await this.fetchAllowedChannel(String(args.channel ?? ''))
    const rawLimit = typeof args.limit === 'number' ? args.limit : 20
    const limit = Math.max(1, Math.min(rawLimit, 100))
    const msgs = await ch.messages.fetch({ limit })
    const me = this.client.user?.id
    const arr = [...msgs.values()].reverse()
    const out =
      arr.length === 0
        ? '(no messages)'
        : arr
            .map(m => {
              const who = m.author.id === me ? 'me' : m.author.username
              const atts = m.attachments.size > 0 ? ` +${m.attachments.size}att` : ''
              const text = m.content.replace(/[\r\n]+/g, ' ⏎ ')
              return `[${m.createdAt.toISOString()}] ${who}: ${text}  (id: ${m.id}${atts})`
            })
            .join('\n')
    return { content: [{ type: 'text' as const, text: out }] }
  }

  private async toolReact(args: Record<string, unknown>) {
    const ch = await this.fetchAllowedChannel(String(args.chat_id ?? ''))
    const msg = await ch.messages.fetch(String(args.message_id ?? ''))
    await msg.react(String(args.emoji ?? ''))
    return { content: [{ type: 'text' as const, text: 'reacted' }] }
  }

  private async toolListEmojis(args: Record<string, unknown>) {
    const ch = await this.fetchAllowedChannel(String(args.chat_id ?? ''))
    const channels =
      ch.type === ChannelType.DM
        ? await Promise.all(
            Object.keys(this.accessStore.load().groups).map(id =>
              this.client.channels.fetch(id).catch(() => null),
            ),
          )
        : [ch]
    const guilds = new Set(channels.flatMap(c => (c && 'guild' in c && c.guild ? [c.guild] : [])))

    const emojis: Emoji[] = []
    const failed: string[] = []
    for (const guild of guilds) {
      try {
        const myRoles = guild.members.me?.roles.cache
        for (const e of (await guild.emojis.fetch()).values()) {
          if (e.available === false) continue
          if (e.roles.cache.size > 0 && !e.roles.cache.some(r => myRoles?.has(r.id) ?? false)) {
            continue
          }
          emojis.push(e)
        }
      } catch (err) {
        failed.push(`server ${guild.id} (${(err as Error).message})`)
      }
    }
    try {
      if (!this.client.application) throw new Error('bot not connected yet')
      emojis.push(...(await this.client.application.emojis.fetch()).values())
    } catch (err) {
      failed.push(`the application (${(err as Error).message})`)
    }
    if (failed.length === guilds.size + 1) {
      throw new Error(`could not fetch emoji of ${failed.join(', ')}`)
    }

    const query = String(args.query ?? '').replaceAll(':', '').toLowerCase()
    const matches = emojis.filter(e => e.name?.toLowerCase().includes(query))
    const lines = matches
      .slice(0, MAX_EMOJIS_LISTED)
      .map(e => `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`)
    if (matches.length === 0) {
      lines.push(query ? `(no custom emoji match "${query}")` : '(no custom emoji found)')
    }
    if (matches.length > MAX_EMOJIS_LISTED) {
      lines.push(`(showing ${MAX_EMOJIS_LISTED} of ${matches.length} — pass query to narrow)`)
    }
    if (failed.length > 0) {
      lines.push(`(partial list — could not fetch emoji of ${failed.join(', ')})`)
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] }
  }

  private async toolEditMessage(args: Record<string, unknown>) {
    const ch = await this.fetchAllowedChannel(String(args.chat_id ?? ''))
    const msg = await ch.messages.fetch(String(args.message_id ?? ''))
    const edited = await msg.edit(String(args.text ?? ''))
    return { content: [{ type: 'text' as const, text: `edited (id: ${edited.id})` }] }
  }

  private async toolDownloadAttachment(args: Record<string, unknown>) {
    const ch = await this.fetchAllowedChannel(String(args.chat_id ?? ''))
    const msg = await ch.messages.fetch(String(args.message_id ?? ''))
    if (msg.attachments.size === 0) {
      return { content: [{ type: 'text' as const, text: 'message has no attachments' }] }
    }
    const lines: string[] = []
    for (const att of msg.attachments.values()) {
      const filePath = await this.downloadAttachment(att)
      const kb = (att.size / 1024).toFixed(0)
      lines.push(
        `  ${filePath}  (${safeAttachmentName(att.name, att.id)}, ${att.contentType ?? 'unknown'}, ${kb}KB)`,
      )
    }
    return {
      content: [
        { type: 'text' as const, text: `downloaded ${lines.length} attachment(s):\n${lines.join('\n')}` },
      ],
    }
  }

  private async toolCreateThread(args: Record<string, unknown>) {
    const ch = await this.fetchAllowedChannel(String(args.chat_id ?? ''))
    if (ch.isThread()) {
      throw new Error(
        `chat_id is already a thread — reply in it, or pass its parent channel ${ch.parentId} to start a new one`,
      )
    }
    if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
      throw new Error('threads need a server text or announcement channel, not a DM or voice chat')
    }
    const message_id = args.message_id ? String(args.message_id) : undefined
    let text: string
    try {
      const thread = await ch.threads.create({
        name: String(args.name ?? 'Thread').slice(0, 100),
        startMessage: message_id,
      })
      text = `thread created (id: ${thread.id})`
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code === 50001 || code === 50013) {
        throw new Error(
          `${(err as Error).message} — check that the bot has Create Public Threads, View Channel and Read Message History in this channel`,
        )
      }
      if (code === 10008) {
        throw new Error(
          `no message ${message_id} in channel ${ch.id} — it may be deleted or in another channel`,
        )
      }
      if (code !== 160004) throw err
      text = `message already has a thread, which keeps its current name (id: ${message_id})`
    }
    text += ' — use it as chat_id to reply there.'
    const parentGroup = this.accessStore.load().groups[ch.id]
    if (parentGroup?.responseMode === 'dynamic') {
      text +=
        ' As in the parent channel, dynamic response mode is active there (you observe all messages and choose whether to reply or output NO_REPLY).'
    } else if (parentGroup?.requireMention ?? true) {
      text +=
        ' As in the parent channel, people must @mention you or reply to one of your messages to reach you there.'
    }
    return { content: [{ type: 'text' as const, text }] }
  }
}
