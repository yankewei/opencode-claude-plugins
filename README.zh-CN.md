# opencode-claude-plugins

[English](README.md) | [简体中文](README.zh-CN.md)

一个最小化的兼容性插件，让你在 [opencode](https://opencode.ai) 里使用 Claude Code 插件。

这个独立的 opencode 插件会读取 Claude Code 的已安装插件数据库 `~/.claude/plugins/installed_plugins.json`，把每个插件的 commands、skills、agents 和 MCP servers 通过 `config` hook 注入到 opencode 的运行时配置里。它还会把 Claude Code 的 `PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`Stop`、`PreCompact` 这些 hooks 桥接到对应的 opencode 事件上，并用 Claude Code 的 stdin JSON 协议执行原始 shell 命令。

它不引入多智能体编排、不捆绑工具、也不强加默认行为。它只是让插件能跑起来。

## 安装

```bash
opencode plugin -g opencode-claude-plugins
```

## 工作原理

1. **发现**。启动时，`config` hook 读取 `~/.claude/plugins/installed_plugins.json`（支持 v1、v2、v3 格式），按 `enabledPlugins` 和项目作用域过滤，然后加载每个插件的 `.claude-plugin/plugin.json` 清单。
2. **转换**。每个插件的 `commands/`、`skills/`、`agents/` 和 `.mcp.json` 会被转成 opencode 原生的结构：
   - Commands 变成 opencode 命令，命名空间为 `<plugin>:<cmd>`，命令体包在 `<command-instruction>` 和 `<user-request>$ARGUMENTS</user-request>` 里。
   - Skills 变成 opencode 命令（opencode 没有 skill 概念），包在 `<skill-instruction>` 里并带上基础目录。
   - Agents 变成 opencode subagents（模式强制为 `subagent`），模型别名会做映射（例如 `sonnet` 映射为 `anthropic/claude-sonnet-4-6`）。
   - MCP 转成 opencode 的 mcp 配置（stdio 映射为 `local`，http / sse 映射为 `remote`）。
   - 同时读取 `~/.claude.json` 的顶层 `mcpServers`（用户级）和 `projects[cwd].mcpServers`（项目级），按裸名注入；项目级覆盖用户级。路径可用 `CLAUDE_CONFIG_PATH` 环境变量覆盖。
3. **注入**。直接修改传给 `config` hook 的运行时配置对象引用。改动在当前会话立即生效，不需要重启。
4. **Hook 桥接**。把 `hooks/hooks.json` 保留在内存中。在 `tool.execute.before`、`tool.execute.after`、`chat.message`、`session.idle` 或 `experimental.session.compacting` 触发时，找到对应的 CC hook，启动 shell 命令，把 Claude Code 的 JSON payload 喂到 stdin，然后解析退出码（0 表示允许/解析，1 表示询问，2 表示拒绝/警告）。

## 支持情况

| Claude Code 组件 | 状态 |
|---|---|
| `commands/*.md` | ✅ → opencode slash 命令 |
| `skills/<name>/SKILL.md` | ✅ → opencode slash 命令 |
| `agents/*.md` | ✅ → opencode subagents |
| `.mcp.json`（stdio + http/sse） | ✅ → opencode mcp 配置 |
| `~/.claude.json` 的 `mcpServers`（用户级 + 项目级） | ✅ → opencode mcp 配置 |
| `hooks/hooks.json`（PreToolUse、PostToolUse、UserPromptSubmit、Stop、PreCompact） | ✅ → opencode 事件 |
| `lspServers`、`outputStyles`、`monitors/`、`bin/`、插件内的 `settings.json` | ❌ 不支持 |
| `SessionStart/End`、`SubagentStart/Stop`、`Notification`、`PostToolUseFailure`、`PermissionRequest` hooks | ❌ 未接入 |

## 许可证

MIT
