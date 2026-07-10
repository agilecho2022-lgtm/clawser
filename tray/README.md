# Clawser Tray

Local tray/menu bar helper for Clawser.

The first version intentionally keeps the menu small:

- Start Clawser / Stop Clawser, depending on relay state
- Relay status
- Quit

## Run From Source

```bash
cd tray
go run .
```

## Build

```bash
cd tray
go build ./...
```

## macOS Local App Bundle

```bash
cd tray
./scripts/build-macos-app.sh
open -n "/tmp/Clawser Tray.app"
```

The local app bundle is intentionally written to `/tmp` so development builds do
not add generated binaries to the repository.

## CLI Resolution

The tray app resolves Clawser in this order:

1. `CLAWSER_BIN`
2. The nearest parent checkout containing `clawser.mjs`
3. `clawser` on `PATH`
