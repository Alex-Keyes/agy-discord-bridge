#!/usr/bin/env bun
import {
  MAX_CHUNK_LIMIT,
  getStateDir,
  getStatePaths,
  pruneExpiredPending,
  readAccessFile,
  saveAccessFile,
  writeApprovalMarker,
} from './config.ts'

const args = process.argv.slice(2)
const cmd = args[0] ?? 'status'
const stateDir = getStateDir()
const { accessFile } = getStatePaths(stateDir)

function usage(): void {
  console.log(`Usage: bun run access <command>

Commands:
  status                                       Show current policy, allowlist, pending codes, channels, delivery config
  pair <code>                                  Approve a pending pairing code (sends confirmation DM)
  deny <code>                                  Discard a pending pairing code silently
  allow <userId>                               Add a Discord user snowflake to the DM allowlist (alias: dm add)
  remove <userId>                              Remove a Discord user snowflake from the DM allowlist (alias: dm remove)
  policy <pairing|allowlist|disabled>          Set DM policy
  group add <channelId> [--no-mention] [--allow id1,id2]
                                               Enable a guild channel
  group rm <channelId>                         Disable a guild channel (alias: group remove)
  set <key> <value>                            Set delivery/mention config:
                                                 ackReaction (emoji or "")
                                                 replyToMode (off | first | all)
                                                 textChunkLimit (1..2000)
                                                 chunkMode (newline | length)
                                                 mentionPatterns (JSON string array)
`)
}

const access = readAccessFile(stateDir)
pruneExpiredPending(access)

