# Live Terminal Production Hardening Design

**Date:** 2026-09-04

## Goal

Make the ChatGPT Live Terminal widget production-grade on desktop and mobile without replacing the proven TypeScript/Vite architecture or weakening the existing SSE/MCP recovery guarantees.

## Current state

The widget is a small Vite-built MCP App delivered as one HTML artifact. The transport layer already supports SSE, bounded MCP `terminal_read` fallback, cursor resynchronisation, stream capability refresh, same-surface PTY replacement, lifecycle teardown, output trimming, theme updates, and session isolation. The targeted UI/runtime test suite is green before this work.

The main deficiencies are UX observability, terminal fidelity, heartbeat efficiency, accessibility, and maintainability. The current controller combines bridge logic, parsing, transport state, surface polling, output rendering and DOM state in one large file. A framework migration is not justified.

## Constraints

- Keep vanilla TypeScript and Vite; do not introduce React or another UI framework.
- Preserve the single-file production artifact and the existing 65,536-byte terminal UI budget.
- Preserve the current SSE-first transport with MCP fallback.
- Preserve exact terminal event ordering, cursor monotonicity and same-surface PTY replacement semantics.
- Do not invent completion percentages from PTY output. Only display task progress if an authoritative backend contract exists.
- Preserve reduced-motion support and dark/light host theme support.
- Maintain compatibility with the current MCP Apps bridge contract. Do not blindly bump the bridge protocol revision solely because newer MCP protocol material exists.

## Context7 decisions

Current MCP TypeScript SDK material exposes the 2026-07-28 era as a modern protocol with explicit extension capability negotiation, including the MCP Apps UI MIME extension. It also changes connection/version negotiation substantially relative to legacy initialize-style clients. Therefore this change keeps the existing widget bridge revision and treats protocol-version migration as a separate compatibility project.

Current Vite 7 guidance continues to recommend a normal production `vite build` and an explicit TypeScript typecheck alongside it. The existing project already follows that model, so no build-system replacement is required.

## UX design

### Follow mode

When the transcript is at or near the live tail, new output follows automatically. If the user scrolls away from the tail, the widget enters a paused-follow state without stopping rendering or transport. When new output arrives while follow is paused, a visible `New output` / `Jump to live` control appears. Activating it scrolls to the tail, resumes follow mode, and clears the pending-output indicator.

The control must be keyboard operable, have a visible focus state, and use a touch target suitable for mobile.

### Connection state

The primary status remains user-oriented: `LIVE`, `CONNECTING`, `RECONNECTING`, `OFFLINE`, `EXITED`, `CLOSED`, or `FAILED`. Transport detail (`SSE` or `MCP`) remains secondary diagnostic information in the footer. Connection state changes use restrained live-region semantics rather than making the transcript itself noisy to assistive technology.

### Terminal fidelity

Carriage return semantics must no longer expand progress-style output into a new line for each refresh. Streaming normalisation must distinguish CRLF from a bare CR. A bare CR means “replace the current logical line”; CRLF means newline. The implementation must work when the CR and replacement text arrive in different streaming chunks.

ANSI colouring and the existing DOM-safe semantic token highlighting remain in place.

### Adaptive surface synchronisation

Surface polling is required for host/session recovery but does not need a fixed two-second cadence forever. While no session is attached, while reconnecting, or immediately after visibility/session changes, use the fast recovery cadence. Once a live transport is healthy, use a slower heartbeat. When the document is hidden, stop scheduled polling; when visible again, poll immediately and resume the cadence appropriate to current state.

The surface poll must remain single-flight and stale results must not resurrect a destroyed or replaced session.

### Accessibility and mobile

- Connection state uses `role="status"` with restrained `aria-live="polite"`.
- The output retains keyboard focusability and gets a clear `:focus-visible` treatment.
- The output region label is transport-neutral because MCP fallback is a first-class runtime path.
- The HTML advertises both dark and light colour schemes.
- Mobile metadata text is not reduced below a practical readable size merely to preserve density.
- New interactive controls use production-size hit areas.

### Output retention messaging

When transcript trimming occurs, the inserted notice must describe output retention generically or accurately for the active viewport. Desktop trimming must never claim it happened “for mobile performance”.

## Module boundaries

The implementation may split `packages/terminal-ui/src/main.ts` where doing so improves testability, but module count is secondary to behaviour and bundle budget. Preferred responsibilities are:

- host/MCP bridge;
- terminal text/control-sequence normalisation;
- stream and fallback transport state;
- surface/session lifecycle;
- DOM rendering/follow interaction.

No split is acceptable if it creates circular dependencies or materially increases the single-file bundle without a maintainability benefit.

## Verification

Acceptance requires:

1. New regression tests prove paused-follow behaviour and jump-to-live behaviour.
2. New tests prove bare-CR line replacement across chunks while CRLF remains newline.
3. New tests prove adaptive/visibility-aware surface polling.
4. New tests prove the accessibility semantics and transport-neutral labelling.
5. Existing UI/runtime tests remain green.
6. Full repository quality workflow passes: dependency audit, typecheck, lint, unit, real PTY E2E, reconnect/concurrency soak, build and diff hygiene.
7. Terminal UI bundle remains within 65,536 bytes.
8. The verified branch is merged into `main` only after exact-head CI is green.
9. Production deployment runs from the merged `main` head and the deployed MCP/widget is smoke-verified.
