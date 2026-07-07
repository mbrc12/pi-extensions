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
- `tail_lines` — default output lines to show when status is pulled

The tool returns the session name and log file path.

## Checking status/output

The LLM should use `task_status` when the user asks to see task output:

```json
{ "name": "training-run", "tail_lines": 100 }
```

If `task_status` is called with no `name` and multiple tasks exist, it prompts the user to choose one, then returns that one transcript as a normal tool result.

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

## Implementation notes

- tmux runs a wrapper script directly, avoiding fish/zsh/bash banners and prompt spam.
- Output is written to `/tmp/<task-name>.log`.
- Exit status is written to `/tmp/<task-name>.exit`.
- No timer/interval polls tmux.
- No `pi.sendMessage()` is used for task state.
- The model/user explicitly pulls state with `task_status` or `/task-status`.
