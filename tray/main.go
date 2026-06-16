package main

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync"
	"time"

	"clawser-tray/internal/clawser"
	"github.com/getlantern/systray"
)

type serviceState string

const (
	stateChecking serviceState = "Checking"
	stateOff      serviceState = "Off"
	stateStarting serviceState = "Starting"
	stateStopping serviceState = "Stopping"
	stateOn       serviceState = "On"
	stateAttached serviceState = "Attached"
	stateError    serviceState = "Error"
)

type trayApp struct {
	cli clawser.CLI

	ctx    context.Context
	cancel context.CancelFunc

	stateMu sync.Mutex
	state   serviceState
	detail  string

	opMu sync.Mutex

	statusItem *systray.MenuItem
	detailItem *systray.MenuItem
	startItem  *systray.MenuItem
	stopItem   *systray.MenuItem
	quitItem   *systray.MenuItem
}

func main() {
	log.SetPrefix("clawser-tray: ")
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	systray.Run(onReady, onExit)
}

func onReady() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	app := &trayApp{
		cli:    clawser.ResolveCLI(),
		ctx:    ctx,
		cancel: cancel,
		state:  stateChecking,
		detail: "Locating Clawser...",
	}
	app.buildMenu()
	app.render()
	app.startHandlers()
	go app.pollStatus()
	go func() {
		<-ctx.Done()
		systray.Quit()
	}()
}

func onExit() {}

func (a *trayApp) buildMenu() {
	systray.SetTitle("Clawser")
	systray.SetTooltip("Clawser")
	systray.SetIcon(iconFor(stateChecking))

	a.statusItem = systray.AddMenuItem("Clawser: Checking", "Current Clawser relay state")
	a.statusItem.Disable()
	a.detailItem = systray.AddMenuItem("Status: Checking...", "Detailed status")
	a.detailItem.Disable()
	systray.AddSeparator()
	a.startItem = systray.AddMenuItem("Start Clawser", "Start the local Clawser relay")
	a.stopItem = systray.AddMenuItem("Stop Clawser", "Stop the local Clawser relay")
	systray.AddSeparator()
	a.quitItem = systray.AddMenuItem("Quit", "Quit Clawser Tray")
}

func (a *trayApp) startHandlers() {
	go func() {
		for {
			select {
			case <-a.ctx.Done():
				return
			case <-a.startItem.ClickedCh:
				go a.startClawser()
			case <-a.stopItem.ClickedCh:
				go a.stopClawser()
			case <-a.quitItem.ClickedCh:
				a.cancel()
				return
			}
		}
	}()
}

func (a *trayApp) pollStatus() {
	ticker := time.NewTicker(1500 * time.Millisecond)
	defer ticker.Stop()

	a.refreshStatus()
	for {
		select {
		case <-a.ctx.Done():
			return
		case <-ticker.C:
			a.refreshStatus()
		}
	}
}

func (a *trayApp) refreshStatus() {
	a.stateMu.Lock()
	current := a.state
	a.stateMu.Unlock()
	if current == stateStarting || current == stateStopping {
		return
	}

	status := clawser.ProbeRelay(a.ctx)
	switch {
	case !status.Reachable:
		a.setState(stateOff, "Relay offline")
	case status.Connected:
		a.setState(stateAttached, "Relay online, Chrome tab attached")
	default:
		a.setState(stateOn, "Relay online, no tab attached")
	}
}

func (a *trayApp) startClawser() {
	if !a.beginOperation(stateStarting, "Starting relay...") {
		return
	}
	defer a.opMu.Unlock()

	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	if output, err := a.cli.Run(ctx, "start", "--json"); err != nil {
		a.setState(stateError, summarizeError(err, output))
		return
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status := clawser.ProbeRelay(a.ctx)
		if status.Reachable {
			if status.Connected {
				a.setState(stateAttached, "Relay online, Chrome tab attached")
			} else {
				a.setState(stateOn, "Relay online, no tab attached")
			}
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	a.setState(stateError, "Relay did not become reachable")
}

func (a *trayApp) stopClawser() {
	if !a.beginOperation(stateStopping, "Stopping relay...") {
		return
	}
	defer a.opMu.Unlock()

	ctx, cancel := context.WithTimeout(a.ctx, 10*time.Second)
	defer cancel()
	if output, err := a.cli.Run(ctx, "stop", "--json"); err != nil {
		a.setState(stateError, summarizeError(err, output))
		return
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !clawser.ProbeRelay(a.ctx).Reachable {
			a.setState(stateOff, "Relay offline")
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	a.setState(stateError, "Relay still appears reachable")
}

func (a *trayApp) beginOperation(state serviceState, detail string) bool {
	if !a.opMu.TryLock() {
		a.setState(stateError, "Another operation is already running")
		return false
	}
	a.setState(state, detail)
	return true
}

func (a *trayApp) setState(state serviceState, detail string) {
	a.stateMu.Lock()
	a.state = state
	a.detail = detail
	a.stateMu.Unlock()
	a.render()
}

func (a *trayApp) render() {
	a.stateMu.Lock()
	state := a.state
	detail := a.detail
	a.stateMu.Unlock()

	systray.SetTitle(titleFor(state))
	systray.SetTooltip("Clawser: " + string(state))
	systray.SetIcon(iconFor(state))

	if a.statusItem != nil {
		a.statusItem.SetTitle("Clawser: " + string(state))
	}
	if a.detailItem != nil {
		a.detailItem.SetTitle("Status: " + detail)
	}

	busy := state == stateStarting || state == stateStopping || state == stateChecking
	if a.startItem != nil {
		if busy || state == stateOn || state == stateAttached {
			a.startItem.Disable()
		} else {
			a.startItem.Enable()
		}
	}
	if a.stopItem != nil {
		if busy || state == stateOff {
			a.stopItem.Disable()
		} else {
			a.stopItem.Enable()
		}
	}
}

func titleFor(state serviceState) string {
	switch state {
	case stateAttached:
		return "Clawser On"
	case stateOn:
		return "Clawser On"
	case stateOff:
		return "Clawser Off"
	case stateStarting:
		return "Clawser..."
	case stateStopping:
		return "Clawser..."
	case stateError:
		return "Clawser Error"
	default:
		return "Clawser"
	}
}

func summarizeError(err error, output string) string {
	trimmed := strings.TrimSpace(output)
	if trimmed != "" {
		lines := strings.Split(trimmed, "\n")
		last := strings.TrimSpace(lines[len(lines)-1])
		if last != "" {
			return last
		}
	}
	return err.Error()
}

func iconFor(state serviceState) []byte {
	var fill color.RGBA
	switch state {
	case stateOn, stateAttached:
		fill = color.RGBA{R: 30, G: 180, B: 90, A: 255}
	case stateError:
		fill = color.RGBA{R: 220, G: 70, B: 70, A: 255}
	case stateStarting, stateStopping, stateChecking:
		fill = color.RGBA{R: 230, G: 170, B: 45, A: 255}
	default:
		fill = color.RGBA{R: 120, G: 120, B: 120, A: 255}
	}

	const size = 18
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	center := float64(size-1) / 2
	radius := 7.0
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx := float64(x) - center
			dy := float64(y) - center
			if dx*dx+dy*dy <= radius*radius {
				img.Set(x, y, fill)
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}
