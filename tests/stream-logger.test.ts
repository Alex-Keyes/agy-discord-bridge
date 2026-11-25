import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  TerminalStreamLogger,
  TranscriptThinkingTailer,
  formatToolSummary,
  formatUsageSummary,
} from '../src/stream-logger.ts'

const tempDirs: string[] = []
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-stream-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe('formatToolSummary and formatUsageSummary', () => {
  test('formats standard tools, MCP tools, and long parameter truncation', () => {
    expect(formatToolSummary('read_file', { Path: '/tmp/foo.ts' })).toBe('read_file(/tmp/foo.ts)')
    expect(
      formatToolSummary('call_mcp_tool', {
        ServerName: 'discord',
        ToolName: 'react',
        Arguments: { chat_id: '123', emoji: '🎉' },
      }),
    ).toBe('discord.react(chat_id=123, emoji=🎉)')
    expect(formatToolSummary('run_command', { CommandLine: 'a'.repeat(150) })).toHaveLength(
      'run_command('.length + 100 + ')'.length,
    )
    expect(formatToolSummary('noop')).toBe('noop')
  })

  test('formats usage and duration compactly', () => {
    expect(
      formatUsageSummary(
        { input_tokens: 3100, cache_read_tokens: 84500, thinking_tokens: 420, output_tokens: 180 },
        4.24,
      ),
    ).toBe('4.2s · in: 3.1k · cached: 84.5k · think: 420 · out: 180')
  })
})

describe('TranscriptThinkingTailer', () => {
  test('skips pre-existing history when resuming and tails only newly appended thinking blocks', () => {
    const brainDir = makeTempDir()
    const convId = 'conv-123'
    const logDir = join(brainDir, convId, '.system_generated', 'logs')
    mkdirSync(logDir, { recursive: true })
    const transcriptPath = join(logDir, 'transcript.jsonl')

    writeFileSync(
      transcriptPath,
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', thinking: 'old thought' }) + '\n',
    )

    const tailer = new TranscriptThinkingTailer(brainDir)
    tailer.attach(convId, true)

    // Old history is skipped on resume
    expect(tailer.poll()).toEqual([])

    // Append a new step + partial line
    appendFileSync(
      transcriptPath,
      JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: 'hi' }) +
        '\n' +
        JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', thinking: 'new thought' }) +
        '\n' +
        '{"step_index":4,"thinking":"partial',
    )

    expect(tailer.poll(2)).toEqual([{ stepIndex: 3, thinking: 'new thought' }])
    // Second poll without new complete lines returns nothing (deduped)
    expect(tailer.poll(2)).toEqual([])

    // Finish the partial line
    appendFileSync(transcriptPath, ' complete"}\n')
    expect(tailer.poll(2)).toEqual([{ stepIndex: 4, thinking: 'partial complete' }])
  })
})

describe('TerminalStreamLogger', () => {
  test('renders header, thinking from transcript, tool calls, streamed text, stats, and outcome', () => {
    const brainDir = makeTempDir()
    const convId = 'conv-live'
    const logDir = join(brainDir, convId, '.system_generated', 'logs')
    mkdirSync(logDir, { recursive: true })
    const transcriptPath = join(logDir, 'transcript.jsonl')

    const chunks: string[] = []
    const logger = new TerminalStreamLogger({
      enabled: true,
      showThinking: true,
      color: false,
      brainDir,
      write: c => chunks.push(c),
    })

    logger.onTurnStart({
      channelLabel: '#general',
      author: 'captainkeyes.',
      preview: 'check tests',
      modeLabel: 'dynamic',
    })
    logger.onStepUpdate({ conversation_id: convId, step_index: 0, step_type: 'user_input', state: 'DONE' })

    // Simulate agy writing step 1 thinking to transcript.jsonl
    writeFileSync(
      transcriptPath,
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', thinking: 'Let me run the tests.' }) +
        '\n',
    )

    logger.onStepUpdate({ conversation_id: convId, step_index: 1, step_type: 'agent_response', state: 'DONE' })
    logger.onStepUpdate({
      conversation_id: convId,
      step_index: 2,
      step_type: 'tool',
      state: 'ACTIVE',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'bun test' } },
    })
    logger.onStepUpdate({
      conversation_id: convId,
      step_index: 2,
      step_type: 'tool',
      state: 'DONE',
      tool_name: 'run_command',
      duration_seconds: 0.4,
    })
    logger.onStepUpdate({
      conversation_id: convId,
      step_index: 2,
      step_type: 'subagent',
      state: 'ACTIVE',
      tool_name: 'invoke_subagent',
      subagent_info: {
        subagents: [{ type_name: 'research', role: 'Codebase Scout' }],
      },
    })
    logger.onStepUpdate({
      conversation_id: convId,
      step_index: 2,
      step_type: 'subagent',
      state: 'DONE',
      tool_name: 'invoke_subagent',
      duration_seconds: 0.9,
      subagent_info: {
        subagents: [{ type_name: 'research', role: 'Codebase Scout' }],
      },
    })
    logger.onStepUpdate({
      conversation_id: convId,
      step_index: 3,
      step_type: 'agent_response',
      state: 'ACTIVE',
      text_delta: 'All ',
    })
    logger.onStepUpdate({
      conversation_id: convId,
      step_index: 3,
      step_type: 'agent_response',
      state: 'DONE',
      text_delta: 'green!',
    })
    logger.onTurnResult('All green!', { input_tokens: 1000, output_tokens: 20 }, 1.2)
    logger.onDeliveryOutcome('posted to Discord')

    const output = chunks.join('')
    expect(output).toContain('#general · @captainkeyes. (dynamic)')
    expect(output).toContain('> check tests')
    expect(output).toContain('💭 Thinking:')
    expect(output).toContain('  Let me run the tests.')
    expect(output).toContain('⚙ run_command(bun test)')
    expect(output).toContain('✓ run_command (0.4s)')
    expect(output).toContain('🤖 subagent(research: Codebase Scout)')
    expect(output).toContain('✓ subagent(research: Codebase Scout) (0.9s)')
    expect(output).toContain('All green!')
    expect(output).toContain('1.2s · in: 1.0k · out: 20')
    expect(output).toContain('↳ posted to Discord')
  })

  test('stays silent when disabled', () => {
    const chunks: string[] = []
    const logger = new TerminalStreamLogger({
      enabled: false,
      showThinking: true,
      color: false,
      write: c => chunks.push(c),
    })

    logger.onTurnStart({ channelLabel: '#general', author: 'alice', preview: 'hi' })
    logger.onStepUpdate({ step_type: 'agent_response', state: 'ACTIVE', text_delta: 'hello' })
    logger.onTurnResult('hello')
    logger.onDeliveryOutcome('posted to Discord')

    expect(chunks.join('')).toBe('')
  })
})
