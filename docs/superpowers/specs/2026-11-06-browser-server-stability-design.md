# Browser server stability while retaining Edge extension 0.1.3

## Authorization and intent

User explicitly authorized first-batch server implementation after the code comparison and two review rounds, retaining compatibility with Edge extension 0.1.3 and deferring every extension change. This records the chosen approach, not another approval gate.

## Approach

Patch the existing Node 22 / Playwright 1.58.2 server. Keep extension protocol 3 and all extension files byte-identical to the approved package. A wholesale upstream migration would require a new extension/runtime; session aliases and general action retries are deferred. No dependency upgrade, installer build, publication, push, or unrelated business-flow changes.

## Behavior

- A failed /json/version read is not a durable negative classification. Successful endpoint classifications expire when the owning Playwright connection closes/disconnects.
- wait --fn passes options in Playwright's third argument; expression/function/body input (including trailing semicolons and async functions) is supported without executing supplied code in Node. Pin executable waits to their original Document, dispose even a late handle, and reject on navigation instead of accepting a replacement document. Page lookup, Document acquisition and execution share this condition's deadline; preceding sequential wait conditions retain their own budgets.
- Keep ordinary relay commands at the existing 30 seconds. Awaited Runtime commands receive at most 125 seconds (120-second action budget plus 5 seconds transport slack). Disconnect remains immediate.
- Explicit target IDs never fall back to the only Page. Ambiguous same-URL pages fail closed. A caller without a target retains its existing default selection. Do not introduce native session probing on the extension path.
- Navigation/frame retirement invalidates refs and their restoration cache. Stale refs use a distinct error, bypassing automatic re-snapshot. A replacement Page cannot silently restore refs from its predecessor. Preserve legacy cold-start re-snapshot only where no previous snapshot/ref identity is known. An unknown ref in an existing snapshot is not cold start.
- Ref actions pin actual nodes before acting so Playwright's actionability retries cannot resolve matching replacement controls across navigation. Delayed typing checks scope between characters; drag uses temporary unique markers on the two pinned nodes and removes them afterward. Raw AX ref ownership/epochs are checked independently of role refs.
- Preserve current close traces and the missing-business-page task gate. No global reconnect/retry of clicks, fills or submissions.

## Evidence and boundaries

First characterize waiting and temporary CDP attach/detach using isolated local components; record which browser/native boundaries are real. Tests must demonstrate actual state/output, not source-text matching. Pin the old dirty worktree and extension assets by SHA256; upstream has no .git, so use source hashes rather than inventing a commit. Verify targeted tests, full Clawser suite, build/types/lint and unchanged extension bytes. Run one fresh final review.
