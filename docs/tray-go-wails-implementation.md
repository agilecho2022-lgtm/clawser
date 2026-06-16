# Clawser Tray: Go systray / Wails Technical Plan

## Goal

Build a resident taskbar/menu bar app as Clawser's primary on/off control.

The tray app should:

- Start and stop the local Clawser relay.
- Show whether the relay is running.
- Quit the tray process.
- Optionally run on login.
- Ship as an installer or app bundle for normal users.

The Chrome extension remains responsible for attaching the current tab. The tray app owns the local service lifecycle.

## Recommended Direction

Use `Go + systray` for the first implementation.

Reasons:

- The required UI is only a tray/menu bar menu, not a full desktop window.
- The app can be a small native binary.
- It avoids bundling Chromium/Electron.
- It can call the existing `clawser` CLI without changing the Node/TypeScript core.
- Packaging can be handled independently per platform.

Use Wails only if we want a richer settings window, onboarding screen, logs viewer, or profile manager.

## Product Shape

Tray menu:

```text
Clawser: Off
----------------
Start Clawser
Stop Clawser
Status: Relay offline
----------------
Launch at Login [x]
Quit
```

When running:

```text
Clawser: On
----------------
Stop Clawser
Status: Relay online, tab attached
...
```

Status states:

- `Off`: relay is not reachable.
- `Starting`: start command is running or relay has not become reachable yet.
- `On`: relay status endpoint is reachable.
- `Attached`: relay reports at least one connected Chrome tab.
- `Error`: start/stop/status failed.

## Architecture

```text
tray app
  |
  | spawns / probes
  v
clawser CLI
  |
  | existing daemon wrapper
  v
clawser relay daemon
  |
  | HTTP extension relay
  v
Chrome extension
```

The tray app should not embed business logic from Clawser. It should treat the CLI and relay HTTP endpoint as the stable interface.

Primary operations:

```text
Start       -> clawser start --json
Stop        -> clawser stop --json
Status      -> clawser status --json
Relay probe -> GET http://127.0.0.1:18792/extension/status
```

## Implementation Option A: Go + systray

Suggested layout:

```text
tray/
  go.mod
  main.go
  internal/
    clawser/
      cli.go
      status.go
  assets/
    icon-off.png
    icon-on.png
    icon-error.png
```

Core packages:

- `github.com/getlantern/systray` for native tray/menu behavior.
- Standard `os/exec` for calling `clawser`.
- Standard `net/http` for fast relay probing.
- Optional autostart helper, or platform-specific implementation.

### Process Control

The tray app should call the installed CLI instead of directly spawning the daemon:

```go
exec.Command(clawserPath, "start", "--json")
exec.Command(clawserPath, "stop", "--json")
exec.Command(clawserPath, "status", "--json")
```

This preserves the current `clawser.mjs` behavior:

- Node version check.
- Profile env handling.
- Config bootstrapping.
- Daemon PID management.
- Browser command shortcut handling.

### CLI Discovery

Resolution order:

1. Bundled CLI inside the app package.
2. `CLAWSER_BIN` environment variable.
3. `clawser` on `PATH`.
4. Development fallback: repository checkout path.

For packaged full mode, prefer bundled CLI:

```text
macOS:
Clawser Tray.app/
  Contents/
    MacOS/clawser-tray
    Resources/
      clawser/
        clawser.mjs
        dist/
        chrome-extension/
      node/
        bin/node
```

Then set:

```text
PATH=<Resources/node/bin>:$PATH
```

and run:

```text
<Resources/node/bin/node> <Resources/clawser/clawser.mjs> start --json
```

This avoids requiring the user to install Node or pnpm.

### Status Loop

Run a background ticker every 1-2 seconds:

1. Probe `http://127.0.0.1:18792/extension/status`.
2. If reachable, parse `connected`.
3. Update menu label and icon.
4. If unreachable, show `Off`.

Do not run `clawser status` every second. Use the HTTP probe for cheap status, and use CLI status only for detailed diagnostics.

### Start Flow

```text
User clicks Start
  -> disable Start menu item
  -> set state Starting
  -> run clawser start --json
  -> wait for relay probe up to 5s
  -> set On or Error
```

If relay is already running, treat Start as success.

### Stop Flow

```text
User clicks Stop
  -> disable Stop menu item
  -> run clawser stop --json
  -> wait until relay probe fails
  -> set Off or Error
```

If relay is already stopped, treat Stop as success.

### Quit Flow

Default behavior:

- Quit only exits the tray app.
- It should ask or expose a preference before stopping Clawser on quit.

Optional menu item:

```text
Quit
Quit and Stop Clawser
```

This avoids accidentally killing an automation session when the user only wanted to hide the tray helper.

## Implementation Option B: Wails

Wails is better if we need a real desktop surface:

- First-run onboarding.
- Extension install walkthrough.
- Profile manager.
- Logs and diagnostics.
- Settings page.
- Update screen.

