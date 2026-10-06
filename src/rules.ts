// Project rules, ported from pi-tool-gate. opencode reads `<project>/.opencode/tool-gate-rules.md`
// and `~/.config/opencode/tool-gate-rules.md`; a project or home that has only pi's files
// (`.pi/tool-gate-rules.md`, `~/.pi/agent/tool-gate-rules.md`) is read as a fallback.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const RULES_FILE = "tool-gate-rules.md";
export const MAX_RULES = 30;

/** Each top-level bullet (`-`, `*`, `+` or `1.`) is one rule; indented lines continue it. */
export function parseRules(markdown: string): string[] {
  const rules: string[] = [];
  let current: string | undefined;
  let inFence = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*```/u.test(line)) inFence = !inFence;
    if (inFence) continue;
    const top = /^(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(line);
    if (top) {
      if (current) rules.push(current);
      current = (top[1] as string).trim();
    } else if (current && /^\s+\S/u.test(line)) {
      current += ` ${line.trim()}`;
    } else if (current) {
      rules.push(current);
      current = undefined;
    }
  }
  if (current) rules.push(current);
  return rules.filter(Boolean);
}

const cache = new Map<string, { mtime: number; rules: string[] }>();

function readRules(file: string): string[] | undefined {
  try {
    const mtime = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.rules;
    const rules = parseRules(readFileSync(file, "utf8"));
    cache.set(file, { mtime, rules });
    return rules;
  } catch {
    return undefined;
  }
}

/** The rules in the first of `files` that exists. */
function firstRules(files: readonly string[]): string[] {
  for (const file of files) {
    const rules = readRules(file);
    if (rules) return rules;
  }
  return [];
}

/** opencode's global config directory (`~/.config/opencode`, honouring XDG_CONFIG_HOME). */
export function configDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
}

/** Project rules file candidates: opencode's first, then pi's. */
export function projectRulesFiles(cwd: string): string[] {
  return [path.join(cwd, ".opencode", RULES_FILE), path.join(cwd, ".pi", RULES_FILE)];
}

/** Global rules file candidates: opencode's first, then pi's. */
export function globalRulesFiles(): string[] {
  return [path.join(configDir(), RULES_FILE), path.join(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), RULES_FILE)];
}

/** Project rules first, then global ones, at most 30. */
export function loadRules(cwd: string): string[] {
  const rules = [...firstRules(projectRulesFiles(cwd)), ...firstRules(globalRulesFiles())];
  return [...new Set(rules)].slice(0, MAX_RULES);
}
