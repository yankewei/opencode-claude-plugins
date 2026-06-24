import path from "node:path"
import os from "node:os"
import { readFile, stat } from "node:fs/promises"
import type {
  InstalledPluginsDatabase,
  InstalledPluginEntryV3,
  PluginInstallation,
  PluginManifest,
  LoadedPlugin,
} from "./types.js"

const CLAUDE_PLUGINS_HOME = process.env.CLAUDE_PLUGINS_HOME ?? path.join(os.homedir(), ".claude/plugins")

export async function discoverPlugins(opts: {
  cwd?: string
  enabledOverride?: Record<string, boolean>
}): Promise<LoadedPlugin[]> {
  const cwd = opts.cwd ?? process.cwd()
  const dbPath = path.join(CLAUDE_PLUGINS_HOME, "installed_plugins.json")

  let db: InstalledPluginsDatabase
  try {
    db = JSON.parse(await readFile(dbPath, "utf8"))
  } catch {
    return []
  }

  const entries = extractEntries(db)
  if (entries.length === 0) return []

  const enabledPlugins = await loadEnabledPlugins()

  const out: LoadedPlugin[] = []
  for (const [key, install] of entries) {
    if (!install) continue
    if (!isEnabled(key, install, enabledPlugins, opts.enabledOverride)) continue
    if (!shouldLoadForCwd(install, cwd)) continue

    const installPath = await resolveInstallPath(install)
    if (!installPath) continue

    const manifest = await loadManifest(installPath, key)
    if (!manifest) continue

    out.push({ key, manifest, installPath, enabled: true })
  }
  return out
}

function extractEntries(db: InstalledPluginsDatabase): Array<[string, PluginInstallation | undefined]> {
  if (Array.isArray(db)) {
    return db
      .filter(isValidV3)
      .map((e) => [`${e.name}@${e.marketplace}`, v3ToInstallation(e)] as [string, PluginInstallation])
  }
  if (db.version === 1) return Object.entries(db.plugins)
  if (db.version === 2) return Object.entries(db.plugins).map(([k, v]) => [k, v[0]])
  return []
}

function isValidV3(e: unknown): e is InstalledPluginEntryV3 {
  const v = e as InstalledPluginEntryV3
  return typeof v.name === "string" && typeof v.marketplace === "string" && typeof v.installPath === "string"
}

function v3ToInstallation(e: InstalledPluginEntryV3): PluginInstallation {
  return {
    scope: e.scope,
    installPath: e.installPath,
    version: e.version,
    lastUpdated: e.lastUpdated,
    gitCommitSha: e.gitCommitSha,
    projectPath: e.projectPath,
  }
}

async function loadEnabledPlugins(): Promise<Record<string, boolean>> {
  try {
    const settings = JSON.parse(await readFile(path.join(os.homedir(), ".claude/settings.json"), "utf8"))
    return settings.enabledPlugins ?? {}
  } catch {
    return {}
  }
}

function isEnabled(
  key: string,
  install: PluginInstallation,
  enabledPlugins: Record<string, boolean>,
  override?: Record<string, boolean>,
): boolean {
  if (override && key in override) return override[key]
  if (key in enabledPlugins) return enabledPlugins[key]
  return true
}

function shouldLoadForCwd(install: PluginInstallation, cwd: string): boolean {
  if (install.scope === "user" || install.scope === "managed") return true
  if (!install.projectPath) return true
  const pp = install.projectPath.replace(/^~/, os.homedir())
  return path.resolve(pp) === path.resolve(cwd)
}

async function resolveInstallPath(install: PluginInstallation): Promise<string | undefined> {
  const p = install.installPath.replace(/^~/, os.homedir())
  try {
    await stat(p)
    return p
  } catch {
    return undefined
  }
}

async function loadManifest(installPath: string, key: string): Promise<PluginManifest | undefined> {
  for (const rel of [".claude-plugin/plugin.json", "plugin.json"]) {
    try {
      const raw = await readFile(path.join(installPath, rel), "utf8")
      return JSON.parse(raw) as PluginManifest
    } catch {
      continue
    }
  }
  // Claude Code marketplace manifest fallback (e.g. tw93/kami, tw93/waza sub-plugins)
  // Marketplace.json may live in installPath or a parent directory, and contains
  // multiple plugin entries keyed by name.
  let dir = installPath
  while (dir !== path.dirname(dir)) {
    try {
      const raw = await readFile(path.join(dir, ".claude-plugin/marketplace.json"), "utf8")
      const market = JSON.parse(raw) as {
        name?: string
        description?: string
        owner?: { name?: string; email?: string }
        plugins?: Array<{
          name?: string
          version?: string
          description?: string
          homepage?: string
        }>
      }
      const pluginName = key.split("@")[0]
      const entry = market.plugins?.find((e) => e.name === pluginName)
      if (!entry?.name) return undefined
      return {
        name: entry.name,
        version: entry.version,
        description: entry.description ?? market.description,
        author: market.owner,
        homepage: entry.homepage,
      }
    } catch {
      dir = path.dirname(dir)
      continue
    }
  }
  // Last resort: some Claude Code plugins (especially per-skill installs like
  // waza-read/waza-write) ship without any manifest file. Use the key as the
  // plugin name so the rest of the loading pipeline can still discover skills,
  // commands, agents, etc.
  return { name: key.split("@")[0] }
}
