// Read-only bash parsing and the always-held list, ported unchanged from pi-tool-gate except for
// an optional `project` directory (opencode's bash can run in a `workdir` other than the project).
import { homedir } from "node:os";
import path from "node:path";

/** Programs that only read, whatever their arguments (special cases are checked below). */
const READ_ONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "wc", "rg", "grep", "egrep", "fgrep", "ag", "fd", "find",
  "tree", "pwd", "echo", "printf", "which", "type", "whoami", "id", "date", "uname", "hostname", "env",
  "printenv", "stat", "file", "du", "df", "diff", "cmp", "sort", "uniq", "cut", "tr", "column", "nl", "jq",
  "yq", "basename", "dirname", "realpath", "readlink", "sha256sum", "shasum", "md5", "md5sum", "true",
  "false", "test", "ps", "uptime", "sed", "awk", "comm", "tac", "rev", "xxd", "od", "strings", "man",
  "tldr", "history", "lsof", "cd", "sleep", "dig", "nslookup", "host", "ping", "traceroute", "ss",
  "netstat", "ifconfig", "ip", "free", "vm_stat", "top", "htop", "pgrep", "nproc", "sysctl", "sw_vers",
  "lsblk", "mount", "groups", "locale", "tput", "xxd", "base64", "sha1sum", "cksum", "column",
]);

/** `<tool> <sub>` subcommands of other CLIs that only read. */
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  docker: new Set(["ps", "logs", "inspect", "images", "image", "stats", "top", "version", "info", "port", "diff", "history", "network", "volume", "context", "events"]),
  podman: new Set(["ps", "logs", "inspect", "images", "stats", "top", "version", "info", "port"]),
  kubectl: new Set(["get", "describe", "logs", "explain", "top", "version", "api-resources", "config"]),
  gh: new Set(["pr", "issue", "run", "repo", "release", "search", "status", "workflow"]),
  systemctl: new Set(["status", "is-active", "is-enabled", "is-failed", "list-units", "list-unit-files", "show", "cat"]),
  journalctl: new Set(["*"]),
  launchctl: new Set(["list", "print"]),
  sqlite3: new Set(["-readonly"]),
};

/** Words that make a CLI subcommand change something, e.g. `gh pr merge`, `docker network rm`. */
const MUTATING_WORDS = /^(create|delete|rm|remove|merge|close|reopen|edit|comment|review|approve|apply|set|add|prune|kill|stop|start|restart|run|exec|cp|push|pull|login|logout|enable|disable|mask|unmask|reload|deploy|upload|download|clone|fork|rename|archive|transfer|sync|cancel|rerun|dispatch|use-context|set-context|delete-context|connect|disconnect|update|upgrade|install|uninstall|write|import|export|tag|untag|load|save|build|commit|attach|pause|unpause|scale|rollout|patch|replace|label|annotate|taint|drain|cordon|uncordon|expose|autoscale|certificate)$/u;

/** A plain HTTP GET with curl or wget: no method, body, upload, or output file. */
function isReadOnlyFetch(name: string, args: readonly string[]): boolean {
  if (name === "curl") {
    return !args.some(
      (a, i) =>
        /^-(X|d|F|T|o|O|K|c)$/u.test(a) ||
        /^--(request|data.*|form.*|upload-file|output|remote-name.*|config|cookie-jar|json)(=|$)/u.test(a) ||
        (/^-[a-zA-Z]+$/u.test(a) && /[XdFToOKc]/u.test(a.slice(1))) ||
        (a === "-X" && args[i + 1] !== "GET"),
    );
  }
  if (name === "wget") return args.some((a) => a === "-qO-" || a === "-O-" || a === "--spider") && !args.some((a) => /^--(post|method|body)/u.test(a));
  return false;
}

/** `git <sub>` subcommands that only read. */
const READ_ONLY_GIT = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "ls-tree", "blame", "describe",
  "shortlog", "reflog", "cat-file", "grep", "remote", "tag", "config", "worktree", "stash", "merge-base",
  "name-rev", "for-each-ref", "show-ref", "rev-list", "whatchanged", "check-ignore",
]);

/** `<pm> <sub>` subcommands of package managers that only read. */
const READ_ONLY_PM: Record<string, Set<string>> = {
  npm: new Set(["ls", "list", "view", "info", "outdated", "explain", "why", "root", "prefix", "config", "help", "search"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "root"]),
  yarn: new Set(["list", "why", "info", "outdated"]),
  cargo: new Set(["tree", "metadata", "search"]),
  pip: new Set(["list", "show", "freeze"]),
  uv: new Set(["tree"]),
  brew: new Set(["list", "info", "search", "outdated", "deps", "--prefix"]),
};

/**
 * Split a shell command into simple commands at `;`, `&&`, `||`, `|`, `&` and newlines, keeping
 * quoted text intact. Each part is tokenized with quotes removed.
 */
