import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { MAX_RULES, configDir, loadRules, parseRules, rulesFiles } from "../src/rules.ts";
import { sharedConfigDir } from "../src/settings.ts";

const root = mkdtempSync(path.join(tmpdir(), "rules-"));
process.env.XDG_CONFIG_HOME = path.join(root, "config");
process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");

function write(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test("top-level bullets are rules; indented lines continue them; fences are skipped", () => {
  const md = `# Rules

- Never edit generated files in \`dist/\`.
- Migrations are append-only:
  write a new one instead of editing.
* No new runtime dependencies.

\`\`\`
- not a rule
\`\`\`
1. Keep commits atomic.
`;
  expect(parseRules(md)).toEqual([
    "Never edit generated files in `dist/`.",
    "Migrations are append-only: write a new one instead of editing.",
    "No new runtime dependencies.",
    "Keep commits atomic.",
  ]);
});

test("the rules files: the project's shared and opencode files, then the user's, under XDG_CONFIG_HOME", () => {
  const project = path.join(root, "p");
  expect(sharedConfigDir()).toBe(path.join(root, "config", "agents"));
  expect(configDir()).toBe(path.join(root, "config", "opencode"));
  expect(rulesFiles(project)).toEqual([
    path.join(project, ".agents", "tool-gate-rules.md"),
    path.join(project, ".opencode", "tool-gate-rules.md"),
    path.join(root, "config", "agents", "tool-gate-rules.md"),
    path.join(root, "config", "opencode", "tool-gate-rules.md"),
  ]);
});

test("rules are the union of all four files in order, exact duplicates dropped", () => {
  const project = path.join(root, "union");
  expect(loadRules(project)).toEqual([]);
  write(path.join(project, ".agents", "tool-gate-rules.md"), "- Shared project rule.\n- Common rule.\n");
  expect(loadRules(project)).toEqual(["Shared project rule.", "Common rule."]);
  write(path.join(project, ".opencode", "tool-gate-rules.md"), "- Common rule.\n- opencode project rule.\n");
  write(path.join(sharedConfigDir(), "tool-gate-rules.md"), "- Shared user rule.\n- Common rule.\n");
  write(path.join(configDir(), "tool-gate-rules.md"), "- opencode user rule.\n");
  expect(loadRules(project)).toEqual([
    "Shared project rule.",
    "Common rule.",
    "opencode project rule.",
    "Shared user rule.",
    "opencode user rule.",
  ]);

  // pi's files are no longer read: the shared location replaces that fallback.
  write(path.join(project, ".pi", "tool-gate-rules.md"), "- pi project rule.\n");
  write(path.join(root, "pi-agent", "tool-gate-rules.md"), "- pi user rule.\n");
  expect(loadRules(project)).not.toContain("pi project rule.");
  expect(loadRules(project)).not.toContain("pi user rule.");

  // A file that goes away drops its rules; an unreadable one is skipped.
  rmSync(path.join(sharedConfigDir(), "tool-gate-rules.md"));
  rmSync(path.join(configDir(), "tool-gate-rules.md"));
  expect(loadRules(project)).toEqual(["Shared project rule.", "Common rule.", "opencode project rule."]);
});

test("at most 30 rules, the project's first", () => {
  const project = path.join(root, "cap");
  write(path.join(project, ".agents", "tool-gate-rules.md"), Array.from({ length: 20 }, (_, i) => `- Project rule ${i}.`).join("\n"));
  write(path.join(sharedConfigDir(), "tool-gate-rules.md"), Array.from({ length: 20 }, (_, i) => `- User rule ${i}.`).join("\n"));
  const rules = loadRules(project);
  expect(rules).toHaveLength(MAX_RULES);
  expect(rules[0]).toBe("Project rule 0.");
  expect(rules.at(-1)).toBe("User rule 9.");
});
