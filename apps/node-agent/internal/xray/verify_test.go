package xray

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeSystem подменяет systemctl/journalctl: is-active отвечает по очереди из states
// (последний ответ повторяется), остальные команды — заданным текстом.
type fakeSystem struct {
	mu      sync.Mutex
	states  []string
	journal string
	show    string
	dialed  []string
	dialErr error
}

func (f *fakeSystem) run(_ context.Context, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case name == "systemctl" && len(args) > 0 && args[0] == "is-active":
		state := f.states[0]
		if len(f.states) > 1 {
			f.states = f.states[1:]
		}
		if state != "active" {
			return []byte(state + "\n"), errors.New("exit status 3")
		}
		return []byte("active\n"), nil
	case name == "systemctl" && len(args) > 0 && args[0] == "show":
		return []byte(f.show), nil
	case name == "journalctl":
		return []byte(f.journal), nil
	case name == "xray":
		return []byte("Xray 26.3.27 (test)\n"), nil
	}
	return nil, nil // restart и прочее — успех
}

func (f *fakeSystem) dial(_ context.Context, addr string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.dialed = append(f.dialed, addr)
	return f.dialErr
}

func (f *fakeSystem) manager() *Manager {
	return NewManagerWithHooks("xray.service", "", "", Hooks{
		Run:            f.run,
		Dial:           f.dial,
		StartupTimeout: 300 * time.Millisecond,
		StableFor:      20 * time.Millisecond,
		PollEvery:      2 * time.Millisecond,
	})
}

const realityOn443 = `{"inbounds":[{"listen":"0.0.0.0","port":443,"protocol":"vless"}]}`

// Журнал, каким он был на de1-exit 26.09.2026: порт 443 держал чужой Caddy.
const bindConflictJournal = `Xray 26.3.27 (Xray, Penetrates Everything.) d2758a0 (go1.26.1 linux/amd64)
2026/09/26 12:07:12 from 203.0.113.77:51514 accepted tcp:example.com:443 [VLESS_REALITY_DE1 -> direct]
Failed to start: app/proxyman/inbound: failed to listen TCP on 443 > listen tcp 0.0.0.0:443: bind: address already in use
xray.service: Main process exited, code=exited, status=255/EXCEPTION
xray.service: Failed with result 'exit-code'.
Failed to start: app/proxyman/inbound: failed to listen TCP on 443 > listen tcp 0.0.0.0:443: bind: address already in use
xray.service: Start request repeated too quickly.`

func TestVerifyRunningAcceptsStableActiveAndListeningPorts(t *testing.T) {
	sys := &fakeSystem{states: []string{"activating", "active"}}

	if err := sys.manager().VerifyRunning(context.Background(), []byte(realityOn443)); err != nil {
		t.Fatalf("VerifyRunning: %v", err)
	}
	if len(sys.dialed) != 1 || sys.dialed[0] != "127.0.0.1:443" {
		t.Fatalf("порт входа проверяется через loopback: %v", sys.dialed)
	}
}

// Сценарий бага: systemctl restart успешен, а Xray падает на bind и systemd сдаётся.
func TestVerifyRunningCatchesCrashLoopWithJournalReason(t *testing.T) {
	sys := &fakeSystem{
		states:  []string{"active", "activating", "active", "activating", "failed"},
		journal: bindConflictJournal,
	}

	err := sys.manager().VerifyRunning(context.Background(), []byte(realityOn443))
	if err == nil {
		t.Fatal("крэш-цикл принят за успешный старт")
	}
	msg := err.Error()
	if !strings.Contains(msg, "(failed)") || !strings.Contains(msg, "address already in use") {
		t.Fatalf("в ошибке нет состояния и причины: %q", msg)
	}
	if strings.Contains(msg, "203.0.113.77") {
		t.Fatalf("адрес клиента из строки доступа не должен уходить в отчёт: %q", msg)
	}
	if strings.Count(msg, "bind: address already in use") != 1 {
		t.Fatalf("повторы крэш-цикла должны схлопываться: %q", msg)
	}
	if len(sys.dialed) != 0 {
		t.Fatal("порт упавшего Xray пробовать бессмысленно — его может держать чужой процесс")
	}
}

func TestVerifyRunningRejectsActiveXrayWithDeadInbound(t *testing.T) {
	sys := &fakeSystem{states: []string{"active"}, dialErr: errors.New("connection refused")}

	err := sys.manager().VerifyRunning(context.Background(), []byte(realityOn443))
	if err == nil || !strings.Contains(err.Error(), "127.0.0.1:443") {
		t.Fatalf("ожидали ошибку про вход 127.0.0.1:443, получили %v", err)
	}
}

func TestVerifyRunningTimesOutWhenNeverActive(t *testing.T) {
	sys := &fakeSystem{states: []string{"activating"}, journal: bindConflictJournal}

	err := sys.manager().VerifyRunning(context.Background(), []byte(realityOn443))
	if err == nil || !strings.Contains(err.Error(), "(activating)") {
		t.Fatalf("ожидали отказ по таймауту в activating, получили %v", err)
	}
}

// Без группы systemd-journal у node-agent журнал закрыт — причина берётся из systemd.
func TestHealthFallsBackToSystemdSummaryWhenJournalIsHidden(t *testing.T) {
	sys := &fakeSystem{
		states: []string{"inactive"},
		journal: "Hint: You are currently not seeing messages from other users and the system.\n" +
			"      Users in groups 'adm', 'systemd-journal' can see all messages.\n-- No entries --\n",
		show: "Result=exit-code\nExecMainStatus=255\nNRestarts=5\n",
	}

	err := sys.manager().Health(context.Background())
	if err == nil {
		t.Fatal("неактивный Xray прошёл проверку здоровья")
	}
	msg := err.Error()
	if !strings.Contains(msg, "журнал недоступен") || !strings.Contains(msg, "ExecMainStatus=255") {
		t.Fatalf("ожидали итог systemd вместо журнала: %q", msg)
	}
}

func TestHealthPassesForActiveXray(t *testing.T) {
	sys := &fakeSystem{states: []string{"active"}}
	if err := sys.manager().Health(context.Background()); err != nil {
		t.Fatalf("Health: %v", err)
	}
}

func TestInboundAddrs(t *testing.T) {
	cfg := `{"inbounds":[
		{"listen":"0.0.0.0","port":443},
		{"listen":"127.0.0.1","port":10085},
		{"listen":"195.66.24.14","port":8443},
		{"listen":"::","port":2087},
		{"listen":"0.0.0.0","port":"1000-2000"},
		{"listen":"/run/xray.sock"}
	]}`

	got := inboundAddrs([]byte(cfg))
	want := []string{"127.0.0.1:443", "127.0.0.1:10085", "195.66.24.14:8443", "127.0.0.1:2087"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("inboundAddrs = %v, ожидали %v", got, want)
	}
}
