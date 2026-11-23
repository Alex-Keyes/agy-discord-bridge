# agy-discord-bridge

A full-featured Discord channel bridge and MCP toolkit for **Google Antigravity CLI (`agy`)**, built for feature parity with Claude Code's official Discord connector.

When a message arrives on Discord, the bridge gates it against your allowlist, forwards it into a persistent multi-turn `agy` session (`--input-format stream-json --output-format stream-json`), and automatically attaches an in-process **Streamable HTTP MCP server** giving Antigravity native Discord tools (`reply`, `react`, `list_emojis`, `edit_message`, `fetch_messages`, `download_attachment`, `create_thread`).

## Features

- **All 7 Discord MCP tools** — injected automatically into every `agy` session via an ephemeral loopback Streamable HTTP MCP server (`127.0.0.1` + per-boot Bearer token, zero global `mcp_config.json` edits required):
  - `reply` (auto-chunked, optional `reply_to`, up to 10 file attachments × 25MB with state-exfiltration protection)
  - `react` (Unicode & custom `<:name:id>` emoji)
  - `list_emojis` (server + application custom emoji discovery, role/availability filtering, query filter)
  - `edit_message` (live progress updates)
  - `fetch_messages` (oldest-first history lookback up to 100 messages with `+Natt` markers)
  - `download_attachment` (on-demand download to local inbox)
  - `create_thread` (start public threads from a channel or message)
- **Zero double-posting, zero silent drops, and optional dynamic responses** — if Antigravity calls `reply`, the bridge skips duplicate posting; if it responds in plain text without calling `reply`, the bridge posts the response automatically; and in `--dynamic` channels (or anytime the agent outputs `NO_REPLY`), Antigravity can observe all messages and selectively chime in, react, or stay silent without flashing typing indicators.
- **Persistent sessions per channel / thread / DM** — keeps a warm `agy` process per chat, queues concurrent turns safely, saves `conversation_id` in `~/.agy-discord/sessions.json` to resume seamlessly across restarts, and reaps idle processes to save memory.
- **Full access control & security** — DM pairing codes (1h TTL, 2-reply cap, 3-pending cap, confirmation DM on approval), allowlists, per-channel guild opt-in, thread inheritance, reply-to-bot & `mentionPatterns` detection, `DISCORD_ACCESS_MODE=static`, corrupt config recovery, and bot-loop prevention.
- **Antigravity Plugin included (`./plugin`)** — install with `agy plugin install ./plugin` to get `/discord:access` and `/discord:configure` slash commands in interactive `agy` sessions.
- **In-chat control commands** — `!agy status`, `!agy reset`, `!agy stop`, `!agy cwd <path>`, `!agy mode <mode>`, `!agy help`.

## Prerequisites

- [Google Antigravity CLI (`agy`)](https://antigravity.google) authenticated once via an interactive `agy` session
- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)

## Quick Setup

### 1. Create a Discord application and bot
1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Go to **Bot** in the sidebar:
   - Under **Privileged Gateway Intents**, enable **Message Content Intent**.
   - *(Recommended)* Turn off **Public Bot** so only your account can invite it to servers.
   - Click **Reset Token** and copy the token.
3. Go to **OAuth2 → URL Generator**:
   - Scope: `bot`
   - Bot Permissions: `View Channels`, `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Read Message History`, `Attach Files`, `Add Reactions`
   - Integration Type: **Guild Install**
4. Open the Generated URL and add the bot to your server.

### 2. Install & configure the bridge
```bash
git clone https://github.com/Alex-Keyes/agy-discord-bridge.git
cd agy-discord-bridge
bun install

# Save your bot token (stored in ~/.agy-discord/.env with chmod 600)
bun run configure <YOUR_BOT_TOKEN>
```

*(Optional)* Install the bundled Antigravity plugin to manage access and setup from inside interactive `agy` sessions:
```bash
agy plugin install ./plugin
```

### 3. Run the bridge
```bash
# Point AGY_CWD at the project you want Antigravity to work in (or omit to use current directory)
AGY_CWD=/path/to/your/project bun run start
```