export function splitCommand(command: string): string[][] {
  const parts: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: '"' | "'" | undefined;
  const endToken = () => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const endPart = () => {
    endToken();
    if (tokens.length) parts.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) token += command[++i];
      else token += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === "\\" && i + 1 < command.length) {
      token += command[++i];
      inToken = true;
    } else if (c === ";" || c === "\n" || c === "|" || c === "&") {
      // `2>&1` and `&>` stay inside the token stream as redirects, not separators.
      if (c === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
        token += c;
        inToken = true;
        continue;
      }
      endPart();
      if ((c === "|" || c === "&") && command[i + 1] === c) i++;
    } else if (c === " " || c === "\t") {
      endToken();
    } else {
      token += c;
      inToken = true;
    }
  }
  endPart();
  return parts;
}

/** Leading `FOO=bar` assignments and wrappers like `time`/`nice` are skipped. */
function program(tokens: string[]): { name: string; args: string[] } | undefined {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[i] as string)) i++;
  while (i < tokens.length && ["time", "nice", "command", "builtin"].includes(tokens[i] as string)) i++;
  const name = tokens[i];
  return name === undefined ? undefined : { name: path.basename(name), args: tokens.slice(i + 1) };
}

/** Output redirects other than to /dev/null or fd duplication, e.g. `> out.txt`, `>> log`. */
export function writeRedirects(command: string): string[] {
  const targets: string[] = [];
  const re = /(?:^|[^<>&0-9])(?:[0-9]|&)?>>?\s*(?!&)([^\s;|&]+)/gu;
  for (const match of command.matchAll(re)) {
    const target = match[1] as string;
    if (target !== "/dev/null" && !/^&?\d$/u.test(target)) targets.push(target);
  }
  return targets;
}

