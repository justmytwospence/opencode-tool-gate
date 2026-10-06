import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_OPTIONS, NAME, currentOptions, resolveOptions } from "../src/index.ts";
import { deepMerge, loadSettings, readJson, sharedConfigDir } from "../src/settings.ts";

const root = mkdtempSync(path.join(tmpdir(), "settings-"));
process.env.XDG_CONFIG_HOME = path.join(root, "config");
const project = path.join(root, "project");

/** Writes `value` (an object, or raw text) to `file`, optionally with a fixed mtime in seconds. */
function write(file: string, value: unknown, mtime?: number) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  if (mtime !== undefined) utimesSync(file, mtime, mtime);
}

test("the shared config directory honours XDG_CONFIG_HOME", () => {
  expect(sharedConfigDir()).toBe(path.join(root, "config", "agents"));
});

test("deepMerge: objects merge, arrays and scalars replace, undefined is skipped", () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2], s: "x" }, { a: { c: 3 }, list: [3], s: undefined, extra: true });
  expect(merged).toEqual({ a: { b: 1, c: 3 }, list: [3], s: "x", extra: true });
  expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 });
});

test("merge order: defaults, shared user file, plugin options, shared project file, .opencode file", () => {
  const defaults = { enabled: true, jev: { model: "jev-latest", timeoutMs: 1_500 }, agents: ["build"], only: "defaults" };
  write(path.join(sharedConfigDir(), "ex.json"), { user: 1, a: "user", b: "user", jev: { timeoutMs: 1 } });
  const plugin = { plugin: 1, b: "plugin", c: "plugin", jev: { model: "m" } };
  write(path.join(project, ".agents", "ex.json"), { project: 1, c: "project", d: "project" });
  write(path.join(project, ".opencode", "ex.json"), { opencode: 1, d: "opencode", agents: ["general"] });
  expect(loadSettings("ex", defaults, plugin, project)).toEqual({
    enabled: true,
    jev: { model: "m", timeoutMs: 1 },
    agents: ["general"],
    only: "defaults",
    user: 1,
    plugin: 1,
    project: 1,
    opencode: 1,
    a: "user",
    b: "plugin",
    c: "project",
    d: "opencode",
  });
  // Without any file, the plugin options alone apply.
  expect(loadSettings("none", defaults, { enabled: false }, project)).toEqual({ ...defaults, enabled: false });
  expect(loadSettings("none", defaults, undefined, project)).toEqual(defaults);
});

test("missing, invalid and non-object files are ignored; unknown keys pass through untouched", () => {
  write(path.join(sharedConfigDir(), "bad.json"), "{ not json");
  write(path.join(project, ".agents", "bad.json"), "[1, 2]");
  write(path.join(project, ".opencode", "bad.json"), '"a string"');
  const plugin = { jev: { provider: "pi-only" }, compact: { enabled: true } };
  expect(loadSettings("bad", { a: 1, jev: { model: "x" } }, plugin, project)).toEqual({ a: 1, jev: { model: "x", provider: "pi-only" }, compact: { enabled: true } });
  expect(readJson(path.join(root, "nope.json"))).toBeUndefined();
});

test("a file is re-read when its mtime changes, and forgotten when removed", () => {
  const file = path.join(sharedConfigDir(), "live.json");
  write(file, { v: 1 }, 1_000);
  expect(readJson(file)).toEqual({ v: 1 });
  write(file, { v: 2 }, 1_000);
  expect(readJson(file)).toEqual({ v: 1 });
  write(file, { v: 3 }, 2_000);
  expect(readJson(file)).toEqual({ v: 3 });
  rmSync(file);
  expect(readJson(file)).toBeUndefined();
});

test("currentOptions layers the plugin's files over its defaults; resolveOptions is the plugin layer alone", () => {
  write(path.join(sharedConfigDir(), `${NAME}.json`), { enabled: false, jev: { timeoutMs: 9 }, thresholds: { impact: 2 }, readOnlyCommands: ["bd"] });
  write(path.join(project, ".agents", `${NAME}.json`), { pushBack: false });
  write(path.join(project, ".opencode", `${NAME}.json`), { enabled: true });
  expect(currentOptions({ allowTools: ["task"], thresholds: { rule: 0.5 } }, project)).toEqual({
    ...DEFAULT_OPTIONS,
    enabled: true,
    pushBack: false,
    allowTools: ["task"],
    readOnlyCommands: ["bd"],
    jev: { ...DEFAULT_OPTIONS.jev, timeoutMs: 9 },
    thresholds: { ...DEFAULT_OPTIONS.thresholds, impact: 2, rule: 0.5 },
  });
  expect(resolveOptions({ pushBack: false })).toEqual({ ...DEFAULT_OPTIONS, pushBack: false });
});
