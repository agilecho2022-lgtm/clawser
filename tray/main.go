package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"os/signal"
	"runtime"
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

	stateMu      sync.Mutex
	state        serviceState
	detail       string
	renderedIcon serviceState
	renderMu     sync.Mutex

	opMu sync.Mutex

	statusItem  *systray.MenuItem
	detailItem  *systray.MenuItem
	serviceItem *systray.MenuItem
	quitItem    *systray.MenuItem
}

type serviceOperation string

const (
	serviceOperationNone  serviceOperation = ""
	serviceOperationStart serviceOperation = "start"
	serviceOperationStop  serviceOperation = "stop"
)

type serviceMenuPresentation struct {
	title     string
	enabled   bool
	operation serviceOperation
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
	go app.startClawser()
	go func() {
		<-ctx.Done()
		systray.Quit()
	}()
}

func onExit() {}

func (a *trayApp) buildMenu() {
	systray.SetTitle("Clawser")
	systray.SetTooltip("Clawser")

	a.statusItem = systray.AddMenuItem("Clawser: Checking", "Current Clawser relay state")
	a.statusItem.Disable()
	a.detailItem = systray.AddMenuItem("Status: Checking...", "Detailed status")
	a.detailItem.Disable()
	systray.AddSeparator()
	a.serviceItem = systray.AddMenuItem("Start Clawser", "Start or stop the local Clawser relay")
	systray.AddSeparator()
	a.quitItem = systray.AddMenuItem("Quit", "Quit Clawser Tray")
}

