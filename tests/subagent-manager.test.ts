import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RuntimeConfig } from '../src/config.ts'
import {
  SubagentManager,
  formatCompletedUpdatesBlock,
} from '../src/subagent-manager.ts'

const tempDirs: string[] = []
function makeTempDir(prefix = 'agy-subagent-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeRuntime(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    token: 'test-token',
    agyBin: 'agy',
    defaultCwd: process.cwd(),
    permissionMode: 'always-proceed',
    subagentsEnabled: true,
    maxSubagents: 2,
    subagentTimeoutMs: 5000,
    idleTimeoutMs: 60_000,
    staticMode: false,
    autoDownloadAttachments: false,
    streamLog: false,
    showThinking: false,
    ...overrides,
  }
}

/**
 * Spawns a tiny Bun worker script that reads one NDJSON user prompt from stdin,
 * sleeps `delayMs`, emits a fake agy stream-json init/step/result sequence, and exits.
 */
function createMockSpawner(
  behavior: (args: string[], cwd: string) => {
    delayMs?: number
    response?: string
    status?: string
    error?: string
    hang?: boolean
    exitCode?: number
  },
) {
  return (cmd: string[], cwd: string) => {
    const cfg = behavior(cmd, cwd)
    const script = `
      const reader = Bun.stdin.stream().getReader();
      await reader.read();
      const cfg = ${JSON.stringify(cfg)};
      if (cfg.hang) {
        await Bun.sleep(60000);
        process.exit(0);
      }
      if (cfg.delayMs) await Bun.sleep(cfg.delayMs);
      if (typeof cfg.exitCode === 'number') {
        process.stderr.write('simulated crash\\n');
        process.exit(cfg.exitCode);
      }
      console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-worker' }));
      if (cfg.response) {
        console.log(JSON.stringify({
          event: 'step_update',
          step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: cfg.response }
        }));
      }
      console.log(JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-worker',
          status: cfg.status ?? 'SUCCESS',
          response: cfg.response ?? '',
          error: cfg.error,
          duration_seconds: (cfg.delayMs ?? 10) / 1000
        }
      }));
      process.exit(0);
    `
    return Bun.spawn([process.execPath, '-e', script], {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }
}

describe('SubagentManager', () => {
  test('runs tasks in parallel up to maxSubagents, queues overflow FIFO, and cleans up worker dirs', async () => {
    const delivered: Array<{ chatId: string; text: string; replyTo?: string }> = []
    const createdDirs: string[] = []
    let spawnCount = 0

    const mgr = new SubagentManager({
      runtime: makeRuntime({ maxSubagents: 2 }),
      createWorkerRuntimeDir(id) {
        const dir = makeTempDir(`worker-${id}-`)
        mkdirSync(join(dir, '.agents'), { recursive: true })
        createdDirs.push(dir)
        return dir
      },
      getChatDefaults: () => ({ cwd: process.cwd(), permissionMode: 'always-proceed' }),
      deliverText: async (chatId, text, replyTo) => {
        delivered.push({ chatId, text, replyTo })
      },
      deliverError: async () => {},
      spawnProcess: createMockSpawner(() => {
        const n = ++spawnCount
        return { delayMs: 120, response: `result-${n}` }
      }),
    })

    const t0 = Date.now()
    const a = mgr.spawn({ chatId: 'c1', task: 'task A', role: 'Worker A', replyTo: 'm1' })
    const b = mgr.spawn({ chatId: 'c1', task: 'task B', role: 'Worker B', replyTo: 'm2' })
    const c = mgr.spawn({ chatId: 'c1', task: 'task C', role: 'Worker C', replyTo: 'm3' })

    expect(a.status).toBe('running')
    expect(b.status).toBe('running')
    expect(c.status).toBe('queued')
    expect(c.queuePosition).toBe(1)

    await mgr.waitForIdle()
    const elapsed = Date.now() - t0

    // 3 tasks @ 120ms each with concurrency 2 should take ~240ms (+ process startup), not 360ms+
    expect(delivered).toHaveLength(3)
    expect(delivered.map(d => d.text).sort()).toEqual(['result-1', 'result-2', 'result-3'])
    expect(delivered.map(d => d.replyTo).sort()).toEqual(['m1', 'm2', 'm3'])
    expect(elapsed).toBeLessThan(1500)

    // Ephemeral worker dirs cleaned up
    for (const dir of createdDirs) {
      expect(existsSync(dir)).toBe(false)
    }

    // Completed updates ledger captured all 3 and drains cleanly
    const updates = mgr.drainCompletedUpdates('c1')
    expect(updates).toHaveLength(3)
    expect(mgr.drainCompletedUpdates('c1')).toEqual([])
    const block = formatCompletedUpdatesBlock(updates)
    expect(block).toContain('<subagent_updates>')
    expect(block).toContain('Worker A')
    expect(block).toContain('</subagent_updates>')
  })

  test('tracks repliedViaTool per subagent independently without cross-suppressing fallback replies', async () => {
    const delivered: Array<{ chatId: string; text: string }> = []

    const mgr = new SubagentManager({
      runtime: makeRuntime({ maxSubagents: 2 }),
      createWorkerRuntimeDir: id => makeTempDir(`worker-${id}-`),
      getChatDefaults: () => ({ cwd: process.cwd(), permissionMode: 'always-proceed' }),
      deliverText: async (chatId, text) => {
        delivered.push({ chatId, text })
      },
      deliverError: async () => {},
      spawnProcess: createMockSpawner(() => ({ delayMs: 100, response: 'fallback text' })),
    })

    const a = mgr.spawn({ chatId: 'c1', task: 'task A', role: 'Direct Replier' })
    const b = mgr.spawn({ chatId: 'c1', task: 'task B', role: 'Fallback Replier' })

    // Only subagent A replied via MCP discord.reply
    mgr.markReplied(a.id)

    await mgr.waitForIdle()

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toEqual({ chatId: 'c1', text: 'fallback text' })
    const summary = mgr.getSummary('c1')
    const recA = summary.recent.find(r => r.id === a.id)
    const recB = summary.recent.find(r => r.id === b.id)
    expect(recA?.repliedViaTool).toBe(true)
    expect(recB?.repliedViaTool).toBe(false)
  })

  test('cancels running and queued subagents cleanly and promotes next queued worker', async () => {
    const delivered: string[] = []
    const errors: string[] = []
    let count = 0

    const mgr = new SubagentManager({
      runtime: makeRuntime({ maxSubagents: 1 }),
      createWorkerRuntimeDir: id => makeTempDir(`worker-${id}-`),
      getChatDefaults: () => ({ cwd: process.cwd(), permissionMode: 'always-proceed' }),
      deliverText: async (_chatId, text) => {
        delivered.push(text)
      },
      deliverError: async (_chatId, text) => {
        errors.push(text)
      },
      spawnProcess: createMockSpawner(() => {
        const n = ++count
        if (n === 1) return { hang: true }
        return { delayMs: 30, response: `ok-${n}` }
      }),
    })

    const first = mgr.spawn({ chatId: 'c1', task: 'hang forever', role: 'Stuck' })
    const second = mgr.spawn({ chatId: 'c1', task: 'drop me', role: 'Queued Drop' })
    const third = mgr.spawn({ chatId: 'c1', task: 'run me', role: 'Promoted' })

    expect(first.status).toBe('running')
    expect(second.status).toBe('queued')
    expect(third.status).toBe('queued')

    // Cancel queued #2 first, then cancel running #1 -> #3 should immediately run and succeed
    expect(mgr.cancel(second.id).cancelled).toBe(true)
    expect(mgr.cancel(first.id).cancelled).toBe(true)

    await mgr.waitForIdle()

    expect(errors).toEqual([])
    expect(delivered).toEqual(['ok-2'])
  })

  test('enforces subagent timeout and delivers error notification', async () => {
    const errors: string[] = []

    const mgr = new SubagentManager({
      runtime: makeRuntime({ maxSubagents: 1, subagentTimeoutMs: 120 }),
      createWorkerRuntimeDir: id => makeTempDir(`worker-${id}-`),
      getChatDefaults: () => ({ cwd: process.cwd(), permissionMode: 'always-proceed' }),
      deliverText: async () => {},
      deliverError: async (_chatId, text) => {
        errors.push(text)
      },
      spawnProcess: createMockSpawner(() => ({ hang: true })),
    })

    mgr.spawn({ chatId: 'c1', task: 'slow task', role: 'Slow Worker' })
    await mgr.waitForIdle()

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('timed out')
  })
})
