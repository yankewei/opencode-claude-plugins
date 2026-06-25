import { describe, it, expect, vi } from "vitest"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import { createCcCompat } from "./plugin.js"
import type { CcCompatRuntime } from "./plugin.js"
import type { OpenCodeMcp, OpenCodeCommand, OpenCodeAgent, PluginComponents } from "./types.js"
import type { PreToolUseResult, PostToolUseResult } from "./hooks.js"

function createFakeRuntime(overrides?: Partial<CcCompatRuntime>): CcCompatRuntime {
  return {
    load: vi.fn().mockResolvedValue(null),
    apply: vi.fn(),
    startMcpServers: vi.fn(),
    beforeToolUse: vi.fn().mockResolvedValue({ decision: "allow" } as PreToolUseResult),
    afterToolUse: vi.fn().mockResolvedValue({ blocked: false, warnings: [] } as PostToolUseResult),
    onCompacting: vi.fn().mockResolvedValue(undefined),
    onIdle: vi.fn().mockResolvedValue(undefined),
    hasHookConfigs: vi.fn().mockReturnValue(true),
    ...overrides,
  }
}

function createFakeClient(): PluginInput["client"] {
  return {
    mcp: {
      add: vi.fn().mockResolvedValue({ data: {} }),
    },
  } as unknown as PluginInput["client"]
}

function createFakeInput(): PluginInput {
  return { client: createFakeClient() } as unknown as PluginInput
}

function emptyConfig(): Config {
  return {
    command: {},
    agent: {},
    mcp: {},
  } as unknown as Config
}

function sampleComponents(): PluginComponents {
  return {
    commands: {
      "p:cmd": { template: "hello" } as OpenCodeCommand,
    },
    agents: {
      "p:agent": { mode: "subagent" } as OpenCodeAgent,
    },
    mcpServers: {
      "p:mcp": { type: "local", command: ["echo"] } as OpenCodeMcp,
    },
    hooksConfigs: [],
    skillPaths: ["/skills/review"],
  }
}

describe("createCcCompat", () => {
  it("loads components and applies them to config", async () => {
    const runtime = createFakeRuntime({ load: vi.fn().mockResolvedValue(sampleComponents()) })
    const plugin = await createCcCompat(runtime)(createFakeInput())
    const config = emptyConfig()

    await plugin.config?.(config)

    expect(runtime.load).toHaveBeenCalledOnce()
    expect(runtime.apply).toHaveBeenCalledWith(sampleComponents(), config)
    expect(runtime.startMcpServers).toHaveBeenCalledWith(expect.anything(), sampleComponents().mcpServers)
  })

  it("skips config mutation when no plugins are discovered", async () => {
    const runtime = createFakeRuntime({ load: vi.fn().mockResolvedValue(null) })
    const plugin = await createCcCompat(runtime)(createFakeInput())
    const config = emptyConfig()

    await plugin.config?.(config)

    expect(runtime.apply).not.toHaveBeenCalled()
    expect(runtime.startMcpServers).not.toHaveBeenCalled()
  })

  it("does not dispatch beforeToolUse when there are no hooks", async () => {
    const runtime = createFakeRuntime({ hasHookConfigs: vi.fn().mockReturnValue(false) })
    const plugin = await createCcCompat(runtime)(createFakeInput())

    await plugin["tool.execute.before"]?.(
      { tool: "bash", sessionID: "s1", callID: "c1" },
      { args: { cmd: "ls" } },
    )

    expect(runtime.beforeToolUse).not.toHaveBeenCalled()
  })

  it("throws when beforeToolUse denies", async () => {
    const runtime = createFakeRuntime({
      beforeToolUse: vi.fn().mockResolvedValue({ decision: "deny", reason: "no shell" }),
    })
    const plugin = await createCcCompat(runtime)(createFakeInput())

    await expect(
      plugin["tool.execute.before"]?.(
        { tool: "bash", sessionID: "s1", callID: "c1" },
        { args: { cmd: "ls" } },
      ),
    ).rejects.toThrow("no shell")
  })

  it("merges updatedInput back into output args", async () => {
    const runtime = createFakeRuntime({
      beforeToolUse: vi.fn().mockResolvedValue({ decision: "allow", updatedInput: { cmd: "ls -la" } }),
    })
    const plugin = await createCcCompat(runtime)(createFakeInput())
    const output = { args: { cmd: "ls" } }

    await plugin["tool.execute.before"]?.(
      { tool: "bash", sessionID: "s1", callID: "c1" },
      output,
    )

    expect(output.args).toEqual({ cmd: "ls -la" })
  })

  it("appends hook results to afterToolUse output", async () => {
    const runtime = createFakeRuntime({
      afterToolUse: vi.fn().mockResolvedValue({
        blocked: true,
        reason: "sensitive",
        additionalContext: "remember",
        warnings: ["warn1"],
      }),
    })
    const plugin = await createCcCompat(runtime)(createFakeInput())
    const output = { title: "done", output: "result", metadata: {} }

    await plugin["tool.execute.after"]?.(
      { tool: "bash", sessionID: "s1", callID: "c1", args: {} },
      output as any,
    )

    expect(output.output).toContain("[hook blocked] sensitive")
    expect(output.output).toContain("remember")
    expect(output.output).toContain("[hook warning] warn1")
  })

  it("pushes additionalContext from compacting hook", async () => {
    const runtime = createFakeRuntime({ onCompacting: vi.fn().mockResolvedValue("compaction note") })
    const plugin = await createCcCompat(runtime)(createFakeInput())
    const output = { context: ["existing"] }

    await plugin["experimental.session.compacting"]?.(
      { sessionID: "s1" },
      output,
    )

    expect(output.context).toEqual(["existing", "compaction note"])
  })

  it("dispatches idle event to Stop hook", async () => {
    const runtime = createFakeRuntime()
    const plugin = await createCcCompat(runtime)(createFakeInput())

    await plugin.event?.({ event: { type: "session.idle" } } as any)

    expect(runtime.onIdle).toHaveBeenCalledOnce()
  })

  it("ignores unrelated events", async () => {
    const runtime = createFakeRuntime()
    const plugin = await createCcCompat(runtime)(createFakeInput())

    await plugin.event?.({ event: { type: "session.status" } } as any)

    expect(runtime.onIdle).not.toHaveBeenCalled()
  })
})