func (a *trayApp) startHandlers() {
	go func() {
		for {
			select {
			case <-a.ctx.Done():
				return
			case <-a.serviceItem.ClickedCh:
				switch serviceMenuPresentationFor(a.currentState()).operation {
				case serviceOperationStart:
					go a.startClawser()
				case serviceOperationStop:
					go a.stopClawser()
				}
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

func (a *trayApp) currentState() serviceState {
	a.stateMu.Lock()
	defer a.stateMu.Unlock()
	return a.state
}

func (a *trayApp) render() {
	a.renderMu.Lock()
	defer a.renderMu.Unlock()

	a.stateMu.Lock()
	state := a.state
	detail := a.detail
	a.stateMu.Unlock()

	systray.SetTitle(titleFor(state))
	systray.SetTooltip("Clawser: " + string(state))
	if state != a.renderedIcon {
		systray.SetIcon(iconFor(state))
		a.renderedIcon = state
	}

	if a.statusItem != nil {
		a.statusItem.SetTitle("Clawser: " + string(state))
	}
	if a.detailItem != nil {
		a.detailItem.SetTitle("Status: " + detail)
	}

	if a.serviceItem != nil {
		presentation := serviceMenuPresentationFor(state)
		a.serviceItem.SetTitle(presentation.title)
		if presentation.enabled {
			a.serviceItem.Enable()
		} else {
			a.serviceItem.Disable()
		}
	}
}

func serviceMenuPresentationFor(state serviceState) serviceMenuPresentation {
	switch state {
	case stateOn, stateAttached:
		return serviceMenuPresentation{
			title:     "Stop Clawser",
			enabled:   true,
			operation: serviceOperationStop,
		}
	case stateStopping:
		return serviceMenuPresentation{
			title:     "Stop Clawser",
			enabled:   false,
			operation: serviceOperationNone,
		}
	case stateOff, stateError:
		return serviceMenuPresentation{
			title:     "Start Clawser",
			enabled:   true,
			operation: serviceOperationStart,
		}
	default:
		return serviceMenuPresentation{
			title:     "Start Clawser",
			enabled:   false,
			operation: serviceOperationNone,
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

	if runtime.GOOS == "windows" {
		return windowsIcon(fill)
	}

	return pngIcon(fill, 18)
}

func pngIcon(fill color.RGBA, size int) []byte {
	img := statusIconImage(fill, size)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

func windowsIcon(fill color.RGBA) []byte {
	images := make([]*image.RGBA, 0, 3)
	for _, size := range []int{16, 24, 32} {
		images = append(images, statusIconImage(fill, size))
	}
	return encodeICO(images)
}

func statusIconImage(fill color.RGBA, size int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	center := float64(size-1) / 2
	radius := float64(size) * 0.39
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx := float64(x) - center
			dy := float64(y) - center
			distance := math.Sqrt(dx*dx + dy*dy)
			edge := radius - distance
			switch {
			case edge >= 1:
				img.Set(x, y, fill)
			case edge > 0:
				pixel := fill
				pixel.A = uint8(float64(fill.A) * edge)
				img.Set(x, y, pixel)
			}
		}
	}
	return img
}

func encodeICO(images []*image.RGBA) []byte {
	const (
		iconDirSize   = 6
		iconEntrySize = 16
	)

	imageData := make([][]byte, len(images))
	offset := iconDirSize + len(images)*iconEntrySize

	var buf bytes.Buffer
	writeUint16(&buf, 0)
	writeUint16(&buf, 1)
	writeUint16(&buf, uint16(len(images)))

	for i, img := range images {
		data := encodeICOBitmap(img)
		imageData[i] = data
		width := img.Bounds().Dx()
		height := img.Bounds().Dy()

		buf.WriteByte(icoSizeByte(width))
		buf.WriteByte(icoSizeByte(height))
		buf.WriteByte(0)
		buf.WriteByte(0)
		writeUint16(&buf, 1)
		writeUint16(&buf, 32)
		writeUint32(&buf, uint32(len(data)))
		writeUint32(&buf, uint32(offset))

		offset += len(data)
	}

	for _, data := range imageData {
		buf.Write(data)
	}
	return buf.Bytes()
}

func encodeICOBitmap(img *image.RGBA) []byte {
	bounds := img.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	xorStride := width * 4
	andStride := ((width + 31) / 32) * 4
	pixelBytes := xorStride * height
	maskBytes := andStride * height

	var buf bytes.Buffer
	writeUint32(&buf, 40)
	writeInt32(&buf, int32(width))
	writeInt32(&buf, int32(height*2))
	writeUint16(&buf, 1)
	writeUint16(&buf, 32)
	writeUint32(&buf, 0)
	writeUint32(&buf, uint32(pixelBytes+maskBytes))
	writeInt32(&buf, 0)
	writeInt32(&buf, 0)
	writeUint32(&buf, 0)
	writeUint32(&buf, 0)

	for y := height - 1; y >= 0; y-- {
		for x := 0; x < width; x++ {
			r, g, b, a := img.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			buf.WriteByte(byte(b >> 8))
			buf.WriteByte(byte(g >> 8))
			buf.WriteByte(byte(r >> 8))
			buf.WriteByte(byte(a >> 8))
		}
	}

	for y := height - 1; y >= 0; y-- {
		maskByte := byte(0)
		bit := uint(7)
		rowBytes := 0
		for x := 0; x < width; x++ {
			_, _, _, a := img.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			if a == 0 {
				maskByte |= 1 << bit
			}
			if bit == 0 {
				buf.WriteByte(maskByte)
				rowBytes++
				maskByte = 0
				bit = 7
			} else {
				bit--
			}
		}
		if bit != 7 {
			buf.WriteByte(maskByte)
			rowBytes++
		}
		for rowBytes < andStride {
			buf.WriteByte(0)
			rowBytes++
		}
	}

	return buf.Bytes()
}

func icoSizeByte(size int) byte {
	if size >= 256 {
		return 0
	}
	return byte(size)
}

func writeUint16(buf *bytes.Buffer, value uint16) {
	_ = binary.Write(buf, binary.LittleEndian, value)
}

func writeUint32(buf *bytes.Buffer, value uint32) {
	_ = binary.Write(buf, binary.LittleEndian, value)
}

func writeInt32(buf *bytes.Buffer, value int32) {
	_ = binary.Write(buf, binary.LittleEndian, value)
}
