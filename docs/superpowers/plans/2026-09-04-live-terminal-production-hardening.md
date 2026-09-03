# Live Terminal Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the ChatGPT Live Terminal UX, terminal fidelity, accessibility, and surface-heartbeat efficiency while preserving the existing SSE/MCP recovery architecture and single-file bundle budget.

**Architecture:** Keep the current vanilla TypeScript/Vite MCP App. Add behaviour at the existing `TerminalViewer` boundary first, extracting helpers only when tests demonstrate a clear responsibility boundary. Preserve SSE-first streaming and MCP fallback; change only presentation/follow state, bare-CR handling, and surface polling cadence/lifecycle.

**Tech Stack:** TypeScript 5.9, Vite 7, Vitest/jsdom, MCP TypeScript SDK, EventSource, DOM APIs.

**Spec:** `docs/superpowers/specs/2026-09-04-live-terminal-production-hardening-design.md`

## Global Constraints

- Keep vanilla TypeScript and Vite; do not introduce a UI framework.
- Keep `packages/terminal-ui/dist/index.html` below 65,536 bytes.
- Preserve SSE-first streaming with bounded MCP `terminal_read` fallback.
- Preserve cursor ordering, same-surface PTY replacement, teardown, and session isolation.
- Do not invent task-progress percentages from PTY text.
- Keep current MCP Apps bridge protocol revision in this change; protocol-era migration is separate work.
- Use TDD: every behavioural production change must be preceded by a regression test that is observed failing for the intended reason.

---

### Task 1: Follow-state UX and accessibility shell

**Files:**
- Modify: `tests/unit/terminal-ui.test.tsx`
- Modify: `packages/terminal-ui/index.html`
- Modify: `packages/terminal-ui/src/main.ts`
- Modify: `packages/terminal-ui/src/styles.css`

**Interfaces:**
- Consumes: existing `TerminalViewer.queueOutput`, `flushOutput`, `renderState` and `#terminal-output` scrolling behaviour.
- Produces: `#terminal-jump-live` button, `data-follow` state on `#terminal-shell`, and accessible connection status semantics.

- [ ] **Step 1: Write failing tests**

Add tests that:

1. Put the output element away from the tail, emit a new terminal event, flush the animation frame, and assert that `#terminal-jump-live` becomes visible while `scrollTop` is preserved.
2. Activate the jump button and assert `scrollTop === scrollHeight`, the button becomes hidden, and subsequent output follows the tail.
3. Assert `#terminal-status` has `role="status"` and `aria-live="polite"`, output/focus labels are transport neutral, and `<meta name="color-scheme">` advertises `dark light`.

- [ ] **Step 2: Run the targeted test and verify RED**

Run through the PR quality workflow or locally:

`pnpm vitest run tests/unit/terminal-ui.test.tsx --exclude '.worktrees/**'`

Expected: failures because the jump control and new accessibility markup do not exist yet.

- [ ] **Step 3: Implement minimal follow state**

Add one button in the terminal frame:

`<button id="terminal-jump-live" class="terminal-jump-live" type="button" hidden>↓ New output</button>`

In `TerminalViewer`:

- cache the button;
- track whether the user is following the tail;
- update follow state from output scroll events;
- show the button only when new output arrives while follow is paused;
- on click, scroll to tail, resume follow and hide the control;
- do not stop rendering or transport when follow is paused.

Update status markup to `role="status" aria-live="polite" aria-atomic="true"` and make the terminal frame/output label transport-neutral.

- [ ] **Step 4: Add production CSS**

Add visible focus treatment for the output and jump button, a mobile-safe touch target, a compact floating placement that does not cover significant transcript content, and host-theme-compatible colours.

- [ ] **Step 5: Run targeted tests and build**

Run:

`pnpm vitest run tests/unit/terminal-ui.test.tsx --exclude '.worktrees/**'`

`pnpm --filter @terminal/terminal-ui typecheck`

`pnpm --filter @terminal/terminal-ui build`

Expected: pass; bundle remains below 65,536 bytes.

### Task 2: Streaming carriage-return fidelity

**Files:**
- Modify: `tests/unit/terminal-ui.test.tsx`
- Modify: `packages/terminal-ui/src/main.ts`

**Interfaces:**
- Consumes: `normalizeTerminalText`, `appendRichTerminalText`, `TerminalViewer.queueOutput`/`flushOutput`.
- Produces: stateful streaming text normalisation in which CRLF is newline and bare CR replaces the current logical line, including across chunks.

- [ ] **Step 1: Write failing tests**

Add tests for:

- `progress 10%\rprogress 20%\rprogress 30%\n` rendering as one final logical progress line rather than three lines;
- one chunk ending in bare `\r` and the next chunk containing replacement text;
- CRLF retaining normal newline semantics;
- ANSI-coloured progress replacement retaining safe rendered text.

- [ ] **Step 2: Run and verify RED**

Expected: current normalisation turns bare CR into newline, so progress-line assertions fail.

- [ ] **Step 3: Implement a minimal streaming normaliser**

Keep pure `normalizeTerminalText` deterministic for existing callers, but add a small stateful normaliser/renderer boundary for streamed chunks. Track the current logical line across chunks. On bare CR, replace the current logical line rather than append a newline; on CRLF, append newline. Do not use `innerHTML`.

If replacing already-rendered text requires DOM mutation, confine it to the current final logical line; never rescan the full transcript on every paint.

- [ ] **Step 4: Verify performance regression guard**

