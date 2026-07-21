# Task Backgrounder Extension for Pi

Run shell commands in the background via **tmux**. Task state is **on-demand only**: there is no periodic polling loop that injects messages into the model or UI.

## Final API

| Capability | Kind | Description |
|------------|------|-------------|
| `task_start` | LLM tool | Start a command in a detached tmux session |
| `task_status` | LLM tool | Show one task's status/output tail as a normal tool result; prompts for a task if needed |
| `task_stop` | LLM tool | Stop a background task and remove it from tracking |
| `task_clear` | LLM tool | Clear tracked task transcripts/output files |
| `/task-status [name]` | Command | With no args, choose one task from a list; with a name, show that task |
| `/task-stop <name>` | Command | Stop one tracked task |
| `/task-clear [all]` | Command | Clear tracked task transcripts; `all` includes running tasks |
| `/task-list` | Command | List tracked tasks only |

No `background_task`, `/bg-stop`, `/task-show`, or repeated update pings are part of the final API.

## Starting a background task

The LLM can call `task_start`:

```json
{
  "command": "python train.py --epochs 100",
  "name": "training-run",
  "tail_lines": 100
}
```

- `command` — shell command to run (required)
- `name` — tmux session name (optional, auto-generated if omitted)
- `cwd` — working directory (optional, defaults to Pi's current cwd)
- `tail_lines` — default number of nonblank output lines to show when status is pulled (default 10; increase when the user asks for more output)

The tool returns the session name and log file path.

## Checking status/output

The LLM should use `task_status` when the user asks to see task output:

```json
{ "name": "training-run", "tail_lines": 100 }
```

If `task_status` is called with no `name` and multiple tasks exist, it prompts the user to choose one, then returns that one transcript as a normal tool result.

The task status tool result is rendered collapsed by default: it shows the task name and status, plus the configured expand-key hint (default `ctrl+o`). When expanded, it shows the requested output tail.

After a task reaches a final state (`exited` or `error`), a hidden follow-up nudge is sent once to the model so it can call `task_clear` once the output is no longer needed.

The user can type:

```text
/task-status
/task-status training-run
/task-list
```

## Stopping a task

The LLM can call `task_stop`:

```json
{ "name": "training-run" }
```

The user can type:

```text
/task-stop training-run
```

## Clearing transcripts

```text
/task-clear
/task-clear all
```

`/task-clear` clears completed/errored/not-found task transcripts and deletes their `/tmp` log/exit/script files. It skips running tasks. `/task-clear all` also clears running tasks from tracking/output files, but does **not** kill their tmux sessions. Use `/task-stop <name>` to kill a running task.

## Agent guidelines

- Use `task_start` when the user asks for a long-running command that would block the agent.
- After starting a background task, continue working on the main request. Do not wait or poll unless the user explicitly asks you to wait.
- Use `task_status` only when the user asks for an update or when you need the output to proceed.
- The default status output is 10 nonblank lines; request a larger `tail_lines` when the user wants more output.
- If `task_status` shows a completed or failed task, call `task_clear` once the output is no longer needed.

## Implementation notes

- tmux runs a wrapper script directly, avoiding fish/zsh/bash banners and prompt spam.
- Output is written to `/tmp/<task-name>.log`.
- Exit status is written to `/tmp/<task-name>.exit`.
- No timer/interval polls tmux.
- Task tracking is rebuilt from the full session history on `session_start` and `session_tree`, so navigating the session tree cannot drop live tasks.
- The model/user explicitly pulls state with `task_status` or `/task-status`.
