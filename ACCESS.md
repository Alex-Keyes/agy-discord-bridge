# Discord — Access & Delivery

Discord only allows DMs between accounts that share a server. Who can DM your bot depends on where it's installed: one private server means only that server's members can reach it; a public community means every member there can open a DM.

The **Public Bot** toggle in the Discord Developer Portal (**Bot** tab, on by default) controls who can add the bot to new servers. Turn it off so only your own account can install it.

For DMs that do reach the bot, the default policy is **`pairing`**. An unknown sender gets a 6-character code in reply and their message is dropped (at most twice — initial code + one reminder — and capped at 3 concurrent pending codes, expiring after 1 hour). Approve with `bun run access pair <code>` (or `/discord:access pair <code>` if you installed the Antigravity plugin). Once approved, the bot confirms in their DM and forwards future messages.

All state lives in `~/.agy-discord/access.json` (overridable via `DISCORD_STATE_DIR`). The bridge re-reads `access.json` on every inbound message, so changes take effect without a restart. Set `DISCORD_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is automatically downgraded to `allowlist` in static mode).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | User snowflake (numeric, e.g. `184695080709324800`) |
| Group key | Channel snowflake — not guild ID |
| Config file | `~/.agy-discord/access.json` |

## DM policies

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `bun run access pair <code>`. |
| `allowlist` | Drop unknown DMs silently (no reply). Recommended once everyone who needs access is added. |
| `disabled` | Drop everything, including allowlisted DMs and guild channels. |

```bash
bun run access policy allowlist
```

## User IDs (snowflakes)

Enable **User Settings → Advanced → Developer Mode** in Discord, then right-click any user and choose **Copy User ID**.

```bash
bun run access allow 184695080709324800
bun run access remove 184695080709324800
```

## Guild channels

Guild channels are off by default. Opt each one in by its **channel** snowflake (not the guild ID). Threads automatically inherit their parent channel's access policy while keeping their own Antigravity conversation.

```bash
# Respond only when @mentioned, replied to, or matching mentionPatterns
bun run access group add 846209781206941736

# Respond to every message in a dedicated channel (no @mention needed)
bun run access group add 846209781206941736 --no-mention

# Observe all messages and dynamically decide whether to chime in, react, or stay silent
bun run access group add 846209781206941736 --dynamic

# Restrict which users can trigger the bot in a channel
bun run access group add 846209781206941736 --allow 184695080709324800,221773638772129792

# Remove a channel
bun run access group rm 846209781206941736
```

### Dynamic / selective response mode (`--dynamic`)

Adding a channel with `--dynamic` sets `"requireMention": false` and `"responseMode": "dynamic"`. In dynamic mode:

- Every message from allowed users is forwarded to Antigravity with `mode="dynamic"` and `mentioned="true|false"` attributes.
- For unmentioned messages (`mentioned="false"`), the bridge skips `ackReaction` and the automatic typing indicator so casual conversation isn't interrupted.
- Antigravity decides whether to reply, react, or stay quiet by outputting `NO_REPLY` (which suppresses any fallback reply).
- Direct `@mentions`, replies to the bot, and `mentionPatterns` matches still arrive with `mentioned="true"` and behave like normal direct prompts.

## Mention detection

In channels with `requireMention: true`, any of the following triggers the bot:

1. A structured `@botname` mention
2. A reply to one of the bot's messages
3. A case-insensitive match against any regex in `mentionPatterns`

```bash
bun run access set mentionPatterns '["^hey agy\\b", "\\bantigravity\\b"]'
```

## Delivery settings

Configure outbound behavior live with `bun run access set <key> <value>`:

- **`ackReaction`**: Reacts to inbound messages on receipt. Unicode emoji work directly; custom server emoji use `<:name:id>`. Set `""` to disable.
- **`replyToMode`**: Controls threading on chunked replies — `first` (default, threads first chunk), `all` (threads every chunk), or `off` (standalone messages).
- **`textChunkLimit`**: Max characters per message (1–2000; Discord's hard cap is 2000).
- **`chunkMode`**: `newline` (default, prefers paragraph/line boundaries and preserves fenced code blocks) or `length` (hard split at limit).

```bash
bun run access set ackReaction 👀
bun run access set ackReaction ""
bun run access set replyToMode first
bun run access set textChunkLimit 1950
bun run access set chunkMode newline
```

## CLI reference

| Command | Effect |
| --- | --- |
| `bun run access` | Print current state: policy, allowlist, pending pairings, enabled channels, delivery settings. |
| `bun run access pair a4f91c` | Approve pairing code `a4f91c`. Adds sender to `allowFrom` and queues confirmation DM. |
| `bun run access deny a4f91c` | Discard a pending code silently. |
| `bun run access allow <userId>` | Add a user snowflake directly. |
| `bun run access remove <userId>` | Remove a user snowflake from `allowFrom`. |
| `bun run access policy <mode>` | Set `dmPolicy`: `pairing`, `allowlist`, or `disabled`. |
| `bun run access group add <channelId>` | Opt in a guild channel. Flags: `--no-mention`, `--dynamic`, `--always`, `--allow id1,id2`. |
| `bun run access group rm <channelId>` | Disable a guild channel. |
| `bun run access set <key> <value>` | Set `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, or `mentionPatterns`. |
| `bun run configure [<token>\|clear]` | Show token/access status, save `DISCORD_BOT_TOKEN` (`chmod 600`), or clear it. |

## Config file (`~/.agy-discord/access.json`)

```jsonc
{
  "dmPolicy": "pairing",
  "allowFrom": ["184695080709324800"],
  "groups": {
    "846209781206941736": {
      "requireMention": true,
      "allowFrom": []
    }
  },
  "mentionPatterns": ["^hey agy\\b"],
  "ackReaction": "👀",
  "replyToMode": "first",
  "textChunkLimit": 2000,
  "chunkMode": "newline"
}
```
