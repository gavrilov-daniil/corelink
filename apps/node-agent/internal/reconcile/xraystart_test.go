package reconcile

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"vpn-platform/node-agent/internal/config"
	"vpn-platform/node-agent/internal/controlplane"
	"vpn-platform/node-agent/internal/stats"
	"vpn-platform/node-agent/internal/xray"
)

// controlPlane отдаёт desired-state с новым хешем и запоминает отчёты агента.
type controlPlane struct {
	mu      sync.Mutex
	reports []map[string]any
}

func (c *controlPlane) handler(w http.ResponseWriter, r *http.Request) {
	switch {
	case strings.HasSuffix(r.URL.Path, "/desired-state"):
		_ = json.NewEncoder(w).Encode(map[string]any{
			"version":    2,
			"configHash": "hash-new",
			"config":     map[string]any{"inbounds": []any{map[string]any{"listen": "0.0.0.0", "port": 443, "protocol": "vless"}}},
			"users":      []any{},
		})
	case strings.HasSuffix(r.URL.Path, "/report"):
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		c.mu.Lock()
		c.reports = append(c.reports, body)
		c.mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	default:
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}
}

func (c *controlPlane) lastReport(t *testing.T) map[string]any {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.reports) == 0 {
		t.Fatal("агент не отправил отчёт")
	}
	return c.reports[len(c.reports)-1]
}

// agentWith собирает Reconciler с Xray, чьё поведение после рестарта задаёт isActive.
func agentWith(t *testing.T, cp *controlPlane, isActive string) *Reconciler {
	t.Helper()
	srv := statsServer(t, cp.handler)
	dir := t.TempDir()

	client, err := controlplane.New(controlplane.Options{
		BaseURL:    srv.URL,
		NodeID:     "11111111-1111-1111-1111-111111111111",
		AgentToken: "token",
	})
	if err != nil {
		t.Fatalf("controlplane.New: %v", err)
	}
	buf, err := stats.New(filepath.Join(dir, "stats-buffer.json"), "1", quietLogger())
	if err != nil {
		t.Fatalf("stats.New: %v", err)
	}
	xr := xray.NewManagerWithHooks("xray.service", "", "", xray.Hooks{
		Run: func(_ context.Context, name string, args ...string) ([]byte, error) {
			switch {
			case name == "systemctl" && args[0] == "is-active":
				if isActive != "active" {
					return []byte(isActive + "\n"), errors.New("exit status 3")
				}
				return []byte("active\n"), nil
			case name == "journalctl":
				return []byte("Failed to start: app/proxyman/inbound: failed to listen TCP on 443 > " +
					"listen tcp 0.0.0.0:443: bind: address already in use\n"), nil
			}
			return nil, nil // systemctl restart проходит — так и было в баге
		},
		Dial:           func(context.Context, string) error { return nil },
		StartupTimeout: 200 * time.Millisecond,
		StableFor:      10 * time.Millisecond,
		PollEvery:      2 * time.Millisecond,
	})

	cfg := &config.Config{XrayConfigPath: filepath.Join(dir, "xray", "config.json"), StateDir: dir, PullInterval: time.Minute}
	rec := New(cfg, client, xr, buf, quietLogger(), "test")
	if err := rec.saveAppliedState(appliedState{ConfigHash: "hash-old", Version: 1}); err != nil {
		t.Fatalf("saveAppliedState: %v", err)
	}
	return rec
}

// Баг 26.09.2026 (de1-exit): Xray не поднялся на новом конфиге — порт держал чужой
// процесс, — а агент отчитался новым хешем, и нода числилась сошедшейся.
func TestXrayThatFailedToStartIsReportedNotApplied(t *testing.T) {
	cp := &controlPlane{}
	rec := agentWith(t, cp, "failed")

	if err := rec.reconcileOnce(context.Background()); err == nil {
		t.Fatal("цикл с упавшим Xray должен вернуть ошибку — Run её залогирует")
	}

	report := cp.lastReport(t)
	if report["appliedConfigHash"] != "hash-old" {
		t.Fatalf("новый хеш выдан за применённый: %v", report["appliedConfigHash"])
	}
	xrayError, _ := report["xrayError"].(string)
	if !strings.Contains(xrayError, "address already in use") {
		t.Fatalf("в отчёте нет причины падения Xray: %q", xrayError)
	}

	applied, err := rec.loadAppliedState()
	if err != nil {
		t.Fatalf("loadAppliedState: %v", err)
	}
	if applied.ConfigHash != "hash-old" {
		t.Fatalf("неприменённый хеш сохранён на диск — следующий цикл не повторит применение: %s", applied.ConfigHash)
	}
}

func TestXrayThatStartedIsReportedAppliedWithoutError(t *testing.T) {
	cp := &controlPlane{}
	rec := agentWith(t, cp, "active")

	if err := rec.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}

	report := cp.lastReport(t)
	if report["appliedConfigHash"] != "hash-new" {
		t.Fatalf("appliedConfigHash = %v, ожидали hash-new", report["appliedConfigHash"])
	}
	if _, present := report["xrayError"]; present {
		t.Fatalf("у работающего Xray в отчёте не должно быть ошибки: %v", report["xrayError"])
	}
}
