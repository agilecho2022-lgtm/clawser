package clawser

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type RelayStatus struct {
	Reachable bool
	Connected bool
}

func ProbeRelay(ctx context.Context) RelayStatus {
	reqCtx, cancel := context.WithTimeout(ctx, 700*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, "http://127.0.0.1:18792/extension/status", nil)
	if err != nil {
		return RelayStatus{}
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return RelayStatus{}
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return RelayStatus{}
	}

	var body struct {
		Connected bool `json:"connected"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		return RelayStatus{Reachable: true}
	}
	return RelayStatus{Reachable: true, Connected: body.Connected}
}
