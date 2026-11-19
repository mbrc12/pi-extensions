# Permissions v2: policy file + kernel sandbox

Replace the regex/LLM gate in `extensions/tools/permissions/` with two enforcers over one
declarative policy file at `~/.pi/agent/permissions.json`.

## 1. Why: what the current system costs and misses

Measured over 57,146 `bash` calls in 501 sessions (2026-07-04 → 2026-11-18):

| Class | Calls | Share |
|---|---|---|
| Read-only (no write target) | 34,881 | 61.0% |
| Write inside policy roots | 20,363 | 35.6% |
| Write outside policy roots (would be denied) | 1,902 | 3.3% |
| Touches credential paths | 1,416 | 2.5% |
| Network commands | 6,989 | 12.2% |

- Denials are rare: **8.5% of write commands**, and 44% of sessions (220/501) never hit one.
- Denials cluster: median **3 distinct outside roots** per affected session, mean 7.2, max 134.
- So grant-and-retry costs about **1.3 prompts per session** on average. Acceptable.
- The current gate cannot enforce any of this: it pattern-matches command text, so `bash -c`,
  quoting, `python -c`, base64 and wrappers are out of scope, and the LLM classifier decides
  by judgment rather than by boundary.
- Sandbox overhead is ~6.5 ms per `bash` call (20 sandboxed spawns 157 ms vs 24 ms unsandboxed).

## 2. Architecture

- **One policy file**: `~/.pi/agent/permissions.json`. Single source of truth for paths, network,
  per-tool overrides, grant behavior.
- **Two enforcers**:
  - *Kernel* (Seatbelt via `sandbox-exec`) for everything that leaves the pi process: `bash`,
    `!` commands, `py_explore`, nested processes.
  - *Tool middleware* (`tool_call` hook) for in-process file tools: `read`, `write`, `edit`,
    `grep`, `find`, `ls`. These are Node `fs` calls and no process sandbox can see them.
- **Precedence everywhere**: `deny` › `allow` › implicit `ask`. Matches Claude Code, so muscle
  memory transfers.
- **Reads are a denylist. Writes are an allowlist.** Reads: everything except `deny`. Writes:
  workspace + `write` roots + caches + temp; anything else is `ask` (grant-and-retry) or denied in
  headless mode.

## 3. Policy file: `~/.pi/agent/permissions.json`

Seven keys, one job each.

```json
{
  "enabled": true,
  "deny": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.netrc", "~/.git-credentials",
           "~/.kube", "~/.docker/config.json", "~/.pi/agent/auth.json", "~/.pi/agent/auth"],
  "write": ["<workspace>", "~/dev/tmp/random-tasks", "~/dev/micromamba/envs/env-1",
            "/tmp", "/private/tmp", "/var/folders", "/private/var/folders",
            "~/.cache", "~/Library/Caches", "~/.npm", "~/.local/share",
            "~/.cargo/registry", "~/.rustup/toolchains", "~/.micromamba/pkgs"],
  "network": "allow",
  "commands": { "prompt": ["\\bsudo\\b", "\\bgit\\s+push\\b.*--force", "..."] },
  "maxGrants": 20,
  "log": "~/.pi/sandbox/denials.jsonl"
}
```

| Key | Meaning |
|---|---|
| `enabled` | kill switch: `false` disables the gate and the sandbox entirely |
| `deny` | paths no grant can open, for reads or writes |
| `write` | writable roots; `<workspace>` is the session workspace |
| `network` | `allow` or `deny` for child processes; Seatbelt cannot filter by host |
| `commands.prompt` | regexes that force a prompt even when paths are allowed |
| `maxGrants` | grant dialogs per session before denials become final |
| `log` | append-only JSONL of denials |

Deliberately absent: everything the code can decide. The profile directory, `sandbox-exec`, the
device files children need (`/dev/null`, `/dev/std*`), the tool-to-enforcer mapping, and the grants
file path are constants, because a knob that silently breaks the sandbox is a trap, not a feature.

## 4. Local grants: `~/.pi/agent/permissions.local.json`

Policy is shared and versioned; grants are machine-local state. Same split as `trust.json`, which
already stores per-folder decisions in `~/.pi/agent/`.

```json
{
  "version": 1,
  "folders": {
    "/Users/subwave/dev/pi": {
      "write": ["/Users/subwave/dev/pi", "/Users/subwave/dev/pi-notes"],
      "network": true,
      "deny": [],
      "updated": "2026-11-19T01:20:00Z"
    },
    "/Users/subwave/dev/chem/molsim/alchem27": {
      "write": ["/Volumes/Storage-1/kiki-offload"],
      "network": false,
      "deny": ["/Volumes/Storage-1/kiki-offload/raw"],
      "updated": "2026-11-12T09:03:00Z"
    }
  }
}
```

