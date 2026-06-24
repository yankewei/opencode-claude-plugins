import { spawn } from "node:child_process"
import path from "node:path"
import os from "node:os"
import type { HooksConfig, HookMatcher, HookEntry, ClaudeHookEvent } from "./types.js"

const HOOK_TIMEOUT_MS = 30_000
const GRACE_MS = 5_000

export interface HookState {
  configs: Array<{ config: HooksConfig; pluginRoot: string }>
}

export function createHookState(): HookState {
  return { configs: [] }
}

export function setHookConfigs(state: HookState, configs: HookState["configs"]): void {
  state.configs = configs
}

// ── Find matching hooks for an event + tool name ──────────────────────────────

function findMatching(event: ClaudeHookEvent, toolName: string, state: HookState): Array<{ entry: HookEntry; pluginRoot?: string }> {
  const out: Array<{ entry: HookEntry; pluginRoot?: string }> = []
  for (const { config, pluginRoot } of state.configs) {
    const matchers = config.hooks?.[event] ?? []
    for (const m of matchers) {
      if (m.matcher && !matchesTool(m.matcher, toolName)) continue
      for (const h of m.hooks) {
        if (h.type !== "command" && h.type !== "http") continue
        out.push({ entry: h, pluginRoot })
      }
    }
  }
  return out
}

function matchesTool(matcher: string, toolName: string): boolean {
  if (!matcher) return true
  const lower = toolName.toLowerCase()
  for (let piece of matcher.split("|")) {
    piece = piece.trim()
    if (!piece) continue
    if (piece === lower) return true
    if (piece.includes("*")) {
      const re = new RegExp("^" + piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$", "i")
      if (re.test(lower)) return true
    }
  }
  return false
}

// ── Build stdin payload (Claude Code snake_case JSON) ─────────────────────────

function buildPayload(event: ClaudeHookEvent, fields: Record<string, unknown>): string {
  return JSON.stringify({
    ...fields,
    hook_event_name: event,
    cwd: process.cwd(),
    session_id: fields.session_id ?? "",
    permission_mode: "bypassPermissions",
    hook_source: "opencode-plugin",
  })
}

// ── Execute a single hook entry ───────────────────────────────────────────────

interface HookResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function executeCommand(command: string, stdin: string, pluginRoot?: string): Promise<HookResult> {
  const cwd = process.cwd()
  const cmd = command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot ?? "")
    .replace(/\$CLAUDE_PLUGIN_ROOT/g, pluginRoot ?? "")
    .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, cwd)
    .replace(/\$CLAUDE_PROJECT_DIR/g, cwd)
    .replace(/^~(?=[/\\])/g, os.homedir())

  const env: Record<string, string> = { ...process.env as Record<string, string> }
  env.CLAUDE_PROJECT_DIR = cwd
  if (pluginRoot) env.CLAUDE_PLUGIN_ROOT = pluginRoot

  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      detached: !process.platform.startsWith("win"),
      env,
    })

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => { stdout += d.toString() })
    child.stderr.on("data", (d) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      try { if (child.pid) process.kill(-child.pid, "SIGTERM") } catch {}
      setTimeout(() => {
        try { if (child.pid) process.kill(-child.pid, "SIGKILL") } catch {}
      }, GRACE_MS)
    }, HOOK_TIMEOUT_MS)

    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() })
    })
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ exitCode: 1, stdout: "", stderr: "spawn failed" })
    })

    child.stdin.write(stdin)
    child.stdin.end()
  })
}

// ── Dispatch + interpret exit codes (Claude Code semantics) ───────────────────

export interface PreToolUseResult {
  decision: "allow" | "deny" | "ask"
  reason?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string
}

