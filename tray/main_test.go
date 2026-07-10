package main

import (
	"encoding/binary"
	"image/color"
	"testing"
)

func TestServiceMenuPresentationForState(t *testing.T) {
	tests := []struct {
		name      string
		state     serviceState
		wantTitle string
		wantOn    bool
		wantOp    serviceOperation
	}{
		{
			name:      "checking disables start action while status is unknown",
			state:     stateChecking,
			wantTitle: "Start Clawser",
			wantOn:    false,
			wantOp:    serviceOperationNone,
		},
		{
			name:      "off offers start",
			state:     stateOff,
			wantTitle: "Start Clawser",
			wantOn:    true,
			wantOp:    serviceOperationStart,
		},
		{
			name:      "starting keeps start visible but disabled",
			state:     stateStarting,
			wantTitle: "Start Clawser",
			wantOn:    false,
			wantOp:    serviceOperationNone,
		},
		{
			name:      "stopping keeps stop visible but disabled",
			state:     stateStopping,
			wantTitle: "Stop Clawser",
			wantOn:    false,
			wantOp:    serviceOperationNone,
		},
		{
			name:      "on offers stop",
			state:     stateOn,
			wantTitle: "Stop Clawser",
			wantOn:    true,
			wantOp:    serviceOperationStop,
		},
		{
			name:      "attached offers stop",
			state:     stateAttached,
			wantTitle: "Stop Clawser",
			wantOn:    true,
			wantOp:    serviceOperationStop,
		},
		{
			name:      "error offers start",
			state:     stateError,
			wantTitle: "Start Clawser",
			wantOn:    true,
			wantOp:    serviceOperationStart,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := serviceMenuPresentationFor(tt.state)

			if got.title != tt.wantTitle {
				t.Fatalf("title = %q, want %q", got.title, tt.wantTitle)
			}
			if got.enabled != tt.wantOn {
				t.Fatalf("enabled = %t, want %t", got.enabled, tt.wantOn)
			}
			if got.operation != tt.wantOp {
				t.Fatalf("operation = %q, want %q", got.operation, tt.wantOp)
			}
		})
	}
}

func TestWindowsIconEncodesICO(t *testing.T) {
	icon := windowsIcon(color.RGBA{R: 30, G: 180, B: 90, A: 255})
	if len(icon) < 6+3*16 {
		t.Fatalf("icon is too short: %d bytes", len(icon))
	}

	if got := binary.LittleEndian.Uint16(icon[0:2]); got != 0 {
		t.Fatalf("reserved field = %d, want 0", got)
	}
	if got := binary.LittleEndian.Uint16(icon[2:4]); got != 1 {
		t.Fatalf("icon type = %d, want 1", got)
	}
	if got := binary.LittleEndian.Uint16(icon[4:6]); got != 3 {
		t.Fatalf("image count = %d, want 3", got)
	}

	wantSizes := []byte{16, 24, 32}
	lastOffset := uint32(6 + 3*16)
	for i, wantSize := range wantSizes {
		entry := 6 + i*16
		if got := icon[entry]; got != wantSize {
			t.Fatalf("image %d width = %d, want %d", i, got, wantSize)
		}
		if got := icon[entry+1]; got != wantSize {
			t.Fatalf("image %d height = %d, want %d", i, got, wantSize)
		}
		if got := binary.LittleEndian.Uint16(icon[entry+4 : entry+6]); got != 1 {
			t.Fatalf("image %d planes = %d, want 1", i, got)
		}
		if got := binary.LittleEndian.Uint16(icon[entry+6 : entry+8]); got != 32 {
			t.Fatalf("image %d bit depth = %d, want 32", i, got)
		}

		size := binary.LittleEndian.Uint32(icon[entry+8 : entry+12])
		offset := binary.LittleEndian.Uint32(icon[entry+12 : entry+16])
		if offset < lastOffset {
			t.Fatalf("image %d offset = %d, want at least %d", i, offset, lastOffset)
		}
		if int(offset+size) > len(icon) {
			t.Fatalf("image %d range [%d, %d) exceeds icon length %d", i, offset, offset+size, len(icon))
		}
		if got := binary.LittleEndian.Uint32(icon[offset : offset+4]); got != 40 {
			t.Fatalf("image %d bitmap header size = %d, want 40", i, got)
		}
		if got := binary.LittleEndian.Uint32(icon[offset+8 : offset+12]); got != uint32(wantSize)*2 {
			t.Fatalf("image %d bitmap height = %d, want %d", i, got, wantSize*2)
		}
		lastOffset = offset + size
	}
}