switch (cmd) {
  case 'status': {
    console.log(`Access file: ${accessFile}`)
    console.log(JSON.stringify(access, null, 2))
    break
  }

  case 'policy': {
    const policy = args[1]
    if (policy !== 'pairing' && policy !== 'allowlist' && policy !== 'disabled') {
      console.error('Policy must be one of: pairing, allowlist, disabled')
      process.exit(1)
    }
    access.dmPolicy = policy
    saveAccessFile(access, stateDir)
    console.log(`dmPolicy set to "${policy}"`)
    break
  }

  case 'pair': {
    const code = args[1]
    if (!code) {
      console.error('Usage: bun run access pair <code>')
      process.exit(1)
    }
    const entry = access.pending[code]
    if (!entry) {
      console.error(`No active pending pairing code "${code}"`)
      process.exit(1)
    }
    if (!access.allowFrom.includes(entry.senderId)) {
      access.allowFrom.push(entry.senderId)
    }
    delete access.pending[code]
    saveAccessFile(access, stateDir)
    writeApprovalMarker(entry.senderId, entry.chatId, stateDir)
    console.log(
      `Paired ${entry.username ? `${entry.username} ` : ''}(${entry.senderId}). Confirmation DM queued.`,
    )
    if (access.dmPolicy === 'pairing') {
      console.log(
        'Tip: once everyone is added, lock down pairing with: bun run access policy allowlist',
      )
    }
    break
  }

  case 'deny': {
    const code = args[1]
    if (!code) {
      console.error('Usage: bun run access deny <code>')
      process.exit(1)
    }
    if (!(code in access.pending)) {
      console.error(`No pending pairing code "${code}"`)
      process.exit(1)
    }
    delete access.pending[code]
    saveAccessFile(access, stateDir)
    console.log(`Discarded pending pairing code "${code}"`)
    break
  }

  case 'allow': {
    const userId = args[1]
    if (!userId) {
      console.error('Usage: bun run access allow <userId>')
      process.exit(1)
    }
    if (!access.allowFrom.includes(userId)) access.allowFrom.push(userId)
    saveAccessFile(access, stateDir)
    console.log(`Added user ${userId} to allowFrom`)
    break
  }

  case 'remove': {
    const userId = args[1]
    if (!userId) {
      console.error('Usage: bun run access remove <userId>')
      process.exit(1)
    }
    access.allowFrom = access.allowFrom.filter(id => id !== userId)
    saveAccessFile(access, stateDir)
    console.log(`Removed user ${userId} from allowFrom`)
    break
  }

  case 'dm': {
    const sub = args[1]
    const userId = args[2]
    if (!userId || (sub !== 'add' && sub !== 'remove')) {
      console.error('Usage: bun run access dm <add|remove> <userId>')
      process.exit(1)
    }
    if (sub === 'add') {
      if (!access.allowFrom.includes(userId)) access.allowFrom.push(userId)
      saveAccessFile(access, stateDir)
      console.log(`Added user ${userId} to allowFrom`)
    } else {
      access.allowFrom = access.allowFrom.filter(id => id !== userId)
      saveAccessFile(access, stateDir)
      console.log(`Removed user ${userId} from allowFrom`)
    }
    break
  }

  case 'group': {
    const sub = args[1]
    const channelId = args[2]
    if (!channelId || (sub !== 'add' && sub !== 'rm' && sub !== 'remove')) {
      console.error(
        'Usage: bun run access group <add|rm> <channelId> [--allow id1,id2] [--no-mention]',
      )
      process.exit(1)
    }

    if (sub === 'rm' || sub === 'remove') {
      delete access.groups[channelId]
      saveAccessFile(access, stateDir)
      console.log(`Removed channel ${channelId}`)
      break
    }

    let allowFrom: string[] = []
    let requireMention = true

    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--no-mention') {
        requireMention = false
      } else if (args[i] === '--mention') {
        requireMention = true
      } else if (args[i] === '--allow' && args[i + 1]) {
        allowFrom = args[i + 1]!
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
        i++
      }
    }

    access.groups[channelId] = { requireMention, allowFrom }
    saveAccessFile(access, stateDir)
    console.log(
      `Configured channel ${channelId}: requireMention=${requireMention}, allowFrom=[${allowFrom.join(', ')}]`,
    )
    break
  }

  case 'set': {
    const key = args[1]
    const rawVal = args[2]
    if (!key || rawVal === undefined) {
      console.error('Usage: bun run access set <ackReaction|replyToMode|textChunkLimit|chunkMode|mentionPatterns> <value>')
      process.exit(1)
    }

    switch (key) {
      case 'ackReaction':
        access.ackReaction = rawVal
        break
      case 'replyToMode':
        if (rawVal !== 'off' && rawVal !== 'first' && rawVal !== 'all') {
          console.error('replyToMode must be one of: off, first, all')
          process.exit(1)
        }
        access.replyToMode = rawVal
        break
      case 'textChunkLimit': {
        const n = Number(rawVal)
        if (!Number.isInteger(n) || n < 1 || n > MAX_CHUNK_LIMIT) {
          console.error(`textChunkLimit must be an integer between 1 and ${MAX_CHUNK_LIMIT}`)
          process.exit(1)
        }
        access.textChunkLimit = n
        break
      }
      case 'chunkMode':
        if (rawVal !== 'length' && rawVal !== 'newline') {
          console.error('chunkMode must be one of: length, newline')
          process.exit(1)
        }
        access.chunkMode = rawVal
        break
      case 'mentionPatterns': {
        let parsed: unknown
        try {
          parsed = JSON.parse(rawVal)
        } catch {
          console.error('mentionPatterns must be a JSON array of regex strings, e.g. \'["^hey agy\\\\b"]\'')
          process.exit(1)
        }
        if (!Array.isArray(parsed) || !parsed.every(x => typeof x === 'string')) {
          console.error('mentionPatterns must be a JSON array of strings')
          process.exit(1)
        }
        for (const pat of parsed) {
          try {
            new RegExp(pat, 'i')
          } catch (err) {
            console.error(`Invalid regex "${pat}": ${(err as Error).message}`)
            process.exit(1)
          }
        }
        access.mentionPatterns = parsed
        break
      }
      default:
        console.error(
          `Unknown key "${key}". Supported: ackReaction, replyToMode, textChunkLimit, chunkMode, mentionPatterns`,
        )
        process.exit(1)
    }

    saveAccessFile(access, stateDir)
    console.log(`Updated ${key} = ${JSON.stringify(access[key as keyof typeof access])}`)
    break
  }

  default:
    usage()
    process.exit(1)
}
