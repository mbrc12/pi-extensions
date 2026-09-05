# Task Backgrounder Extension for Pi

Run shell commands in the background via **tmux**. Pi checks tracked tasks locally and injects one durable message when each task reaches a terminal state. It does not send progress messages while a task is running.

## API

| Capability | Kind | Description |
|------------|------|-------------|
| `task_start` | LLM tool | Start a command in a detached tmux session and monitor it for completion |
| `task_status` | LLM tool | Show one task's current status and output tail; prompts for a task if needed |
| `task_stop` | LLM tool | Stop a task and keep it tracked for output inspection and cleanup |
| `task_clear` | LLM tool | Clear tracked task transcripts and output files |
| `/task-status [name]` | Command | Choose or show one task in a temporary Escape-dismissible view |
| `/task-stop <name>` | Command | Stop one tracked task |
| `/task-clear [all]` | Command | Clear tracked task transcripts; `all` includes running tasks |
| `/task-list` | Command | List tracked tasks |

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
- `name` — task name (optional, generated if omitted)
- `cwd` — working directory (optional, defaults to Pi's current directory)
- `tail_lines` — default number of nonblank output lines shown by `task_status` (default 10)

The tool returns the task name and log file path. Each run receives a stable task ID and a private internal tmux session name, so a concurrent old operation cannot affect a later run that reuses the display name.

## Completion notifications

Pi injects a visible `task-completion` message for every terminal outcome:

| Outcome | Meaning |
|---------|---------|
| `succeeded` | The command exited with code 0 |
| `failed` | The command exited with a non-zero or invalid exit code |
| `stopped` | Pi deliberately stopped the task |
| `lost` | The tmux session disappeared without recording an exit code |

The message includes the exit code when available. The agent can call `task_status` to inspect process output; raw process output is not injected automatically.

- The status message is persisted immediately.
- If the agent is idle, a hidden wake message starts a new turn.
- If the agent is busy, Pi delivers the wake message as a follow-up after the current work.
- Completions that occur close together are batched into one message.
- Reloading or resuming catches up on pending completions without sending duplicates.

Do not use `sleep` or repeatedly call `task_status` just to wait for completion. End the turn and let the completion message wake the agent.

## Footer status

The footer shows a compact task summary while the extension is active:

```text
⚙️  x+y/z
```

- A compact two-cell gap keeps the counts visually separate from the double-width gear; the counts contain no spaces.
- `x` is the number of successfully completed tracked tasks and is shown in green.
- `y` is the number of failed tracked tasks and is shown in red.
- `z` is the total number of tracked tasks.
- The gear, plus sign, and `/z` are shown in the theme's accent colour.

Running, stopped, and lost tasks are included in the total but not in the success or failure counts.

## Checking status and output

Use `task_status` only for an intermediate update or additional output:

```json
{ "name": "training-run", "tail_lines": 100 }
```

If multiple tasks exist and no name is supplied, the tool prompts the user to choose one. The result shows the task name and status by default. Press `Ctrl+O` to show the requested output tail.

The user can also type:

```text
/task-status
/task-status training-run
/task-list
```

In the interactive TUI, `/task-status` opens a temporary view. Press `Esc` to close it.

## Stopping a task

The LLM can call:

```json
{ "name": "training-run" }
```

The user can type:

```text
/task-stop training-run
```

Stopping a tracked running task produces a `stopped` completion notification. By default, the stopped task remains tracked so the agent can inspect its output and then call `task_clear`. Setting `delete_files:true` removes its files and tracking immediately.

## Clearing transcripts

```text
/task-clear
/task-clear all
```

`/task-clear` clears completed, errored, stopped, or lost task transcripts and deletes their temporary files. It skips running tasks. `/task-clear all` stops running tasks before removing their tracking data and temporary files.

## Agent guidelines

- Use `task_start` for a long-running command that would otherwise block the agent.
- After starting a task, continue any independent work.
- Do not use `sleep` or repeatedly poll `task_status` while waiting. Let the automatic completion notification wake you.
- Use `task_status` only when the user requests an intermediate update or when you need output before completion.
- After handling a completion, call `task_clear` once its output is no longer needed.

## Implementation notes

- tmux runs a wrapper script directly, avoiding interactive shell banners and prompts.
- Output, wrapper, and exit-status files use task-ID-specific names under `/tmp` and owner-only permissions.
- The wrapper records the command's exit code through an atomic file rename before it exits.
- A non-overlapping one-second timer runs only while unreported tasks are tracked. It checks exit files first and tmux second; it does not read growing logs.
- On-demand log reads work backwards from the end and stop at 48 KB, so large logs are never loaded in full.
- Completion messages and pending notifications are persisted in the session.
- Lifecycle entries cover both LLM tools and slash commands, so cleared or stopped tasks do not reappear after reload.
- State is rebuilt from the full session history on `session_start` and `session_tree`, so tree navigation cannot drop live tasks.
