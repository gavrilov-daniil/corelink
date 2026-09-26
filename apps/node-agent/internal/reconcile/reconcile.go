// Package reconcile runs the pull → verify → apply → report loop.
package reconcile

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"vpn-platform/node-agent/internal/config"
	"vpn-platform/node-agent/internal/controlplane"
	"vpn-platform/node-agent/internal/stats"
	"vpn-platform/node-agent/internal/xray"
)

type Reconciler struct {
	cfg          *config.Config
	cp           *controlplane.Client
	xray         *xray.Manager
	stats        *stats.Buffer
	log          *slog.Logger
	agentVersion string
	statePath    string

	// lastStatsRead — момент предыдущего деструктивного чтения счётчиков; он же
	// window_start следующей дельты. Живёт только в памяти: после рестарта окно
	// начинается со старта процесса, и это корректно — счётчики в Xray на тот
	// момент уже обнулены прошлым чтением, а рестарт самого Xray обнуляет их
	// целиком. Времена монотонно растут, поэтому дедуп control-plane по
	// (node, subject, window_start) не задевается.
	lastStatsRead time.Time
}

func New(cfg *config.Config, cp *controlplane.Client, xr *xray.Manager, sb *stats.Buffer, log *slog.Logger, agentVersion string) *Reconciler {
	return &Reconciler{
		cfg:           cfg,
		cp:            cp,
		xray:          xr,
		stats:         sb,
		log:           log,
		agentVersion:  agentVersion,
		statePath:     filepath.Join(cfg.StateDir, "applied-state.json"),
		lastStatsRead: time.Now().UTC(),
	}
}

// Run reconciles once immediately, then on every tick until ctx is cancelled.
// A failed pass is logged and swallowed: if the control plane is unreachable the
// node must keep serving its last applied config, not fall over.
func (r *Reconciler) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.cfg.PullInterval)
	defer ticker.Stop()

	if err := r.reconcileOnce(ctx); err != nil {
		r.log.Warn("reconcile: initial pass failed, keeping last applied config", "err", err)
	}

	for {
		select {
		case <-ctx.Done():
			r.log.Info("reconcile: shutting down")
			return ctx.Err()
		case <-ticker.C:
			if err := r.reconcileOnce(ctx); err != nil {
				r.log.Warn("reconcile: pass failed, keeping last applied config", "err", err)
			}
		}
	}
}

func (r *Reconciler) reconcileOnce(ctx context.Context) error {
	desired, err := r.cp.PullDesiredState(ctx)
	if err != nil {
		return fmt.Errorf("pull: %w", err)
	}

	applied, err := r.loadAppliedState()
	if err != nil {
		return fmt.Errorf("load applied state: %w", err)
	}

	// xrayProblem — почему Xray сейчас не обслуживает клиентов. Уходит в отчёт: по
	// одному хешу control-plane считал бы сошедшейся ноду, где Xray лежит.
	var xrayProblem error
	// Hash idempotency: identical config_hash means nothing to do.
	if desired.ConfigHash == applied.ConfigHash {
		r.log.Debug("reconcile: config unchanged", "config_hash", desired.ConfigHash, "version", desired.Version)
		xrayProblem = r.xray.Health(ctx)
	} else {
		r.log.Info("reconcile: applying new config",
			"from_hash", applied.ConfigHash,
			"to_hash", desired.ConfigHash,
			"version", desired.Version,
			"users", len(desired.Users))
		if err := r.apply(ctx, desired); err != nil {
			// Хеш НЕ сохраняем: следующий цикл применит заново (порт мог освободиться).
			// Отчёт при этом уходит — с прежним хешем и причиной, иначе платформа видит
			// только замолчавший heartbeat и не знает, что чинить.
			xrayProblem = fmt.Errorf("apply: %w", err)
		} else {
			applied = appliedState{
				ConfigHash: desired.ConfigHash,
				Version:    desired.Version,
				AppliedAt:  time.Now().UTC(),
			}
			if err := r.saveAppliedState(applied); err != nil {
				return fmt.Errorf("persist applied state: %w", err)
			}
		}
	}

	if err := r.report(ctx, applied, xrayProblem); err != nil {
		return fmt.Errorf("report: %w", err)
	}
	// Метрики не важнее конфига: не сняли статистику — жалуемся и идём дальше,
	// нода при этом продолжает обслуживать актуальный desired-state.
	if err := r.collectStats(ctx); err != nil {
		r.log.Warn("reconcile: stats collection failed", "err", err)
	}
	if err := r.shipStats(ctx); err != nil {
		return fmt.Errorf("ship stats: %w", err)
	}
	return xrayProblem
}

