// Shared, harness-neutral settings. The pi, opencode and Claude Code ports of these plugins all
// read `$XDG_CONFIG_HOME/agents/<name>.json` (default `~/.config/agents/<name>.json`) and
// `<project>/.agents/<name>.json`, so one file can hold the keys they have in common; keys a
// harness does not know are ignored. Files are read when needed, cached by mtime, so edits apply
// without a restart. Missing, unreadable or invalid files are ignored silently.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** The shared user config directory: `$XDG_CONFIG_HOME/agents`, by default `~/.config/agents`. */
export function sharedConfigDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "agents");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const cache = new Map<string, { mtime: number; value: Record<string, unknown> | undefined }>();

/**
 * The JSON object in `file`, re-read when its mtime changes. Undefined when the file is missing,
 * unreadable, not valid JSON, or not an object.
 */
export function readJson(file: string): Record<string, unknown> | undefined {
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return undefined;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;
  let value: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    value = isRecord(parsed) ? parsed : undefined;
  } catch {
    value = undefined;
  }
  cache.set(file, { mtime, value });
  return value;
}

/** `over` on top of `base`: objects merge recursively; arrays and other values replace. */
export function deepMerge<T extends object>(base: T, over: Record<string, unknown> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

/**
 * The settings for `name` in force now, later layers winning: `defaults`, the shared user file,
 * `pluginOptions` (the plugin's options in opencode.jsonc), the shared project file
 * `<directory>/.agents/<name>.json`, then `<directory>/.opencode/<name>.json`.
 */
export function loadSettings<T extends object>(
  name: string,
  defaults: T,
  pluginOptions: Record<string, unknown> | undefined,
  directory: string,
): T {
  const layers = [
    readJson(path.join(sharedConfigDir(), `${name}.json`)),
    pluginOptions,
    readJson(path.join(directory, ".agents", `${name}.json`)),
    readJson(path.join(directory, ".opencode", `${name}.json`)),
  ];
  return layers.reduce<T>((merged, layer) => deepMerge(merged, layer), defaults);
}
