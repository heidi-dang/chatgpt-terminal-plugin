# ChatGPT Terminal Continuous Quality Loop

This playbook is a reusable control prompt for ChatGPT when working on this repository through the Terminal plugin. Its purpose is to keep repository work evidence-driven, incremental, reviewable, and continuously pushed to one rolling pull request.

## Primary instruction

Use the Terminal plugin as the execution surface for this repository and keep iterating over the entire codebase. Repeatedly audit, reproduce defects, debug root causes, improve performance, refactor maintainability problems, improve the Terminal UI/UX, strengthen tests, and verify production behavior.

Do not stop after one successful fix. Continue through the loop until the current execution budget is exhausted or the explicit stop conditions are met. When a new chat/turn resumes the work, recover the same branch and same open pull request and continue from the next unfinished loop cycle.

A cycle is successful only when **100% of the defined acceptance gates pass** and the cycle scores **10/10**. Never use “100% working” to mean that zero undiscovered defects can exist; it means every required observable gate in this playbook passed with recorded evidence.

## Repository baseline

The repository is a pnpm TypeScript monorepo containing:

- `packages/mcp-server` — MCP backend, HTTP/SSE, authorization, gateway, audit, turn/session lifecycle, stream capabilities, trusted extensions.
- `packages/local-agent` — persistent PTY, local execution, code-block execution, device identity, gateway client, LSP lifecycle.
- `packages/protocol` — shared protocol and Zod schemas.
- `packages/terminal-ui` — static-first single-file MCP App Terminal UI.
- `tests/unit` — security, lifecycle, authorization, installer, UI, process, buffering, LSP, and extension coverage.
- `tests/e2e` — actual MCP v2 client -> server -> authenticated local agent -> real PTY flow.

