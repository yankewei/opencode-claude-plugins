import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { discoverPlugins } from "./discover.js"

function setupEnv(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compat-"))
  process.env.CLAUDE_PLUGINS_HOME = path.join(tmp, ".claude", "plugins")
  process.env.HOME = tmp
  return tmp
}

function teardownEnv(tmp: string): void {
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.CLAUDE_PLUGINS_HOME
}

function writeInstalledDb(tmp: string, data: unknown): void {
  const dir = path.join(tmp, ".claude", "plugins")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "installed_plugins.json"), JSON.stringify(data))
}

function writeSettings(tmp: string, data: unknown): void {
  const dir = path.join(tmp, ".claude")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(data))
}

function createPlugin(tmp: string, relPath: string, manifest?: Record<string, unknown>): void {
  const dir = path.join(tmp, relPath)
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true })
  if (manifest) {
    fs.writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest))
  }
}

describe("discoverPlugins", () => {
  let tmp: string

  beforeEach(() => {
    tmp = setupEnv()
  })

  afterEach(() => {
    teardownEnv(tmp)
  })

  it("returns empty array when database is missing", async () => {
    const plugins = await discoverPlugins({})
    expect(plugins).toEqual([])
  })

  it("loads v1 schema", async () => {
    createPlugin(tmp, "plugins/p1", { name: "p1" })
    writeInstalledDb(tmp, {
      version: 1,
      plugins: {
        p1: {
          scope: "user",
          installPath: path.join(tmp, "plugins/p1"),
          version: "1.0.0",
        },
      },
    })

    const plugins = await discoverPlugins({})
    expect(plugins).toHaveLength(1)
    expect(plugins[0].key).toBe("p1")
    expect(plugins[0].manifest.name).toBe("p1")
  })

  it("loads v2 schema taking first installation", async () => {
    createPlugin(tmp, "plugins/p2", { name: "p2" })
    writeInstalledDb(tmp, {
      version: 2,
      plugins: {
        p2: [
          {
            scope: "user",
            installPath: path.join(tmp, "plugins/p2"),
            version: "1.0.0",
          },
        ],
      },
    })

    const plugins = await discoverPlugins({})
    expect(plugins).toHaveLength(1)
    expect(plugins[0].key).toBe("p2")
  })

  it("loads v3 schema", async () => {
    createPlugin(tmp, "plugins/p3", { name: "p3" })
    writeInstalledDb(tmp, [
      {
        name: "p3",
        marketplace: "market",
        scope: "user",
        version: "1.0.0",
        installPath: path.join(tmp, "plugins/p3"),
        lastUpdated: "2024-01-01",
      },
    ])

    const plugins = await discoverPlugins({})
    expect(plugins).toHaveLength(1)
    expect(plugins[0].key).toBe("p3@market")
  })

  it("filters disabled plugins from settings", async () => {
    createPlugin(tmp, "plugins/p4", { name: "p4" })
    writeInstalledDb(tmp, {
      version: 1,
      plugins: {
        p4: {
          scope: "user",
          installPath: path.join(tmp, "plugins/p4"),
          version: "1.0.0",
        },
      },
    })
    writeSettings(tmp, { enabledPlugins: { p4: false } })

    const plugins = await discoverPlugins({})
    expect(plugins).toHaveLength(0)
  })

  it("respects project scope", async () => {
    createPlugin(tmp, "plugins/p5", { name: "p5" })
    const projectPath = path.join(tmp, "project-a")
    fs.mkdirSync(projectPath, { recursive: true })
    writeInstalledDb(tmp, {
      version: 1,
      plugins: {
        p5: {
          scope: "project",
          installPath: path.join(tmp, "plugins/p5"),
          version: "1.0.0",
          projectPath,
        },
      },
    })

    const inProject = await discoverPlugins({ cwd: projectPath })
    expect(inProject).toHaveLength(1)

    const outside = await discoverPlugins({ cwd: tmp })
    expect(outside).toHaveLength(0)
  })

  it("falls back to plugin key as name when manifest is missing", async () => {
    const installPath = path.join(tmp, "plugins/p6")
    fs.mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true })
    writeInstalledDb(tmp, {
      version: 1,
      plugins: {
        "p6@market": {
          scope: "user",
          installPath,
          version: "1.0.0",
        },
      },
    })

    const plugins = await discoverPlugins({})
    expect(plugins).toHaveLength(1)
    expect(plugins[0].manifest.name).toBe("p6")
  })

  it("allows override of enabled state", async () => {
    createPlugin(tmp, "plugins/p7", { name: "p7" })
    writeInstalledDb(tmp, {
      version: 1,
      plugins: {
        p7: {
          scope: "user",
          installPath: path.join(tmp, "plugins/p7"),
          version: "1.0.0",
        },
      },
    })
    writeSettings(tmp, { enabledPlugins: { p7: false } })

    const plugins = await discoverPlugins({ enabledOverride: { p7: true } })
    expect(plugins).toHaveLength(1)
  })
})