- **Keyed by the folder a session starts in**, using the session's `cwd`.
- **Lookup:** exact match, else the nearest ancestor folder that has an entry (the walk
  `trust.json` already uses). No entry → policy defaults only.
- **Applied at `session_start`:** entry loaded, profile rendered, in-process tool policy built. A
  grant added mid-session rewrites the profile immediately; no restart.
- **Precedence:** `policy.deny` (never grantable) › `policy.write` ›
  `folder.write` › `folder.deny` (additive, lets one checkout be stricter) › implicit `ask`.
- **Refuses keys at `/` and `$HOME`.** A session started in `~` gets no folder grants; grants
  require a named subdirectory.
- **Writes are atomic**: temp file plus rename, re-read and merge before writing, one retry on
  conflict, mode `0600`. Subagents really do run concurrently and write here.
- **`updated`** lets `/permissions` list and prune entries for folders that no longer exist.
- **Self-grant is impossible.** `~/.pi/agent` is in no write allowlist, so sandboxed `bash` cannot
  edit this file. Only the in-process extension writes it.

## 5. Enforcement points

| Surface | Enforcer | Wiring |
|---|---|---|
| `bash` tool, `!` commands, all children | Seatbelt | `shellPath` → wrapper script |
| `py_explore` | Seatbelt | prefix `spawn()` with `sandbox-exec -f <profile>` |
| `read`/`write`/`edit`/`grep`/`find`/`ls` | tool middleware | `tool_call` hook path check |
| `subagent`/`multiagent` | inherited | child pi reads same settings + policy file |
| `web_use`, `deslop`, `notify-on-idle` | none | harness-owned, not model-authored commands |

Wrapper:

```bash
#!/bin/bash
# ~/.local/bin/pi-sandboxed-bash
profile="$HOME/.pi/sandbox/sessions/${PI_SESSION_ID}.sb"
[[ -f $profile ]] || exec /bin/bash "$@"          # no profile yet: unsandboxed
exec /usr/bin/sandbox-exec -f "$profile" /bin/bash "$@"
```

- `PI_SESSION_ID` is exported to children, so the profile path needs no env mutation.
- The permissions extension writes `<session-id>.sb` at `session_start` and rewrites it on every
  grant. `sandbox-exec` reads the file at exec time, so no restart is needed.
- `!` commands are sandboxed by the same path. Provide `/sandbox off` for one deliberate
  unsandboxed command, and list current grants in the status line.

## 6. Grant-and-retry

1. `tool_result` hook inspects results for sandbox denials:
   `Operation not permitted`, `Permission denied`, `Read-only file system`.
2. Extract **every** denied path, not just the first. Verified: a command writing to three denied
   directories reports all three in one result, because bash does not abort on `EPERM`. One dialog
   therefore covers the whole command; there is no retry ladder.
3. Resolve symlinks on each path before using it. Verified: a write through `/tmp/link/w.txt`
   is reported as `/tmp/link/w.txt`, while the kernel checked the link target. Resolve the longest
   existing prefix, then check policy against the real path.
4. Classify each path: inside `write` → not a denial. Inside `deny` → hard block, never
   offer a grant. Otherwise → grantable.
5. Dialog offers scopes, not commands:
   - `[a]` each denied path's parent directory (default, one keypress covers siblings)
   - `[w]` widen to the nearest common ancestor of all denied paths
   - `[f]` the exact file only
   - `[n]` no
   Network denials get `[g] grant network (session)`.
6. On grant: append the directory roots to this folder's entry in
   `~/.pi/agent/permissions.local.json`, regenerate the profile, re-issue the same tool call once.
   Grants are path roots, so a later command writing a *different* file in the same directory needs
   no prompt, and the next session started in that folder inherits them. `[s]` grants for the
   current session only, without touching the file. Cap: `grants.retries` (1) retries per call,
   `grants.cap` (20) grants per session. Past the cap, denials become final.
7. Annotate partial results. A command that loses writes can still exit 0, so the harness marks the
   tool result as "N writes denied, output incomplete" when any denial line is present.
8. Headless (`-p`, subagents): `ask` degrades to deny. The result text names the paths and says the
   parent session must grant them.

Never command-scoped. Storing "allow this exact command string" is string matching again, and it
fails on the next variant (`out/run2.csv`). Path roots are the only unit that survives repetition.

Why retry instead of pre-parsing: to know what a `bash` command will write you must parse it, and
that parser is the thing we are deleting. `EPERM` plus retry needs no parsing.