func (r *Reconciler) apply(ctx context.Context, ds *controlplane.DesiredState) error {
	if err := r.xray.WriteConfig(r.cfg.XrayConfigPath, ds.Config); err != nil {
		return err
	}
	// v1 is thin: users live inside the full config, so any change (including a
	// single added/removed user) is applied by rewriting the config and doing a
	// full restart.
	// TODO(M2): apply user-only deltas live via Xray gRPC HandlerService.AlterInbound
	// (add/remove clients without dropping connections), and only reload/restart
	// when non-user parts of the config actually change.

	// Рестарт поднимает Xray с нулевыми счётчиками, поэтому снимаем накопленное
	// ДО него — иначе трафик с прошлого чтения уходит вместе со старым процессом.
	if err := r.collectStats(ctx); err != nil {
		r.log.Warn("reconcile: stats collection before restart failed", "err", err)
	}
	if err := r.xray.Restart(ctx); err != nil {
		return err
	}
	return r.xray.VerifyRunning(ctx, ds.Config)
}

// maxCountersPerEntry — потолок одной записи буфера, он же потолок одного тела
// POST /stats. На ноде с тысячей активных юзеров цикл даёт тысячи счётчиков, и
// одним куском они не влезали в лимит тела control-plane: батч получал 413 и
// вставал колом в голове очереди — учёт трафика по ноде замирал НАСОВСЕМ.
// 2000 счётчиков — это порядка 1000 дельт на проводе, сотни килобайт JSON.
const maxCountersPerEntry = 2000

// collectStats снимает дельту счётчиков с Xray и кладёт её в durable-буфер.
//
// Порядок здесь — не стилистика. QueryStats(reset=true) уже обнулил счётчики,
// поэтому дельта существует единственным экземпляром в памяти, и записать её на
// диск надо до любых сетевых операций (отправка идёт отдельно, из shipStats по
// содержимому буфера). Окно дельты — [lastStatsRead, момент чтения], и
// lastStatsRead двигается ТОЛЬКО после успешного Append: если запись не удалась,
// следующее окно поглотит потерянный интервал, а не начнётся с дырой.
func (r *Reconciler) collectStats(ctx context.Context) error {
	windowStart := r.lastStatsRead

	counters, err := r.xray.Stats(ctx)
	if err != nil {
		return err
	}
	readAt := time.Now().UTC()

	// Xray отдаёт все зарегистрированные счётчики, включая нулевые: на ноде с
	// тысячей юзеров это тысячи пустых записей каждые 30 секунд. Шлём только то,
	// где реально был трафик.
	counters = nonZero(counters)
	if len(counters) == 0 {
		// Окно всё равно закрываем — иначе window_start застынет и следующая
		// дельта приедет окном в несколько часов.
		r.lastStatsRead = readAt
		return nil
	}

	// Резать надо ЗДЕСЬ, а не при отправке. report_id выдаётся записи буфера, и он же
	// ключ дедупа на control-plane: разрезанный при отправке батч уехал бы несколькими
	// телами с ОДНИМ report_id, и все части кроме первой были бы отброшены как повтор.
	appended := 0
	for len(counters) > 0 {
		size := min(len(counters), maxCountersPerEntry)
		entry, err := r.stats.Append(windowStart, counters[:size])
		if err != nil {
			// Счётчики в Xray уже обнулены, а на диск дельта не легла — эти байты
			// потеряны. Громко, потому что это прямая недостача в учёте трафика.
			r.log.Error("reconcile: stats delta lost, buffer write failed", "counters", size, "err", err)
			// Часть кусков уже легла с этим window_start. Оставить окно открытым значит
			// отдать следующей дельте тот же window_start — и она вся упрётся в дедуп
			// control-plane по (node, subject, window_start), то есть потеряется целиком.
			if appended > 0 {
				r.lastStatsRead = readAt
			}
			return err
		}
		appended++
		counters = counters[size:]
		r.log.Debug("reconcile: stats collected",
			"report_id", entry.ReportID,
			"counters", size,
			"window_start", windowStart.Format(time.RFC3339))
	}
	r.lastStatsRead = readAt
	return nil
}

func nonZero(counters []stats.Counter) []stats.Counter {
	out := counters[:0]
	for _, c := range counters {
		if c.Value != 0 {
			out = append(out, c)
		}
	}
	return out
}

