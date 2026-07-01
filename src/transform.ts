import path from "node:path"
import os from "node:os"
import { readFile, readdir, stat } from "node:fs/promises"
import type {
  LoadedPlugin,
  PluginComponents,
  OpenCodeCommand,
  OpenCodeAgent,
  OpenCodeMcp,
  CommandFrontmatter,
  AgentFrontmatter,
  ClaudeCodeMcpConfig,
  ClaudeCodeMcpServer,
  ClaudeJson,
  HooksConfig,
  HookEntry,
} from "./types.js"

const ANTHROPIC_PREFIX = "anthropic/"
const MODEL_ALIAS = new Map<string, string>([
  ["sonnet", `${ANTHROPIC_PREFIX}claude-sonnet-4-6`],
  ["opus", `${ANTHROPIC_PREFIX}claude-opus-4-7`],
  ["haiku", `${ANTHROPIC_PREFIX}claude-haiku-4-5`],
])

export async function loadComponents(
  plugins: LoadedPlugin[],
  opts: { cwd?: string; claudeConfigPath?: string } = {},
): Promise<PluginComponents> {
  const out: PluginComponents = { commands: {}, agents: {}, mcpServers: {}, hooksConfigs: [], skillPaths: [] }
  await Promise.all(plugins.map((p) => loadOne(p, out)))
  await loadClaudeJsonMcp(out, opts.cwd ?? process.cwd(), opts.claudeConfigPath)
  return out
}

async function loadOne(plugin: LoadedPlugin, out: PluginComponents): Promise<void> {
  await Promise.all([
    loadCommands(plugin, out),
    loadSkills(plugin, out),
    loadAgents(plugin, out),
    loadMcp(plugin, out),
    loadHooks(plugin, out),
  ])
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function loadCommands(plugin: LoadedPlugin, out: PluginComponents): Promise<void> {
  const dir = path.join(plugin.installPath, "commands")
  if (!(await exists(dir))) return
  const files = await readdir(dir).catch(() => [])
  for (const f of files) {
    if (!f.endsWith(".md")) continue
    const full = path.join(dir, f)
    const raw = await readFile(full, "utf8").catch(() => "")
    if (!raw) continue
    const { data, body } = parseFrontmatter<CommandFrontmatter>(raw)
    const name = f.replace(/\.md$/, "")
    const ns = `${plugin.manifest.name}:${name}`
    const resolved = resolvePluginPaths(body.trim(), plugin.installPath)
    out.commands[ns] = {
      template: `<command-instruction>\n${resolved}\n</command-instruction>\n\n<user-request>\n$ARGUMENTS\n</user-request>`,
      description: `(plugin: ${plugin.manifest.name}) ${data.description ?? ""}`.trim(),
      ...(data.agent ? { agent: data.agent } : {}),
      ...(mapModel(data.model) ? { model: mapModel(data.model)! } : {}),
      ...(typeof data.subtask === "boolean" ? { subtask: data.subtask } : {}),
    }
  }
}

// ── Skills (exposed as opencode skill paths) ──────────────────────────────────

async function loadSkills(plugin: LoadedPlugin, out: PluginComponents): Promise<void> {
  const skillsDir = path.join(plugin.installPath, "skills")
  if (await exists(skillsDir)) {
    const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const skillDir = path.join(skillsDir, e.name)
      if (await exists(path.join(skillDir, "SKILL.md"))) {
        out.skillPaths.push(skillDir)
      }
    }
  }
  // Fallback: single skill at plugin root (e.g. tw93/kami)
  const rootSkill = path.join(plugin.installPath, "SKILL.md")
  if (await exists(rootSkill)) {
    out.skillPaths.push(plugin.installPath)
  }
}

// ── Agents ────────────────────────────────────────────────────────────────────

async function loadAgents(plugin: LoadedPlugin, out: PluginComponents): Promise<void> {
  const dir = path.join(plugin.installPath, "agents")
  if (!(await exists(dir))) return
  const files = await readdir(dir).catch(() => [])
  for (const f of files) {
    if (!f.endsWith(".md")) continue
    const full = path.join(dir, f)
    const raw = await readFile(full, "utf8").catch(() => "")
    if (!raw) continue
    const { data, body } = parseFrontmatter<AgentFrontmatter>(raw)
    const name = f.replace(/\.md$/, "")
    const ns = `${plugin.manifest.name}:${name}`
    const agent: OpenCodeAgent = {
      mode: "subagent",
      description: `(plugin: ${plugin.manifest.name}) ${data.description ?? ""}`.trim(),
      prompt: resolvePluginPaths(body.trim(), plugin.installPath),
    }
    const model = mapModel(data.model)
    if (model) agent.model = model
    const tools = parseTools(data.tools)
    if (tools) agent.tools = tools
    out.agents[ns] = agent
  }
}

// ── MCP ───────────────────────────────────────────────────────────────────────

