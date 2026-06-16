# Clawser

Version: `2026.3.12`

Clawser is a browser automation CLI for controlling Chrome through a local
relay and the Clawser Chrome extension.

## Requirements

- Node.js `22.12+`
- pnpm
- Google Chrome

## Install

From this checkout:

```bash
pnpm install
pnpm build
pnpm link --global
```

If pnpm says the global bin directory is not configured, run:

```bash
pnpm setup
```

Then open a new shell and run `pnpm link --global` again.

Verify the CLI:

```bash
clawser --help
clawser status
```

## Chrome Extension

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

## Start

Start the local relay:

```bash
clawser start
```

The relay listens on:

```text
http://127.0.0.1:18792/
```

Open a Chrome tab, then click the pinned **Clawser Browser Relay** icon on that
tab. The badge should show `ON`.

Check attached tabs:

```bash
clawser tabs
```

Stop the relay:

```bash
clawser stop
```

## Commands

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

Debug page state:

```bash
clawser console
clawser errors
clawser requests
clawser evaluate --fn '() => document.title'
clawser cookies
clawser storage local get
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

## State Directory

Clawser stores local runtime files under:

```text
~/.clawser
```

Named profiles use matching directories, for example:

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

Before a tab is attached, the response should include:

```json
{ "connected": false }
```

After clicking the extension icon on a tab, it should become:

```json
{ "connected": true }
```

If commands such as `snapshot`, `screenshot`, `evaluate`, `cookies`, or
`storage` fail with:

```text
tab not found (no attached Chrome tabs for profile "chrome")
```

click the extension icon on the target tab and wait for the badge to show `ON`.

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
