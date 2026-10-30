# Port upstream Spectrum with oc-port-agent

This repository uses [kyeshmz/oc-port-agent](https://github.com/kyeshmz/oc-port-agent)
to adopt and synchronize functionality from
[photon-hq/spectrum-ts](https://github.com/photon-hq/spectrum-ts). The tracked
policies describe how upstream behavior maps onto the existing Web-only packages.

## Setup

Requirements: Node.js 22+, Git, pnpm 12.14.0, and an authenticated OpenCode V2 CLI
with the configured `openai/gpt-6.1-sol` model available.

```sh
pnpm install --frozen-lockfile
pnpm port:setup
pnpm port:check
```

`oc-port-agent` is not published to npm. `port:setup` clones and builds the actual
tool at reviewed commit
[`02acab4d72fdb3787cbfff153b5f5ce0e9cff7e6`](https://github.com/kyeshmz/oc-port-agent/tree/02acab4d72fdb3787cbfff153b5f5ce0e9cff7e6)
in ignored `.oc-port/tool/`. Re-running setup verifies that checkout's identity and
rebuilds it. It does not install anything globally. The tool is development-only;
none of its Node code is shipped in the SDK packages.

`pnpm oc-port` invokes that tool's CLI directly. `port:check` and `port:sync` select
the repository's `ports.json` collection. Follow the tool's
[installation requirements](https://github.com/kyeshmz/oc-port-agent/blob/02acab4d72fdb3787cbfff153b5f5ce0e9cff7e6/CONTRIBUTING.md#requirements-and-installation)
when configuring OpenCode authentication.

## Inspect, adopt, and synchronize

```sh
# Fetch main and compare with each policy's recorded checkpoint; no model call.
pnpm port:check

# Preview selected functionality already present upstream, including missing APIs.
pnpm port:check --full

# From a clean, committed checkout, create an isolated upstream-change proposal.
pnpm port:sync

# Adopt existing selected functionality, even when upstream has no new commits.
pnpm port:sync --full
```

The policies start from the reviewed Spectrum revision
`d9e39089dc3d1c6f4536826f5ca50798856eecab` using `baselineCommit`. This is a known
partial compatibility baseline, not a declaration that every selected API is
implemented. An ordinary check with no new commits can be up to date while
streaming text, Markdown, or other features remain absent. `--full` asks the tool
to evaluate existing selected functionality too.

For a smaller adoption, select one policy rather than the whole collection:

```sh
pnpm oc-port check --config oc-port-agent.json --full
pnpm oc-port sync --config oc-port-agent.json --full
```

`oc-port-agent.json` is also the default for `pnpm oc-port check`. Other policy
paths are listed in `ports.json`. A new narrowly scoped feature can use another
policy with its own upstream source/test paths, target edit paths, acceptance
criteria, immutable baseline, and verification commands. Add it to the collection
when it should participate in regular synchronization.

### Configured policies

| Policy | Selected behavior | Baseline full-preview bytes |
| --- | --- | ---: |
| `oc-port-agent.json` | Shared public API, builders, factory/selector shapes, and umbrella iMessage exports | 912,816 |
| `ports/cloud-actions.json` | Cloud iMessage sends, actions, attachments, and advanced content delivery | 909,184 |
| `ports/cloud-lifecycle.json` | Authentication, line inventory, lifecycle, inbound native streams, and metadata | 919,704 |
| `ports/shared-delivery.json` | Webhook verification/deserialization and shared stream/cancellation behavior | 946,751 |

At the baseline, their union includes **175 selected files, including 57 original
test files** and every original cloud-iMessage test. These are selected
evidence files, not counts of converted modules or passing upstream tests.
Each policy has a 1,000,000-byte complete-context limit. Separate policies keep
full before/after source packets within that limit; the combined selection would
exceed 2.3 MB. Future growth stops with an explicit size error rather than silently
dropping source context.

The two policies reading `packages/core/src/spectrum.ts` explicitly list that file
in `allowNulTextPaths`. Upstream uses a literal NUL inside a TypeScript string as a
platform/channel map-key separator. oc-port validates its UTF-8 and preserves its
exact contents in JSON context; the exception neither rewrites upstream nor adds
that implementation to the Cloudflare runtime.

### Proposal lifecycle

The tool fetches upstream into a bare cache, pins the source context, and uses a
private OpenCode server for each model task. It runs the collection's policies
sequentially in one proposal worktree, with independent checkpoints. Verification
installs dependencies in that fresh worktree, runs `pnpm pack:all`, and runs
`pnpm check:packed`. Collection verification runs again against the combined
result. Set `TMPDIR` to your preferred scratch directory before sync to choose
where proposal worktrees are created.

The CLI prints the proposal branch, worktree, and evidence paths. Review the diff,
original assertions, and `.oc-port/reports/*.json`, then merge the complete
verified proposal. Checkpoints become effective only after that merge. Failed
worktrees remain available for inspection.

To explicitly publish a verified proposal as a draft PR:

```sh
pnpm port:sync --pr --repo kyeshmz/spectrum-cloudflare --base main
```

That requires GitHub CLI authentication and a checkout matching the freshly
fetched remote base. Ordinary sync creates only a local proposal. The repository
does not schedule syncs; run the command when upstream should be checked.

## Adaptation and evidence

The configured scope covers shared core behavior, cloud iMessage, webhooks, and
the iMessage umbrella exports. It can expand existing compatibility, including
features present at the baseline. Other messaging providers, web-framework
adapters, local macOS integration, and upstream release infrastructure need their
own reviewed selection and target architecture. The tool does not automatically
partition or convert an arbitrary upstream monorepo.

Every policy preserves:

- Web-only deployed code: `Uint8Array`, Web Crypto, fetch, streams, and explicit
  Worker bindings; no Node/Bun APIs, polyfills, or `nodejs_compat`.
- Independent package consumption and the existing public API names/signatures.
- One app-owned line inventory, message materializer, and cancellation lifetime;
  canonical phone routing and multipart targets.
- Awaited webhook callbacks and authoritative backend message lookups.
- Original regression assertions and explicit attribution. An upstream-only
  platform capability or unavailable wire contract must be reported as blocked.

Verification scripts, package manifests, generated contracts, source pins, and
the existing boundary/provenance guards are protected from model edits. A port
needing a dependency, export-map, contract, or architecture change therefore
requires an operator-reviewed policy/setup change. Passing checks supports the
review; it does not prove whole-framework parity or live device delivery.
Current usage, runtime, and compatibility documentation can be updated alongside
implemented behavior, while original attribution and historical coverage remain.

Keep `tests/upstream-manifest.json` as the original adapted-test baseline. Record
new partial-port source revisions and assertion lineage in tests and `docs/ports/`
without relabeling old tests as rebased. A full baseline change requires reviewing
every indexed source and the pinned CI checkout. CI also audits the original
source hashes against that checkout. Local source tests do not fetch upstream;
dependency installation and isolated package-consumer setup may require network
access.

Policy changes invalidate saved checkpoints. Follow oc-port's explicit
`baseline --config <policy> --commit <reviewed-sha>` procedure and use `--full`
when newly selected behavior needs adoption. Avoid resetting to HEAD to make a
backlog disappear. Model and budget overrides do not change the policy hash:

```sh
pnpm port:sync --model openai/gpt-6.1-sol
```

For the exact CLI behavior, see the pinned tool's
[README](https://github.com/kyeshmz/oc-port-agent/blob/02acab4d72fdb3787cbfff153b5f5ce0e9cff7e6/README.md),
[collection guide](https://github.com/kyeshmz/oc-port-agent/blob/02acab4d72fdb3787cbfff153b5f5ce0e9cff7e6/docs/multiple-repositories.md),
and [structured instructions](https://github.com/kyeshmz/oc-port-agent/blob/02acab4d72fdb3787cbfff153b5f5ce0e9cff7e6/docs/porting-instructions.md).
Current implemented coverage remains in [UPSTREAM-COMPATIBILITY.md](UPSTREAM-COMPATIBILITY.md).

## Setup verification — 2026-10-30

- Fresh `pnpm port:setup` installed and built the pinned public commit above.
- The installed tool's official schemas, runtime parser, exact NUL-text allowances,
  verification commands, and target/protected edit boundaries passed validation
  for all four policies.
- `pnpm port:check` reported the unchanged upstream baseline as up to date.
- `pnpm port:check --full` successfully read every policy's complete source
  context, including the literal-NUL source. The table records those measured
  plan sizes. Full preview is inspection only; model-powered adoption remains a
  separate run.
- oc-port's private-server agent-discovery smoke passed with OpenCode **2.2.0**.
  The reader fix passed **78 tests** with one optional smoke test skipped, and its
  [Tool CI](https://github.com/kyeshmz/oc-port-agent/actions/runs/41114601045) passed.