async function loadMcp(plugin: LoadedPlugin, out: PluginComponents): Promise<void> {
  const file = path.join(plugin.installPath, ".mcp.json")
  const raw = await readFile(file, "utf8").catch(() => "")
  if (!raw) return
  let cfg: ClaudeCodeMcpConfig
  try {
    cfg = JSON.parse(raw)
  } catch {
    return
  }
  // Claude Code accepts two shapes: { mcpServers: {...} } or a bare {...} at top level.
  const servers = cfg.mcpServers ?? (isMcpServerMap(cfg) ? cfg : {})
  for (const [name, server] of Object.entries(servers)) {
    if (server.disabled) continue
    const ns = `${plugin.manifest.name}:${name}`
    const transformed = transformMcp(server)
    if (transformed) out.mcpServers[ns] = transformed
  }
}

function isMcpServerMap(cfg: unknown): cfg is Record<string, ClaudeCodeMcpServer> {
  if (typeof cfg !== "object" || cfg === null) return false
  const c = cfg as Record<string, unknown>
  if ("mcpServers" in c) return false
  for (const v of Object.values(c)) {
    if (typeof v !== "object" || v === null) return false
    const sv = v as Record<string, unknown>
    return typeof sv.command === "string" || typeof sv.url === "string"
  }
  return true
}

function transformMcp(server: ClaudeCodeMcpServer): OpenCodeMcp | undefined {
  const type = server.type ?? "stdio"
  if (type === "http" || type === "sse") {
    if (!server.url) return undefined
    const out: OpenCodeMcp = { type: "remote", url: server.url, enabled: true }
    if (server.headers && Object.keys(server.headers).length) out.headers = server.headers
    if (server.oauth) out.oauth = { clientId: server.oauth.clientId, scope: server.oauth.scopes?.join(" ") }
    return out
  }
  if (!server.command) return undefined
  const out: OpenCodeMcp = {
    type: "local",
    command: [server.command, ...(server.args ?? [])],
    enabled: true,
  }
  if (server.env && Object.keys(server.env).length) out.environment = server.env
  return out
}

// ── ~/.claude.json MCP (user + project scope) ────────────────────────────────

async function loadClaudeJsonMcp(
  out: PluginComponents,
  cwd: string,
  claudeConfigPath?: string,
): Promise<void> {
  const file = claudeConfigPath ?? process.env.CLAUDE_CONFIG_PATH ?? path.join(os.homedir(), ".claude.json")
  const raw = await readFile(file, "utf8").catch(() => "")
  if (!raw) return
  let cfg: ClaudeJson
  try {
    cfg = JSON.parse(raw)
  } catch {
    return
  }
  const cwdResolved = path.resolve(cwd)
  // User-scope servers first, then project-scope overrides by bare name.
  for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
    addClaudeJsonServer(out, name, server)
  }
  const projectServers = cfg.projects?.[cwdResolved]?.mcpServers
  if (projectServers) {
    for (const [name, server] of Object.entries(projectServers)) {
      addClaudeJsonServer(out, name, server, true)
    }
  }
}

function addClaudeJsonServer(
  out: PluginComponents,
  name: string,
  server: ClaudeCodeMcpServer,
  overrideExisting = false,
): void {
  if (overrideExisting) delete out.mcpServers[name]
  if (server.disabled) return
  const transformed = transformMcp(server)
  if (transformed) out.mcpServers[name] = transformed
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

async function loadHooks(plugin: LoadedPlugin, out: PluginComponents): Promise<void> {
  const file = path.join(plugin.installPath, "hooks/hooks.json")
  const raw = await readFile(file, "utf8").catch(() => "")
  if (!raw) return
  let cfg: HooksConfig
  try {
    cfg = JSON.parse(raw)
  } catch {
    return
  }
  stampPluginRoot(cfg, plugin.installPath)
  out.hooksConfigs.push({ config: cfg, pluginRoot: plugin.installPath })
}

function stampPluginRoot(cfg: HooksConfig, root: string): void {
  for (const matchers of Object.values(cfg.hooks ?? {})) {
    for (const m of matchers ?? []) {
      for (const h of m.hooks) {
        if (h.type === "command" || h.type === "http") h.pluginRoot = root
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapModel(model?: string): string | undefined {
  if (!model) return undefined
  if (model === "inherit") return undefined
  const lower = model.toLowerCase()
  if (MODEL_ALIAS.has(lower)) return MODEL_ALIAS.get(lower)
  if (model.includes("/")) return model
  if (model.startsWith("claude-")) return `${ANTHROPIC_PREFIX}${model}`
  return undefined
}

function parseTools(tools?: string): Record<string, boolean> | undefined {
  if (!tools) return undefined
  const out: Record<string, boolean> = {}
  for (let part of tools.split(",")) {
    part = part.trim()
    if (!part) continue
    if (part.startsWith("-")) out[part.slice(1)] = false
    else out[part] = true
  }
  return Object.keys(out).length ? out : undefined
}

function resolvePluginPaths(text: string, root: string): string {
  return text
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root)
    .replace(/\$CLAUDE_PLUGIN_ROOT/g, root)
    .replace(/^~(?=[/\\])/gm, os.homedir())
}

function parseFrontmatter<T>(raw: string): { data: T; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {} as T, body: raw }
  const data = parseYaml(match[1]) as T
  return { data, body: match[2] }
}

function parseYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\S[^:]*):\s*(.*)$/)
    if (!m) continue
    const key = m[1].trim()
    let val: unknown = m[2].trim()
    if (val === "true") val = true
    else if (val === "false") val = false
    else if (val === "") val = undefined
    out[key] = val
  }
  return out
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
