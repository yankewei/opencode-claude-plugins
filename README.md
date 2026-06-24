# cc-plugins

Use your Claude Code plugins inside [opencode](https://opencode.ai) — a minimal compatibility plugin.

This is a standalone opencode plugin that reads Claude Code's installed plugin database (`~/.claude/plugins/installed_plugins.json`) and injects each plugin's commands, skills, agents, and MCP servers into opencode's runtime config via the `config` hook. It also bridges Claude Code's `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `PreCompact` hooks onto opencode events and executes the original shell commands with the Claude Code stdin JSON protocol.

No multi-agent orchestration, no bundled tools, no opinionated defaults — just plugin compatibility.

## Install

### Local (project)

The plugin file lives at `.opencode/plugins/cc-compat.ts` and imports from `src/`. From this repo's root:

```bash
npm install
```

Then run opencode in this directory — the plugin is auto-loaded from `.opencode/plugins/`.

### Use in another project

Copy the `src/` directory and `.opencode/plugins/cc-compat.ts` into your target project (preserving the relative path), or publish to npm and add the package name to your `opencode.json`:

```jsonc
{ "plugin": ["cc-plugins"] }
```

## How it works

1. **Discovery** — On startup, the `config` hook reads `~/.claude/plugins/installed_plugins.json` (supports v1/v2/v3 schemas), filters by `enabledPlugins` and project scope, loads each `.claude-plugin/plugin.json` manifest.
2. **Transform** — Each plugin's `commands/`, `skills/`, `agents/`, `.mcp.json` are translated to opencode-native shapes:
   - Commands → opencode commands, namespaced `<plugin>:<cmd>`, body wrapped in `<command-instruction>` + `<user-request>$ARGUMENTS</user-request>`
   - Skills → opencode commands (opencode has no skill concept), wrapped in `<skill-instruction>` with base dir
   - Agents → opencode subagents (mode forced to `subagent`), model aliases mapped (`sonnet`→`anthropic/claude-sonnet-4-6`, etc.)
   - MCP → opencode mcp config (stdio→`local`, http/sse→`remote`)
3. **Inject** — Mutates the live config object reference passed to the `config` hook. Takes effect in the current session, no restart.
4. **Hook bridge** — Stores `hooks/hooks.json` in memory. On `tool.execute.before`/`tool.execute.after`/`chat.message`/`session.idle`/`experimental.session.compacting`, finds matching CC hooks, spawns the shell command, feeds the Claude Code JSON payload on stdin, interprets exit codes (0=allow/parse, 1=ask, 2=deny/warn).

## Supported

| Claude Code component | Status |
|---|---|
| `commands/*.md` | ✅ → opencode slash commands |
| `skills/<name>/SKILL.md` | ✅ → opencode slash commands |
| `agents/*.md` | ✅ → opencode subagents |
| `.mcp.json` (stdio + http/sse) | ✅ → opencode mcp config |
| `hooks/hooks.json` (PreToolUse, PostToolUse, UserPromptSubmit, Stop, PreCompact) | ✅ → opencode events |
| `lspServers`, `outputStyles`, `monitors/`, `bin/`, in-plugin `settings.json` | ❌ not supported |
| `SessionStart/End`, `SubagentStart/Stop`, `Notification`, `PostToolUseFailure`, `PermissionRequest` hooks | ❌ not wired |

## Prerequisites

Install plugins with Claude Code first (`/plugin install <name>`). This plugin only reads the resulting database — it does not install or fetch plugins from marketplaces.

## Config

Environment variables:
- `CLAUDE_PLUGINS_HOME` — override `~/.claude/plugins` (useful for testing)

## License

MIT
