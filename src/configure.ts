#!/usr/bin/env bun
import {
  clearBotToken,
  getStateDir,
  getStatePaths,
  pruneExpiredPending,
  readAccessFile,
  readStoredToken,
  saveBotToken,
} from './config.ts'

const args = process.argv.slice(2)
const arg = args[0]?.trim()
const stateDir = getStateDir()

function printStatus(): void {
  const { accessFile, envFile } = getStatePaths(stateDir)
  const { token, source } = readStoredToken(stateDir)
  const access = readAccessFile(stateDir)
  pruneExpiredPending(access)

  console.log(`State directory: ${stateDir}`)
  if (token) {
    console.log(`Bot token:       set (${token.slice(0, 6)}... from ${source})`)
  } else {
    console.log(`Bot token:       NOT SET (expected in ${envFile})`)
  }

  console.log(`DM policy:       ${access.dmPolicy}`)
  console.log(
    `Allowed DMs:     ${access.allowFrom.length}${access.allowFrom.length > 0 ? ` (${access.allowFrom.join(', ')})` : ''}`,
  )
  const pendingEntries = Object.entries(access.pending)
  console.log(
    `Pending codes:   ${pendingEntries.length}${pendingEntries.length > 0 ? ` (${pendingEntries.map(([c, p]) => `${c} -> ${p.senderId}`).join(', ')})` : ''}`,
  )
  console.log(`Guild channels:  ${Object.keys(access.groups).length}`)
  console.log(`Access file:     ${accessFile}`)
  console.log('')

  if (!token) {
    console.log('Next step: run `bun run configure <BOT_TOKEN>` with your token from Discord Developer Portal -> Bot -> Reset Token.')
  } else if (access.dmPolicy === 'pairing' && access.allowFrom.length === 0) {
    console.log('Next step: start the bridge (`bun run start`) and DM your bot on Discord to get a pairing code.')
  } else if (access.dmPolicy === 'pairing' && access.allowFrom.length > 0) {
    console.log(
      'Security tip: everyone needed is in allowFrom? Lock down pairing so strangers cannot request codes:\n' +
        '  bun run access policy allowlist',
    )
  } else {
    console.log('Ready. Start the bridge with: bun run start')
  }
}

if (!arg || arg === 'status') {
  printStatus()
  process.exit(0)
}

if (arg === 'clear') {
  const removed = clearBotToken(stateDir)
  console.log(removed ? 'Cleared DISCORD_BOT_TOKEN from state .env.' : 'No stored token found.')
  printStatus()
  process.exit(0)
}

const savedPath = saveBotToken(arg, stateDir)
console.log(`Saved DISCORD_BOT_TOKEN to ${savedPath} (chmod 600). Restart the bridge if already running.\n`)
printStatus()
