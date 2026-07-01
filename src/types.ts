// CC plugin manifest + installed_plugins.json + opencode config shapes

// ── opencode config shapes (subset we inject via `config` hook) ──────────────

export interface OpenCodeCommand {
  template: string
  description?: string
  agent?: string
  model?: string
  variant?: string
  subtask?: boolean
}

export interface OpenCodeAgent {
  mode?: "subagent" | "primary" | "all"
  model?: string
  prompt?: string
  description?: string
  tools?: Record<string, boolean>
  permission?: Record<string, string | Record<string, string>>
  temperature?: number
  top_p?: number
  disable?: boolean
  hidden?: boolean
  color?: string
  steps?: number
}

export interface OpenCodeMcpLocal {
  type: "local"
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export interface OpenCodeMcpRemote {
  type: "remote"
  url: string
  enabled?: boolean
  headers?: Record<string, string>
  oauth?: { clientId?: string; clientSecret?: string; scope?: string } | false
  timeout?: number
}

export type OpenCodeMcp = OpenCodeMcpLocal | OpenCodeMcpRemote

export interface OpenCodeConfig {
  command?: Record<string, OpenCodeCommand>
  agent?: Record<string, OpenCodeAgent>
  mcp?: Record<string, OpenCodeMcp>
  skills?: {
    paths?: string[]
    urls?: string[]
  }
  [key: string]: unknown
}

// ── Claude Code plugin manifest ───────────────────────────────────────────────

export interface PluginManifest {
  name: string
  version?: string
  description?: string
  author?: { name?: string; email?: string; url?: string }
  homepage?: string
  repository?: string
  license?: string
  keywords?: string[]
  commands?: string | string[]
  agents?: string | string[]
  skills?: string | string[]
  hooks?: string
  mcpServers?: string
}

// ── installed_plugins.json (3 schema versions) ────────────────────────────────

export type PluginScope = "user" | "project" | "local" | "managed"

export interface PluginInstallation {
  scope: PluginScope
  installPath: string
  version: string
  installedAt?: string
  lastUpdated?: string
  gitCommitSha?: string
  isLocal?: boolean
  projectPath?: string
}

export interface InstalledPluginsV1 {
  version: 1
  plugins: Record<string, PluginInstallation>
}

export interface InstalledPluginsV2 {
  version: 2
  plugins: Record<string, PluginInstallation[]>
}

export interface InstalledPluginEntryV3 {
  name: string
  marketplace: string
  scope: PluginScope
  version: string
  installPath: string
  lastUpdated: string
  gitCommitSha?: string
  projectPath?: string
}

export type InstalledPluginsDatabase =
  | InstalledPluginsV1
  | InstalledPluginsV2
  | InstalledPluginEntryV3[]

// ── CC component shapes ───────────────────────────────────────────────────────

export interface CommandFrontmatter {
  description?: string
  "argument-hint"?: string
  agent?: string
  model?: string
  subtask?: boolean
}

export interface AgentFrontmatter {
  name?: string
  description?: string
  model?: string
  tools?: string
  mode?: "subagent" | "primary" | "all"
}

export interface ClaudeCodeMcpServer {
  type?: "http" | "sse" | "stdio"
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  oauth?: { clientId?: string; scopes?: string[] }
  scope?: "user" | "project" | "local"
  projectPath?: string
  disabled?: boolean
}

export interface ClaudeCodeMcpConfig {
  mcpServers?: Record<string, ClaudeCodeMcpServer>
}

// ── ~/.claude.json (user + project MCP) ───────────────────────────────────────

export interface ClaudeJson {
  mcpServers?: Record<string, ClaudeCodeMcpServer>
  projects?: Record<string, { mcpServers?: Record<string, ClaudeCodeMcpServer> }>
}

// ── CC hooks ──────────────────────────────────────────────────────────────────

export type ClaudeHookEvent =
  | "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "PreCompact"
  | "Notification" | "SessionStart" | "SessionEnd"
  | "SubagentStart" | "SubagentStop" | "PostToolUseFailure" | "PermissionRequest"

export type HookEntry =
  | { type: "command"; command?: string; allowedEnvVars?: string[]; pluginRoot?: string }
  | { type: "prompt"; prompt?: string }
  | { type: "agent"; agent?: string }
  | { type: "http"; url: string; headers?: Record<string, string>; allowedEnvVars?: string[]; timeout?: number; pluginRoot?: string }

export interface HookMatcher {
  matcher?: string
  hooks: HookEntry[]
}

export interface HooksConfig {
  hooks?: Partial<Record<ClaudeHookEvent, HookMatcher[]>>
}

// ── Loaded plugin (discovered + probed) ───────────────────────────────────────

export interface LoadedPlugin {
  key: string
  manifest: PluginManifest
  installPath: string
  enabled: boolean
}

export interface PluginComponents {
  commands: Record<string, OpenCodeCommand>
  agents: Record<string, OpenCodeAgent>
  mcpServers: Record<string, OpenCodeMcp>
  hooksConfigs: Array<{ config: HooksConfig; pluginRoot: string }>
  skillPaths: string[]
}
