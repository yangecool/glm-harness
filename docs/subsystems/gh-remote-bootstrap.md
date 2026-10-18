# GH Remote Runtime Bootstrap

English | [中文](gh-remote-bootstrap.zh.md)

The remote runtime bootstrap is the E04.2 artifact chain that puts a complete GH runtime on an SSH-reachable Linux host that has no Node installed: a relocatable archive (staged CLI closure, bundled `bin/node`, initialized profile home template, POSIX installer, per-file digest manifest), a controller deployment pipeline over real OpenSSH, and acceptance tooling. The controller side lives in [`scripts/gh-remote/`](../../scripts/gh-remote) with the build entry [`scripts/build-gh-remote-archive.ts`](../../scripts/build-gh-remote-archive.ts); it deliberately reuses the upstream [SSH subsystem](ssh.md) tooling patterns while shipping a full runtime rather than a transport helper.

Source: [`scripts/gh-remote/artifact.ts`](../../scripts/gh-remote/artifact.ts), [`scripts/gh-remote/bootstrap.ts`](../../scripts/gh-remote/bootstrap.ts), [`scripts/gh-remote/deploy.ts`](../../scripts/gh-remote/deploy.ts)

## The archive

`pnpm run build` first, then `node --import tsx/esm scripts/build-gh-remote-archive.ts` stages the `@deepseek-ai/dsh` CLI closure with the same legacy-deploy steps the SSH helper uses, repairs what that deploy drops (workspace-owned peer and transitive packages are materialized to a fixpoint; the GH-banned upstream business packages are pruned), boots the staged closure through the real `gh-headless` profile against a loopback GLM fixture, and only then packs `gh-remote/` (bootstrap, `bin/node`, `runtime/`, `home-template/`, `LICENSES/`) into `dist-exe/gh-remote/gh-remote-<version>-<target>.tar.gz` with a `.sha256` sidecar. `manifest.json` inside the payload pins format, version, commit, target, node version, and every file's SHA-256 and mode; `verifyPayload` rejects missing, extra, duplicate, altered, or re-permissioned files before activation.

## The bootstrap

`bootstrap.sh` is generated POSIX sh (`scripts/gh-remote/bootstrap.ts`) and runs on the target with no Node: `install` probes kernel/architecture/libc, verifies the archive digest and the extracted file inventory byte-for-byte (`sha256sum` checklist parsed from the manifest with awk), stages under `flock`, moves the release into `releases/<timestamp>-<commit>`, flips the `current` symlink atomically, and seeds `home/` from the template once. `run`/`start`/`stop`/`status` manage the runner through the bundled node; `rollback` re-verifies and reactivates the previous release. Every failure names its stage and exits with that stage's code (probe 90 … usage 98), so controllers localize errors instead of guessing (F24). Linux glibc targets only for now; mac/windows remote hosts arrive with platform qualification (E04.6).

## The controller pipeline

`scripts/gh-remote-deploy.ts` is the user-facing command: `--save-as/--list/--remove` manage SSH target records (coordinates and key paths only — never secret material) in `~/.glmh/remote-targets.json`; `--target <name|user@host:port> --archive <path>` pins the host key on first use after showing its fingerprint (refusing untrusted keys, hard-failing on changed keys — R02), probes the host, uploads, installs, and reports the active release. Connection details delegate to the system `ssh`/`scp` (agent, config aliases, `ProxyJump`), and non-standard ports are first-class (R01/R03/R04 front). The acceptance driver `scripts/gh-remote-verify.ts` runs the whole matrix against an unprivileged fixture sshd through a PATH jail that provably contains no Node: TOFU refusal, probe, install, atomic activation, a real `gh-headless` turn writing a file on the target, tampered-archive refusal, concurrent-install serialization, and rollback. `scripts/gh-remote-mem.ts` collects MEM03/MEM04 samples (process-tree Rss/Pss from `/proc/*/smaps_rollup`) for the ready hold and a long scripted task.

## Relation to the SSH helper

The upstream SSH helper archive carries the transport-side runtime only; GH remote bootstrap composes the product runtime the helper connects to. Both share the release discipline — manifest-verified payloads, stage-localized failures, atomic activation — but the GH archive is built from the GH profile closure with its banned-package pruning and profile home template, and the two artifacts version independently.
