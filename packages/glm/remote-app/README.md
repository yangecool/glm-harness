---
description: "The GH resident remote-service surface: the dsh web transport's server half with the browser payload stripped, owning the readiness announce line and the ghRemote identity RPC for headless deployment."
kind: "package-bundle"
---

# @glm-harness/gh-remote-app

English | [中文](README.zh.md)

## Summary

Mount this bundle to turn the web transport into a headless resident service. It disables the static client, module graph, HMR chain, client plugin runner, and the inherited telemetry, analytics, and account rows, keeping webserver, gateway, session, job, terminal, and workspace controllers. It claims the webserver fallback seat with a minimal root route that still performs the launch-token to cookie exchange, prints the `gh-remote ready:` line supervisors observe, and exposes `ghRemote/identity` for connecting clients.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The `gh-remote` profile in a GH Harness home composes `@glm-harness/gh-base`, `@deepseek-ai/dsh-web-app`, then this bundle:

```bash
node apps/cli/lib/bin.js --profile gh-remote --no-open --host 127.0.0.1 --port 0
# gh-remote ready: http://127.0.0.1:<port>/?token=<launch-token>
```

The printed URL's token exchanges for the session cookie at the root; every API call then goes through `POST /api/<namespace>/<method>` exactly as the browser client does.

### When to choose it

Choose it when a deployment needs the resident service: GH-006 continuous execution, reattach, and supervision all target this composition. `gh-headless` stays the one-shot runner; `gh-web` stays the full browser surface.

<a id="understand-the-implementation"></a>
## Understand the implementation

The patch layer removes rows by id after `dsh-web-app` applies: `web-runtime` (static dist, URL line, browser open), `modules`, `client-hmr`, `cordis-client-runner`, plus the telemetry, analytics, and account rows the desktop layer also removes. The plugin then claims the freed webserver fallback seat: unauthenticated roots get connection's minimal 401, a valid launch token mints the cookie with the standard 303, and an authenticated root gets an explicit no-static answer. Readiness prints only after Loader settlement with live webServer and connection services, mirroring the dsh web line's contract. `GhRemoteIdentityService` publishes the `ghRemote` Remote namespace with one `identity()` method returning product, profile, runtime, node, platform, arch, pid, and start time.

<a id="further-exploration"></a>
## Further Exploration

- `scripts/gh-remote-service-verify.ts` drives the whole flow against the real profile: ready line, no-static root, identity, a session turn over HTTP RPC, a second connection attaching to the same session, and clean shutdown.
- `docs/subsystems/gh-remote-bootstrap.md` covers the archive chain that ships this profile to a target host.
- `packages/glm/desktop` shows the sibling GH layer over the same web-app surface for the Electron shell.

<a id="dev-note"></a>
## Dev Note

`static inject` requires both `webServer` and `connection`, so the plugin cannot activate on compositions without the web transport — the failure is a parked fiber, not a crash. The Remote boundary type lives in `./types` because the Typert workspace generator requires public non-root subpaths for boundary types; the generated `./typert` and `./remote` faces come from the workspace build.

<a id="model-experience"></a>
## Model Experience

### Identity RPC is operator-facing

#### What the model sees

Nothing from this package: sessions run under the `gh-base` composition exactly as on any surface; `ghRemote/identity` and the readiness line are transport facts.

#### Token effect

No request-shape effect; the RPC surface this bundle adds changes no tool catalog and no prompt prefix.

#### KV Cache effect

None: identity queries never touch the session transcript.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The identity snapshot is process-local; target and install facts live in the deployment record, not this service (GH-006 supervisor work).
- No capability negotiation beyond method availability; generation-scoped attach semantics arrive with GH-006-D.
- Linux loopback and same-machine deployment are what current evidence covers; cross-host TLS serving is unverified.
- The no-static root answers 404 with a plain-text body; no HTML shell exists by design.
