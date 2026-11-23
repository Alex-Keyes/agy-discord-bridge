import type { GroupPolicy, GroupResponseMode } from './config.ts'

export const NO_REPLY_TOKEN = 'NO_REPLY'

/**
 * Returns true if the agent's entire response is the silent NO_REPLY sentinel
 * (optionally wrapped in simple punctuation/markdown delimiters like [NO_REPLY] or `NO_REPLY`).
 */
export function isNoReply(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return /^[\[`<*_\s]*NO_REPLY[\]`>*_.\s]*$/i.test(trimmed)
}

export interface FallbackReplyDecisionInput {
  response: string
  repliedViaTool: boolean
}

/**
 * Determines whether the bridge should skip posting a fallback text reply after a turn.
 */
export function shouldSuppressFallbackReply(
  turn: FallbackReplyDecisionInput,
  options: { isDynamic: boolean },
): boolean {
  if (turn.repliedViaTool) return true
  if (isNoReply(turn.response)) return true
  if (options.isDynamic && turn.response.trim() === '') return true
  return false
}

export type GroupDecision =
  | { action: 'drop' }
  | {
      action: 'deliver'
      responseMode: GroupResponseMode
      mentioned: boolean
      /** True when observing unmentioned chatter in dynamic mode (skip typing/ack noise). */
      isDynamicAmbient: boolean
    }

/**
 * Resolves the effective response mode for a guild channel policy.
 */
export function resolveGroupResponseMode(policy: GroupPolicy): GroupResponseMode {
  return policy.responseMode === 'dynamic' ? 'dynamic' : 'always'
}

/**
 * Returns true if the bridge needs to evaluate mention status for this group policy.
 */
export function needsMentionCheck(policy: GroupPolicy): boolean {
  const mode = resolveGroupResponseMode(policy)
  if (mode === 'dynamic') return true
  return policy.requireMention ?? true
}

/**
 * Evaluates guild-channel access and dynamic/ambient delivery flags.
 */
export function evaluateGroupPolicy(
  policy: GroupPolicy | undefined,
  senderId: string,
  mentioned: boolean,
): GroupDecision {
  if (!policy) return { action: 'drop' }

  const groupAllowFrom = policy.allowFrom ?? []
  if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
    return { action: 'drop' }
  }

  const responseMode = resolveGroupResponseMode(policy)
  const requireMention = responseMode === 'dynamic' ? false : (policy.requireMention ?? true)

  if (requireMention && !mentioned) {
    return { action: 'drop' }
  }

  return {
    action: 'deliver',
    responseMode,
    mentioned,
    isDynamicAmbient: responseMode === 'dynamic' && !mentioned,
  }
}