Or run persistently in `tmux`:
```bash
tmux new -s agy-discord -c /path/to/your/project \
  'AGY_CWD=/path/to/your/project bun run /path/to/agy-discord-bridge/src/bridge.ts'
```

### 4. Pair & lock down
1. DM your bot on Discord — it replies with a 6-character pairing code.
2. Approve it locally:
   ```bash
   bun run access pair <code>
   ```
   The bot sends `"Paired! Say hi to Antigravity."` in Discord.
3. Once everyone who needs access is added, lock down pairing:
   ```bash
   bun run access policy allowlist
   ```
4. Opt in any guild channels you want:
   ```bash
   # Require @mention or reply-to-bot (recommended for channels shared with other bots)
   bun run access group add <CHANNEL_ID> --allow <YOUR_USER_ID>

   # Respond to every message in a dedicated channel
   bun run access group add <CHANNEL_ID> --allow <YOUR_USER_ID> --no-mention

   # Observe all messages and dynamically decide when to chime in, react, or stay silent (NO_REPLY)
   bun run access group add <CHANNEL_ID> --allow <YOUR_USER_ID> --dynamic
   ```

See **[ACCESS.md](./ACCESS.md)** for full access control, mention regexes, and delivery tuning (`ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`).

## Tools Exposed to Antigravity

| Tool | Purpose |
| --- | --- |
| `reply` | Send a message to an allowlisted chat. Supports `reply_to` threading and `files` (up to 10 files, 25MB each). Auto-chunks under 2,000 chars. |
| `react` | Add a Unicode or custom (`<:name:id>`) emoji reaction to a message. |
| `list_emojis` | List available custom server and application emoji in `<:name:id>` form (supports `query`, capped at 200). |
| `edit_message` | Edit a message previously sent by the bot (useful for live progress updates). |
| `fetch_messages` | Fetch recent channel history oldest-first (up to 100 messages) with IDs and `+Natt` attachment markers. |
| `download_attachment` | Download attachments from a message ID into `~/.agy-discord/inbox/` and return local paths. |
| `create_thread` | Start a public thread in an opted-in text/announcement channel and return its `chat_id`. |

## Parity with Claude Code's Official Discord Connector

| Capability | Claude Official Plugin | `agy-discord-bridge` |
| --- | --- | --- |
| All 7 MCP tools (`reply`, `react`, `list_emojis`, `edit_message`, `fetch_messages`, `download_attachment`, `create_thread`) | Yes | Yes |
| DM pairing (1h TTL, 2-reply cap, 3-pending cap, approval DM) | Yes | Yes |
| Guild channels, thread inheritance, `allowFrom`, `--no-mention` | Yes | Yes |
| Mention triggers (`@bot`, reply-to-bot, `mentionPatterns` regexes) | Yes | Yes |
| Delivery config (`ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`) | Yes | Yes |
| `DISCORD_ACCESS_MODE=static` & `DISCORD_STATE_DIR` multi-bot | Yes | Yes |
| Outbound channel gate + state exfiltration guard (`assertSendable`) | Yes | Yes |
| Slash-command skills (`/discord:access`, `/discord:configure`) | Yes | Yes (via `./plugin`) |
| Persistent multi-turn session per channel/thread + `!agy` chat controls | N/A (single CLI session) | Yes |
| Mid-turn interactive permission buttons (`Allow`/`Deny` in DM) | Yes (Claude internal protocol) | No — `agy` headless `stream-json` configures permissions via `AGY_PERMISSION_MODE` + `~/.gemini/antigravity-cli/settings.json` allow/deny rules |

## Multi-bot & Environment Variables

Run multiple independent bots on one machine by pointing `DISCORD_STATE_DIR` at a separate directory per instance:

```bash
DISCORD_STATE_DIR=~/.agy-discord-ops AGY_CWD=/srv/ops bun run start
```

See [.env.example](./.env.example) for all environment options (`AGY_CWD`, `AGY_PERMISSION_MODE`, `AGY_MODEL`, `AGY_EFFORT`, `AGY_IDLE_TIMEOUT_MS`, `DISCORD_ACCESS_MODE`, `DISCORD_AUTO_DOWNLOAD_ATTACHMENTS`, `DISCORD_STATE_DIR`).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
