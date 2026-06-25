import type { Plugin, Config, PluginInput } from "@opencode-ai/plugin"
import { discoverPlugins } from "./discover.js"
import { loadComponents } from "./transform.js"
import {
  createHookState,
  setHookConfigs,
  dispatchPreToolUse,
  dispatchPostToolUse,
  dispatchSimpleEvent,
} from "./hooks.js"
import type { HookState, PreToolUseResult, PostToolUseResult } from "./hooks.js"
import type { OpenCodeMcp, PluginComponents } from "./types.js"

// The plugin API's Config type currently omits `skills`, but opencode's runtime
// config accepts skill paths. We extend the type once and cast at the boundary
// rather than repeating inline object assertions.
interface ConfigWithSkills extends Config {
  skills?: { paths?: string[]; urls?: string[] }
}

const DEBUG = process.env.CC_COMPAT_DEBUG === "1" || process.env.CC_COMPAT_DEBUG === "true"
const log = (...args: unknown[]): void => {
  if (DEBUG) console.error("[cc-compat]", ...args)
}

export interface CcCompatRuntime {
  load(): Promise<PluginComponents | null>
  apply(components: PluginComponents, config: Config): void
  startMcpServers(client: PluginInput["client"], mcpServers: Record<string, OpenCodeMcp>): void
  beforeToolUse(
    tool: string,
    args: Record<string, unknown>,
    sessionID: string,
  ): Promise<PreToolUseResult>
  afterToolUse(
    tool: string,
    args: Record<string, unknown>,
    response: { title?: string; output?: string },
    sessionID: string,
  ): Promise<PostToolUseResult>
  onCompacting(sessionID: string): Promise<string | undefined>
  onIdle(sessionID: string): Promise<string | undefined>
  hasHookConfigs(): boolean
}

export class DefaultCcCompatRuntime implements CcCompatRuntime {
  private hookState: HookState
  private loaded: boolean

  constructor() {
    this.hookState = createHookState()
    this.loaded = false
  }

  async load(): Promise<PluginComponents | null> {
    if (this.loaded) return null
    this.loaded = true

    const plugins = await discoverPlugins({})
    log(
      `discovered ${plugins.length} plugin(s):`,
      plugins.map((p) => p.key).join(", ") || "(none)",
    )
    if (plugins.length === 0) return null

    const components = await loadComponents(plugins)
    log(
      `loaded: ${Object.keys(components.commands).length} commands, ` +
        `${Object.keys(components.agents).length} agents, ` +
        `${Object.keys(components.mcpServers).length} mcp, ` +
        `${components.hooksConfigs.length} hooks`,
    )

    setHookConfigs(this.hookState, components.hooksConfigs)
    return components
  }

  apply(components: PluginComponents, config: Config): void {
    config.command = { ...config.command, ...components.commands } as Config["command"]
    config.agent = { ...config.agent, ...components.agents } as Config["agent"]
    config.mcp = { ...config.mcp, ...components.mcpServers } as Config["mcp"]

    const configWithSkills = config as ConfigWithSkills
    const existingPaths = configWithSkills.skills?.paths ?? []
    configWithSkills.skills = {
      paths: [...existingPaths, ...components.skillPaths],
      urls: configWithSkills.skills?.urls ?? [],
    }
  }

  startMcpServers(client: PluginInput["client"], mcpServers: Record<string, OpenCodeMcp>): void {
    for (const [name, cfg] of Object.entries(mcpServers)) {
      client.mcp
        .add({ body: { name, config: cfg } })
        .then((res) => {
          log(
            `mcp.add(${name}) →`,
            res.error
              ? `error: ${JSON.stringify(res.error).slice(0, 200)}`
              : `ok: ${JSON.stringify(res.data).slice(0, 200)}`,
          )
        })
        .catch((err) => {
          console.error(`[cc-compat] mcp.add(${name}) failed:`, err)
        })
    }
  }

  async beforeToolUse(
    tool: string,
    args: Record<string, unknown>,
    sessionID: string,
  ): Promise<PreToolUseResult> {
    return dispatchPreToolUse(tool, args, this.hookState, sessionID)
  }

  async afterToolUse(
    tool: string,
    args: Record<string, unknown>,
    response: { title?: string; output?: string },
    sessionID: string,
  ): Promise<PostToolUseResult> {
    return dispatchPostToolUse(tool, args, response, this.hookState, sessionID)
  }

  async onCompacting(sessionID: string): Promise<string | undefined> {
    const result = await dispatchSimpleEvent("PreCompact", {}, this.hookState)
    return result.additionalContext
  }

  async onIdle(sessionID: string): Promise<string | undefined> {
    const result = await dispatchSimpleEvent("Stop", { stop_hook_active: false }, this.hookState)
    return result.additionalContext
  }

  hasHookConfigs(): boolean {
    return this.hookState.configs.length > 0
  }
}

export function createCcCompat(runtime: CcCompatRuntime): Plugin {
  return async ({ client }) => {
    return {
      config: async (config: Config) => {
        try {
          const components = await runtime.load()
          if (!components) return
          runtime.apply(components, config)
          runtime.startMcpServers(client, components.mcpServers)
        } catch (err) {
          console.error("[cc-compat] failed to load Claude Code plugins:", err)
        }
      },

      "tool.execute.before": async (input, output) => {
        if (!runtime.hasHookConfigs()) return
        const result = await runtime.beforeToolUse(input.tool, output.args ?? {}, input.sessionID)
        if (result.decision === "deny") {
          throw new Error(result.reason ?? "blocked by Claude Code PreToolUse hook")
        }
        if (result.updatedInput) {
          Object.assign(output.args, result.updatedInput)
        }
      },

      "tool.execute.after": async (input, output) => {
        if (!runtime.hasHookConfigs()) return
        const result = await runtime.afterToolUse(
          input.tool,
          input.args ?? {},
          { title: output.title, output: output.output },
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
        if (!runtime.hasHookConfigs()) return
        const additionalContext = await runtime.onCompacting(_input.sessionID)
        if (additionalContext) output.context.push(additionalContext)
      },

      event: async ({ event }) => {
        if (!runtime.hasHookConfigs()) return
        if (event.type === "session.idle") {
          await runtime.onIdle("")
        }
      },
    }
  }
}

export const CcCompat: Plugin = async (input) => {
  const runtime: CcCompatRuntime = new DefaultCcCompatRuntime()
  return createCcCompat(runtime)(input)
}

export default CcCompat
