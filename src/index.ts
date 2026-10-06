// opencode-tool-gate: auto-approves tool calls. Fixed rules settle the clear cases (read-only calls
// run, a short list of dangerous ones is always held); Jev judges the gray zone. A held call is
// blocked with Jev's explanation and suggested workaround, in `tool.execute.before`, which is the
// only channel a server plugin has: the thrown error is what the agent reads. The agent works
// around it, or asks you with opencode's `question` tool, quoting the call, with "Allow" and "Deny"
// options; an "Allow" answer lets the identical retry through, once. Project rules in
// `.agents/tool-gate-rules.md` and `.opencode/tool-gate-rules.md` are checked on every judged
// call. Without Jev, calls fall through to opencode's own permission rules. Settings come from the
// shared `~/.config/agents/tool-gate.json` and `.agents/tool-gate.json`, the plugin options, and
// `.opencode/tool-gate.json`, read on each call (see settings.ts).
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { alwaysAskBash, alwaysAskPath, bashKey, expandHome, isCredentialPath, isReadOnlyBash, patchFiles } from "./bash.ts";
import { askJev } from "./jev.ts";
import {
  DEFAULT_THRESHOLDS,
  type Thresholds,
  WORKAROUNDS,
  judgeQuestions,
  judgeState,
  steerReason,
  suggestions,
  verdict,
  workaroundQuestion,
} from "./judge.ts";
import { loadRules } from "./rules.ts";
import { deepMerge, loadSettings } from "./settings.ts";
import { type MessageLike, clip, clipTail, recentTexts, recentUserMessages } from "./transcript.ts";

/** The plugin's name: its settings files are `<dir>/tool-gate.json`. */
export const NAME = "tool-gate";

export interface Options {
  enabled: boolean;
  jev: { model: string; timeoutMs: number };
  thresholds: Thresholds;
  /** Tools that never need a decision (they change nothing, or gate their own nested calls). */
  allowTools: string[];
  /** Extra programs treated as read-only in bash. */
  readOnlyCommands: string[];
  /** Push a held call back with Jev's workaround first; off, the agent is told to ask you straight away. */
  pushBack: boolean;
}

export const DEFAULT_OPTIONS: Options = {
  enabled: true,
  jev: { model: "jev-latest", timeoutMs: 3_000 },
  thresholds: DEFAULT_THRESHOLDS,
  allowTools: ["task", "todowrite", "todoread", "question", "skill", "websearch", "webfetch", "codesearch"],
  readOnlyCommands: [],
  pushBack: true,
};

/** Built-in tools that only read; `read` is still checked for credential files. */
const BUILTIN_READ = new Set(["read", "glob", "grep", "list", "lsp"]);

/** The label the user picks on the agent's question to let a held call run, or to decline it. */
export const ALLOW_LABEL = "Allow";
export const DENY_LABEL = "Deny";

export const DECLINED = "The user declined this call. Do not retry it; continue without it, or ask the user how to proceed.";

type Args = Record<string, unknown>;
type Client = PluginInput["client"];

type Plan =
  | { kind: "allow"; why: string }
  | { kind: "ask"; reasons: string[]; key: string; args: string }
  | { kind: "judge"; args: string; key: string };

interface Held {
  tool: string;
  /** The exact call: tool and normalized args. */
  exact: string;
  /** Same program and subcommand, or same directory: one push-back per family per user turn. */
  family: string;
  /** What the agent's question to the user must quote. */
  target: string;
  /** Why it was held, one line. */
  summary: string;
}

interface SessionState {
  /** Exact calls and families pushed back this user turn. */
  pushedBack: Set<string>;
  /** Held calls the user may still answer, by exact key. */
  pending: Map<string, Held>;
  /** Exact calls the user allowed once. */
  approved: Set<string>;
  /** Exact calls the user declined this turn. */
  denied: Set<string>;
  git: Map<string, Promise<GitInfo | undefined>>;
}

interface GitInfo {
  branch: string;
  dirty: boolean;
}

/** The plugin options from opencode.jsonc over the defaults: that layer alone, without the shared files. */
export function resolveOptions(raw: Record<string, unknown> | undefined): Options {
  return deepMerge(DEFAULT_OPTIONS, raw);
}

/**
 * The options in force now: defaults, `~/.config/agents/tool-gate.json`, the plugin options,
 * `<directory>/.agents/tool-gate.json`, then `<directory>/.opencode/tool-gate.json`.
 */
