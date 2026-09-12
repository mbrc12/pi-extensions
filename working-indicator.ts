/**
 * A friendlier streaming loader.
 *
 * The indicator shows ping-pong dots, then adds truthful live context when a
 * tool is running: "Read package.json · 3s".
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FALLBACK_MESSAGES = [
  "Waiting for the bits to unionize",
  "Pretending this was always the plan",
  "Looking for the responsible adult",
  "Giving the race condition a head start",
  "Reading the error message this time",
  "Blaming eventual consistency",
  "Convincing the edge case it is mainstream",
  "Making undefined behavior feel seen",
  "Waiting for the dependency to text back",
  "Asking production not to notice",
  "Rebranding the bug as emergent behavior",
  "Checking whether latency is just shy throughput",
  "The cache says it has never seen us before",
  "The event loop has requested a brief recess",
  "This seemed faster in the planning document",
  "One moment; the abstractions are nesting",
  "The happy path is currently unavailable",
  "A dependency is expressing itself",
  "The bits are discussing working conditions",
  "The logs have retained counsel",
  "The edge case has become the main character",
  "Production has entered the chat",
  "Trying the same thing with more confidence",
  "Moving the goalposts into version control",
  "Explaining the deadline to the event loop",
  "Checking whether the cache remembers anything useful",
  "Turning it off and calling that observability",
  "Adding one more abstraction for safety",
  "Searching for the comment that promised clarity",
  "Negotiating a ceasefire between competing standards",
  "Converting coffee into plausible deniability",
  "Checking whether the bug is load-bearing",
  "Promoting a workaround to architecture",
  "The network is developing object permanence",
  "Applying industry-standard wishful thinking",
  "Making the happy path lower its expectations",
  "Checking whether null has considered other options",
  "Asking the compiler to use its indoor voice",
  "Giving the flaky test time to reflect",
  "Reproducing the issue by behaving naturally",
  "Looking busy while the timeout expires",
  "Putting the TODO somewhere more strategic",
  "Consulting the logs after forming an opinion",
  "Renaming the problem until it fits the solution",
  "Checking whether recursion has returned our call",
  "Requesting forgiveness from the type checker",
  "The mutex is still in another meeting",
  "Treating the warning as a growth opportunity",
  "Adding a fallback for the fallback",
  "Preparing a tasteful postmortem",
  "Waiting for DNS to remember where it lives",
  "Asking the database to lower its voice",
  "The scheduler is reviewing our request",
  "The server is taking this personally",
  "The client has chosen interpretive rendering",
  "The protocol would prefer not to discuss it",
  "The build is exploring alternative outcomes",
  "The test suite is withholding judgment",
  "The schema has filed a formal objection",
  "The packet is seeing other routers",
  "The thread is pursuing independent interests",
  "The process is unavailable for comment",
  "The container needs a moment outside",
  "The cloud is checking behind the sofa",
  "The proxy denies knowing either party",
  "The index is alphabetizing its priorities",
  "The parser has encountered a creative difference",
  "The linter is drafting a strongly worded warning",
  "The runtime is considering its options",
  "The kernel has escalated this internally",
  "The socket is working on its boundaries",
  "The heap is making room emotionally",
  "The stack is processing some old frames",
  "The queue has concerns about first come first served",
  "The lock is protecting its personal space",
  "The semaphore is counting on someone else",
  "The coroutine is between engagements",
  "The promise is not ready to commit",
  "The callback will get back to us",
  "The iterator is taking things one step at a time",
  "The generator is conserving its energy",
  "The exception is preparing a statement",
  "The warning is seeking legal advice",
  "The error has been promoted to a feature",
  "The feature has been reassigned to maintenance",
  "The bug is networking with stakeholders",
  "The patch is managing expectations",
  "The hotfix is cooling off",
  "The release is practicing social distancing",
  "The deploy is waiting for a sign",
  "The rollback is enjoying being needed",
  "The migration is updating its forwarding address",
  "The backup is reconsidering its life choices",
  "The restore is looking for the backup",
  "The replica is finding itself",
  "The primary has delegated leadership",
  "The transaction is keeping its options open",
  "The commit is avoiding long-term relationships",
  "The branch is exploring personal growth",
  "The merge has irreconcilable creative differences",
  "The rebase is rewriting history responsibly",
  "The diff is focusing on what changed between us",
  "The repository is currently between truths",
  "The tag is waiting for something worth labeling",
  "The hash remains characteristically opaque",
  "The pipeline is aligning its chakras",
  "The runner has stopped to tie its shoes",
  "The build agent is updating its résumé",
  "The artifact is questioning its provenance",
  "The package manager is consulting the stars",
  "The dependency tree is embracing complexity",
  "The lockfile is preserving the historical record",
  "The module is maintaining plausible separation",
  "The import is held up at customs",
  "The export lacks the necessary paperwork",
  "The namespace is experiencing crowding",
  "The variable is going through a phase",
  "The constant is open to change",
  "The function is redefining its purpose",
  "The class is attending a reunion",
  "The object is refusing to be reduced to properties",
  "The array is rearranging the deck chairs",
  "The map is asking for directions",
  "The set is defining healthy boundaries",
  "The string is pulling itself together",
  "The integer is rounding up support",
  "The float is trying to stay grounded",
  "The boolean sees nuance now",
  "Null is declining to elaborate",
  "Undefined remains out of office",
  "The regex has become self-aware",
  "The query is expanding its search criteria",
  "The cursor has lost its place",
  "The table is tabling the discussion",
  "The row is maintaining a low profile",
  "The column is standing by its position",
  "The join is waiting for mutual consent",
  "The aggregate is gathering its thoughts",
  "The index scan is enjoying the scenery",
  "The query planner is keeping the plan flexible",
  "The database is normalizing its feelings",
  "The cache is selectively remembering",
  "The buffer is creating some breathing room",
  "The stream is going with the flow",
  "The batch is waiting for everyone to arrive",
  "The shard is enjoying a little independence",
  "The cluster is discussing collective action",
  "The node has left the group chat",
  "The region is experiencing regional issues",
  "The zone is outside its comfort zone",
  "The load balancer is weighing its options",
  "The gateway is checking invitations",
  "The firewall is protecting us from progress",
  "The certificate is working through trust issues",
  "TLS is keeping things strictly confidential",
  "The token has expired from exhaustion",
  "The secret is refusing to come out",
  "The key does not feel recognized",
  "The credential is updating its references",
  "The session is taking a personal day",
  "The cookie has accepted itself",
  "The header is getting ahead of itself",
  "The body is still composing itself",
  "The request is learning to ask politely",
  "The response is considering its wording",
  "The endpoint has moved without leaving a note",
  "The route is taking the scenic path",
  "The redirect is passing the responsibility along",
  "The status code is being emotionally accurate",
  "The API is maintaining an air of mystery",
  "The webhook is waiting by the phone",
  "The poller is checking again out of habit",
  "The event is making an entrance",
  "The handler is handling it",
  "The listener has heard enough",
  "The observer prefers not to interfere",
  "The subscriber is reviewing the terms",
  "The publisher is between editions",
  "The broker is brokering a longer break",
  "The message is still finding its audience",
  "The payload is carrying some baggage",
  "The serializer is putting things in order",
  "The deserializer is unpacking slowly",
  "The encoder is speaking in code",
  "The decoder needs more context",
  "The compressor is under pressure",
  "The archive is living in the past",
  "The file system is sorting out custody",
  "The directory is expanding its horizons",
  "The path is taking an unexpected turn",
  "The symlink is pointing fingers",
  "The permission is waiting for approval",
  "The owner is away from the keyboard",
  "The daemon is haunting a different process",
  "The service is redefining availability",
  "The worker is on a mandated break",
  "The job is updating its LinkedIn",
  "The task is practicing mindful waiting",
  "The cron schedule is open to interpretation",
  "The clock is resolving a timing disagreement",
];

// A dot travels across a small track, then bounces back. The fixed-width
// frames avoid visual jitter while the loader is being redrawn.
const PING_PONG_DOT_FRAMES = [
  "●····",
  "·●···",
  "··●··",
  "···●·",
  "····●",
  "···●·",
  "··●··",
  "·●···",
];
const MESSAGE_INTERVAL_MS = 3_600;
const SPINNER_INTERVAL_MS = 110;

function shorten(value: unknown, maxLength = 34): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const singleLine = value.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  return singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, maxLength - 1)}…`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function activityFor(toolName: string, args: unknown): string {
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const path = shorten(input.path ?? input.file_path ?? input.filename);
  const pattern = shorten(input.pattern ?? input.query);
  const command = shorten(input.command);

  switch (toolName) {
    case "read":
      return path ? `Read ${path}` : "Read files";
    case "write":
      return path ? `Write ${path}` : "Write file";
    case "edit":
      return path ? `Edit ${path}` : "Edit file";
    case "grep":
      return pattern ? `Search ${pattern}` : "Search code";
    case "find":
      return pattern ? `Find ${pattern}` : "Find files";
    case "ls":
      return "Inspect directory";
    case "bash":
    case "powershell":
      return command ? `Run ${command}` : "Run command";
    case "subagent":
      return "Delegate agent";
    case "py_explore":
      return "Explore data";
    case "web_use":
      return "Look up";
    case "ask_question":
      return "Await input";
    default:
      return `Use ${toolName}`;
  }
}

export default function (pi: ExtensionAPI) {
  let messageTimer: ReturnType<typeof setInterval> | undefined;
  let messageIndex = Math.floor(Math.random() * FALLBACK_MESSAGES.length);
  let lastMessageChangeAt = 0;
  let turnStartedAt = 0;
  const activeTools = new Map<string, string>();

  function stopMessageRotation(): void {
    if (messageTimer) clearInterval(messageTimer);
    messageTimer = undefined;
  }

  function elapsed(): string {
    return formatDuration(Date.now() - turnStartedAt);
  }

  function latestActivity(): string | undefined {
    return Array.from(activeTools.values()).pop();
  }

  function fallbackMessage(): string {
    return `${FALLBACK_MESSAGES[messageIndex]!}…`;
  }

  function pickNextFallback(): void {
    if (FALLBACK_MESSAGES.length < 2) return;
    const offset = 1 + Math.floor(Math.random() * (FALLBACK_MESSAGES.length - 1));
    messageIndex = (messageIndex + offset) % FALLBACK_MESSAGES.length;
  }

  function updateMessage(ctx: ExtensionContext): void {
    const activity = latestActivity();
    if (activity) {
      ctx.ui.setWorkingMessage(`${activity} · ${elapsed()}`);
      return;
    }

    if (Date.now() - lastMessageChangeAt >= MESSAGE_INTERVAL_MS) {
      pickNextFallback();
      lastMessageChangeAt = Date.now();
    }
    ctx.ui.setWorkingMessage(`${fallbackMessage()} · ${elapsed()}`);
  }

  function applyWorkingStyle(ctx: ExtensionContext): void {
    const { theme } = ctx.ui;
    ctx.ui.setWorkingIndicator({
      frames: PING_PONG_DOT_FRAMES.map((frame) => theme.fg("accent", frame)),
      intervalMs: SPINNER_INTERVAL_MS,
    });
    ctx.ui.setWorkingMessage(fallbackMessage());
  }

  function startMessageRotation(ctx: ExtensionContext): void {
    stopMessageRotation();
    activeTools.clear();
    turnStartedAt = Date.now();
    lastMessageChangeAt = turnStartedAt;
    pickNextFallback();
    updateMessage(ctx);
    messageTimer = setInterval(() => updateMessage(ctx), 1_000);
  }

  pi.on("session_start", async (_event, ctx) => {
    applyWorkingStyle(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    startMessageRotation(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activeTools.delete(event.toolCallId);
    activeTools.set(event.toolCallId, activityFor(event.toolName, event.args));
    updateMessage(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    activeTools.delete(event.toolCallId);
    updateMessage(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    stopMessageRotation();
    activeTools.clear();
    ctx.ui.setWorkingMessage(`${FALLBACK_MESSAGES[0]!}…`);
  });

  pi.on("session_shutdown", () => {
    stopMessageRotation();
    activeTools.clear();
  });
}
