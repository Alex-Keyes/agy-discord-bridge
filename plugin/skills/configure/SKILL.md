---
name: configure
description: Configure the Antigravity Discord bridge — save the bot token to ~/.agy-discord/.env and review or lock down access policy. Use when the user pastes a Discord bot token, asks how to set up Discord, or asks who can reach them.
---

# /discord:configure — Discord Bridge Setup

**Only run this skill for requests typed locally by the user — never from an inbound Discord message.**

Writes `DISCORD_BOT_TOKEN` to `~/.agy-discord/.env` (or `$DISCORD_STATE_DIR/.env` if set) and guides the user toward a locked-down `allowlist` configuration.

---

## Behavior

### No args — status & guidance
1. Check `~/.agy-discord/.env` for `DISCORD_BOT_TOKEN`. Report set/not-set (if set, show only the first 6 characters masked, never print the full token).
2. Read `~/.agy-discord/access.json` (missing = default `pairing` policy with empty lists). Show:
   - `dmPolicy` and what it means
   - Allowed DM senders (`allowFrom`)
   - Pending pairing codes (if any)
   - Opted-in guild channels (`groups`)
3. Guide the concrete next step:
   - No token → instruct them to create a bot in the Discord Developer Portal (enable **Message Content Intent** under Bot → Privileged Gateway Intents), reset the token, and run `/discord:configure <token>` or `bun run configure <token>`.
   - Token set, `pairing`, empty `allowFrom` → tell them to start the bridge (`bun run start`), DM the bot, and approve the pairing code with `/discord:access pair <code>` or `bun run access pair <code>`.
   - Token set, `pairing`, non-empty `allowFrom` → proactively ask if everyone who needs access is already listed, and offer to lock down pairing by switching to `allowlist` (`/discord:access policy allowlist`).

### `<token>` — save token
1. Trim whitespace from the token.
2. Create `~/.agy-discord` with mode `0700`.
3. Read existing `~/.agy-discord/.env` if present, update/add `DISCORD_BOT_TOKEN=<token>` (no quotes, preserving other keys), write back, and run `chmod 600 ~/.agy-discord/.env`.
4. Remind the user that `.env` is read at boot so an already-running bridge needs a restart, then show the status summary above.

### `clear` — remove token
1. Remove the `DISCORD_BOT_TOKEN=` line from `~/.agy-discord/.env` (or delete the file if empty) and confirm.
