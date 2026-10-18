---
description: "The gh-supervisor profile surface: one minimal Cordis plugin that runs the plain-Node supervision library as a resident composition — it claims the data root, mints the persistent runtime id, spawns the current release's gh-remote service child, and ends the runner with the supervision loop's exit code; every tunable is validated Config."
kind: "package-bundle"
---

# @glm-harness/gh-remote-supervisor-app

English | [中文](README.zh.md)

## Summary

Run this plugin as the whole `gh-supervisor` profile: one Cordis row keeps a deployed gh-remote service alive. On boot it resolves the data root (Config, `GH_REMOTE_ROOT`, then `~/.glmh-remote`), mints the persistent runtime id, reads the current release pointer, and spawns the release's `gh-remote` service child under the shared home. The profile lives exactly as long as the supervision loop: an explicit stop, the crash circuit breaker, or a refused lock ends the runner with the loop's own exit code. Backoffs, drain budgets, ready timeout, and the child's bind address are Config — a profile patch tunes them without a rebuild.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This is a single-row composition plugin, not a library to import: it exists so `gh-supervisor` boots as one complete Cordis tree with no base layers, keeping the resident supervisor's memory at the plugin minimum.

### When to choose it

Choose it when a runtime archive's resident supervision should be a product surface — the POSIX bootstrap's `run`/`start` verbs exec exactly this profile (`lib/bin.js --profile gh-supervisor --no-open --host 127.0.0.1 --port 0`). A deployment that already owns process supervision can use the plain `gh-remote-supervisor` library instead.

### Minimal configuration

```sh
DSH_HOME=/srv/gh/home GH_REMOTE_ROOT=/srv/gh \
  node <release>/runtime/lib/bin.js --profile gh-supervisor --no-open --host 127.0.0.1 --port 0
```

The profile's Config carries the supervision contract: `root` (data root; empty reads `GH_REMOTE_ROOT`, then `~/.glmh-remote`), `home` (the child's `DSH_HOME`; empty uses `<root>/home` when present), `childProfile` (`gh-remote`), `host`/`port` (the child's bind address; `0` picks a free port), `readyTimeoutMs` (60s), `baseBackoffMs`/`maxBackoffMs` (1s doubling to 60s), `drainTimeoutMs` (10s SIGTERM-to-SIGKILL grace), and `crashThreshold`/`crashWindowMs` (5 crashes per 5 minutes trips the circuit). A profile patch overrides any of them without a rebuild.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`GhSupervisorAppService` boots by resolving the root, calling the library's `ensureRuntimeId`, and reading the current-release pointer; a root with no current release is a loud boot failure (exit 70 on stderr — this profile composes no logger console sink). The child is spawned through `launcherFor(releaseDir)`, which prefers the release's bundled `bin/node`, with `GH_REMOTE_ROOT`, `GH_REMOTE_RELEASE_ID`, and the resolved `DSH_HOME` exported, so the service child reports its release identity in the `ghRemote/describe` handshake. The supervision outcome maps onto the CLI's exit-code contract (0 stopped, 69 lock refused, 75 circuit open, 76 spawn failure) and ends the runner through the injected `appExit` callable; disposal first settles boot, prevents late startup, then stops and awaits the supervision loop through child exit and lock release.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema, boot sequence, supervision wiring, outcome-to-exit mapping |
| [`cordis.patch.yml`](cordis.patch.yml) | The single `gh-supervisor-runner` row: this plugin as a complete tree |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@glm-harness/gh-remote-supervisor`](../remote-supervisor/README.md) — the supervision library and CLI this profile runs, including the lifecycle verbs that switch releases under it
- [`@glm-harness/gh-remote-app`](../remote-app/README.md) — the resident service child, its ready line, and the `ghRemote` identity RPC
- [gh-remote runtime archive](../../bundle/base/README.md) — the relocatable deployment whose bootstrap execs this profile

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- POSIX only, inherited from the supervision library: lifecycle signaling is SIGTERM/SIGKILL based.
- The profile resolves the release at boot only; release switches happen through the supervisor CLI's `update`/`rollback` verbs, which stop this runner and start a new one from the new release.
- One data root per supervisor: a second supervisor over the same root refuses the claim rather than sharing it.
- OS-level autostart (systemd/launchd units) is deployment work documented separately, not part of this profile.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The plugin injects the `appExit` callable interface from `dsh-cmdline` instead of `process.exit` so every profile launcher (Electron, CLI) owns the real teardown path. Boot failures write to stderr directly because the minimal profile composes no logger sink — an archive operator reading `log/runner.log` sees the reason without opening a debugger. The Config defaults mirror the library CLI's fixed policy, so the profile and the plain CLI supervise identically unless a patch says otherwise.

</details>