func (r *Reconciler) report(ctx context.Context, applied appliedState, xrayProblem error) error {
	xrayVer, err := r.xray.Version(ctx)
	if err != nil {
		r.log.Warn("reconcile: xray version unavailable", "err", err)
		xrayVer = ""
	}

	obs := controlplane.ObservedState{
		AppliedConfigHash: applied.ConfigHash,
		AgentVersion:      r.agentVersion,
		XrayVersion:       xrayVer,
		Sys:               collectSysStats(),
	}
	if xrayProblem != nil {
		obs.XrayError = xrayProblem.Error()
	}
	return r.cp.ReportState(ctx, obs)
}

// shipStats ships the buffered stats batches one by one — each carries its own
// report_id, which is what the control plane dedups on.
//
// Очередь строго FIFO, поэтому застрявшая голова останавливает ВСЁ, что накопится
// следом. Отсюда разделение отказов: батч, который не примут никогда, выбрасывается
// с громким логом, а временный отказ прекращает цикл и повторяется на следующем.
func (r *Reconciler) shipStats(ctx context.Context) error {
	for _, entry := range r.stats.Pending() {
		accepted, err := r.cp.ShipStats(ctx, controlplane.BatchFromEntry(entry))
		if err != nil {
			var httpErr *controlplane.HTTPError
			if !errors.As(err, &httpErr) || !httpErr.Permanent() {
				// 5xx, таймаут, оборванная сеть, 401/429 — повторяем на следующем цикле,
				// буфер держим: данные важнее, control-plane вернётся.
				return err
			}
			r.log.Error("reconcile: stats batch rejected permanently, dropping",
				"report_id", entry.ReportID,
				"status", httpErr.Status,
				"counters", len(entry.Counters),
				"err", err)
			if err := r.stats.MarkShipped(entry.ReportID); err != nil {
				return fmt.Errorf("drop rejected %s: %w", entry.ReportID, err)
			}
			continue
		}
		// accepted=false — батч уже принят control-plane раньше. Ретрай даст тот же
		// ответ, поэтому дропаем буфер точно так же, как при accepted=true.
		if !accepted {
			r.log.Warn("reconcile: stats batch already accepted, dropping", "report_id", entry.ReportID)
		}
		if err := r.stats.MarkShipped(entry.ReportID); err != nil {
			return fmt.Errorf("mark shipped %s: %w", entry.ReportID, err)
		}
	}
	return nil
}

// appliedState persists what we last successfully applied, so a restart with an
// unchanged desired state is a no-op rather than a needless Xray restart.
type appliedState struct {
	ConfigHash string    `json:"config_hash"`
	Version    int64     `json:"version"`
	AppliedAt  time.Time `json:"applied_at"`
}

func (r *Reconciler) loadAppliedState() (appliedState, error) {
	raw, err := os.ReadFile(r.statePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return appliedState{}, nil
		}
		return appliedState{}, err
	}
	var st appliedState
	if err := json.Unmarshal(raw, &st); err != nil {
		return appliedState{}, fmt.Errorf("corrupt applied state %s: %w", r.statePath, err)
	}
	return st, nil
}

func (r *Reconciler) saveAppliedState(st appliedState) error {
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.statePath), 0o750); err != nil {
		return err
	}
	tmp := r.statePath + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, r.statePath)
}

// collectSysStats reads a few cheap health signals from /proc (Linux). Best
// effort: any missing file just leaves the zero value.
func collectSysStats() controlplane.SysStats {
	var s controlplane.SysStats
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		if f := strings.Fields(string(raw)); len(f) > 0 {
			if v, err := strconv.ParseFloat(f[0], 64); err == nil {
				s.Load1 = v
			}
		}
	}
	if raw, err := os.ReadFile("/proc/uptime"); err == nil {
		if f := strings.Fields(string(raw)); len(f) > 0 {
			if v, err := strconv.ParseFloat(f[0], 64); err == nil {
				s.UptimeSec = v
			}
		}
	}
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			f := strings.Fields(line)
			if len(f) < 2 {
				continue
			}
			switch f[0] {
			case "MemTotal:":
				if v, err := strconv.ParseUint(f[1], 10, 64); err == nil {
					s.MemTotalKB = v
				}
			case "MemAvailable:":
				if v, err := strconv.ParseUint(f[1], 10, 64); err == nil {
					s.MemAvailKB = v
				}
			}
		}
	}
	return s
}
