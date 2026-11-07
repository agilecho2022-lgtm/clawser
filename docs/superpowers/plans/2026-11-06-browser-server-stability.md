# Browser server stability implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. User authorized execution; retain the existing workspace and previous changes. One fresh reviewer at the end.

**Goal:** Correct first-batch waiting, classification, target and ref behavior while retaining Edge 0.1.3.
**Architecture:** Patch existing browser owners and add narrow helpers for wait-source normalization and relay timeout selection. No extension/protocol/dependency changes.
**Tech Stack:** Node 22.23.2, TypeScript, Playwright 1.58.2, Vitest 4.1.
**Spec:** ../specs/2026-11-06-browser-server-stability-design.md

## Global Constraints

- All chrome-extension files and manifest stay byte-identical to the baseline; no store submission.
- Preserve preexisting uncommitted source/logging/privacy changes and BillRPA work.
- No installer build, push, merge or blanket staging/commit of the mixed worktree.
- Record before/after evidence under the BillRPA 2026-11-06-clawser-server-batch1 evidence directory.

## Review Focus

- A transient endpoint identification failure must recover and not silently select another page.
- An explicitly missing/ambiguous target must never issue an action on the only or same-URL page.
- Navigation, iframe replacement and Page replacement must not restore/renumber stale refs.
- A Promise wait may exceed 30 seconds but stays bounded; ordinary commands and disconnect keep their bounds.
- Real old 0.1.3 worker protocol/close handling remains compatible, independent of native fixture limitations.

### Task 1: Baseline characterization and endpoint classification

Files: pw-session.page-cdp.ts, pw-session.ts, endpoint tests and isolated characterization harness.
- [x] Capture dirty baseline and extension hashes; characterize long waits and temporary session attach/detach.
- [x] RED: first version request fails, next succeeds; connection retirement invalidates the cached classification.
- [x] GREEN: retain only successful classifications; invalidate at connection lifecycle boundaries. Keep existing native/extension routing.

### Task 2: Executable wait and relay budgets

Files: pw-tools-core.interactions.ts, evaluate-source.ts / wait-predicate.ts, extension-relay.ts, relay-command-timeout.ts, wait/relay tests.
- [x] RED: caller timeout respected, expression/function/body/async false semantics preserved, replacement document rejected.
- [x] RED: actual relay awaited Runtime survives 30 seconds and completes; ordinary work times out at 30; awaited work times out at 125; disconnect rejects pending work.
- [x] GREEN: correct third argument, pin Document and clean up handle; choose the command budget by Runtime await semantics.

### Task 3: Explicit target fails closed

Files: pw-session.ts and extension-fallback tests.
- [x] RED: missing target, failed metadata and ambiguous same-URL mapping cannot select the only/wrong Page; known target and no-target defaults remain usable.
- [x] GREEN: remove both outer/extension singleton fallbacks and unproven ordinal URL matching. No session aliases or automatic action retry.

### Task 4: Ref lifecycle and cold-start compatibility

Files: pw-session.ts, pw-tools-core.interactions.ts, pw-tools-core.snapshot.ts, ref/snapshot integration tests.
- [x] RED: old refs rejected after main navigation, selected iframe retirement, Page replacement; no fallback action on replacement controls; fresh snapshot works; cold start still works.
- [x] GREEN: distinct stale-ref error; clear bound target caches; bind frame-scoped refs to the resolved Frame; only genuinely cold unknown refs may refresh.

### Task 5: Whole-scope verification and review

- [x] Run full Vitest suite and relevant BillRPA missing-page/close compatibility tests; build and run typecheck, scoped lint/format.
- [x] Verify extension bytes against both baseline and submitted 0.1.3 ZIP; save final delta separately from preexisting changes.
- [x] Fresh read-only reviewer checks source delta, plan and observed evidence; address material findings with regression proof.
- [x] Update canonical BillRPA implementation/evidence records and report exact limitations, without claiming a new installer or deployment.

Completed 2026-11-07. Final full suite: 729 passed / 25 skipped / 0 failed; explicit native/targeted run: 36 passed (24 native, 12 unit); BillRPA compatibility: 14 passed. One independent review produced six material findings after regrading; all were covered in one RED→GREEN fix pass and the final green suite. The earlier 726-pass run preceded these review fixes and is not the final result. No extension, protocol, dependency, installer or deployment change. Canonical record: `/Users/agilecho/code/billrpa/doc/财务RPA/cards/2026-11-07-Clawser服务端稳定性第一批.md`.
