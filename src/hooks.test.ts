import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { EventEmitter } from "node:events"
import type { SpawnOptions } from "node:child_process"
import { spawn } from "node:child_process"
import {
  createHookState,
  setHookConfigs,
  dispatchPreToolUse,
  dispatchPostToolUse,
  dispatchSimpleEvent,
} from "./hooks.js"
import type { HookState } from "./hooks.js"

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}))

const spawnMock = vi.mocked(spawn)

interface MockChildOpts {
  code: number
  stdout?: string
  stderr?: string
}

function makeChildProcess(opts: MockChildOpts): ReturnType<typeof spawnMock> {
  const child = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const stdin = new EventEmitter()
  Object.assign(stdin, { write: vi.fn(), end: vi.fn() })
  Object.assign(child, { stdout, stderr, stdin, pid: 1234 })

  process.nextTick(() => {
    if (opts.stdout) stdout.emit("data", Buffer.from(opts.stdout))
    if (opts.stderr) stderr.emit("data", Buffer.from(opts.stderr))
    child.emit("close", opts.code)
  })

  return child as ReturnType<typeof spawnMock>
}

describe("hooks dispatch", () => {
  let state: HookState

  beforeEach(() => {
    state = createHookState()
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeChildProcess({ code: 0 }) as unknown as ReturnType<typeof spawnMock>)
  })

  afterEach(() => {
    spawnMock.mockReset()
  })

  it("allows when no matching hooks", async () => {
    const result = await dispatchPreToolUse("bash", { cmd: "ls" }, state, "s1")
    expect(result.decision).toBe("allow")
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("denies on exit code 2", async () => {
    setHookConfigs(state, [
      {
        pluginRoot: "/tmp",
        config: {
          hooks: {
            PreToolUse: [
              {
                matcher: "bash",
                hooks: [{ type: "command", command: "block.sh" }],
              },
            ],
          },
        },
      },
    ])
    spawnMock.mockImplementation(() => makeChildProcess({ code: 2, stderr: "no bash" }))

    const result = await dispatchPreToolUse("bash", { cmd: "ls" }, state, "s1")
    expect(result.decision).toBe("deny")
    expect(result.reason).toBe("no bash")
  })

  it("returns ask on exit code 1", async () => {
    setHookConfigs(state, [
      {
        pluginRoot: "/tmp",
        config: {
          hooks: {
            PreToolUse: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: "ask.sh" }],
              },
            ],
          },
        },
      },
    ])
    spawnMock.mockImplementation(() => makeChildProcess({ code: 1, stdout: "confirm?" }))

    const result = await dispatchPreToolUse("read", { path: "x" }, state, "s1")
    expect(result.decision).toBe("ask")
    expect(result.reason).toBe("confirm?")
  })

  it("parses updatedInput from stdout JSON on exit 0", async () => {
    setHookConfigs(state, [
      {
        pluginRoot: "/tmp",
        config: {
          hooks: {
            PreToolUse: [
              {
                hooks: [{ type: "command", command: "modify.sh" }],
              },
            ],
          },
        },
      },
    ])
    spawnMock.mockImplementation(() =>
      makeChildProcess({
        code: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { updatedInput: { cmd: "ls -la" } } }),
      }))

    const result = await dispatchPreToolUse("bash", { cmd: "ls" }, state, "s1")
    expect(result.decision).toBe("allow")
    expect(result.updatedInput).toEqual({ cmd: "ls -la" })
  })

  it("respects matcher wildcard", async () => {
    setHookConfigs(state, [
      {
        pluginRoot: "/tmp",
        config: {
          hooks: {
            PostToolUse: [
              {
                matcher: "read|edit",
                hooks: [{ type: "command", command: "post.sh" }],
              },
            ],
          },
        },
      },
    ])

    await dispatchPostToolUse("bash", {}, { output: "" }, state, "s1")
    expect(spawnMock).not.toHaveBeenCalled()

    spawnMock.mockClear()
    spawnMock.mockImplementation(() => makeChildProcess({ code: 0 }))
    await dispatchPostToolUse("read", {}, { output: "" }, state, "s1")
    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it("appends additionalContext from post tool use hook", async () => {
    setHookConfigs(state, [
      {
        pluginRoot: "/tmp",
        config: {
          hooks: {
            PostToolUse: [
              {
                hooks: [{ type: "command", command: "context.sh" }],
              },
            ],
          },
        },
      },
    ])
    spawnMock.mockImplementation(() =>
      makeChildProcess({
        code: 0,
        stdout: JSON.stringify({ systemMessage: "remember this" }),
      }))

    const result = await dispatchPostToolUse("bash", {}, { output: "done" }, state, "s1")
    expect(result.additionalContext).toBe("remember this")
  })

  it("dispatches simple events without tool matching", async () => {
    setHookConfigs(state, [
      {
        pluginRoot: "/tmp",
        config: {
          hooks: {
            Stop: [
              {
                hooks: [{ type: "command", command: "stop.sh" }],
              },
            ],
          },
        },
      },
    ])

    await dispatchSimpleEvent("Stop", { stop_hook_active: false }, state)
    expect(spawnMock).toHaveBeenCalledOnce()
    const cmd = spawnMock.mock.calls[0][0] as string
    expect(cmd).toBe("stop.sh")
  })

  it("passes env vars and resolves plugin root in command", async () => {
    setHookConfigs(state, [
      {
        pluginRoot: "/plugin/root",
        config: {
          hooks: {
            PreToolUse: [
              {
                hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hook.sh" }],
              },
            ],
          },
        },
      },
    ])

    await dispatchPreToolUse("bash", {}, state, "s1")
    const cmd = spawnMock.mock.calls[0][0] as string
    const opts = spawnMock.mock.calls[0][1] as unknown as { env: Record<string, string> }
    expect(cmd).toBe("/plugin/root/hook.sh")
    expect(opts.env.CLAUDE_PLUGIN_ROOT).toBe("/plugin/root")
    expect(opts.env.CLAUDE_PROJECT_DIR).toBe(process.cwd())
  })

  it("ignores non-command hook entries", async () => {
    setHookConfigs(state, [
      {
        pluginRoot: "/tmp",
        config: {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  { type: "prompt", prompt: "ignore me" },
                  { type: "command", command: "run.sh" },
                ],
              },
            ],
          },
        },
      },
    ])

    await dispatchPreToolUse("bash", {}, state, "s1")
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(spawnMock.mock.calls[0][0]).toBe("run.sh")
  })
})
