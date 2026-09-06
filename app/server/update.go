package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
)

// One entry per project_x table this feature knows how to refresh. Order is
// the order they run in - cheap/fast ones first so a user watching the
// progress bar sees movement immediately.
type updateStep struct {
	ID    string // matches the table name under D:/project_x/<exchange>/<id>
	Label string
	Run   func() (rowsAdded int, err error)
}

type stepResult struct {
	Status    string `json:"status"` // "pending" | "running" | "done" | "failed" | "skipped"
	RowsAdded int    `json:"rowsAdded,omitempty"`
	Error     string `json:"error,omitempty"`
}

type updateState struct {
	Status     string                `json:"status"` // "idle" | "running" | "complete" | "failed"
	Message    string                `json:"message"`
	Percent    int                   `json:"percent"`
	StartedAt  *time.Time            `json:"startedAt,omitempty"`
	FinishedAt *time.Time            `json:"finishedAt,omitempty"`
	Steps      map[string]stepResult `json:"steps"`
	Order      []string              `json:"order"`
}

var (
	updateMu    sync.Mutex
	currentJob  = updateState{Status: "idle", Steps: map[string]stepResult{}}
	updateSteps []updateStep
)

// registerUpdateSteps is called once from main() after every fetch function
// is defined, so this file doesn't need to know their implementations.
func registerUpdateSteps(steps []updateStep) {
	updateSteps = steps
	order := make([]string, len(steps))
	init := map[string]stepResult{}
	for i, s := range steps {
		order[i] = s.ID
		init[s.ID] = stepResult{Status: "pending"}
	}
	currentJob.Order = order
	currentJob.Steps = init
}

func snapshotState() updateState {
	updateMu.Lock()
	defer updateMu.Unlock()
	// Shallow-copy the map so the JSON encoder outside the lock can't race
	// with the goroutine still writing to it mid-update.
	cp := currentJob
	cp.Steps = make(map[string]stepResult, len(currentJob.Steps))
	for k, v := range currentJob.Steps {
		cp.Steps[k] = v
	}
	return cp
}

func setStepResult(id string, r stepResult) {
	updateMu.Lock()
	currentJob.Steps[id] = r
	updateMu.Unlock()
}

func setProgress(message string, percent int) {
	updateMu.Lock()
	currentJob.Message = message
	currentJob.Percent = percent
	updateMu.Unlock()
}

// runFullUpdate walks every registered step in order. A single step failing
// does not stop the run - the point of an "update everything" button is that
// one broken source (a site redesign, a network blip) shouldn't block every
// other table from refreshing, mirroring how the reference system (Hawkeye)
// treats a failed sub-step as reported, not fatal.
func runFullUpdate() {
	total := len(updateSteps)
	for i, step := range updateSteps {
		setStepResult(step.ID, stepResult{Status: "running"})
		setProgress("Updating "+step.Label, (i*100)/total)

		rows, err := step.Run()
		if err != nil {
			log.Printf("[update] %s failed: %v", step.ID, err)
			setStepResult(step.ID, stepResult{Status: "failed", Error: err.Error()})
			continue
		}
		setStepResult(step.ID, stepResult{Status: "done", RowsAdded: rows})
	}

	updateMu.Lock()
	now := time.Now()
	currentJob.FinishedAt = &now
	currentJob.Percent = 100
	failedAny := false
	for _, r := range currentJob.Steps {
		if r.Status == "failed" {
			failedAny = true
		}
	}
	if failedAny {
		currentJob.Status = "failed"
		currentJob.Message = "Update finished with some errors"
	} else {
		currentJob.Status = "complete"
		currentJob.Message = "All tables up to date"
	}
	updateMu.Unlock()
}

// GET /api/update
func handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	data, err := json.Marshal(snapshotState())
	writeJSON(w, data, err)
}

// POST /api/update
func handleUpdateTrigger(w http.ResponseWriter, r *http.Request) {
	updateMu.Lock()
	if currentJob.Status == "running" {
		updateMu.Unlock()
		w.WriteHeader(http.StatusConflict)
		data, _ := json.Marshal(snapshotState())
		w.Write(data)
		return
	}
	now := time.Now()
	init := map[string]stepResult{}
	for _, s := range updateSteps {
		init[s.ID] = stepResult{Status: "pending"}
	}
	currentJob = updateState{
		Status:    "running",
		Message:   "Starting update",
		Percent:   0,
		StartedAt: &now,
		Steps:     init,
		Order:     currentJob.Order,
	}
	updateMu.Unlock()

	go runFullUpdate()

	w.WriteHeader(http.StatusAccepted)
	data, _ := json.Marshal(snapshotState())
	w.Write(data)
}
