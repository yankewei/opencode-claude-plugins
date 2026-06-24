import type { Plugin, Config } from "@opencode-ai/plugin"
import { discoverPlugins, loadComponents, createHookState, setHookConfigs, dispatchPreToolUse, dispatchPostToolUse, dispatchSimpleEvent } from "../../src/index.js"
import type { HookState, OpenCodeMcp } from "../../src/index.js"

const hookState: HookState = createHookState()
let loaded = false

const DEBUG = process.env.CC_COMPAT_DEBUG === "1" || process.env.CC_COMPAT_DEBUG === "true"
const log = (...args: unknown[]): void => { if (DEBUG) console.error("[cc-compat]", ...args) }

export const CcCompat: Plugin = async ({ client }) => {
  return {
    config: async (config: Config) => {
      if (loaded) return
      loaded = true
      try {
        const plugins = await discoverPlugins({})
        log(`discovered ${plugins.length} plugin(s):`, plugins.map((p) => p.key).join(", ") || "(none)")
        if (plugins.length === 0) return
        const components = await loadComponents(plugins)
        log(`loaded: ${Object.keys(components.commands).length} commands, ${Object.keys(components.agents).length} agents, ${Object.keys(components.mcpServers).length} mcp, ${components.hooksConfigs.length} hooks`)
        config.command = { ...config.command, ...components.commands } as Config["command"]
        config.agent = { ...config.agent, ...components.agents } as Config["agent"]
        config.mcp = { ...config.mcp, ...components.mcpServers } as Config["mcp"]
        // The plugin API's Config type currently omits `skills`, but opencode's runtime
        // config accepts skill paths. We cast to inject them alongside commands.
        ;(config as unknown as { skills?: { paths?: string[]; urls?: string[] } }).skills = {
          paths: [...((config as unknown as { skills?: { paths?: string[] } }).skills?.paths ?? []), ...components.skillPaths],
          urls: (config as unknown as { skills?: { urls?: string[] } }).skills?.urls ?? [],
        }
        setHookConfigs(hookState, components.hooksConfigs)

        // Start MCP servers in the background so a slow `npx` download or a
        // hanging server cannot block opencode's startup.
        for (const [name, cfg] of Object.entries(components.mcpServers)) {
          client.mcp.add({ body: { name, config: cfg as OpenCodeMcp } })
            .then((res) => {
              log(`mcp.add(${name}) →`, res.error ? `error: ${JSON.stringify(res.error).slice(0, 200)}` : `ok: ${JSON.stringify(res.data).slice(0, 200)}`)
            })
            .catch((err) => {
              console.error(`[cc-compat] mcp.add(${name}) failed:`, err)
            })
        }
      } catch (err) {
        console.error("[cc-compat] failed to load Claude Code plugins:", err)
      }
    },

    "tool.execute.before": async (input, output) => {
      if (hookState.configs.length === 0) return
      const result = await dispatchPreToolUse(
        input.tool,
        output.args ?? {},
        hookState,
        input.sessionID,
      )
      if (result.decision === "deny") {
        throw new Error(result.reason ?? "blocked by Claude Code PreToolUse hook")
      }
      if (result.updatedInput) {
        Object.assign(output.args, result.updatedInput)
      }
    },

    "tool.execute.after": async (input, output) => {
      if (hookState.configs.length === 0) return
      const result = await dispatchPostToolUse(
        input.tool,
        input.args ?? {},
        { title: output.title, output: output.output },
        hookState,
        input.sessionID,
      )
      if (result.blocked) {
        output.output = (output.output ?? "") + `\n\n[hook blocked] ${result.reason ?? ""}`
      }
      if (result.additionalContext) {
        output.output = (output.output ?? "") + `\n\n${result.additionalContext}`
      }
      for (const w of result.warnings) {
        output.output = (output.output ?? "") + `\n\n[hook warning] ${w}`
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      if (hookState.configs.length === 0) return
      const result = await dispatchSimpleEvent("PreCompact", {}, hookState)
      if (result.additionalContext) output.context.push(result.additionalContext)
    },

    event: async ({ event }) => {
      if (hookState.configs.length === 0) return
      if (event.type === "session.idle") {
        await dispatchSimpleEvent("Stop", { stop_hook_active: false }, hookState)
      }
    },
  }
}

export default CcCompat
