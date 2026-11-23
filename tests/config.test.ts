import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AccessStore,
  assertSendable,
  clearBotToken,
  defaultAccess,
  issuePairingCode,
  pruneExpiredPending,
  readAccessFile,
  readStoredToken,
  safeAttachmentName,
  saveAccessFile,
  saveBotToken,
} from '../src/config.ts'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-discord-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('pairing and access store', () => {
  test('issues code, allows 1 resend, then drops; caps pending at 3', () => {
    const access = defaultAccess()
    const now = 1_700_000_000_000

    const first = issuePairingCode(access, 'u1', 'alice', 'dm1', now)
    expect(first.action).toBe('pair')
    if (first.action === 'pair') {
      expect(first.isResend).toBe(false)
      expect(first.code).toHaveLength(6)
    }

    const second = issuePairingCode(access, 'u1', 'alice', 'dm1', now + 1000)
    expect(second.action).toBe('pair')
    if (second.action === 'pair' && first.action === 'pair') {
      expect(second.isResend).toBe(true)
      expect(second.code).toBe(first.code)
    }

    // 3rd attempt from same user is silently dropped
    expect(issuePairingCode(access, 'u1', 'alice', 'dm1', now + 2000)).toEqual({ action: 'drop' })

    // 2nd & 3rd distinct users succeed, 4th is dropped (cap 3)
    expect(issuePairingCode(access, 'u2', 'bob', 'dm2', now).action).toBe('pair')
    expect(issuePairingCode(access, 'u3', 'carol', 'dm3', now).action).toBe('pair')
    expect(issuePairingCode(access, 'u4', 'dave', 'dm4', now)).toEqual({ action: 'drop' })

    // Expiration prunes all entries after TTL
    expect(pruneExpiredPending(access, now + 60 * 60 * 1000 + 1)).toBe(true)
    expect(Object.keys(access.pending)).toHaveLength(0)
  })

  test('static mode downgrades pairing to allowlist and ignores runtime disk edits', () => {
    const dir = makeTempDir()
    const initial = defaultAccess()
    initial.allowFrom = ['111']
    saveAccessFile(initial, dir)

    const store = new AccessStore(dir, true)
    const loaded = store.load()
    expect(loaded.dmPolicy).toBe('allowlist')
    expect(loaded.allowFrom).toEqual(['111'])

    // Disk edits after boot are ignored in static mode
    const mutated = defaultAccess()
    mutated.allowFrom = ['999']
    saveAccessFile(mutated, dir)
    expect(store.load().allowFrom).toEqual(['111'])
  })

  test('corrupt access.json is moved aside instead of crashing', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'access.json'), '{not valid json')
    const recovered = readAccessFile(dir)
    expect(recovered.dmPolicy).toBe('pairing')
    const files = readdirSync(dir)
    expect(files.some(f => f.startsWith('access.json.corrupt-'))).toBe(true)
  })

  test('preserves group responseMode across save and read', () => {
    const dir = makeTempDir()
    const access = defaultAccess()
    access.groups['123456'] = {
      requireMention: false,
      responseMode: 'dynamic',
      allowFrom: ['u1'],
    }
    saveAccessFile(access, dir)
    const loaded = readAccessFile(dir)
    expect(loaded.groups['123456']).toEqual({
      requireMention: false,
      responseMode: 'dynamic',
      allowFrom: ['u1'],
    })
  })
})

describe('security guards and token storage', () => {
  test('assertSendable blocks state files but allows inbox files', () => {
    const dir = makeTempDir()
    const envPath = join(dir, '.env')
    const accessPath = join(dir, 'access.json')
    const inboxDir = join(dir, 'inbox')
    mkdirSync(inboxDir, { recursive: true })
    const inboxFile = join(inboxDir, 'photo.png')

    writeFileSync(envPath, 'DISCORD_BOT_TOKEN=secret\n')
    writeFileSync(accessPath, '{}')
    writeFileSync(inboxFile, 'png')

    expect(() => assertSendable(envPath, dir)).toThrow('refusing to send channel state')
    expect(() => assertSendable(accessPath, dir)).toThrow('refusing to send channel state')
    expect(() => assertSendable(inboxFile, dir)).not.toThrow()
  })

  test('safeAttachmentName strips delimiter characters', () => {
    expect(safeAttachmentName('evil];\n[name.png', '123')).toBe('evil____name.png')
    expect(safeAttachmentName(null, '123')).toBe('123')
  })

  test('saveBotToken and clearBotToken preserve other keys', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, '.env'), 'OTHER_KEY=keep\n')
    saveBotToken('MTIzTestToken', dir)
    const prevEnv = process.env.DISCORD_BOT_TOKEN
    delete process.env.DISCORD_BOT_TOKEN
    try {
      expect(readStoredToken(dir).token).toBe('MTIzTestToken')
      clearBotToken(dir)
      expect(readStoredToken(dir).token).toBeUndefined()
    } finally {
      if (prevEnv !== undefined) process.env.DISCORD_BOT_TOKEN = prevEnv
    }
  })
})
