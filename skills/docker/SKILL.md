---
name: docker
description: Use Colima for local Docker work on this Mac. Use when setting up project toolchains or services in containers, creating Dockerfiles and launch scripts, inspecting images or containers, or managing Docker contexts, storage, and cleanup.
---

# Docker on this Mac

- Share one Colima VM and Docker engine for all local container work. Use the profile named `dev` for all projects. Do not create another profile or install Docker Desktop unless the user asks.
- Put new project-specific Linux toolchains and services in Docker by default. Keep source files and editors on the Mac. Use separate images and containers for each project, not separate VMs.
- A Docker context is a named connection to an engine. Use `docker --context colima-dev` without changing the active context. If the shared VM is off, start it explicitly with `colima start dev --activate=false`.
- The `default` context can point to an inactive socket. If plain `docker ps` fails, use `docker context ls` and `colima list` before changing anything.

## Directory layout

- Keep the Dockerfile, `.dockerignore`, launch scripts, and other container configuration in `~/dev/docker/<name>/`. Use that directory as the build context. Keep project source files in their project directory.
- Keep the real launcher in the environment directory. Add a relative symlink in `~/dev/docker/scripts/` so the user can find all shortcuts in one place.
- Make `start` explicit. It can start the shared VM if needed and build a missing image. It must not open an editor. Running the shortcut without arguments shows help.
- Stop individual containers without shutting down the shared VM. To stop the VM when no project needs it, use `colima stop dev`. This keeps all images and data. Leave a VM that was already running alone.

## Build and run

- This Mac uses Apple Silicon. The shell can set `DOCKER_DEFAULT_PLATFORM=linux/amd64`. Pass `--platform linux/arm64` to builds and runs for native images. Use AMD64 only if the workload requires it.
- Pin the application and toolchain versions in the Dockerfile. Keep project files, credentials, and generated output out of the build context if the image does not need them.
- For one-off commands and language servers, use a fresh container with `--rm`. Mount only the project directory the command needs. If a host editor and a language server share files, mount the directory at the same absolute path inside the container.
- Use the host user and group for writable mounts when supported. Make sure that this user can read and use the image's tools. For a language server that uses standard input and output, keep stdin open with `-i`, omit `-t`, and do not publish a port.
- Use a bounded background task for builds and large pulls. After a change, run a small test through the launcher. For editor integration, make sure that the language server attaches.

## Inspect or clean up

- Run `docker --context colima-dev ps` to list running containers. Use `image ls` to list images and `system df` to see Docker storage use.
- Docker manages images and volumes for all projects on the shared VM disk under `~/.colima/`. The files in `~/dev/docker/` are recipes and scripts. Do not edit or remove the disk directly.
- Get user approval before pruning or removing images or volumes. Remove only the intended project's resources. Removing the shared profile with its data affects every project, not just Rocq.

## Rocq example

```sh
~/dev/docker/scripts/rocq start
docker --context colima-dev ps
nvim ~/dev/vlsi/rocq/Register.v
```

- `rocq start` starts the shared Docker engine if needed and prepares the `rocq:9.1.1` image. Neovim launches `coq-lsp` through `~/dev/docker/rocq/rocq-env`.
- Closing Neovim removes the language server container and leaves the engine running. Remove the Rocq image by tag if it is no longer needed. Do not delete the shared profile to clean up one project.
