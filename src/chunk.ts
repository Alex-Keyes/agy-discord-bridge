import { MAX_CHUNK_LIMIT } from './config.ts'

export type ChunkMode = 'newline' | 'length'

/**
 * Splits long text into Discord-safe chunks (<= 2000 chars).
 * - 'newline' (default): prefers paragraph/line/word boundaries and preserves fenced code blocks across splits.
 * - 'length': hard splits at the character limit.
 */
export function chunkText(
  text: string,
  limit = MAX_CHUNK_LIMIT,
  mode: ChunkMode = 'newline',
): string[] {
  const maxLen = Math.max(1, Math.min(limit, MAX_CHUNK_LIMIT))
  if (!text) return ['(empty response)']
  if (text.length <= maxLen) return [text]

  if (mode === 'length') {
    const out: string[] = []
    for (let i = 0; i < text.length; i += maxLen) {
      out.push(text.slice(i, i + maxLen))
    }
    return out
  }

  return chunkMarkdown(text, maxLen)
}

/**
 * Splits markdown while preferring paragraph/line boundaries and keeping
 * triple-backtick code fences closed and reopened cleanly across chunks.
 */
export function chunkMarkdown(text: string, limit = MAX_CHUNK_LIMIT): string[] {
  const maxLen = Math.max(20, Math.min(limit, MAX_CHUNK_LIMIT))
  const normalized = text.trim()
  if (!normalized) return ['(empty response)']
  if (normalized.length <= maxLen) return [normalized]

  const chunks: string[] = []
  let remaining = normalized
  let openFence: string | null = null

  while (remaining.length > 0) {
    const prefix = openFence ? `${openFence}\n` : ''
    const reserveForClose = 5
    const budget = Math.max(10, maxLen - prefix.length - reserveForClose)

    if (prefix.length + remaining.length <= maxLen) {
      chunks.push(prefix + remaining)
      break
    }

    const splitAt = findSplitPoint(remaining, budget)
    let piece = remaining.slice(0, splitAt).trimEnd()
    if (!piece) {
      piece = remaining.slice(0, budget)
      remaining = remaining.slice(budget)
    } else {
      remaining = remaining.slice(splitAt).replace(/^\n+/, '')
    }

    const nextOpenFence = computeOpenFence(openFence, piece)
    if (nextOpenFence) {
      piece += '\n```'
    }

    chunks.push(prefix + piece)
    openFence = nextOpenFence
  }

  return chunks
}

function findSplitPoint(text: string, maxLen: number): number {
  const minPreferred = Math.floor(maxLen * 0.5)

  const para = text.lastIndexOf('\n\n', maxLen)
  if (para >= minPreferred) return para

  const newline = text.lastIndexOf('\n', maxLen)
  if (newline >= minPreferred) return newline

  const space = text.lastIndexOf(' ', maxLen)
  if (space >= minPreferred) return space

  return maxLen
}

function computeOpenFence(initialFence: string | null, segment: string): string | null {
  let fence = initialFence
  for (const line of segment.split('\n')) {
    const match = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/)
    if (!match) continue
    fence = fence === null ? match[0].trim() : null
  }
  return fence
}
