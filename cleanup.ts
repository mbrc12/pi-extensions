import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CLEANUP_PROMPT = `Perform a complete stop-and-cleanup pass now. This is an instruction to act, not to give advice. Do not shut down, quit, exit, restart, or reload the Pi session; leave the session open and idle after cleanup.

First stop or cancel all work that is currently running for this session, the current project, or the user's active request. Do not start any new work except what is needed to stop and clean up existing work. Inspect the available tools, local environment, project instructions, session state, and relevant cloud CLIs/APIs before acting.

Cover all applicable resources, including:
- background jobs, queued jobs, schedulers, workers, subprocesses, child processes, daemons, file watchers, dev servers, test runners, agents, and queued tasks;
- Docker/Podman containers, compose stacks, Kubernetes workloads, port forwards, tunnels, remote shells, and other local or remote sessions;
- cloud batch jobs, training/evaluation/inference runs, pipelines, workflows, queue consumers, CI runners, notebooks, development environments, GPU reservations, VMs, containers, clusters, endpoints, autoscaling groups, and other compute allocations;
- temporary storage, scratch resources, leases, reservations, and resources that can continue incurring charges or processing after this turn.

Cancel queued work before stopping active work where possible. Gracefully stop processes first, then force-stop only when necessary. For cloud resources, enumerate active resources in the configured account, project, region, and environment, and stop or release every ephemeral compute or processing allocation associated with this work. Re-check after cleanup so resources that restart automatically are disabled or stopped. Do not assume that a successful command means the resource is gone.

Do not delete source code, repositories, credentials, configuration needed to inspect or stop resources, durable datasets, backups, or unrelated production resources. Do not commit, push, deploy, or make unrelated changes. If a resource is ambiguous or appears unrelated, leave it alone and report it. If a required permission, provider, region, or tool is unavailable, report the exact blocker and the resource that may still be running.

Verify that no applicable processing, job, allocation, or chargeable ephemeral resource remains. Then give a concise report with: stopped/cancelled resources, resources verified already stopped, anything still running or uncertain, and any blockers. After the report, stop; do not resume the original task or perform follow-up work, and do not shut down the session.`;

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cleanup", {
		description: "Ask the model to stop and clean up active jobs and resources",
		handler: (_args, _ctx) => {
			pi.sendMessage(
				{
					customType: "cleanup",
					content: CLEANUP_PROMPT,
					display: false,
				},
				{
					triggerTurn: true,
					deliverAs: "steer",
				},
			);
		},
	});
}
