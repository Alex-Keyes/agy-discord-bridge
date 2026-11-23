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
})
