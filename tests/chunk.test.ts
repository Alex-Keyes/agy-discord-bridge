import { describe, expect, test } from 'bun:test'
import { chunkMarkdown, chunkText } from '../src/chunk.ts'

describe('chunkText', () => {
  test('returns single chunk when under limit', () => {
    expect(chunkText('hello world', 2000, 'newline')).toEqual(['hello world'])
    expect(chunkText('hello world', 2000, 'length')).toEqual(['hello world'])
  })

  test('length mode hard-splits at limit', () => {
    const chunks = chunkText('abcdefghij', 4, 'length')
    expect(chunks).toEqual(['abcd', 'efgh', 'ij'])
  })

  test('newline mode preserves fenced code blocks across chunks', () => {
    const code = '```ts\n' + 'const x = 1;\n'.repeat(40) + '```'
    const chunks = chunkMarkdown(code, 300)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300)
      const fenceLines = chunk.match(/^```/gm) ?? []
      expect(fenceLines.length % 2).toBe(0)
    }
    expect(chunks[0]).toStartWith('```ts\n')
    expect(chunks[1]).toStartWith('```ts\n')
  })

  test('caps limit at Discord 2000-character ceiling', () => {
    const long = 'a'.repeat(4500)
    const chunks = chunkText(long, 5000, 'length')
    expect(chunks.map(c => c.length)).toEqual([2000, 2000, 500])
  })
})