Current mandatory local gate:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
```

The Terminal UI bundle currently has a hard repository budget of 30,000 bytes. At creation of this playbook the built single-file UI was 29,956 bytes, so bundle headroom is a priority performance risk. UI improvements must recover and preserve meaningful headroom rather than simply adding weight until the hard limit is hit.

## Non-negotiable Git / PR invariant

There must be exactly one rolling feature branch and one open pull request for this continuous quality campaign.

1. Never do improvement work directly on `main`.
2. Reuse `quality/continuous-terminal-audit` if it exists.
3. Preserve pre-existing user work. Never reset, discard, clean, or overwrite unexplained changes.
4. Every coherent successful improvement is its own commit chunk.
5. Push after every successful chunk.
6. Open the PR once. After it exists, update that PR; never create a second PR for this campaign.
7. Never force-push unless the user explicitly orders it.
8. Never merge the rolling PR unless the user explicitly orders it.
9. If more than one matching open PR exists, stop Git mutation and reconcile the ambiguity before continuing.
10. A failed or partially verified change must not be committed as a successful chunk.

### Recovery commands

At the beginning of every resumed session:

```bash
git status --short --branch
git branch --show-current
git remote -v
gh pr list --state open --head quality/continuous-terminal-audit --json number,title,url,headRefName,baseRefName,isDraft
```

If the branch exists locally, switch to it. If it only exists remotely, track it. If the current working tree contains unexplained changes, inspect and preserve them before doing anything else.

The PR invariant is:

```text
open PR count for quality/continuous-terminal-audit -> main == 1
```

If count is zero, push the branch and create one draft PR. If count is one, reuse it. If count is greater than one, do not create another.

## Continuous loop

Run the following phases in order for every cycle.

### Phase 0 — Recover and prove the baseline

Before selecting new work:

- Confirm repository, branch, HEAD, remote, working-tree state, and current PR.
- Read the latest PR discussion/check state before changing code.
- Run or confirm the mandatory local gate on the current HEAD.
- Record current Terminal UI bundle size.
- Record any known failing live behavior, flaky behavior, regression, warning, or near-limit resource.
- Do not start a new refactor on top of a failing baseline unless the purpose of the chunk is to repair that failure.

### Phase 1 — Whole-repo audit sweep

Rotate through all of these scopes. Do not repeatedly polish only the easiest area.

#### A. Correctness and lifecycle

Audit:

- PTY create/write/read/resize/interrupt/close semantics.
- turn/session ownership and teardown.
- stale PTY cleanup and process-tree cleanup.
- reconnect/resume and cursor monotonicity.
- duplicate, stale, out-of-order, and gap event handling.
- SSE capability issuance, expiry, refresh, fallback, and teardown.
- error propagation and retry boundaries.
- code-block execution and cancellation.
- LSP start/request/notification/stop behavior.

#### B. Security and isolation

Audit:

- OAuth/JWT boundaries.
- user/client/session/device isolation.
- execution-profile authorization.
- replay protection and device challenge validation.
- path traversal, symlink, canonicalization, and workspace containment.
- secret leakage in logs, tool output, UI, errors, and tests.
- trusted extension loading/reload boundaries.
- request validation and schema drift.
- denial behavior for read-only and insufficient profiles.

Never weaken a security boundary merely to make a test pass.

#### C. Performance and resource behavior

Audit and measure:

- Terminal UI bundle bytes and gzip size.
- render batching and DOM growth.
- output trimming and retained buffers.
- SSE reconnect churn and polling fallback frequency.
- unnecessary timers, listeners, EventSource instances, WebSockets, PTYs, and LSP processes.
- CPU/memory growth under long output.
- large transcript behavior.
- repeated parsing/normalization work.
- server hot paths and avoidable allocations.
- startup/build/test duration when a code change could materially affect them.

Performance changes require before/after evidence, not intuition.

For the current UI, recover meaningful space below the 30,000-byte hard limit. A UI change that leaves only trivial headroom is not 10/10 unless there is strong evidence that further reduction would cause a meaningful regression.

#### D. Refactoring and maintainability

Look for:

- oversized classes/functions and mixed responsibilities.
- duplicated stream/session/error logic.
- unclear state machines.
- weak types, broad records, or repeated parsing.
- dead code and obsolete compatibility paths.
- implicit coupling between MCP server, agent, protocol, and UI.
- missing reusable helpers where duplication creates defect risk.
- test fixtures/helpers that obscure intent.

Refactor only with behavior locked by tests. Avoid churn-only rewrites.

#### E. Terminal UI / UX

Audit the live Terminal UI itself, not only static source:

- initial loading/connecting state.
- transition to live state.
- reconnecting/offline/failed/closed/exited states.
- actual streamed output during a long-running command.
- output ordering and duplicate suppression.
- scroll behavior and auto-follow behavior.
- overflow/text effects without reordering terminal truth.
- rich syntax highlighting.
- code-block execution presentation.
- LSP activity presentation.
- long paths and long machine names.
- narrow/mobile/iOS layout.
- keyboard/focus behavior where applicable.
- accessible labels, contrast, reduced-motion behavior, and readable status.
- terminal history trimming without visible corruption.
- no blank terminal while a live session is producing output.

Every UI chunk needs visual/live evidence in addition to unit tests.

#### F. Tests, CI, docs, install, deployment

Audit:

- regression coverage for every fixed bug.
- missing negative tests and teardown tests.
- E2E coverage of real PTY behavior.
- installer idempotence and failure messages.
- docs against actual commands/configuration.
- production environment examples.
- health/readiness behavior.
- release/deployment reproducibility.
- CI coverage for the mandatory gate.
- dependency/runtime constraints.

Documentation must describe real behavior, not intended behavior.

### Phase 2 — Select one bounded chunk

Choose the highest-impact verified finding that can be completed coherently.

A chunk should normally contain one root cause or one tightly related improvement family. Examples:

- fix a reconnect state-machine defect plus its regression tests;
- reduce UI bundle/render cost without behavior regression;
- extract duplicated stream parsing and add focused tests;
- fix mobile overflow and add responsive verification;
- harden LSP teardown and add process-leak coverage.

Do not combine unrelated cleanup merely to make a larger commit.

Before editing, write down:

```text
Cycle:
Finding:
Reproduction / evidence:
Root cause hypothesis:
Files expected to change:
Targeted tests:
Performance/UI evidence required:
Regression risks:
```

### Phase 3 — Reproduce before repair

For a defect:

1. Reproduce it deterministically where practical.
2. Add or identify a test that fails for the correct reason.
3. Trace the root cause across protocol/server/agent/UI boundaries as needed.
4. Avoid symptom-only delays, retries, arbitrary sleeps, or hidden fallbacks.

For performance/refactor/UI work:

1. Capture the relevant before-state.
2. Define the measurable or observable desired result.
3. Lock critical existing behavior with tests before restructuring.

### Phase 4 — Implement the root-cause fix

Implementation rules:

- Prefer the smallest architectural change that resolves the root cause cleanly.
- Keep protocol schemas and implementation synchronized.
- Preserve least privilege and containment.
- Bound buffers, output, retries, timers, and resource lifetimes.
- Clean up every listener/timer/PTY/LSP/EventSource/WebSocket created by the changed path.
- Do not hardcode machine-specific paths, hosts, credentials, or environment values.
- Do not add dependencies for convenience when the existing stack can solve the problem cleanly.
- Do not suppress errors that should be visible to the model, operator, test, or UI.

### Phase 5 — Targeted verification

Run the smallest tests that directly prove the chunk first.

Examples:

```bash
pnpm vitest run tests/unit/terminal-ui.test.tsx
pnpm vitest run tests/unit/terminal-turn-registry.test.ts
pnpm vitest run tests/unit/process-features.test.ts
pnpm vitest run tests/e2e/terminal.e2e.test.ts
```

Also run any new regression test added by the chunk.

A failing targeted test means the cycle is not complete. Debug it before proceeding.

### Phase 6 — Full mandatory gate

Before every successful commit chunk run:

```bash
pnpm typecheck && \
pnpm lint && \
pnpm test && \
pnpm test:e2e && \
pnpm build
```

All commands must exit zero.

Additionally run:

```bash
git diff --check
git status --short
```

Review the actual diff for accidental files, generated output, secrets, debugging statements, broad formatting churn, and unrelated changes.

### Phase 7 — Live Terminal proof

For changes affecting terminal behavior, streaming, UI, PTY lifecycle, code execution, or LSP, verify using the Terminal plugin itself.

Minimum live exercise:

1. Start one fresh terminal session for the current user turn.
2. Run a multi-step/long-output sequence long enough to observe streaming rather than only final output.
3. Confirm output appears while the process is active.
4. Confirm ordering remains correct.
5. Confirm the UI leaves `connecting` and reaches the expected live/final state.
6. Exercise resize/interrupt/close if the changed scope touches them.
7. Exercise reconnect/fallback behavior if the changed scope touches streaming.
8. Exercise syntax-highlighted output/code block behavior if the changed scope touches rendering.
9. Exercise LSP start/request/notification/stop if the changed scope touches LSP.
10. Confirm no stale PTY/process remains after teardown.

For UI changes, inspect both a wide layout and a narrow/mobile-sized layout. Capture a screenshot/evidence artifact when the available Terminal/App surface supports it.

### Phase 8 — 10/10 acceptance score

Score the chunk using exactly these ten gates. Each gate is binary: 1 or 0. No partial credit.

| # | Gate | Pass condition |
|---|---|---|
| 1 | Root cause | Root cause is identified and addressed, not merely masked. |
| 2 | Regression proof | Focused regression test or equivalent deterministic evidence exists and passes. |
| 3 | Type/lint/build | Typecheck, lint, and production build all pass. |
| 4 | Unit/E2E | Entire unit suite and real E2E suite pass. |
| 5 | Security/isolation | Changed path preserves authorization, containment, validation, and secret boundaries. |
| 6 | Performance/resources | No unexplained regression; changed resource/performance path has before/after evidence. |
| 7 | UI/UX | Relevant live UI behavior is verified, including state transitions and mobile impact where applicable. |
| 8 | Resilience/cleanup | Error, reconnect, cancellation, teardown, and resource cleanup are verified for affected paths. |
| 9 | Maintainability | Diff reduces or does not worsen complexity/duplication and contains no unrelated churn. |
| 10 | Git/evidence | Diff reviewed, `git diff --check` clean, commit is coherent, push succeeds, and same PR is updated. |

Required result:

```text
Score: 10/10
Defined acceptance gates passed: 100%
```

If any gate is 0, the chunk is **not done**, must not be labeled successful, and should not be committed as a completed improvement.

### Phase 9 — Commit one successful chunk

After 10/10 verification only:

```bash
git add <only-the-files-for-this-chunk>
git diff --cached --check
git diff --cached --stat
git diff --cached
```

Use an explicit commit message such as:

```text
fix: harden terminal stream recovery
perf: reduce terminal UI render overhead
refactor: isolate terminal stream state machine
ui: improve mobile terminal status and overflow
```

Then push the same branch:

```bash
git push -u origin quality/continuous-terminal-audit
```

Do not create a new branch for each cycle.

### Phase 10 — Create or update exactly one PR

Check first:

```bash
gh pr list --state open --head quality/continuous-terminal-audit --json number,title,url,isDraft
```

If no PR exists, create one draft PR targeting `main`.

Suggested title:

```text
Continuous terminal plugin audit, hardening and UI improvements
```

The PR body must maintain a rolling evidence table:

```markdown
| Cycle | Commit | Scope | Root cause / improvement | Targeted proof | Full gate | Bundle/perf | Live UI | Score |
|---|---|---|---|---|---|---|---|---|
```

After every pushed chunk, update the same PR body with the new row and any important residual risk.

Never create PR #2 for the same campaign just because a new cycle starts.

### Phase 11 — CI verification

If GitHub Actions/required checks exist, inspect the exact pushed commit. Do not declare the cycle closed while required CI is failing or pending.

When polling GitHub Actions, use `gh run view` and exit immediately on failure. Do not hide a failed check by rerunning blindly; inspect the failure and fix the root cause.

A CI-only failure is still a failed cycle even if local tests passed.

### Phase 12 — Continue immediately

After a successful push/PR update:

1. Re-read `git status --short --branch`.
2. Confirm the PR still targets `main` and still uses the same head branch.
3. Select the next audit scope, preferring one not covered in the previous cycle.
4. Start the next loop without waiting for a new instruction while the current ChatGPT execution budget allows it.

## Priority order for the first passes

Given the current repository state, use this initial order unless new evidence shows a more severe problem:

1. Recover Terminal UI bundle headroom and inspect render/output growth behavior.
2. Stream/SSE reconnect, fallback, gap recovery, and stale-session teardown.
3. PTY/process/LSP leak and lifecycle audit.
4. Mobile/iOS Terminal UI layout, overflow, reconnect status, and long-output UX.
5. Authorization/device/session isolation and trusted-extension boundaries.
6. Refactor the highest-risk oversized stateful modules only after behavior is fully locked by tests.
7. Installer/deployment/CI/release-readiness audit.
8. Whole-repo adversarial regression sweep.

## Failure loop

When any check fails:

```text
FAIL -> capture exact evidence -> localize root cause -> repair -> targeted tests -> full gate -> live proof -> rescore
```

Do not:

- commit a known failing state as a completed chunk;
- skip E2E because unit tests pass;
- skip live UI proof for UI/streaming changes;
- lower test expectations to match broken behavior;
- add arbitrary sleep/retry delays as a substitute for fixing synchronization;
- silently discard the user's existing changes;
- open another PR to avoid repairing the first one.

## Clean-sweep rule

A single green test run is not enough to declare the repository fully audited.

After all known findings are fixed, perform at least three clean adversarial sweeps with different emphasis:

1. correctness/security/lifecycle;
2. performance/resource/refactor;
3. UI/mobile/deployment/test/release.

Each sweep must inspect fresh evidence and the current diff/HEAD. If a sweep finds a material issue, create another bounded cycle and continue.

When all three sweeps produce no material actionable defect or regression and every required gate remains green, report:

```text
Repository campaign status: 10/10 against the defined acceptance model.
Defined acceptance gates: 100% passing.
Open PR: exactly one.
Branch: quality/continuous-terminal-audit.
All successful improvements: committed in coherent chunks and pushed.
Remaining items: only explicitly documented non-blocking opportunities, if any.
```

Then leave the rolling PR open for user review unless explicitly instructed to merge it.

## Resume handoff format

If the ChatGPT turn/context/tool budget ends before the campaign is complete, finish with this durable handoff so the next turn can continue without starting over:

```text
Repo:
Branch:
HEAD:
Open PR:
Last completed cycle:
Last 10/10 evidence:
Current bundle size:
Working tree:
Unfinished finding:
Exact next command/action:
Do not create another PR.
```

The next ChatGPT turn must recover this state, use the Terminal plugin again, and continue the same loop.
