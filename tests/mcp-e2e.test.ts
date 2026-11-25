import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { startDiscordMcpServer } from '../src/mcp-server.ts'

describe('in-process Streamable HTTP MCP server', () => {
  test('enforces Bearer auth, lists all 7 Discord tools, and executes tool calls', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const srv = startDiscordMcpServer({
      async callTool(name, args) {
        calls.push({ name, args })
        return { content: [{ type: 'text', text: `mock-ok:${name}:${String(args.chat_id ?? '')}` }] }
      },
    })

    try {
      // Ephemeral runtime workspace has both .agents/mcp_config.json and AGENTS.md
      const mcpCfgPath = join(srv.runtimeDir, '.agents', 'mcp_config.json')
      const agentsMdPath = join(srv.runtimeDir, 'AGENTS.md')
      expect(existsSync(mcpCfgPath)).toBe(true)
      expect(existsSync(agentsMdPath)).toBe(true)
      const agentsMd = readFileSync(agentsMdPath, 'utf8')
      expect(agentsMd).toContain('mode="dynamic"')
      expect(agentsMd).toContain('NO_REPLY')
      const mcpCfg = JSON.parse(readFileSync(mcpCfgPath, 'utf8'))
      expect(mcpCfg.mcpServers.discord.serverUrl).toBe(srv.url)
      expect(mcpCfg.mcpServers.discord.headers.Authorization).toBe(`Bearer ${srv.bearerToken}`)

      // Rejects unauthenticated requests
      const unauth = await fetch(srv.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(unauth.status).toBe(401)

      const authHeaders = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${srv.bearerToken}`,
      }

      // List tools
      const listRes = await fetch(srv.url, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      })
      expect(listRes.status).toBe(200)
      const listBody = (await listRes.json()) as {
        result: { tools: Array<{ name: string }> }
      }
      const toolNames = listBody.result.tools.map(t => t.name).sort()
      expect(toolNames).toEqual([
        'create_thread',
        'download_attachment',
        'edit_message',
        'fetch_messages',
        'list_emojis',
        'react',
        'reply',
      ])

      // Call a tool
      const callRes = await fetch(srv.url, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'reply', arguments: { chat_id: '12345', text: 'hello' } },
        }),
      })
      expect(callRes.status).toBe(200)
      const callBody = (await callRes.json()) as {
        result: { content: Array<{ text: string }> }
      }
      expect(callBody.result.content[0]?.text).toBe('mock-ok:reply:12345')
      expect(calls).toEqual([{ name: 'reply', args: { chat_id: '12345', text: 'hello' } }])
    } finally {
      srv.close()
    }

    // Ephemeral runtimeDir cleaned up on close()
    expect(existsSync(srv.runtimeDir)).toBe(false)
  })

  test('exposes subagent tools on coordinator /mcp and isolates worker /mcp/worker/<id>', async () => {
    const calls: Array<{
      name: string
      args: Record<string, unknown>
      caller?: { kind: string; subagentId?: string }
    }> = []

    const srv = startDiscordMcpServer(
      {
        async callTool(name, args, caller) {
          calls.push({ name, args, caller })
          return { content: [{ type: 'text', text: `ok:${name}` }] }
        },
      },
      { enableSubagents: true },
    )

    let workerDir = ''
    try {
      const authHeaders = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${srv.bearerToken}`,
      }

      // Coordinator AGENTS.md includes subagent delegation instructions
      const coordAgentsMd = readFileSync(join(srv.runtimeDir, 'AGENTS.md'), 'utf8')
      expect(coordAgentsMd).toContain('spawn_subagent')

      // Coordinator /mcp lists all 10 tools
      const coordListRes = await fetch(srv.url, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      expect(coordListRes.status).toBe(200)
      const coordListBody = (await coordListRes.json()) as {
        result: { tools: Array<{ name: string }> }
      }
      expect(coordListBody.result.tools.map(t => t.name).sort()).toEqual([
        'cancel_subagent',
        'create_thread',
        'download_attachment',
        'edit_message',
        'fetch_messages',
        'list_emojis',
        'list_subagents',
        'react',
        'reply',
        'spawn_subagent',
      ])

      // Worker runtime workspace points to /mcp/worker/<id>
      workerDir = srv.createWorkerRuntimeDir('sa-abc123')
      const workerCfg = JSON.parse(
        readFileSync(join(workerDir, '.agents', 'mcp_config.json'), 'utf8'),
      )
      const workerUrl = workerCfg.mcpServers.discord.serverUrl as string
      expect(workerUrl).toEndWith('/mcp/worker/sa-abc123')

      // Worker endpoint rejects unauthenticated requests
      const unauthWorker = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      })
      expect(unauthWorker.status).toBe(401)

      // Worker endpoint exposes ONLY the 7 Discord tools (no recursive spawn_subagent)
      const workerListRes = await fetch(workerUrl, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      })
      expect(workerListRes.status).toBe(200)
      const workerListBody = (await workerListRes.json()) as {
        result: { tools: Array<{ name: string }> }
      }
      expect(workerListBody.result.tools.map(t => t.name).sort()).toEqual([
        'create_thread',
        'download_attachment',
        'edit_message',
        'fetch_messages',
        'list_emojis',
        'react',
        'reply',
      ])

      // Calls on coordinator vs worker endpoints attribute caller accurately
      await fetch(srv.url, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'reply', arguments: { chat_id: 'c1', text: 'coord' } },
        }),
      })
      await fetch(workerUrl, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'reply', arguments: { chat_id: 'c1', text: 'worker' } },
        }),
      })

      expect(calls).toEqual([
        {
          name: 'reply',
          args: { chat_id: 'c1', text: 'coord' },
          caller: { kind: 'coordinator' },
        },
        {
          name: 'reply',
          args: { chat_id: 'c1', text: 'worker' },
          caller: { kind: 'subagent', subagentId: 'sa-abc123' },
        },
      ])
    } finally {
      srv.close()
    }

    expect(existsSync(workerDir)).toBe(false)
  })
})
