import { describe, expect, test } from 'bun:test'
import {
  evaluateGroupPolicy,
  isNoReply,
  needsMentionCheck,
  resolveGroupResponseMode,
  shouldSuppressFallbackReply,
} from '../src/response-policy.ts'

describe('NO_REPLY sentinel detection', () => {
  test('matches exact NO_REPLY and common lightweight wrappers', () => {
    expect(isNoReply('NO_REPLY')).toBe(true)
    expect(isNoReply('  no_reply \n')).toBe(true)
    expect(isNoReply('[NO_REPLY]')).toBe(true)
    expect(isNoReply('`NO_REPLY`')).toBe(true)
    expect(isNoReply('**NO_REPLY**')).toBe(true)
    expect(isNoReply('<NO_REPLY>')).toBe(true)
    expect(isNoReply('NO_REPLY.')).toBe(true)
  })

  test('does not match empty strings or normal sentences containing NO_REPLY', () => {
    expect(isNoReply('')).toBe(false)
    expect(isNoReply('   ')).toBe(false)
    expect(isNoReply('I configured NO_REPLY support.')).toBe(false)
    expect(isNoReply('NO_REPLY because they were chatting')).toBe(false)
  })
})

describe('fallback reply suppression', () => {
  test('suppresses when agent already replied via MCP tool', () => {
    expect(
      shouldSuppressFallbackReply(
        { response: 'Done!', repliedViaTool: true },
        { isDynamic: false },
      ),
    ).toBe(true)
  })

  test('suppresses on NO_REPLY in both always and dynamic modes', () => {
    expect(
      shouldSuppressFallbackReply(
        { response: 'NO_REPLY', repliedViaTool: false },
        { isDynamic: false },
      ),
    ).toBe(true)
    expect(
      shouldSuppressFallbackReply(
        { response: '[NO_REPLY]', repliedViaTool: false },
        { isDynamic: true },
      ),
    ).toBe(true)
  })

  test('suppresses empty output in dynamic mode but not in always mode', () => {
    expect(
      shouldSuppressFallbackReply(
        { response: '   ', repliedViaTool: false },
        { isDynamic: true },
      ),
    ).toBe(true)
    expect(
      shouldSuppressFallbackReply(
        { response: '   ', repliedViaTool: false },
        { isDynamic: false },
      ),
    ).toBe(false)
  })

  test('allows normal text replies through', () => {
    expect(
      shouldSuppressFallbackReply(
        { response: 'Here is the fix.', repliedViaTool: false },
        { isDynamic: true },
      ),
    ).toBe(false)
  })
})

describe('group policy evaluation', () => {
  test('drops when channel is not opted in or sender is not in allowFrom', () => {
    expect(evaluateGroupPolicy(undefined, 'u1', true)).toEqual({ action: 'drop' })
    expect(
      evaluateGroupPolicy({ requireMention: false, allowFrom: ['u2'] }, 'u1', true),
    ).toEqual({ action: 'drop' })
  })

  test('requireMention=true drops unmentioned and delivers mentioned in always mode', () => {
    const policy = { requireMention: true, allowFrom: [] }
    expect(needsMentionCheck(policy)).toBe(true)
    expect(evaluateGroupPolicy(policy, 'u1', false)).toEqual({ action: 'drop' })
    expect(evaluateGroupPolicy(policy, 'u1', true)).toEqual({
      action: 'deliver',
      responseMode: 'always',
      mentioned: true,
      isDynamicAmbient: false,
    })
  })

  test('requireMention=false without responseMode delivers in always mode without mention check', () => {
    const policy = { requireMention: false, allowFrom: [] }
    expect(resolveGroupResponseMode(policy)).toBe('always')
    expect(needsMentionCheck(policy)).toBe(false)
    expect(evaluateGroupPolicy(policy, 'u1', false)).toEqual({
      action: 'deliver',
      responseMode: 'always',
      mentioned: false,
      isDynamicAmbient: false,
    })
  })

  test('responseMode=dynamic delivers unmentioned as ambient and mentioned as direct', () => {
    // Even if requireMention was left true in JSON, dynamic mode overrides it.
    const policy = { requireMention: true, allowFrom: [], responseMode: 'dynamic' as const }
    expect(resolveGroupResponseMode(policy)).toBe('dynamic')
    expect(needsMentionCheck(policy)).toBe(true)

    expect(evaluateGroupPolicy(policy, 'u1', false)).toEqual({
      action: 'deliver',
      responseMode: 'dynamic',
      mentioned: false,
      isDynamicAmbient: true,
    })
    expect(evaluateGroupPolicy(policy, 'u1', true)).toEqual({
      action: 'deliver',
      responseMode: 'dynamic',
      mentioned: true,
      isDynamicAmbient: false,
    })
  })
})