Keep the existing test proving normal streaming paints do not read the full transcript `textContent` on every frame. Add a specific assertion that ordinary no-CR chunks still take the append-only path.

- [ ] **Step 5: Run targeted tests/typecheck/build**

Expected: all terminal UI tests pass and the bundle remains within budget.

### Task 3: Adaptive and visibility-aware surface heartbeat

**Files:**
- Modify: `tests/unit/terminal-ui.test.tsx`
- Modify: `packages/terminal-ui/src/main.ts`

**Interfaces:**
- Consumes: `startSurfaceSync`, `pollSurface`, stream state, `document.visibilityState`.
- Produces: fast recovery polling when acquiring/reconnecting, slower polling while live, no scheduled polling while hidden, immediate resync on visibility restoration.

- [ ] **Step 1: Write failing fake-timer tests**

Test that:

- before a live transport exists, the recovery cadence causes a surface status call at the fast interval;
- after SSE reaches `live`, repeated surface calls do not continue at the old two-second rate and instead use a slower healthy interval;
- switching document visibility to hidden suppresses scheduled surface status calls;
- returning visible triggers an immediate status call and resumes the correct cadence;
- destroy removes visibility listeners/timers.

- [ ] **Step 2: Run and verify RED**

Expected: current fixed `setInterval(..., 2000)` violates healthy and hidden-state assertions.

- [ ] **Step 3: Replace fixed interval with scheduled heartbeat**

Use one timeout at a time rather than a permanent interval. Compute delay from state:

- recovery/acquisition: 2,000 ms;
- healthy live transport: 15,000 ms;
- final/closed state: no heartbeat;
- hidden document: no timer.

After each poll completes, schedule the next one from the latest state. On `visibilitychange` to visible, cancel stale timer, poll immediately, then reschedule. Preserve `surfacePollInFlight` single-flight behaviour.

- [ ] **Step 4: Verify tests**

Run targeted UI tests with fake timers and ensure no orphan timers remain after `destroy()`.

### Task 4: Accurate retention copy and mobile readability

**Files:**
- Modify: `tests/unit/terminal-ui.test.tsx`
- Modify: `packages/terminal-ui/src/main.ts`
- Modify: `packages/terminal-ui/src/styles.css`

**Interfaces:**
- Consumes: transcript trimming thresholds and current viewport detection.
- Produces: viewport-accurate trim notice and readable production metadata typography.

- [ ] **Step 1: Write failing tests**

Add a desktop trimming test that forces the desktop threshold and asserts the notice does not contain “mobile performance”. Keep the existing narrow-screen trimming test and update it to accept the new accurate/generic wording.

- [ ] **Step 2: Run and verify RED**

Expected: desktop trim currently emits the mobile-specific string.

- [ ] **Step 3: Implement accurate copy**

Use a generic notice such as `[Older terminal output trimmed to keep the live view responsive]` for both viewport classes, or explicitly choose viewport-specific accurate wording.

- [ ] **Step 4: Improve CSS readability**

Raise the smallest mobile kicker/status/footer/path sizes while preserving the compact card. Do not enlarge the terminal transcript enough to materially reduce useful output density.

- [ ] **Step 5: Run UI tests and build budget check**

Expected: green and below 65,536 bytes.

### Task 5: Maintainability refactor under green tests

**Files:**
- Modify or create focused files under `packages/terminal-ui/src/`
- Modify imports in `packages/terminal-ui/src/main.ts`

**Interfaces:**
- Consumes: behaviour proven green by Tasks 1–4.
- Produces: smaller responsibility boundaries without observable behaviour changes.

- [ ] **Step 1: Identify cohesive pure helpers**

Prefer extracting terminal text/control-sequence functions and bridge/result-normalisation helpers first because they have minimal shared mutable state. Do not split `TerminalViewer` merely to chase line-count targets.

- [ ] **Step 2: Refactor one responsibility at a time**

After each extraction, run:

`pnpm vitest run tests/unit/terminal-ui.test.tsx tests/unit/terminal-ui-runtime.test.ts tests/unit/terminal-ui-surface-recovery.test.ts --exclude '.worktrees/**'`

Expected: no behaviour change.

- [ ] **Step 3: Verify bundle budget**

Run terminal UI build and reject any refactor that materially increases the single-file artifact without compensating value.

### Task 6: Full verification, review, merge and deployment

**Files:**
- Potentially update documentation only if verification reveals changed operational behaviour.

**Interfaces:**
- Consumes: completed feature branch.
- Produces: verified `main` and deployed production MCP/widget.

- [ ] **Step 1: Run exact-head PR quality workflow**

Require all of:

- dependency audit;
- TypeScript typecheck;
- ESLint;
- unit tests;
- real PTY E2E;
- reconnect/concurrency soak;
- production build;
- `git diff --check`.

- [ ] **Step 2: Review the complete diff**

Check for protocol-version drift, invented progress semantics, security regressions, stale timers/listeners, transcript-order changes, mobile regressions, and bundle-budget regression.

- [ ] **Step 3: Merge exact verified head into `main`**

Use the exact PR head SHA guard when merging.

- [ ] **Step 4: Deploy from merged `main`**

Use the repository’s production deployment workflow, not the stale Replit GitSafe checkout. Wait for the deployment workflow to settle and verify the deployed commit matches the merge commit.

- [ ] **Step 5: Production smoke verification**

Verify public health/MCP reachability, a real `terminal_list_agents` or equivalent MCP operation, terminal surface creation, live output streaming/fallback, and widget resource delivery. Record the final commit and deployment status.