## 7. Subagents and multiagent

- Child pi processes inherit `~/.pi/agent/settings.json`, so `shellPath` applies and their `bash`
  is sandboxed with their own `PI_SESSION_ID` profile.
- Their permissions extension resolves the **same grants file by its own `cwd`**, so a subagent
  started in the parent folder inherits everything the parent has, with no env plumbing. A subagent
  started with a different `cwd` (multiagent accepts one) gets *that* folder's grants, which is the
  correct answer rather than a leak.
- No UI: `ask` → deny, with an explicit reason string ("denied by sandbox: no grant for <path> in
  this folder's permissions.local.json"). The operator reports the failure instead of hanging.
- Net effect, as expected: a subagent that reaches outside the allowlist **autofails**, cleanly.

## 8. Rollout

1. `shared/permissions-policy.ts`: resolve(path, op) → allow/ask/deny, plus profile renderer.
   Unit tests with fixtures. No wiring yet.
2. Shadow mode: wrapper + profile generation, `mode: "shadow"`, denials logged to
   `~/.pi/sandbox/denials.jsonl`. Run one week; diff logged denials against the 3.3% estimate.
3. In-process tool checks in shadow mode, same log.
4. Flip `mode: "enforce"`. Add `/sandbox off` and the grants status line at the same time.
5. Grant-and-retry.
6. `py_explore` sandbox prefix (blocks `~/.pip` writes if not in `write`; verify against
   `random-tasks` venv usage).
7. Subagent grant inheritance.
8. Delete `classifier.ts` (460 lines) and its tests (1,271 lines). Keep the ask dialog, keep
   `allow`/`ask` modes, keep `llm-classifier.ts` as opt-in `auto` mode only.

## 9. Known holes and costs

- **Hardlinks defeat path rules.** Measured: with `~/.ssh` denied, `ln -f ~/.ssh/known_hosts
  <workspace>/.hl` then reading it through the workspace prints the key. Unfixable at this layer;
  accept it, since an agent creating a hardlink to a credential is an overt act visible in the
  transcript.
- **Read allowlists are fragile.** A `(deny default)` profile with an explicit read allowlist
  aborted the child with `Abort trap: 6` (dyld). Start from `(allow file-read*)` plus deny.
- **`/tmp` is `/private/tmp`.** Both spellings are required in write rules.
- **Nested `pi -p` from `bash` breaks** (2.5% of calls read `~/.pi/agent/auth`, most `node`
  scripts reading pi's own auth). Those calls lose auth read and network. Workaround: use the
  `subagent` tool instead of shelling out to pi.
- **`sandbox-exec` is deprecated** but is still the only user-space Seatbelt interface and still
  ships on macOS 26.7.3. Claude Code, Codex and Agent Safehouse all depend on it.
- **A wrapper that cannot find its profile falls back to an unsandboxed shell**, printing a warning
  on stderr. Fail-open is deliberate (a broken profile must not brick every command) but it is the
  reason the `PI_SESSION_ID` bug went unnoticed for two runs.
- **Network is binary in SBPL.** No host filtering. `network: "ask"` gives one prompt per session,
  which is why the 12.2% network share does not become 12.2% prompts.

## 10. Tests

- Policy resolver: deny beats allow; `<workspace>` expansion; `~` expansion; last-match within a
  list; headless degrade to deny.
- Profile renderer: `/tmp` and `/private/tmp` both present; deny roots emitted before allows;
  workspace from cwd; grants appended.
- Escape cases, asserted as *blocked* by the kernel, not by regex: `bash -c`, `python -c`,
  symlink-through-workspace, `..` traversal, base64-decoded write, `tee`, heredoc redirect.
- Grant-and-retry: EPERM parsed, grant appended, profile rewritten, exactly one retry.
- Local grants: atomic write under concurrent writers (two processes, one merge, no lost entry);
  ancestor lookup; `$HOME` and `/` refused as keys; `policy.deny` still wins over a folder grant.
- Subagent: no-UI denial produces a failed tool call, not a hang.

## 11. Open decisions

- `network` default: `ask` (one prompt per session) vs `allow` for the first release. Denying
  breaks 12.2% of commands until granted.
- Whether `~/dev/*` (sibling repos) should be in `write`. It is the single largest denial
  class, and granting it removes most of the 1,902 denials.
- Whether a folder entry should inherit from an ancestor entry or stay exact-match only. Inheritance
  is proposed because starting a session in `dev/pi/extensions` should not re-prompt for `dev/pi`.

## 12. Implementation status

Shipped:

| Piece | Where |
|---|---|
| Policy loader, resolver, profile renderer, denial parser, grant store | `extensions/shared/permissions-policy.ts` |
| Policy gate on `tool_call`, grant dialog on `tool_result`, profile per session | `extensions/tools/permissions/index.ts` |
| `sandbox-exec` prefix for python subprocesses | `extensions/tools/py-explore/index.ts` |
| `shellPath` forwarded when built-in tools are rebuilt | `extensions/tui/minimal-tools.ts` |
| Sandboxed shell | `~/.local/bin/pi-sandboxed-bash` |
| `shellPath` wiring | `~/.pi/agent/settings.json` (backup: `settings.json.bak-prepermissions`) |
| Defaults | `~/.pi/agent/permissions.json` (seeded on first load, 7 keys) |
| Grants | `~/.pi/agent/permissions.local.json` |
| Tests | `extensions/tests/permissions-policy.test.ts` (20 tests) |

Verified by hand:

- Workspace writes, `/tmp`, `env-1` and `random-tasks` succeed inside the sandbox.
- Writes outside the allowlist fail with `Operation not permitted`; `~/.ssh` reads fail; writes to
  `~/.pi/agent` fail, so the agent cannot grant itself.
- `git status` works inside the sandbox, so the profile is not too tight for normal tooling.
- A real pi session wrote its own profile with the right workspace root.
- Grant flow: `ask` → `saveFolderGrant` → `allow`, including a different filename in the same
  directory, and the rendered profile gains the root.

Open on purpose:

- `network: "allow"`. Flipping it to `"deny"` in the policy file is a one-line change, but SBPL
  cannot filter by host, so it breaks 12.2% of commands until a network grant flow exists.
- `classifier.ts` and `llm-classifier.ts` still run for the `ask` band (paths outside the
  allowlist, and bash in classify mode). They are no longer the primary gate.
- Denial risk log: `~/.pi/sandbox/denials.jsonl` grows without rotation.

## 13. What the first live run taught us

Two defects that only a real session exposed, both now fixed:

- **`PI_SESSION_ID` is stripped from the bash child environment.** `dist/core/tools/bash.js`
  deletes it in `resolveSpawnContext` unless `exposeSessionEnvironment` is set, so a wrapper
  cannot find a session-named profile and silently falls back. Profiles are now keyed by
  `sha1(realpath(workspace))[:16]`, which the wrapper computes with `pwd -P` and `shasum`.
  Grants are per folder anyway, so this matches the store.
- **`minimal-tools.ts` rebuilt the bash tool without `shellPath`.** It calls
  `createBashTool(cwd)` and registers the result as `bash`, overriding the built-in, so
  `shellPath` in settings was ignored and every command ran unsandboxed. It now reads
  `pi.getSettings().shellPath` on `session_start`, expands `~` (the value is passed straight to
  `spawn`, which does not expand it), and rebuilds the tool with it. Any extension that
  overrides a built-in tool must forward `shellPath` the same way.

Also verified after the fix, in real `pi -p` sessions:

- `touch ~/x` → `Operation not permitted`, file absent.
- `echo test > ./ok.txt` and `echo hi > /tmp/x` → both succeed.

Removed with this pass: `llm-classifier.ts`, `cwd.ts`, and `/permissions-test-llm`. Classify mode
no longer calls a model: a rule match of `dangerous` prompts, `defer` passes, because the kernel
is the boundary and a deferred rule means "cannot be judged from the text alone". `classifier.ts`
stays as the destructive-pattern list (`git push --force`, `curl | sh`, `sudo`, package installs).

## 14. Main flow

One policy file, two enforcers, one gate.

### Startup (once per session)

1. Load `~/.pi/agent/permissions.json` (policy) and `~/.pi/agent/permissions.local.json`
   (grants). Grants are looked up by the session `cwd`, exact match first, then the nearest
   ancestor entry.
2. Render the Seatbelt profile for that workspace to
   `~/.pi/sandbox/workspaces/<sha1(realpath(workspace))[:16]>.sb`.
3. The wrapper `~/.local/bin/pi-sandboxed-bash` is the session shell, so every `bash` call and
   `!` command runs under that profile. `py_explore` prepends the same profile to its spawn.

### Per tool call (`tool_call` hook)

```
policy.mode === "off" or mode === "allow"  →  no interception
bash                                        →  commands.prompt match ? "ask" : undefined
path tools (and any tool with a path arg)   →  resolveFs → deny | allow | ask
other tools                                 →  undefined
```

`resolveFs`: policy deny › folder deny › `write` allowlist (workspace, temp, caches, folder
grants) › ask. Reads are a denylist.

Verdict handling:

| Verdict | Interactive | Headless (`-p`, subagents) |
|---|---|---|
| `allow` | runs, no prompt | runs |
| `ask` | dialog: outside policy, or ⛔ destructive | blocked: "needs approval, no UI" |
| `deny` | blocked, no dialog, not grantable | blocked |

### Execution

The kernel enforces what the profile says. Writes outside the allowlist, credential reads and
(configurable) network fail with `EPERM` regardless of what the command text claims.

### After execution (`tool_result` hook)

1. Parse every `<path>: Operation not permitted` line. One command reports all blocked paths,
   because the shell does not abort on `EPERM`.
2. Annotate the result: "N denied writes, output is incomplete". A command can exit 0 with the
   data lost, so this is not cosmetic.
3. Offer a grant: parent dirs (default), nearest common ancestor, exact files, session-only, or no.
   `deny` paths never appear in that dialog.
4. On grant: write `~/.pi/agent/permissions.local.json`, re-render the profile, tell the model to
   re-run. Grants are directory roots, so the next command touching a sibling file is silent.

### Modes

| Mode | Symbol | Gate | Kernel sandbox | Behaviour |
|---|---|---|---|---|
| `allow` | 🟢 green | off | off (`.off` marker) | the permissions system is bypassed entirely |
| `sandbox` | 📦 box | on | on | policy decides; ask band and destructive patterns prompt |
| `ask` | 🔴 red | on | on | prompt for every call; `deny` still blocks |

`deny` is absolute in `sandbox` and `ask`. `allow` is the only way past the policy, and it is a
full bypass: the extension swaps the workspace's `.sb` profile for a `.off` marker, so the shell
wrapper and `py_explore` run without `sandbox-exec` at all.

### Removed

`classifier.ts` (460 lines), `llm-classifier.ts` (164), `cwd.ts` (12), `test.ts` (1,271) are gone;
`types.ts` is 14 lines. No model runs in the permission path. `extensions/tools/permissions/` is
891 lines total.

Verified live: `echo benign-ok` runs; `git push --force` → "Destructive command blocked (no UI to
approve)"; the `write` tool on `~/x` → "Needs approval and no UI is available", file absent;
`touch ~/x` via bash → `Operation not permitted`, file absent.

## 15. Configuration minimalism

The first draft had `always` and `write` as separate lists. They were concatenated in the same two
places and never read differently, so the split was editorial only — and a reader would reasonably
assume `always` outranked something. Merged into `write`.

Removed at the same time, all unused or traps:

| Removed | Why |
|---|---|
| `always` | identical to `write` in every code path |
| `tools` map | never read; the enforcer is chosen in code |
| `sandbox.provider` | constant |
| `sandbox.shellPath` | the real value lives in `~/.pi/agent/settings.json` |
| `sandbox.profileDir` | the wrapper hardcodes the same path; changing it breaks the sandbox |
| `sandbox.extraWrite` | device files, not a user decision |
| `grants.retries` | retries are model-mediated, not counted |
| `mode` (`enforce`/`shadow`/`off`) | a second axis named "mode"; replaced by `enabled` |
| `grants.store` | derived from the agent directory |

The policy is now 7 keys. Anything a wrong value would silently break is a constant instead.

## 16. The allow-mode hole, and what it taught

A live session wrote to `~/.pi/agent/permissions.local.json` in `allow` mode and the write
succeeded. Cause: `policyGate` returned early on `currentMode === "allow"`, before the deny check, so
`allow` meant "no policy at all", and the check sat above the deny it was supposed to defer to.

It was masked by the sandbox: bash in the same session still could not read `~/.ssh`, because the
kernel profile is independent of the interactive mode. Only in-process tools (the `write` tool)
bypassed. So the same path gave two answers depending on which tool touched it, which is exactly
the inconsistency a permissions system must not have.

Fixes:

- `deny` is evaluated in every mode except `allow`, and `allow` is now a real bypass rather than a
  half-bypass: it also removes the kernel sandbox, via a `.off` marker next to the profile. A
  `.off` marker cannot be mistaken for a profile, and the wrapper picks it up without a restart.
- The mode axis was renamed to what it does: `allow`, `sandbox`, `ask`. `classify` and `auto`
  restore as `sandbox`, so old sessions migrate silently.
- The policy file's own `mode` key (`enforce`/`shadow`/`off`) is gone; one `enabled` boolean
  remains. Two axes both called "mode" is how the hole got missed.

Grant dialog now carries symbols: 📁 folder, 🌳 wider ancestor, 📄 exact files, ⏳ session only,
🚫 no.
