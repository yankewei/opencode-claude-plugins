import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadComponents } from "./transform.js"
import type { LoadedPlugin } from "./types.js"

function createPluginDir(): { tmp: string; plugin: LoadedPlugin } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compat-transform-"))
  const installPath = path.join(tmp, "plugin")
  fs.mkdirSync(installPath, { recursive: true })
  return {
    tmp,
    plugin: {
      key: "my-plugin@market",
      manifest: { name: "my-plugin", version: "1.0.0" },
      installPath,
      enabled: true,
    },
  }
}

function cleanup(tmp: string): void {
  fs.rmSync(tmp, { recursive: true, force: true })
}

function emptyClaudeConfig(tmp: string): string {
  const p = path.join(tmp, ".claude.json")
  fs.writeFileSync(p, JSON.stringify({}))
  return p
}

describe("loadComponents", () => {
  it("loads commands from commands/*.md", async () => {
    const { tmp, plugin } = createPluginDir()
    const commandsDir = path.join(plugin.installPath, "commands")
    fs.mkdirSync(commandsDir, { recursive: true })
    fs.writeFileSync(
      path.join(commandsDir, "hello.md"),
      "---\ndescription: Say hello\nmodel: sonnet\n---\n\nGreet the user.",
    )

    const components = await loadComponents([plugin], { claudeConfigPath: emptyClaudeConfig(tmp) })
    cleanup(tmp)

    expect(Object.keys(components.commands)).toEqual(["my-plugin:hello"])
    expect(components.commands["my-plugin:hello"].description).toContain("Say hello")
    expect(components.commands["my-plugin:hello"].template).toContain("Greet the user")
    expect(components.commands["my-plugin:hello"].model).toBe("anthropic/claude-sonnet-4-6")
  })

  it("loads skills from skills/<name>/SKILL.md as skill paths", async () => {
    const { tmp, plugin } = createPluginDir()
    const skillsDir = path.join(plugin.installPath, "skills", "write")
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "---\nname: writer\n---\n\nWrite well.")

    const components = await loadComponents([plugin], { claudeConfigPath: emptyClaudeConfig(tmp) })
    cleanup(tmp)

    expect(components.skillPaths).toContain(skillsDir)
    expect(Object.keys(components.commands)).toHaveLength(0)
  })

  it("loads root-level SKILL.md fallback", async () => {
    const { tmp, plugin } = createPluginDir()
    fs.writeFileSync(path.join(plugin.installPath, "SKILL.md"), "---\nname: root-skill\n---\n\nRoot skill.")

    const components = await loadComponents([plugin], { claudeConfigPath: emptyClaudeConfig(tmp) })
    cleanup(tmp)

    expect(components.skillPaths).toContain(plugin.installPath)
  })

  it("loads agents from agents/*.md", async () => {
    const { tmp, plugin } = createPluginDir()
    const agentsDir = path.join(plugin.installPath, "agents")
    fs.mkdirSync(agentsDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentsDir, "reviewer.md"),
      "---\ndescription: Code reviewer\nmodel: opus\ntools: read,edit,-bash\n---\n\nReview code carefully.",
    )

    const components = await loadComponents([plugin], { claudeConfigPath: emptyClaudeConfig(tmp) })
    cleanup(tmp)

    expect(Object.keys(components.agents)).toEqual(["my-plugin:reviewer"])
    const agent = components.agents["my-plugin:reviewer"]
    expect(agent.mode).toBe("subagent")
    expect(agent.model).toBe("anthropic/claude-opus-4-7")
    expect(agent.tools).toEqual({ read: true, edit: true, bash: false })
    expect(agent.prompt).toContain("Review code carefully")
  })

  it("loads .mcp.json stdio servers", async () => {
    const { tmp, plugin } = createPluginDir()
    fs.writeFileSync(
      path.join(plugin.installPath, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          fs: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem"],
            env: { FOO: "bar" },
          },
        },
      }),
    )

    const components = await loadComponents([plugin], { claudeConfigPath: emptyClaudeConfig(tmp) })
    cleanup(tmp)

    expect(Object.keys(components.mcpServers)).toEqual(["my-plugin:fs"])
    const mcp = components.mcpServers["my-plugin:fs"]
    expect(mcp.type).toBe("local")
    if (mcp.type !== "local") throw new Error("expected local mcp")
    expect(mcp.command).toEqual(["npx", "-y", "@modelcontextprotocol/server-filesystem"])
    expect(mcp.environment).toEqual({ FOO: "bar" })
  })

  it("loads .mcp.json remote http/sse servers", async () => {
    const { tmp, plugin } = createPluginDir()
    fs.writeFileSync(
      path.join(plugin.installPath, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          web: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer token" },
            oauth: { clientId: "id", scopes: ["read", "write"] },
          },
        },
      }),
    )

    const components = await loadComponents([plugin], { claudeConfigPath: emptyClaudeConfig(tmp) })
    cleanup(tmp)

    const mcp = components.mcpServers["my-plugin:web"]
    expect(mcp.type).toBe("remote")
    if (mcp.type !== "remote") throw new Error("expected remote mcp")
    expect(mcp.url).toBe("https://example.com/mcp")
    expect(mcp.headers).toEqual({ Authorization: "Bearer token" })
    expect(mcp.oauth).toEqual({ clientId: "id", scope: "read write" })
  })

  it("loads hooks from hooks/hooks.json", async () => {
    const { tmp, plugin } = createPluginDir()
    const hooksDir = path.join(plugin.installPath, "hooks")
    fs.mkdirSync(hooksDir, { recursive: true })
    fs.writeFileSync(
      path.join(hooksDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "bash",
              hooks: [{ type: "command", command: "echo pre" }],
            },
          ],
        },
      }),
    )

    const components = await loadComponents([plugin], { claudeConfigPath: emptyClaudeConfig(tmp) })
    cleanup(tmp)

    expect(components.hooksConfigs).toHaveLength(1)
    const cfg = components.hooksConfigs[0]
    expect(cfg.pluginRoot).toBe(plugin.installPath)
    expect(cfg.config.hooks?.PreToolUse?.[0].hooks[0]).toMatchObject({
      type: "command",
      command: "echo pre",
      pluginRoot: plugin.installPath,
    })
  })

  it("skips disabled mcp servers", async () => {
    const { tmp, plugin } = createPluginDir()
    fs.writeFileSync(
      path.join(plugin.installPath, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          off: { command: "echo", disabled: true },
        },
      }),
    )

    const components = await loadComponents([plugin], { claudeConfigPath: emptyClaudeConfig(tmp) })
    cleanup(tmp)

    expect(Object.keys(components.mcpServers)).toHaveLength(0)
  })

  it("resolves CLAUDE_PLUGIN_ROOT in command bodies", async () => {
    const { tmp, plugin } = createPluginDir()
    const commandsDir = path.join(plugin.installPath, "commands")
    fs.mkdirSync(commandsDir, { recursive: true })
    fs.writeFileSync(
      path.join(commandsDir, "ctx.md"),
      "---\n---\nUse ${CLAUDE_PLUGIN_ROOT}/data.",
    )

    const components = await loadComponents([plugin], { claudeConfigPath: emptyClaudeConfig(tmp) })
    cleanup(tmp)

    expect(components.commands["my-plugin:ctx"].template).toContain(plugin.installPath)
  })

  it("loads user-scope MCP from ~/.claude.json", async () => {
    const { tmp, plugin } = createPluginDir()
    const cfgPath = path.join(tmp, ".claude.json")
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          context7: { type: "http", url: "https://mcp.context7.com/mcp" },
        },
      }),
    )

    const components = await loadComponents([plugin], { claudeConfigPath: cfgPath })
    cleanup(tmp)

    const mcp = components.mcpServers["context7"]
    expect(mcp?.type).toBe("remote")
    if (mcp?.type !== "remote") throw new Error("expected remote mcp")
    expect(mcp.url).toBe("https://mcp.context7.com/mcp")
  })

  it("loads project-scope MCP from ~/.claude.json projects[cwd]", async () => {
    const { tmp, plugin } = createPluginDir()
    const projectDir = path.join(tmp, "myproject")
    fs.mkdirSync(projectDir, { recursive: true })
    const cfgPath = path.join(tmp, ".claude.json")
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        mcpServers: {
          ctx7: { type: "http", url: "https://user.example.com/mcp" },
        },
        projects: {
          [projectDir]: {
            mcpServers: {
              ctx7: { type: "http", url: "https://project.example.com/mcp" },
              local: { command: "npx", args: ["srv"] },
            },
          },
        },
      }),
    )

    const components = await loadComponents([plugin], {
      cwd: projectDir,
      claudeConfigPath: cfgPath,
    })
    cleanup(tmp)

    expect(components.mcpServers["ctx7"]?.type).toBe("remote")
    if (components.mcpServers["ctx7"]?.type !== "remote") throw new Error("expected remote")
    expect((components.mcpServers["ctx7"] as any).url).toBe("https://project.example.com/mcp")
    expect(components.mcpServers["local"]?.type).toBe("local")
  })

  it("skips project-scope MCP for non-matching cwd", async () => {
    const { tmp, plugin } = createPluginDir()
    const cfgPath = path.join(tmp, ".claude.json")
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        projects: {
          "/elsewhere": {
            mcpServers: {
              ctx7: { type: "http", url: "https://elsewhere.example.com/mcp" },
            },
          },
        },
      }),
    )

    const components = await loadComponents([plugin], {
      cwd: path.join(tmp, "here"),
      claudeConfigPath: cfgPath,
    })
    cleanup(tmp)

    expect(components.mcpServers["ctx7"]).toBeUndefined()
  })

  it("respects CLAUDE_CONFIG_PATH env override", async () => {
    const { tmp, plugin } = createPluginDir()
    const cfgPath = path.join(tmp, ".claude.json")
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ mcpServers: { viaEnv: { command: "echo" } } }),
    )
    process.env.CLAUDE_CONFIG_PATH = cfgPath
    try {
      const components = await loadComponents([plugin])
      expect(components.mcpServers["viaEnv"]?.type).toBe("local")
    } finally {
      delete process.env.CLAUDE_CONFIG_PATH
    }
    cleanup(tmp)
  })
})