Suggested shape:

```text
tray-wails/
  wails.json
  main.go
  app.go
  frontend/
    src/
      App.tsx
      Settings.tsx
      Diagnostics.tsx
```

Wails would still call the same `clawser` commands. The difference is UI depth, not backend responsibility.

Possible Wails menu:

```text
Tray icon
  -> Start / Stop
  -> Open Dashboard
  -> Quit

Dashboard window
  -> Service status
  -> Extension setup
  -> Profiles
  -> Logs
  -> Diagnostics
```

Tradeoffs:

- More polished for non-technical users.
- More code and release surface.
- Larger than pure Go systray.
- Version-specific tray support should be verified before committing to the exact Wails version.

## Packaging

### Lightweight Mode

Installer includes only the tray app.

Requirements:

- User must already have `clawser` installed globally.
- User must already have compatible Node.js.

Pros:

- Small installer.
- Easier to maintain.

Cons:

- Less friendly to non-technical users.
- More environment/path failures.

### Full Mode

Installer includes:

- Tray binary.
- Clawser built output.
- Chrome extension assets.
- Node runtime.

Pros:

- Install-and-run experience.
- No pnpm or Node prerequisite.
- Better for distribution.

Cons:

- Larger installer.
- Need update strategy for bundled Node and Clawser.

Recommendation: use full mode for real users, lightweight mode for development.

### macOS

Target artifacts:

- `.app` bundle for local testing.
- `.dmg` for distribution.
- Optional `.pkg` if installing launch agents or privileged files is needed.

Implementation notes:

- Menu bar app should use `LSUIElement=true` so it does not appear in the Dock.
- Launch at login can use a LaunchAgent or modern login item APIs.
- Codesigning and notarization are required for smooth external distribution.

### Windows

Target artifacts:

- `.exe` for development.
- `.msi` or installer `.exe` for distribution.

Implementation notes:

- Tray app uses notification area.
- Launch at login can be implemented via registry `Run` key or Startup folder.
- Installer should add bundled CLI directory to an internal app path, not necessarily system `PATH`.

### Linux

Target artifacts:

- `.deb`
- `.rpm`
- AppImage, optional

Implementation notes:

- System tray availability varies by desktop environment.
- Autostart can use `~/.config/autostart/clawser-tray.desktop`.
- Some environments require AppIndicator support.

## Update Strategy

Start simple:

- Ship tray app and Clawser together.
- Version the tray app using the Clawser version.
- Replace the whole app bundle during update.

Future:

- Add update checks.
- Separate tray version from Clawser core version.
- Show "Update available" in menu.

## Security Notes

- The tray app should only call local `clawser` commands and local loopback endpoints.
- Avoid opening remote URLs from untrusted status output.
- Do not run shell strings. Use `exec.Command` with argument arrays.
- Prefer app-bundled paths over `PATH` lookup in full mode.
- Preserve the existing relay token and config behavior in `clawser.mjs`.

## Error Handling

Show concise errors in the tray menu:

```text
Error: Node runtime missing
Error: Relay failed to start
Error: CLI not found
Error: Extension not installed
```

Also write detailed logs:

```text
macOS:   ~/Library/Logs/Clawser Tray/tray.log
Windows: %LOCALAPPDATA%/Clawser Tray/logs/tray.log
Linux:   ~/.local/state/clawser-tray/tray.log
```

## Milestones

### Milestone 1: Local Development Tray

- Add `tray/` Go module.
- Implement systray menu.
- Wire Start, Stop, Status, Quit.
- Use existing globally linked `clawser`.
- Manual test on macOS.

### Milestone 2: Status Polish

- Add status display for relay attached/unattached.
- Improve error display without adding extension management actions.
- Keep Chrome extension installation in the CLI and README for now.

### Milestone 3: Bundled CLI

- Package built Clawser output into tray app resources.
- Bundle Node runtime.
- Resolve CLI path from app resources.
- Verify no global `clawser` dependency.

### Milestone 4: Installer

- Build `.app`.
- Add `LSUIElement=true`.
- Build `.dmg`.
- Add signing/notarization path.

### Milestone 5: Cross-platform

- Add Windows packaging.
- Add Linux packaging.
- Add platform-specific autostart.

## Open Decisions

- Should Quit stop the relay by default?
- Should Start ever run extension setup automatically, or should extension setup stay CLI-only?
- Should the tray app support multiple Clawser profiles?
- Should the tray app expose a settings window now, or defer until Wails is needed?
- Should the first packaged version be macOS-only?

## Initial Recommendation

Build the first version with `Go + systray` as a macOS menu bar app:

- Full mode eventually.
- Lightweight mode first.
- No settings window.
- Start/Stop/Status/Quit.

If that feels good, add a small settings window later. At that point we can either keep Go systray and open a simple native/web window, or migrate the tray frontend to Wails.
