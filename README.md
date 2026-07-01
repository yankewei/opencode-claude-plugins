# opencode-claude-plugins

[English](README.md) | [简体中文](README.zh-CN.md)

A minimal compatibility plugin that lets you use Claude Code plugins inside [opencode](https://opencode.ai).

This standalone opencode plugin reads Claude Code's installed plugin database at `~/.claude/plugins/installed_plugins.json`. It pulls each plugin's commands, skills, agents, and MCP servers into opencode's runtime config through the `config` hook. It also bridges Claude Code hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `PreCompact`) onto matching opencode events, then runs the original shell commands using Claude Code's stdin JSON protocol.

It does not add multi-agent orchestration, bundled tools, or opinionated defaults. It just makes the plugins work.

## Install

```bash
opencode plugin -g opencode-claude-plugins
```

## How it works

1. **Discovery.** On startup, the `config` hook reads `~/.claude/plugins/installed_plugins.json` (v1/v2/v3 schemas), filters by `enabledPlugins` and project scope, and loads each `.claude-plugin/plugin.json` manifest.
2. **Transform.** Each plugin's `commands/`, `skills/`, `agents/`, and `.mcp.json` are translated into opencode-native shapes:
   - Commands become opencode commands, namespaced `<plugin>:<cmd>`, with the body wrapped in `<command-instruction>` and `<user-request>$ARGUMENTS</user-request>`.
   - Skills become opencode commands (opencode has no skill concept), wrapped in `<skill-instruction>` with a base dir.
   - Agents become opencode subagents (mode forced to `subagent`), with model aliases mapped (`sonnet` to `anthropic/claude-sonnet-4-6`, and so on).
   - MCP becomes opencode mcp config (stdio maps to `local`, http/sse maps to `remote`).
   - It also reads top-level `mcpServers` (user scope) and `projects[cwd].mcpServers` (project scope) from `~/.claude.json`, injects them by bare name, and lets project scope override user scope. Override the path with `CLAUDE_CONFIG_PATH`.
3. **Inject.** It mutates the live config object reference passed to the `config` hook. The change takes effect in the current session; no restart is needed.
4. **Hook bridge.** It keeps `hooks/hooks.json` in memory. On `tool.execute.before`, `tool.execute.after`, `chat.message`, `session.idle`, or `experimental.session.compacting`, it finds the matching CC hook, spawns the shell command, feeds the Claude Code JSON payload on stdin, and interprets the exit code (0 means allow/parse, 1 means ask, 2 means deny/warn).

## Supported

| Claude Code component | Status |
|---|---|
| `commands/*.md` | ✅ → opencode slash commands |
| `skills/<name>/SKILL.md` | ✅ → opencode slash commands |
| `agents/*.md` | ✅ → opencode subagents |
| `.mcp.json` (stdio + http/sse) | ✅ → opencode mcp config |
| `~/.claude.json` `mcpServers` (user + project scope) | ✅ → opencode mcp config |
| `hooks/hooks.json` (PreToolUse, PostToolUse, UserPromptSubmit, Stop, PreCompact) | ✅ → opencode events |
| `lspServers`, `outputStyles`, `monitors/`, `bin/`, in-plugin `settings.json` | ❌ not supported |
| `SessionStart/End`, `SubagentStart/Stop`, `Notification`, `PostToolUseFailure`, `PermissionRequest` hooks | ❌ not wired |

## License

MIT
