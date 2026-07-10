---
name: clawser-chrome-cli
description: Use when an agent needs to operate, inspect, test, or automate Google Chrome through the Clawser CLI, including opening pages, taking snapshots, clicking/typing by snapshot refs, capturing screenshots/PDFs, reading console/errors/network requests, handling downloads/uploads/dialogs, and troubleshooting Clawser Browser Relay connection state.
---

# Clawser Chrome CLI

Use Clawser as the browser-control surface when the task needs real Chrome state, local pages, login sessions, extension-mediated Chrome control, visual evidence, or repeatable CLI automation.

## Command Selection

Prefer the installed command when available:

```bash
clawser browser --json status
```

If `clawser` is not on `PATH`, run from this checkout:

```bash
node /Users/agilecho/code/project/clawser/clawser.mjs browser --json status
```

For scripts and agent automation, use the explicit `browser` command plus `--json`. Human-facing examples may use the top-level shortcuts, which map to the same browser commands:

```bash
clawser snapshot
clawser click <ref>
clawser type <ref> "text"
```

## Startup Workflow

1. Check whether the relay and browser profile are ready:

   ```bash
   clawser browser --json status
   ```

2. Start the relay if needed:

   ```bash
   clawser browser --json start
   ```

3. Ensure the Chrome tab is connected. If commands report no attached tab, ask the user to open the target tab in Chrome and click the pinned **Clawser Browser Relay** extension icon until the badge shows `ON`.

4. Confirm attached tabs:

   ```bash
   clawser browser --json tabs
   ```

5. Use `open` for a new tab, or `navigate` for the current focused tab:

   ```bash
   clawser browser --json open https://example.com
   clawser browser --json navigate https://example.com/dashboard
   ```

## Core Interaction Loop

Always snapshot before interacting. Re-snapshot after navigation, DOM updates, submitting forms, opening modals, or scrolling.

```bash
clawser browser --json snapshot --format ai --limit 500
```

Use refs from the latest snapshot:

```bash
clawser browser --json click <ref>
clawser browser --json type <ref> "hello"
clawser browser --json type <ref> "query" --submit
clawser browser --json press Enter
clawser browser --json hover <ref>
clawser browser --json scrollintoview <ref>
clawser browser --json select <ref> OptionA OptionB
```

Refs are ephemeral. Do not reuse old refs after the page changes.

## Waiting

Prefer semantic waits over fixed sleeps:

```bash
clawser browser --json wait --text "Done"
clawser browser --json wait --text-gone "Loading"
clawser browser --json wait --url "**/dashboard"
clawser browser --json wait --load networkidle
clawser browser --json wait ".ready-selector"
```

Use `--timeout-ms` when the page is expected to be slow.

## Evidence And Inspection

Capture artifacts when reporting UI state, visual regressions, or completed flows:

```bash
clawser browser --json screenshot --full-page
clawser browser --json screenshot --ref <ref>
clawser browser --json pdf
```

Inspect runtime evidence:

```bash
clawser browser --json console --level error
clawser browser --json errors
clawser browser --json requests
clawser browser --json responsebody <url>
```

Use `evaluate` sparingly for page state that snapshots cannot expose:

```bash
clawser browser --json evaluate --fn '() => document.title'
clawser browser --json evaluate --ref <ref> --fn '(el) => el.textContent'
```

Avoid arbitrary destructive page JavaScript unless the user explicitly requested that behavior.

## Forms, Files, Dialogs, And Downloads

Fill multiple fields with JSON descriptors:

```bash
clawser browser --json fill --fields '[{"ref":"1","value":"Ada"}]'
```

For file uploads, arm upload before clicking the page control that opens the file chooser:

```bash
clawser browser --json upload /tmp/clawser/uploads/file.pdf
clawser browser --json click <upload-ref>
```

For downloads:

```bash
clawser browser --json download <ref> /tmp/clawser/downloads/report.pdf
clawser browser --json waitfordownload /tmp/clawser/downloads/report.pdf
```

For alerts, confirms, and prompts, arm the dialog handler before triggering the dialog:

```bash
clawser browser --json dialog --accept
clawser browser --json click <dangerous-or-dialog-ref>
```

## Tabs And Profiles

List, focus, and close tabs:

```bash
clawser browser --json tabs
clawser browser --json focus <targetId>
clawser browser --json close <targetId>
clawser browser tab select 1
```

When multiple browser profiles are configured, pass the intended profile:

```bash
clawser browser --browser-profile chrome --json snapshot
```

## Troubleshooting

- `tab not found` or no attached tabs: the Chrome extension is not connected to a tab. Ask the user to click the **Clawser Browser Relay** extension icon on the target tab and wait for `ON`.
- Relay unreachable: run `clawser browser --json start`, then retry `status`.
- Need extension install path: run `clawser browser --json extension path` or `clawser extension path`.
- Need to install/update the unpacked extension: run `clawser browser --json extension install`, then ask the user to load the printed extension directory in `chrome://extensions`.
- Stale refs or wrong element: take a new `snapshot --format ai`; use `--selector`, `--interactive`, or `--compact` to narrow noisy pages.
- Slow page: add `wait --load networkidle`, `wait --text`, or a larger command `--timeout`.

## Safety Rules

- Do not close Chrome with system commands. `clawser browser stop` only stops the relay and is safe.
- Do not submit purchases, irreversible account changes, deletes, or external messages without explicit user confirmation.
- Redact secrets from final reports. Prefer saying that an authenticated page was reached instead of echoing tokens, cookies, passwords, or private account data.
- When working in a logged-in user browser, keep actions scoped to the requested task and report any unexpected navigation or permission prompt.