export function currentOptions(raw: Record<string, unknown> | undefined, directory: string): Options {
  return loadSettings(NAME, DEFAULT_OPTIONS, raw, directory);
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** The file a read, edit or write touches (opencode's `filePath`; pi's `path` is accepted too). */
const fileOf = (args: Args) => str(args.filePath) || str(args.path);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Args)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Args)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The exact call, for approvals: bash by command and directory (not its description), others by args. */
export function exactKey(tool: string, args: Args): string {
  if (tool === "bash") return `bash\0${str(args.workdir)}\0${str(args.command).trim()}`;
  return `${tool}\0${stableJson(args)}`;
}

/** What the agent's question to the user has to quote: the command, the file, or the arguments. */
export function targetOf(tool: string, args: Args): string {
  if (tool === "bash") return str(args.command).trim().slice(0, 300);
  if (tool === "apply_patch") return patchFiles(str(args.patchText)).join(", ").slice(0, 300);
  const file = fileOf(args);
  if (file) return file;
  return JSON.stringify(args).slice(0, 300);
}

export function describeCall(tool: string, args: Args): string {
  if (tool === "bash") return `bash: ${clip(str(args.command).trim(), 200)}`;
  if (tool === "apply_patch") return `apply_patch: ${clip(patchFiles(str(args.patchText)).join(", "), 200)}`;
  const file = fileOf(args);
  if (file) return `${tool}: ${file}`;
  return `${tool}: ${clip(JSON.stringify(args), 200)}`;
}

