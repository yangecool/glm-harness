# GLM Harness

English | [中文](README.zh.md)

GLM Harness (`glmh`) is a GLM-native coding agent harness with desktop, web, and headless surfaces. It reuses the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin runtime — Cordis, the launcher, the agent loop, and the client platform — and delivers every GLM-specific product behavior as `@glm-harness/*` plugin bundles instead of forks.

Concretely:

- the GLM model route is a self-written OpenAI-compatible chat-completions stack (`@glm-harness/gh-model-glm`, default endpoint `https://open.bigmodel.cn/api/paas/v4`), not a reuse of any upstream model plugin;
- the product profiles (`gh-web`, `gh-headless`, and the reserved `desktop` profile) start from `@glm-harness/gh-base` instead of `@deepseek-ai/dsh-base`;
- the reserved desktop profile is claimed by a GH overlay that also disables the upstream telemetry rows the reserved name would otherwise enable;
- the GLM identity — color ramp, marks, wordmark, and product copy — is carried by the brand bundle through the plugin slot system, with a small set of in-place identity edits (document title, favicon and renderer assets, desktop copy);
- no GLM business logic lives in the Electron main process, the launcher, or the shared agent loop.

<a id="branches-and-upstream"></a>

## Branches and upstream

| Branch | Contents |
| --- | --- |
| `main` | GLM Harness history: one squashed snapshot of the DSH baseline plus the GLM Harness commits. It does not carry the upstream commit sequence. |
| `upstream` | The DeepSeek Harness baseline this repository builds on, at `dsh-v0.2.1-rc.1`, with the full upstream history. Read-only reference. |

`origin` points to `deepseek-ai/deepseek-harness` and is fetched, never pushed to.

<a id="status"></a>

## Status

Bootstrap phase. Delivered so far, each with recorded evidence under `artifacts/gh-validation/`:

- runtime derivation with an explicit DeepSeek-free base bundle (GH-001);
- resource baseline with repeatable fixtures (GH-002);
- the native GLM provider route (GH-003);
- the Web workflow prototype and reserved desktop composition (GH-004);
- the initial GLM Harness brand layer and partial interface replacement (GH-BRAND).

The live ledger — including blocked items and unmet budgets — is [docs/glm/delivery-status.json](docs/glm/delivery-status.json). Remote archives, direct SSH bootstrap, and resident-service supervision and reconnection slices are implemented; complete remote lifecycle and desktop integration remain under review.

Validation against the real GLM API is pending credentials and stays open in the ledger; every workflow claim so far is backed by a scripted mock endpoint recorded in the evidence runs.

<a id="run-from-source"></a>

<a id="run"></a>

## Run from source

### Requirements

- Node.js `^22.19.0 || >=24.0.0`
- pnpm
- A display, when launching the desktop shell

### Build and initialize profiles

```sh
pnpm install
pnpm run build
pnpm tsx scripts/gh-init-profiles.ts
```

The last command writes the GH product profiles into `~/.glmh` (override with `--home <dir>`). Re-running never touches an already-initialized profile.

### Launch

```sh
# Web UI at http://127.0.0.1:3080 by default
DSH_HOME=~/.glmh node apps/cli/lib/bin.js gh-web

# Electron shell over the reserved desktop profile
DSH_HOME=~/.glmh pnpm start:desktop

# Headless agent loop, no UI
DSH_HOME=~/.glmh node apps/cli/lib/bin.js gh-headless
```

The three profile names are booted exactly like any DSH profile, because they are ordinary profiles: the launcher loads whatever a home's `profiles/<name>` provides. The `desktop` profile is reserved for the Electron shell and refused by the terminal launcher.

### Configure a model

Open Settings → Models in the Web UI and store a credential for the GLM route (default endpoint `https://open.bigmodel.cn/api/paas/v4`). Requests go through the GH-written transport; no other model plugin is involved.

<a id="repository-layout"></a>

## Repository layout

| Path | Role |
| --- | --- |
| `packages/glm/base` | `@glm-harness/gh-base` — the GH base bundle every profile starts from |
| `packages/glm/model-glm` | `@glm-harness/gh-model-glm` — GLM chat-completions wire stack (transport, SSE, translate) |
| `packages/glm/brand` | `@glm-harness/gh-brand` — identity, theme ramp, and slot occupants |
| `packages/glm/desktop` | `@glm-harness/gh-desktop` — reserved-profile overlay, disables upstream telemetry |
| `scripts/gh-init-profiles.ts` | Writes the profile compositions the launcher discovers at runtime |
| `scripts/check-gh-closure.ts` | Gate: GLM closures must stay free of upstream model, account, and telemetry packages |
| `docs/glm/delivery-status.json` | Delivery ledger |
| `artifacts/gh-validation/` | Recorded validation runs (config, cases, logs, screenshots) |
| `apps/`, `packages/`, `vendor/` | Upstream DSH runtime, kept as imported |

<a id="development"></a>

## Development

```sh
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test
pnpm tsx scripts/check-gh-closure.ts
pnpm run constraints
pnpm run verify-translation-pairing
```

`check-gh-closure` composes every GH profile and fails if the `@glm-harness` dependency closure or the composed profile names an upstream model, account, or telemetry package. Review [SAFETY.md](SAFETY.md) before running an agent against real workspaces.

Main pushes and manual runs build [Windows x64 unsigned previews](.github/workflows/gh-windows-x64.yml) and [Linux runtime archives](.github/workflows/gh-remote-release.yml). Windows previews use an explicit standalone application ID without local release-account files. Only `gh-v*` tags attach artifacts to GitHub Releases; signed installation and auto-update qualification remain separate. The inherited real-DeepSeek suite runs in upstream or when `DSH_ENABLE_REAL_API_E2E=true` is explicitly configured; enabled runs still require their API secret.

<a id="license"></a>

## License

MIT, inherited from DeepSeek Harness; third-party notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). GLM Harness is an independent derivative and is not affiliated with DeepSeek AI or the GLM model vendor.