/** True when every simple command in `command` only reads. */
export function isReadOnlyBash(command: string, extra: readonly string[] = []): boolean {
  if (/\$\(|`|<\(|>\(/u.test(command)) return false;
  if (writeRedirects(command).length) return false;
  const parts = splitCommand(command);
  if (parts.length === 0) return false;
  return parts.every((tokens) => {
    const p = program(tokens);
    if (!p) return true;
    const { name, args } = p;
    if (extra.includes(name)) return true;
    if (name === "git") {
      const sub = args.find((a) => !a.startsWith("-"));
      if (!sub || !READ_ONLY_GIT.has(sub)) return false;
      if (sub === "branch" && args.some((a) => /^-(d|D|m|M|c|C|-delete|-move|-copy)$/u.test(a))) return false;
      if (sub === "remote" && args.some((a) => ["add", "remove", "rm", "rename", "set-url", "prune"].includes(a))) return false;
      if (sub === "tag" && args.some((a) => /^-(d|a|s|f)$/u.test(a) || a === "--delete")) return false;
      if (sub === "config" && !args.some((a) => ["--get", "--list", "-l", "--get-all", "--show-origin"].includes(a))) return false;
      if (sub === "stash" && !args.some((a) => ["list", "show"].includes(a))) return false;
      if (sub === "worktree" && !args.includes("list")) return false;
      return true;
    }
    const pm = READ_ONLY_PM[name];
    if (pm) {
      const sub = args.find((a) => !a.startsWith("-"));
      return sub !== undefined && pm.has(sub);
    }
    if (name === "curl" || name === "wget") return isReadOnlyFetch(name, args);
    const cli = READ_ONLY_SUBCOMMANDS[name];
    if (cli) {
      if (name === "sqlite3") return args.includes("-readonly") && !args.some((a) => /^\.(output|once|save|import|backup|restore)\b/u.test(a));
      if (name === "journalctl") return !args.some((a) => /^--(vacuum|rotate|flush|sync)/u.test(a));
      if (name === "docker" && args[0] === "compose") {
        const sub = args.slice(1).find((a) => !a.startsWith("-") && !/\.(ya?ml)$/u.test(a));
        return sub !== undefined && ["ps", "logs", "config", "ls", "images", "top", "version"].includes(sub);
      }
      const words = args.filter((a) => !a.startsWith("-"));
      const sub = words[0];
      if (sub === undefined || !cli.has(sub)) return false;
      // `gh pr view` reads, `gh pr merge` does not; `docker network ls` reads, `docker network rm` does not.
      if (words.slice(1).some((w) => MUTATING_WORDS.test(w))) return false;
      if (name === "gh" && !words.slice(1).some((w) => ["view", "list", "status", "diff", "checks", "watch"].includes(w)) && sub !== "status") return false;
      if (name === "docker" && ["network", "volume", "context", "image"].includes(sub) && !words.slice(1).some((w) => ["ls", "inspect", "list"].includes(w))) return false;
      return true;
    }
    if (!READ_ONLY_PROGRAMS.has(name)) return false;
    if (name === "sed" && args.some((a) => /^-[a-zA-Z]*i/u.test(a) || a.startsWith("--in-place"))) return false;
    if (name === "find" && args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fls"].includes(a))) return false;
    if (name === "awk" && args.some((a) => /system\(|>\s*"/u.test(a))) return false;
    if (name === "env" && args.some((a) => !a.startsWith("-") && !a.includes("="))) return false;
    return true;
  });
}

const CREDENTIAL_PATTERNS = [
  /(^|\/)\.env(\.[^/]*)?$/u,
  /(^|\/)\.ssh(\/|$)/u,
  /(^|\/)auth\.json$/u,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/u,
  /(^|\/)\.aws\/credentials$/u,
  /(^|\/)\.netrc$/u,
  /(^|\/)\.npmrc$/u,
  /(^|\/)\.pypirc$/u,
  /(^|\/)credentials(\.json)?$/u,
  /\.(pem|key|p12|pfx)$/u,
];

/** Checked-in templates such as `.env.example` hold no secrets. */
const NOT_CREDENTIALS = /\.(example|sample|template|dist|defaults?)$/u;

export function isCredentialPath(file: string): boolean {
  return !NOT_CREDENTIALS.test(file) && CREDENTIAL_PATTERNS.some((re) => re.test(file));
}

/** `/`, a top-level directory, home, the project, or a parent of home or the project. */
function isProtectedDir(resolved: string, project: string): boolean {
  if (path.dirname(resolved) === "/" || resolved === "/") return true;
  const isAncestorOf = (dir: string) => dir === resolved || dir.startsWith(`${resolved}${path.sep}`);
  return isAncestorOf(homedir()) || isAncestorOf(path.resolve(project));
}

export function expandHome(file: string): string {
  if (file === "~" || file === "$HOME") return homedir();
  if (file.startsWith("~/")) return path.join(homedir(), file.slice(2));
  if (file.startsWith("$HOME/")) return path.join(homedir(), file.slice(6));
  return file;
}

/**
 * Reasons this bash command must be put to the user whatever Jev says, or [] when none apply.
 * `cwd` is where the command runs (relative paths resolve against it), `branch` the current git
 * branch, for force-pushes without an explicit refspec, and `project` the project directory
 * (the one `rm` must not delete), when the command runs somewhere else.
 */
export function alwaysAskBash(command: string, cwd: string, branch?: string, project = cwd): string[] {
  const reasons: string[] = [];
  const parts = splitCommand(command);
  for (const tokens of parts) {
    const p = program(tokens);
    if (!p) continue;
    const { name, args } = p;
    if (name === "sudo" || name === "doas") reasons.push("runs as root (sudo)");
    if (name === "rm" || name === "rmdir" || name === "trash") {
      for (const target of args.filter((a) => !a.startsWith("-"))) {
        if (isProtectedDir(path.resolve(cwd, expandHome(target)), project)) {
          reasons.push(`deletes ${target}, the project, your home directory, or a parent of either`);
          break;
        }
      }
    }
    if (name === "git" && args.find((a) => !a.startsWith("-")) === "push") {
      const force = args.some((a) => a === "-f" || a === "--force" || a.startsWith("--force-with-lease") || a === "--mirror" || /^\+/u.test(a));
      const refs = args.filter((a) => !a.startsWith("-")).slice(1);
      const mentionsMain = refs.some((a) => /(^|[:+/])(main|master)$/u.test(a));
      const onMain = refs.length <= 1 && (branch === "main" || branch === "master");
      if (force && (mentionsMain || onMain)) reasons.push("force-pushes main/master");
    }
  }
  if (/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/u.test(command)) reasons.push("pipes a download into a shell");
  for (const tokens of parts) {
    for (const token of tokens) {
      if (isCredentialPath(expandHome(token))) {
        reasons.push(`touches credentials (${token})`);
        break;
      }
    }
  }
  return [...new Set(reasons)];
}

/** Reasons a write/edit to `file` must be held whatever Jev says, or []. */
export function alwaysAskPath(file: string): string[] {
  const reasons: string[] = [];
  if (isCredentialPath(expandHome(file))) reasons.push(`touches credentials (${file})`);
  return reasons;
}

/** The files an `apply_patch` patch (`*** Add|Update|Delete File: path`) touches, in order. */
export function patchFiles(patchText: string): string[] {
  const files: string[] = [];
  for (const match of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gmu)) files.push(match[1] as string);
  return [...new Set(files)];
}

/** A key for "allow similar for this session": the first two words of a bash command. */
export function bashKey(command: string): string {
  const first = splitCommand(command)[0] ?? [];
  const p = program(first);
  if (!p) return command.trim().slice(0, 40);
  const sub = p.args.find((a) => !a.startsWith("-"));
  return sub ? `${p.name} ${sub}` : p.name;
}
