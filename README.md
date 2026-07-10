# Clawser

Version: `2026.3.12`

Clawser is a local Chrome automation CLI. It starts a local relay, connects to
Chrome through the **Clawser Browser Relay** extension, and exposes browser
operations as CLI commands that are easy to call from scripts.

This checkout also includes a lightweight Go tray/menu bar helper for starting
and stopping the local relay.

Chinese documentation: [README_ZH.md](README_ZH.md)

## What Works Today

- Start and stop the local browser relay.
- Open Chrome automatically on `clawser start` when Chrome is not already
  running.
- Attach the current Chrome tab by clicking the pinned Chrome extension.
- Inspect tabs, snapshots, console messages, errors, requests, cookies, and
  storage.
- Interact with pages by ref: click, type, press, hover, drag, select, upload,
  wait, evaluate, screenshots, downloads, dialogs, and traces.
- Run as a CLI or through the included macOS menu bar helper.
- Use JSON output for Node.js/RPA scripts.

Current intentional limits:

- `clawser stop` stops the relay only. It does not close Chrome.
- The Chrome extension must still be clicked manually on the target tab so the
  badge shows `ON`.
- The tray app is currently a local development app bundle, not a signed
  installer.

## Requirements

- Node.js `22.12+`
- pnpm
- Google Chrome
- Go `1.24+` only if you want to build the tray helper

## Quick Install

Linux / macOS / WSL2 / Android (Termux):

```bash
curl -fsSL https://www.toymotion.fun/install.sh | bash
```

Windows native PowerShell:

```powershell
iex (irm https://www.toymotion.fun/install.ps1)
```

The quick install script installs the source checkout to `~/.clawser-src` and
links the `clawser` command to `~/.local/bin/clawser`. If `~/.local/bin` is not
on `PATH`, the script prints the line to add to your shell profile.

You can override the source, branch, and install directory with environment
variables:

```bash
curl -fsSL https://www.toymotion.fun/install.sh | \
  CLAWSER_BRANCH=main CLAWSER_INSTALL_DIR=/opt/clawser bash
```

## Install From Source

```bash
pnpm install
pnpm build
pnpm link --global
```

If pnpm says the global bin directory is not configured, run:

```bash
pnpm setup
```

Then open a new shell and run:

```bash
pnpm link --global
```

Verify the CLI:

```bash
clawser --help
clawser status
```

You can also run from the checkout without global linking:

```bash
node clawser.mjs status
```

## Chrome Extension Setup

Install the unpacked extension into Clawser's state directory:

```bash
clawser extension install
clawser extension path
```

The default extension path is:

```text
~/.clawser/browser/chrome-extension
```

Load it in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the folder printed by `clawser extension path`.
5. Pin **Clawser Browser Relay** in the toolbar.

## Basic Workflow

Start the local relay:

```bash
clawser start
```

The relay listens on:

```text
http://127.0.0.1:18792/
```

When Chrome is not running, `clawser start` opens Chrome with `about:blank`.
It does not attach a tab by itself.

Open the target Chrome tab, then click the pinned **Clawser Browser Relay**
extension icon on that tab. The badge should show `ON`.

Check relay attachment:

```bash
curl http://127.0.0.1:18792/extension/status
```

Expected states:

```json
{ "connected": false }
```

before attaching a tab, and:

```json
{ "connected": true }
```

after clicking the extension icon.

List attached tabs:

```bash
clawser tabs
```

Stop the relay:

```bash
clawser stop
```

`clawser stop` does not close Chrome.

To disable the automatic Chrome open on `start`:

```bash
CLAWSER_SKIP_CHROME_BOOTSTRAP=1 clawser start
```

## Tray / Menu Bar Helper

The repository includes a small Go tray app under `tray/`.

Current menu:

- `Start Clawser` or `Stop Clawser`, depending on relay state
- relay status
- `Quit`

Build and run the local macOS app bundle:

```bash
cd tray
./scripts/build-macos-app.sh
open -n "/tmp/Clawser Tray.app"
```

The local app bundle is written to `/tmp` so development builds do not add
generated binaries to the repository.

The tray app resolves Clawser in this order:

1. `CLAWSER_BIN`
2. The nearest parent checkout containing `clawser.mjs`
3. `clawser` on `PATH`

The tray app uses the same CLI behavior as `clawser start` and `clawser stop`.
It starts/stops the relay only; it does not click the Chrome extension for you.

## Common CLI Commands

Open and inspect pages:

```bash
clawser open https://www.baidu.com
clawser tabs
clawser snapshot --format ai
clawser snapshot --format aria --limit 200
clawser screenshot --full-page
```

Interact with a page:

```bash
clawser click <ref>
clawser type <ref> "hello"
clawser press Enter
clawser hover <ref>
clawser wait --text "Done"
```

Page state and debugging:

```bash
clawser console
clawser errors
clawser requests
clawser evaluate --fn '() => document.title'
clawser cookies
clawser storage local get
```

Downloads, upload, and dialogs:

```bash
clawser upload /path/to/file.pdf
clawser waitfordownload /tmp/downloaded-file
clawser download <ref> /tmp/downloaded-file
clawser dialog --accept
```

Profiles and extension helpers:

```bash
clawser status
clawser profiles
clawser extension install
clawser extension path
```

JSON output:

```bash
clawser status --json
clawser tabs --json
clawser snapshot --json
```

## Script Integration

Prefer JSON output for scripts:

```bash
clawser browser --json tabs
clawser browser --json snapshot --format ai --selector ".login-panel"
```

The repository can be called directly without a global install:

```js
const { execFile } = require("child_process");

execFile(
  process.execPath,
  ["/path/to/clawser/clawser.mjs", "browser", "--json", "tabs"],
  (error, stdout) => {
    if (error) throw error;
    console.log(JSON.parse(stdout));
  },
);
```

For legacy OpenClaw-style wrappers, map calls like this:

```text
openclaw browser tabs --json
  -> clawser browser --json tabs

snapshot("html", selector)
  -> clawser browser --json snapshot --format ai --selector <selector>
```

The `ai` snapshot returns `refs`, which can be used by `click`, `type`, `hover`,
and related commands.

## State Directory

Clawser stores runtime files under:

```text
~/.clawser
```

Named profiles use matching directories:

```text
~/.clawser-dev
~/.clawser-work
```

The relay token is fixed to:

```text
CLAWSER
```

The Chrome extension adds the token automatically. Users do not need to enter a
token in the extension.

## Troubleshooting

Relay not reachable:

```bash
clawser start
curl http://127.0.0.1:18792/extension/status
```

No attached tabs:

```text
tab not found (no attached Chrome tabs for profile "chrome")
```

Fix:

1. Open the target tab in Chrome.
2. Click the pinned **Clawser Browser Relay** extension icon.
3. Wait for the badge to show `ON`.
4. Run `clawser tabs`.

Chrome did not open on start:

```bash
node clawser.mjs start --json
```

If you intentionally do not want Clawser to open Chrome:

```bash
CLAWSER_SKIP_CHROME_BOOTSTRAP=1 clawser start
```

## Development

Useful checks:

```bash
pnpm build
pnpm test
pnpm tsgo
pnpm check
```

Focused smoke checks:

```bash
clawser --help
clawser status --json
clawser start --json
clawser extension install --json
clawser tabs --json
```

Tray checks:

```bash
cd tray
go test ./...
./scripts/build-macos-app.sh
open -n "/tmp/Clawser Tray.app"
```
