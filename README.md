# opencode-tool-gate

An [opencode](https://opencode.ai) plugin that auto-approves tool calls, so you are only pulled in
when a call is risky and the agent could not find a way around it. The port of
[pi-tool-gate](https://github.com/justmytwospence/pi-tool-gate), with the same read-only parsing,
always-held list, Jev questions and thresholds.

1. **Clear cases, no model call.** Read-only calls run: the built-in `read`, `glob`, `grep`, `list`
   and `lsp`, the tools in `allowTools` (`task`, `todowrite`, `question`, `skill`, `websearch`,
   `webfetch`, ...), and bash made only of read-only programs (`ls`, `rg`, `git status|diff|log`,
   `npm ls`, `curl`/`wget` GETs, `docker ps|logs|inspect`, `docker compose ps|logs|config`,
   `kubectl get|describe|logs`, `gh pr|issue|run view|list`, `systemctl status`, `journalctl`,
   `sqlite3 -readonly`, `dig`, ... with no writing redirects or command substitution). A short list
   is always held, whatever Jev says: `sudo`, deleting `/`, a top-level directory, your home
   directory, the project, or a parent of either, force-pushing main/master, `curl … | sh`, and
   touching credential files (`.env*` but not `.env.example`, `~/.ssh`, `auth.json`, keys). Writes
   and deletes elsewhere outside the project go to Jev.
2. **Jev for the gray zone, holding only on confident danger.** Edits, writes, patches, other bash
   commands, and MCP tools go to [Jev](https://docs.typesafe.ai), TypeSafe's System One model, in
   one request (about 250 ms). A call is held only when Jev is confident it is dangerous:
   - it cannot be undone (>= 0.9),
   - it does something other people see or depend on (>= 0.85: deploy, publish, post a message,
     open or merge a PR, modify a shared or cloud resource) and you did not directly ask for it
     (< 0.8); pushing commits to a git branch and maintaining your own machines over ssh do not count,
   - it sends secrets or private data off the machine (>= 0.8),
   - its impact if unwanted is 2.5 or more of 3 (lost data, leaked secrets, broken production),
   - it is clearly unrelated to your request (< 0.1) and could do harm (impact >= 1.5),
   - or it breaks a project rule (>= 0.7).

   Doubt alone never holds a call: an investigation command Jev is unsure is on-task still runs.
   Jev sees your last three messages, the agent's latest explanation, the agent's one-line
   description of a bash command, the working directory and git branch.
3. **Jev pushes back, the agent works around it or asks you.** A held call is blocked before it
   runs (and before opencode's own permission check); the error the agent reads carries Jev's
   explanation (which checks failed and how sure it is, plus any quoted rules) and a suggested
   workaround, which Jev picks in a second request made only for held calls: preview it with a dry
   run, narrow it, make it reversible, keep it local, follow the project rule, skip it, or "no
   workaround, this is the user's call". The agent then does the job another way, drops the call,
   or asks you with opencode's built-in `question` tool: one question that quotes the call verbatim
   and says why it is needed, with options labeled `Allow` and `Deny`. Answering `Allow` lets that
   exact call (same tool, same arguments) through once; `Deny` blocks it for the rest of the turn.
   A retry without your answer is blocked again, with the same instructions, so the agent cannot
   approve its own call. Set `"pushBack": false` to skip the workaround and have the agent ask you
   straight away.

Subagent sessions (the `task` tool) go through the same gate. In `opencode run`, the `question`
tool is denied, so a held call simply stays blocked.

opencode's own `permission` rules still apply after the gate lets a call through: a command your
config sets to `ask` (say `sudo *`) is held by the gate first, then asked by opencode.

Without `TYPESAFE_API_KEY`, or when Jev fails or takes over 3 s, judged calls fall through to
opencode's own permission rules (logged as a warning); the always-held list still holds. Each
decision is logged under the `tool-gate` service with Jev's scores and latency
(`opencode run --print-logs`).

## Project rules

Each top-level bullet in `<project>/.opencode/tool-gate-rules.md` and
`~/.config/opencode/tool-gate-rules.md` is a rule (at most 30), checked on every judged call. A
project or home with only pi's files (`.pi/tool-gate-rules.md`, `~/.pi/agent/tool-gate-rules.md`)
is read as a fallback.

```markdown
- Migrations are append-only: never edit an existing migration, add a new one.
- No new runtime dependencies without asking.
```

## Install

In `opencode.jsonc`, pinned to a commit:

```jsonc
"plugin": [
  ["opencode-tool-gate@github:justmytwospence/opencode-tool-gate#<commit>", {
    // all optional; defaults shown
    "enabled": true,
    "jev": { "model": "jev-latest", "timeoutMs": 3000 },
    "thresholds": {
      "irreversible": 0.9, "remoteChange": 0.85, "requested": 0.8, "exfiltration": 0.8,
      "impact": 2.5, "offTask": 0.1, "offTaskImpact": 1.5, "rule": 0.7
    },
    "allowTools": ["task", "todowrite", "todoread", "question", "skill", "websearch", "webfetch", "codesearch"],
    "readOnlyCommands": [],
    "pushBack": true
  }]
]
```

`allowTools` replaces the default list. `task` is allowed because each tool a subagent calls is
gated on its own; `webfetch` only does GETs. `readOnlyCommands` adds programs (say `bd`) treated
as read-only in bash. Needs `TYPESAFE_API_KEY` in opencode's environment. Tested with opencode
1.18.29.

## Differences from pi-tool-gate

- No `/gate` command, status line or toasts: a server plugin cannot register commands or draw UI.
  Turn the gate off with `"enabled": false` in the plugin options.
- No "allow similar for this session": approval is per exact call, through the `question` tool.
- Without Jev, pi asked you about calls its tool hints flagged; opencode plugins cannot see tool
  annotations, so judged calls fall through to opencode's own permission rules instead.
- Jev's token usage is logged, not added to the tool result.

## Development

```sh
npm install
npm run check   # typecheck and tests
```

Try a local checkout in place of the pin: opencode dedupes plugins by package name and the later
config wins, so

```sh
printf '{"plugin":["opencode-tool-gate@file:'"$PWD"'"]}' > /tmp/try.json
OPENCODE_CONFIG=/tmp/try.json opencode
```

links this checkout instead of the pinned commit.