/** Text compared loosely: backticks and backslashes dropped, whitespace collapsed. */
export function normalize(text: string): string {
  return text.replace(/[`\\]/gu, "").replace(/\s+/gu, " ").trim();
}

const isAllow = (label: string) => /^allow\b/iu.test(label.trim());
const isDeny = (label: string) => /^(deny|block|decline)\b/iu.test(label.trim());

interface QuestionLike {
  question?: string;
  header?: string;
  options?: { label?: string; description?: string }[];
}

/** The labels chosen for each question, from the question tool's metadata or, failing that, its text. */
export function questionAnswers(output: { output?: string; metadata?: unknown }): string[][] {
  const meta = output.metadata as { answers?: unknown } | undefined;
  if (Array.isArray(meta?.answers)) {
    return meta.answers.map((a) => (Array.isArray(a) ? a.map(String) : typeof a === "string" ? [a] : []));
  }
  const answers: string[][] = [];
  for (const match of str(output.output).matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/gu)) {
    answers.push((match[2] as string).split(", ").map((s) => s.trim()));
  }
  return answers;
}

const execFileAsync = promisify(execFile);

async function gitInfo(cwd: string): Promise<GitInfo | undefined> {
  try {
    const branch = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], { timeout: 2_000 });
    const dirty = await execFileAsync("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=no"], { timeout: 2_000 });
    return { branch: branch.stdout.trim() || "(detached)", dirty: dirty.stdout.trim().length > 0 };
  } catch {
    return undefined;
  }
}

/**
 * `options` is read on every tool call when it is a function (the server passes one that merges
 * the settings files), so edits apply without a restart.
 */
export async function createHooks(
  client: Client,
  options: Options | (() => Options),
  directory: string,
  deps: { fetch?: typeof fetch; git?: (cwd: string) => Promise<GitInfo | undefined> } = {},
): Promise<Hooks> {
  const optionsNow = typeof options === "function" ? options : () => options;
  const sessions = new Map<string, SessionState>();
  const session = (id: string): SessionState => {
    let s = sessions.get(id);
    if (!s) {
      s = { pushedBack: new Set(), pending: new Map(), approved: new Set(), denied: new Set(), git: new Map() };
      sessions.set(id, s);
    }
    return s;
  };
  const jevOptionsFor = (options: Options) => ({ model: options.jev.model, timeoutMs: options.jev.timeoutMs, ...(deps.fetch ? { fetch: deps.fetch } : {}) });

  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: "tool-gate", level, message, ...(extra ? { extra } : {}) } }).catch(() => undefined);

  const git = (s: SessionState, cwd: string) => {
    let info = s.git.get(cwd);
    if (!info) {
      info = (deps.git ?? gitInfo)(cwd);
      s.git.set(cwd, info);
    }
    return info;
  };

  const plan = async (options: Options, s: SessionState, tool: string, args: Args, cwd: string): Promise<Plan> => {
    if (options.allowTools.includes(tool)) return { kind: "allow", why: "allow list" };
    if (tool === "bash") {
      const command = str(args.command);
      const reasons = alwaysAskBash(command, cwd, (await git(s, cwd))?.branch, directory);
      if (reasons.length) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}`, args: clip(command, 6_000) };
      if (isReadOnlyBash(command, options.readOnlyCommands)) return { kind: "allow", why: "read-only command" };
      return { kind: "judge", args: clip(command, 6_000), key: `bash:${bashKey(command)}` };
    }
    if (tool === "edit" || tool === "write") {
      const file = fileOf(args);
      const reasons = alwaysAskPath(file);
      if (reasons.length) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}`, args: clip(JSON.stringify(args), 6_000) };
      const dir = path.dirname(path.resolve(cwd, expandHome(file)));
      return { kind: "judge", args: clip(JSON.stringify(args), 6_000), key: `${tool}:${dir}` };
    }
    if (tool === "apply_patch") {
      const files = patchFiles(str(args.patchText));
      const reasons = [...new Set(files.flatMap(alwaysAskPath))];
      if (reasons.length) return { kind: "ask", reasons, key: `fixed:${reasons.join("; ")}`, args: clip(str(args.patchText), 6_000) };
      const dir = path.dirname(path.resolve(cwd, expandHome(files[0] ?? ".")));
      return { kind: "judge", args: clip(str(args.patchText), 6_000), key: `apply_patch:${dir}` };
    }
    if (BUILTIN_READ.has(tool)) {
      const file = fileOf(args);
      if (tool === "read" && file && isCredentialPath(expandHome(file))) {
        return { kind: "ask", reasons: [`reads credentials (${file})`], key: `read:${file}`, args: clip(JSON.stringify(args), 2_000) };
      }
      return { kind: "allow", why: "read-only tool" };
    }
    return { kind: "judge", args: clip(JSON.stringify(args), 6_000), key: `tool:${tool}` };
  };

  /** The state Jev judges a call in. */
  const judgeStateFor = async (sessionID: string, s: SessionState, cwd: string, tool: string, args: Args, argsText: string, rules: readonly string[]) => {
    let messages: MessageLike[] = [];
    try {
      const { data } = await client.session.messages({ path: { id: sessionID } });
      messages = (data ?? []) as unknown as MessageLike[];
    } catch {
      // No transcript: Jev judges the call on its own.
    }
    return judgeState({
      userRequest: recentUserMessages(messages, 3).map((text, i, all) => clip(text, i === all.length - 1 ? 3_000 : 1_000)),
      recentIntent: clipTail(recentTexts(messages).assistant, 2_000),
      cwd,
      git: await git(s, cwd),
      tool,
      args: argsText,
      ...(tool === "bash" && str(args.description) ? { description: clip(str(args.description), 300) } : {}),
      rules,
    });
  };

  /**
   * A held call. The first time in a user turn (per call or family) it is blocked with Jev's
   * explanation and suggested workaround; the agent works around it, or asks the user with the
   * question tool and retries the identical call once they allow it. A retry without their answer
   * is blocked again, with the same instructions.
   */
  const hold = async (
    options: Options,
    s: SessionState,
    h: Held & { reason: string; state: Record<string, unknown> },
  ): Promise<never> => {
    const { reason, state, ...held } = h;
    s.pending.set(held.exact, held);
    const call = `${held.tool}: ${held.target}`;
    const howToAsk = (why: string) =>
      `ask the user with the \`question\` tool: one question that quotes the call verbatim (${held.target}) ` +
      `and says ${why}, with two options labeled exactly "${ALLOW_LABEL}" and "${DENY_LABEL}". ` +
      `If they answer ${ALLOW_LABEL}, make the identical call again and it will run. Retrying without their answer is blocked.`;
    const repeat = s.pushedBack.has(held.exact) || s.pushedBack.has(held.family);
    s.pushedBack.add(held.exact);
    s.pushedBack.add(held.family);
    if (options.pushBack && !repeat) {
      const suggestion = await askJev({ ...state, held_because: reason }, workaroundQuestion(), jevOptionsFor(options));
      const ideas = suggestion.ok ? suggestions(suggestion.answers) : [];
      const noWorkaround = ideas[0] === WORKAROUNDS.user_only;
      const advice = noWorkaround
        ? "Jev sees no workaround: whether to do this is the user's decision."
        : ideas.length
          ? `Jev suggests: ${ideas.join("; or ")}.`
          : "Look for a safer way: reversible, local, narrower, or previewed first.";
      await log("info", `pushed back: ${call}`, { held: held.summary, workaround: ideas[0] ?? "(none)" });
      throw new Error(
        `${reason}\n${advice}\nThe user has not been asked. ` +
          (noWorkaround
            ? `If the call still seems worth it, ${howToAsk("why this exact call is needed")}`
            : `Get the job done another way if you can. If no workaround is good enough, ${howToAsk("why this exact call is needed and why the workarounds fall short")}`) +
          " If it is not worth raising, carry on without it.",
      );
    }
    await log("info", `${repeat ? "held again" : "held"}: ${call}`, { held: held.summary });
    throw new Error(
      `${reason}\n${repeat ? "Still held: the user has not answered." : "The user has not been asked."} ` +
        `To run it, ${howToAsk("why this exact call is needed")} Otherwise carry on without it.`,
    );
  };

  return {
    "tool.execute.before": async (input, output) => {
      const options = optionsNow();
      if (!options.enabled) return;
      const tool = input.tool;
      const args = ((output.args ?? {}) as Args);
      const s = session(input.sessionID);
      const cwd = (tool === "bash" && str(args.workdir)) || directory;
      const p = await plan(options, s, tool, args, cwd);
      const call = describeCall(tool, args);

      if (p.kind === "allow") {
        await log("info", `allow: ${call}`, { why: p.why });
        return;
      }

      const exact = exactKey(tool, args);
      if (s.approved.has(exact)) {
        s.approved.delete(exact);
        s.pending.delete(exact);
        await log("info", `allow: ${call}`, { why: "the user allowed it once" });
        return;
      }
      if (s.denied.has(exact)) {
        await log("info", `blocked: ${call}`, { why: "the user declined it" });
        throw new Error(DECLINED);
      }

      if (p.kind === "ask") {
        const why = p.reasons.join("; ");
        return hold(options, s, {
          tool,
          exact,
          family: p.key,
          target: targetOf(tool, args),
          summary: why,
          reason: `tool-gate held this ${tool} call: it ${why}. Calls like this are always held, whatever Jev says.`,
          state: await judgeStateFor(input.sessionID, s, cwd, tool, args, p.args, []),
        });
      }

      const rules = loadRules(directory);
      const state = await judgeStateFor(input.sessionID, s, cwd, tool, args, p.args, rules);
      const outcome = await askJev(state, judgeQuestions(rules), jevOptionsFor(options));

      if (!outcome.ok) {
        await log("warn", `allow: ${call}`, { why: `Jev unavailable (${outcome.reason}); opencode's own permission rules apply` });
        return;
      }

      const v = verdict(outcome.answers, rules, options.thresholds);
      const action = !v || v.allow ? "allow" : "hold";
      await log("info", `${action}: ${call}`, {
        why: action === "allow" ? "Jev" : v!.failures.join("; "),
        scores: v?.scores,
        latencyMs: outcome.latencyMs,
        ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      });
      if (action === "allow") return;
      const brokenRules = v!.brokenRules.length ? ` (${v!.brokenRules.map((r) => `"${clip(r, 120)}"`).join(", ")})` : "";
      return hold(options, s, {
        tool,
        exact,
        family: p.key,
        target: targetOf(tool, args),
        summary: `${v!.failures.join("; ")}${brokenRules}`,
        reason: steerReason(tool, v!),
        state,
      });
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "question") return;
      const s = sessions.get(input.sessionID);
      if (!s || s.pending.size === 0) return;
      const questions = ((input.args as { questions?: QuestionLike[] } | undefined)?.questions ?? []);
      const answers = questionAnswers(output);
      for (const [i, q] of questions.entries()) {
        const chosen = answers[i] ?? [];
        const decision = chosen.some(isDeny) ? "deny" : chosen.some(isAllow) ? "allow" : undefined;
        if (!decision) continue;
        const haystack = normalize([q.header, q.question, ...(q.options ?? []).map((o) => `${o.label ?? ""} ${o.description ?? ""}`)].join(" "));
        const matched = [...s.pending.values()].filter((h) => h.target && haystack.includes(normalize(h.target)));
        if (!matched.length) {
          await log("warn", `question answered "${chosen.join(", ")}" but quotes no held call`, { question: clip(str(q.question), 200) });
          continue;
        }
        for (const h of matched) {
          s.pending.delete(h.exact);
          (decision === "allow" ? s.approved : s.denied).add(h.exact);
          await log("info", `user ${decision === "allow" ? "allowed" : "declined"}: ${h.tool} ${h.target}`);
        }
      }
    },

    "chat.message": async (input) => {
      // A new user turn starts over: push-backs, grants and refusals belong to the turn they were made in.
      const s = sessions.get(input.sessionID);
      if (!s) return;
      s.pushedBack.clear();
      s.pending.clear();
      s.approved.clear();
      s.denied.clear();
      s.git.clear();
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") sessions.delete((event.properties as { info: { id: string } }).info.id);
    },
  };
}

const server: Plugin = async (input, options) =>
  createHooks(input.client, () => currentOptions(options, input.directory), input.directory);

export default { id: NAME, server };