export async function dispatchPreToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  state: HookState,
  sessionId: string,
): Promise<PreToolUseResult> {
  const hooks = findMatching("PreToolUse", toolName, state)
  if (hooks.length === 0) return { decision: "allow" }

  let result: PreToolUseResult = { decision: "allow" }
  let currentInput = toSnakeCase(toolInput)

  for (const { entry, pluginRoot } of hooks) {
    if (entry.type !== "command") continue
    const payload = buildPayload("PreToolUse", {
      session_id: sessionId,
      tool_name: toolName,
      tool_input: currentInput,
    })
    const r = await executeCommand(entry.command!, payload, pluginRoot ?? entry.pluginRoot)

    if (r.exitCode === 2) {
      return { decision: "deny", reason: r.stderr || r.stdout || "Hook blocked the operation" }
    }
    if (r.exitCode === 1) {
      result = { decision: "ask", reason: r.stderr || r.stdout }
      continue
    }
    if (r.exitCode === 0 && r.stdout) {
      try {
        const parsed = JSON.parse(r.stdout)
        const spec = parsed.hookSpecificOutput
        if (spec?.permissionDecision === "deny") return { decision: "deny", reason: spec.permissionDecisionReason }
        if (spec?.permissionDecision === "ask") { result = { decision: "ask", reason: spec.permissionDecisionReason }; continue }
        if (spec?.updatedInput) {
          Object.assign(currentInput, toSnakeCase(spec.updatedInput))
          result.updatedInput = fromSnakeCase(currentInput)
        }
        if (parsed.decision === "block" || parsed.decision === "deny") return { decision: "deny", reason: parsed.reason }
        if (parsed.decision === "ask") { result = { decision: "ask", reason: parsed.reason }; continue }
        if (parsed.systemMessage) result.additionalContext = parsed.systemMessage
      } catch {
        // non-JSON stdout on exit 0: treat as message
      }
    }
  }
  return result
}

export interface PostToolUseResult {
  blocked: boolean
  reason?: string
  additionalContext?: string
  warnings: string[]
}

export async function dispatchPostToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: { title?: string; output?: string },
  state: HookState,
  sessionId: string,
): Promise<PostToolUseResult> {
  const hooks = findMatching("PostToolUse", toolName, state)
  if (hooks.length === 0) return { blocked: false, warnings: [] }

  const out: PostToolUseResult = { blocked: false, warnings: [] }
  for (const { entry, pluginRoot } of hooks) {
    if (entry.type !== "command") continue
    const payload = buildPayload("PostToolUse", {
      session_id: sessionId,
      tool_name: toolName,
      tool_input: toSnakeCase(toolInput),
      tool_response: toSnakeCase(toolResponse),
    })
    const r = await executeCommand(entry.command!, payload, pluginRoot ?? entry.pluginRoot)

    if (r.exitCode === 2) {
      out.warnings.push(r.stderr || r.stdout)
      continue
    }
    if (r.exitCode === 0 && r.stdout) {
      try {
        const parsed = JSON.parse(r.stdout)
        if (parsed.decision === "block") {
          out.blocked = true
          out.reason = parsed.reason ?? r.stderr
        }
        if (parsed.hookSpecificOutput?.additionalContext) {
          out.additionalContext = (out.additionalContext ?? "") + parsed.hookSpecificOutput.additionalContext
        }
        if (parsed.systemMessage) out.additionalContext = (out.additionalContext ?? "") + parsed.systemMessage
      } catch {
        // non-JSON stdout: append as message
        out.additionalContext = (out.additionalContext ?? "") + r.stdout
      }
    }
  }
  return out
}

export async function dispatchSimpleEvent(
  event: ClaudeHookEvent,
  fields: Record<string, unknown>,
  state: HookState,
): Promise<PostToolUseResult> {
  const hooks = findMatching(event, "", state)
  if (hooks.length === 0) return { blocked: false, warnings: [] }

  const out: PostToolUseResult = { blocked: false, warnings: [] }
  for (const { entry, pluginRoot } of hooks) {
    if (entry.type !== "command") continue
    const payload = buildPayload(event, fields)
    const r = await executeCommand(entry.command!, payload, pluginRoot ?? entry.pluginRoot)
    if (r.exitCode === 2) out.warnings.push(r.stderr || r.stdout)
    if (r.exitCode === 0 && r.stdout) {
      try {
        const parsed = JSON.parse(r.stdout)
        if (parsed.decision === "block") { out.blocked = true; out.reason = parsed.reason }
        if (parsed.systemMessage) out.additionalContext = (out.additionalContext ?? "") + parsed.systemMessage
      } catch {
        out.additionalContext = (out.additionalContext ?? "") + r.stdout
      }
    }
  }
  return out
}

// ── snake_case helpers (Claude Code convention) ───────────────────────────────

function toSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/([A-Z])/g, "_$1").toLowerCase()] = v
  }
  return out
}

function fromSnakeCase(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v
  }
  return out
}
