#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const home = os.homedir()
const pluginsHome = process.env.CLAUDE_PLUGINS_HOME ?? path.join(home, ".claude/plugins")
const dbPath = path.join(pluginsHome, "installed_plugins.json")
const settingsPath = path.join(home, ".claude/settings.json")

async function exists(p) {
  return stat(p).then(() => true, () => false)
}

function short(p) {
  return p.replace(home, "~")
}

console.log("=== cc-plugins diagnose ===\n")
console.log("CLAUDE_PLUGINS_HOME:", short(pluginsHome))
console.log("cwd:", process.cwd())

// 1. installed_plugins.json
console.log("\n--- 1. installed_plugins.json ---")
console.log("path:", short(dbPath))
let db
if (!(await exists(dbPath))) {
  console.log("status: NOT FOUND")
  process.exit(0)
}
try {
  db = JSON.parse(await readFile(dbPath, "utf8"))
  console.log("status: OK, version:", Array.isArray(db) ? "v3" : db.version)
} catch (e) {
  console.log("status: PARSE ERROR", e.message)
  process.exit(0)
}

// 2. enabledPlugins
console.log("\n--- 2. enabledPlugins ---")
let enabledPlugins = {}
try {
  const settings = JSON.parse(await readFile(settingsPath, "utf8"))
  enabledPlugins = settings.enabledPlugins ?? {}
  console.log("enabledPlugins:", enabledPlugins)
} catch {
  console.log("settings.json: not found or unreadable, treating all as enabled")
}

// 3. extract all entries
console.log("\n--- 3. all installed plugins ---")
let entries = []
if (Array.isArray(db)) {
  entries = db
    .filter((e) => typeof e.name === "string" && typeof e.marketplace === "string" && typeof e.installPath === "string")
    .map((e) => [`${e.name}@${e.marketplace}`, {
      scope: e.scope,
      installPath: e.installPath,
      version: e.version,
      lastUpdated: e.lastUpdated,
      gitCommitSha: e.gitCommitSha,
      projectPath: e.projectPath,
    }])
} else if (db.version === 1) {
  entries = Object.entries(db.plugins)
} else if (db.version === 2) {
  entries = Object.entries(db.plugins).map(([k, v]) => [k, v[0]])
}

console.log(`found ${entries.length} plugin entry(s)\n`)

const cwd = process.cwd()

for (const [key, install] of entries) {
  console.log("=".repeat(60))
  console.log("key:", key)

  if (!install) {
    console.log("status: install data missing\n")
    continue
  }

  // enabled check
  const isEnabled = key in enabledPlugins ? enabledPlugins[key] : true
  if (!isEnabled) {
    console.log("status: DISABLED in ~/.claude/settings.json\n")
    continue
  }

  // scope check
  let loadForCwd = true
  if (install.scope !== "user" && install.scope !== "managed" && install.projectPath) {
    const pp = install.projectPath.replace(/^~/, home)
    loadForCwd = path.resolve(pp) === path.resolve(cwd)
  }
  if (!loadForCwd) {
    console.log("status: project scope mismatch (skipped)")
    console.log(`  scope=${install.scope}, projectPath=${install.projectPath}\n`)
    continue
  }

  // installPath
  const installPath = install.installPath?.replace(/^~/, home)
  console.log("installPath:", short(installPath))
  if (!(await exists(installPath))) {
    console.log("status: installPath NOT FOUND\n")
    continue
  }

  // manifest
  let manifest = null
  let manifestSource = null

  // direct plugin.json
  for (const rel of [".claude-plugin/plugin.json", "plugin.json"]) {
    const p = path.join(installPath, rel)
    if (await exists(p)) {
      try {
        const raw = JSON.parse(await readFile(p, "utf8"))
        if (raw.name) {
          manifest = raw
          manifestSource = rel
          break
        }
      } catch {}
    }
  }

  // marketplace.json fallback: may live in installPath or a parent dir
  if (!manifest) {
    let dir = installPath
    while (dir !== path.dirname(dir)) {
      const p = path.join(dir, ".claude-plugin/marketplace.json")
      if (await exists(p)) {
        try {
          const raw = JSON.parse(await readFile(p, "utf8"))
          const pluginName = key.split("@")[0]
          const entry = raw.plugins?.find((e) => e.name === pluginName)
          if (entry?.name) {
            manifest = {
              name: entry.name,
              version: entry.version,
              description: entry.description ?? raw.description,
            }
            manifestSource = `${short(p)} → plugins.find(e => e.name === '${pluginName}')`
            break
          }
        } catch {}
      }
      dir = path.dirname(dir)
    }
  }

  if (!manifest) {
    console.log("status: NO MANIFEST FOUND")
    console.log("  tried: .claude-plugin/plugin.json, plugin.json")
    console.log("  and .claude-plugin/marketplace.json in installPath and parent dirs\n")
    continue
  }

  console.log("manifest:", manifestSource)
  console.log("  name:", manifest.name, "version:", manifest.version ?? "(none)")

  // components
  const components = {
    commands: (await exists(path.join(installPath, "commands")))
      ? (await readdir(path.join(installPath, "commands"))).filter((f) => f.endsWith(".md")).length
      : 0,
    skills: 0,
    agents: (await exists(path.join(installPath, "agents")))
      ? (await readdir(path.join(installPath, "agents"))).filter((f) => f.endsWith(".md")).length
      : 0,
    mcp: await exists(path.join(installPath, ".mcp.json")) ? 1 : 0,
    hooks: await exists(path.join(installPath, "hooks/hooks.json")) ? 1 : 0,
  }

  const skillsDir = path.join(installPath, "skills")
  if (await exists(skillsDir)) {
    const dirs = await readdir(skillsDir, { withFileTypes: true })
    for (const d of dirs.filter((x) => x.isDirectory())) {
      if (await exists(path.join(skillsDir, d.name, "SKILL.md"))) components.skills++
    }
  }
  if (await exists(path.join(installPath, "SKILL.md"))) components.skills++

  console.log("components:", JSON.stringify(components), "\n")
}

console.log("=== end ===")
