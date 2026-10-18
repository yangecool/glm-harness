---
description: "GH remote process supervision: one data root, one resident service — lock-directory single-instance claims, identity files, a stdout readiness contract, bounded crash backoff with a circuit breaker, and a SIGTERM-then-SIGKILL drain ladder, all plain Node with zero dependencies."
kind: "package-reference"
---

# @glm-harness/gh-remote-supervisor

English | [中文](README.zh.md)

## Summary

Run this module to keep a resident gh-remote service alive independently of any SSH session or desktop process. One data root admits exactly one supervised child: a lock directory refuses concurrent owners, an identity file publishes the live pid and ready URL, readiness waits for a stdout contract line, and crashes restart on capped exponential backoff until a windowed circuit breaker stops the loop. `stop` and `restart` drain the named child through a SIGTERM-then-SIGKILL ladder. Use it wherever the service must outlive the connection that started it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

This is a plain Node module and CLI, not a composition row: run `lib/index.js` beside the deployed runtime archive, pointed at the service's data root.

### When to choose it

Choose it when the service must survive disconnects and desktop exits. A one-shot invocation (GH-005's `bootstrap.sh run`) does not need it; any resident deployment does.

### Minimal configuration

```sh
node lib/index.js --root "$GH_REMOTE_HOME/data" run -- \
  node "$GH_REMOTE_HOME/runtime/lib/bin.js" --profile gh-remote \
  --no-open --host 127.0.0.1 --port 0
```

There is no configuration file; behavior is fixed product policy (ready timeout 60s, backoff 1s doubling to 60s, drain grace 10s, circuit at 5 crashes per 5 minutes). The verbs: `run`, `stop`, `restart`, `status` print or act on the root's lock and identity files; exit codes are 0 clean, 64 usage, 69 lock refused (or immutable-release collision), 75 circuit open, 76 spawn failure.

### Release lifecycle

`run` without an explicit `-- CMD` launches the current release: immutable runtime directories under `<root>/releases/<id>/` (each sealed with a `gh-release.json` manifest, entry `lib/bin.js`, optional bundled `bin/node`), named by a rename-atomic `<root>/releases/current.json` pointer that also chains the previous release for rollback.

```sh
node lib/index.js --root "$GH_REMOTE_HOME/data" install --from "$EXTRACTED_RUNTIME" --id r-1
node lib/index.js --root "$GH_REMOTE_HOME/data" update --from "$NEXT_RUNTIME" --id r-2 --drain-timeout 30000
node lib/index.js --root "$GH_REMOTE_HOME/data" rollback
node lib/index.js --root "$GH_REMOTE_HOME/data" gc
node lib/index.js --root "$GH_REMOTE_HOME/data" uninstall          # data kept
```

`install` copies the source into a staging directory and commits it with one rename, so a release is complete or absent and a repeat install under the same id is refused. `update` and `rollback` poll the live service's `ghRemote/activity` RPC until no agent is running (or the drain timeout elapses), stop through the drain ladder, switch the pointer, and relaunch from the new release; the identity file records which release is live. `gc` removes interrupted-install staging leftovers and every release nothing pins — current, rollback target, and any release a live service still runs are kept. `uninstall` removes the runtimes and service state while keeping every other byte of the root; `uninstall --purge` deletes the root itself.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`src/index.ts` claims `<root>/run/supervisor.lock` by creating the directory (atomic on POSIX) and writing `lock.json` with the supervisor pid, a fresh nonce, and the command. A lock whose owner pid is alive — any process — is refused; a dead owner's lock is replaced. Each spawn writes `<root>/run/service.json` (pid, nonce, startedAt, readyAt, restarts, circuit state, readyUrl) through a temp-file rename, so readers only ever see complete documents. The child's stdout is scanned for a line starting `gh-remote ready: `; the rest of that line is the authenticated service URL. A crash is any child death or ready-timeout; restarts back off exponentially (capped), and five crashes inside a five-minute window open the circuit and end the loop. Draining sends SIGTERM, waits the grace period, then SIGKILL — every grace timer is cleared when the child exits first, so a graceful drain leaves nothing holding the event loop. The CLI `stop` verb stops the supervisor itself (the lock holder), which drains its own child, and then kills any child a SIGKILLed supervisor left behind.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Lock, identity, readiness, backoff, circuit breaker, drain ladder, CLI verbs, activity drain |
| [`src/releases.ts`](src/releases.ts) | Immutable release installs, atomic current pointer, gc pinning, uninstall split |
| [`tests/supervisor.spec.ts`](tests/supervisor.spec.ts) | Lock races, identity lifecycle, ready-line edge cases, backoff caps, circuit, drain escalation, CLI verbs |
| [`tests/releases.spec.ts`](tests/releases.spec.ts) | Install immutability, pointer chaining, staging diagnosis, gc pins, uninstall data retention |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@glm-harness/gh-remote-app`](../remote-app/README.md) — the resident service this module supervises, and the ready line it prints
- [gh-remote runtime archive](../../bundle/base/README.md) — the relocatable deployment the supervisor runs beside
- [`dsh-session-controller`](../../api/session-controller/README.md) — the RPC surface clients reach through the supervised service

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- POSIX only: supervision is built on SIGTERM/SIGKILL and atomic directory creation; a Windows service-control port is future work.
- Stale-lock stealing checks pid liveness, which cannot distinguish a reused pid; the nonce prevents same-root confusion but not OS pid recycling after a crash.
- Circuit state lives in the supervisor process; a restarted supervisor begins a fresh crash window.
- The readiness contract is one stdout line, so a service that buffers or redirects stdout needs the `printUrl` path kept on stdout.
- OS-level autostart (systemd/launchd units) is deployment work documented separately, not part of this module.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Zero dependencies by design: the module must run beside any runtime archive without the workspace's node_modules, so every helper (locking, identity, drain) is plain `node:` built-ins. `lib/index.js` doubles as the CLI through an argv trailer that only fires when executed as a program; importing the module arms nothing. The tests spawn real child processes — the drain-ladder timing cases are the slow ones by intent.

</details>
