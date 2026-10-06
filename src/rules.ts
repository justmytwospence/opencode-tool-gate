// Project rules, ported from pi-tool-gate. The rules are the union of the shared files the pi and
// Claude Code ports read too (`<project>/.agents/tool-gate-rules.md`,
// `~/.config/agents/tool-gate-rules.md`) and opencode's own (`<project>/.opencode/tool-gate-rules.md`,
// `~/.config/opencode/tool-gate-rules.md`), project files first, exact duplicates dropped.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { sharedConfigDir } from "./settings.ts";

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

/** The rules in `file`, re-read when its mtime changes; none when it is missing or unreadable. */
function readRules(file: string): string[] {
  try {
    const mtime = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.rules;
    const rules = parseRules(readFileSync(file, "utf8"));
    cache.set(file, { mtime, rules });
    return rules;
  } catch {
    return [];
  }
}

/** opencode's global config directory (`~/.config/opencode`, honouring XDG_CONFIG_HOME). */
export function configDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
}

/** The rules files, in the order their rules are listed: the project's shared and opencode files, then the user's. */
export function rulesFiles(cwd: string): string[] {
  return [
    path.join(cwd, ".agents", RULES_FILE),
    path.join(cwd, ".opencode", RULES_FILE),
    path.join(sharedConfigDir(), RULES_FILE),
    path.join(configDir(), RULES_FILE),
  ];
}

/** The rules of every file in `rulesFiles`, concatenated, exact duplicates dropped, at most 30. */
export function loadRules(cwd: string): string[] {
  const rules = rulesFiles(cwd).flatMap(readRules);
  return [...new Set(rules)].slice(0, MAX_RULES);
}
