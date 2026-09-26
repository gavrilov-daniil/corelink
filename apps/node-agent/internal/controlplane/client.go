// Package controlplane is the dial-out (PULL) client to the control plane.
//
// The agent always initiates the connection; the control plane never dials the
// node. This means a node only needs outbound 443 — no inbound management port,
// no public API surface on the node itself.
//
// Authentication is a per-node secret in the x-agent-token header, obtained by
// trading a one-shot bootstrap token via Enroll. mTLS is supported but optional
// (see New).
package controlplane

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"vpn-platform/node-agent/internal/stats"
)

// User is one Xray client. In v1 users are just a mirror of what is already in
// the full config; the field exists so the agent can log/report user counts and
// later (M2) apply user-only deltas without a restart.
type User struct {
	Email string `json:"email"`
	UUID  string `json:"uuid"`
	Level int    `json:"level"`
}

// DesiredState is the full, authoritative declaration for the node. Wire format
// is the control plane's camelCase JSON.
type DesiredState struct {
	Version     int64           `json:"version"`
	ConfigHash  string          `json:"configHash"` // sha256 of canonical config JSON
	Config      json.RawMessage `json:"config"`     // the entire Xray config for this node
	Users       []User          `json:"users"`
	GeneratedAt string          `json:"generatedAt"`
}

// signedEnvelope wraps the desired state. The signature covers Payload's exact
// bytes as received — signing raw bytes (not a re-serialized struct) sidesteps
// any JSON canonicalization mismatch between control plane and agent.
type signedEnvelope struct {
	Payload   json.RawMessage `json:"payload"`
	Signature string          `json:"signature"` // base64(RS256 over Payload)
}

type SysStats struct {
	Load1      float64 `json:"load1"`
	UptimeSec  float64 `json:"uptimeSec"`
	MemTotalKB uint64  `json:"memTotalKb"`
	MemAvailKB uint64  `json:"memAvailKb"`
}

// ObservedState is what the agent reports back each cycle (heartbeat + result).
type ObservedState struct {
	AppliedConfigHash string
	AgentVersion      string
	XrayVersion       string
	Sys               SysStats
	// XrayError — почему Xray сейчас не обслуживает клиентов (не поднялся после
	// рестарта, упал позже). Пусто — работает. Непустой отчёт control-plane не
	// считает сходимостью, даже если хеш совпал.
	XrayError string
}

// StatsDelta is one traffic delta in the control plane's format.
type StatsDelta struct {
	SubjectType string `json:"subjectType"` // user | inbound | outbound
	SubjectKey  string `json:"subjectKey"`
	UpDelta     int64  `json:"upDelta"`
	DownDelta   int64  `json:"downDelta"`
	WindowStart string `json:"windowStart"` // ISO-8601
	WindowEnd   string `json:"windowEnd"`
}

// StatsBatch is the body of POST /stats. ReportID is monotonic
// ("<agent_epoch>:<seq>") and is what the control plane dedups redelivery on.
type StatsBatch struct {
	ReportID string       `json:"reportId"`
	Deltas   []StatsDelta `json:"deltas"`
}

type statsAck struct {
	Accepted bool `json:"accepted"`
	Applied  int  `json:"applied"`
}

// EnrollRequest trades a one-shot bootstrap token for this node's permanent
// per-node agent token.
//
// RealityPublicKey is the PUBLIC half only — the private key never leaves the
// node. The control plane needs it (plus the shortIds) to build client configs:
// pbk= and sid= in every connection string come from here.
type EnrollRequest struct {
	NodeID           string   `json:"nodeId"`
	BootstrapToken   string   `json:"bootstrapToken"`
	RealityPublicKey string   `json:"realityPublicKey"`
	ShortIDs         []string `json:"shortIds"`
	AgentVersion     string   `json:"agentVersion"`
}

type EnrollResponse struct {
	NodeID     string `json:"nodeId"`
	AgentToken string `json:"agentToken"`
	AgentEpoch int64  `json:"agentEpoch"`
}

// HTTPError is a non-2xx answer from the control plane. The status is part of the
// error on purpose: for buffered data (stats) the caller must tell "will never be
// accepted" apart from "try again later".
type HTTPError struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("controlplane: %s %s: status %d: %s", e.Method, e.Path, e.Status, e.Body)
}

// Permanent reports whether re-sending the very same request could ever succeed.
//
// Не «любой 4xx». 401/403 — сорванная аутентификация: её чинит перевыпуск токена,
// а выброшенная статистика не восстанавливается ничем. 404 — нода, которую ещё не
// завели в панели. 408/429 — прямая просьба повторить позже. Постоянным считаем
// только отказ, относящийся к САМОМУ ТЕЛУ запроса: с ним повтор бессмыслен, а
// застрявший в очереди батч останавливает учёт трафика по ноде насовсем.
func (e *HTTPError) Permanent() bool {
	switch e.Status {
	case http.StatusBadRequest,
		http.StatusRequestEntityTooLarge,
		http.StatusUnsupportedMediaType,
		http.StatusUnprocessableEntity:
		return true
	default:
		return false
	}
}

type Client struct {
	baseURL string
	nodeID  string
	token   string
	httpc   *http.Client
	cpPub   *rsa.PublicKey
}

type Options struct {
	BaseURL         string
	NodeID          string
	AgentToken      string
	ClientCertPath  string
	ClientKeyPath   string
	CPPublicKeyPath string
}

// New builds the client. mTLS и проверка подписи включаются по наличию файлов в
// конфиге: без них агент работает по обычному HTTPS с токеном в заголовке —
// это состояние control-plane на сегодня.
func New(opts Options) (*Client, error) {
	// TLS 1.2 как нижняя граница: агент ходит через произвольный reverse-proxy.
	// Там, где настроен mTLS, поднимаем до 1.3 — этот путь целиком наш.
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if opts.ClientCertPath != "" && opts.ClientKeyPath != "" {
		cert, err := tls.LoadX509KeyPair(opts.ClientCertPath, opts.ClientKeyPath)
		if err != nil {
			return nil, fmt.Errorf("controlplane: load client cert: %w", err)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
		tlsCfg.MinVersion = tls.VersionTLS13
	}

	var pub *rsa.PublicKey
	if opts.CPPublicKeyPath != "" {
		p, err := loadRSAPublicKey(opts.CPPublicKeyPath)
		if err != nil {
			return nil, err
		}
		pub = p
	}

	httpc := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig:     tlsCfg,
			MaxIdleConns:        4,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: 10 * time.Second,
		},
	}
	return &Client{
		baseURL: strings.TrimRight(opts.BaseURL, "/"),
		nodeID:  opts.NodeID,
		token:   opts.AgentToken,
		httpc:   httpc,
		cpPub:   pub,
	}, nil
}

// UseToken switches the client to a new agent token (after enrollment). The
// client is used from a single goroutine (the reconcile loop starts later), so
// no locking here.
func (c *Client) UseToken(token string) { c.token = token }

// Enroll exchanges the one-shot bootstrap token for a per-node agent token.
//
// This is the ONLY call that goes out without x-agent-token: at this point the
// node has no token yet, and the bootstrap token in the body is what
// authenticates it. It is single-use server-side, so a second call with the same
// token fails — that is the point, and the caller must not retry it blindly.
func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (*EnrollResponse, error) {
	if req.BootstrapToken == "" {
		return nil, fmt.Errorf("controlplane: enroll without bootstrap token")
	}
	if req.ShortIDs == nil {
		req.ShortIDs = []string{}
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("controlplane: encode enroll: %w", err)
	}
	body, err := c.doAuth(ctx, http.MethodPost, "/internal/agent/enroll", payload, "")
	if err != nil {
		return nil, err
	}
	var res EnrollResponse
	if err := json.Unmarshal(body, &res); err != nil {
		return nil, fmt.Errorf("controlplane: decode enroll response: %w", err)
	}
	if res.AgentToken == "" {
		return nil, fmt.Errorf("controlplane: enroll response without agentToken")
	}
	return &res, nil
}

// VerifySignature verifies an RS256 (RSASSA-PKCS1-v1_5 + SHA-256) signature over
// payload. This is the agent's root of trust: even if the transport is somehow
// compromised, an attacker cannot forge a desired state without the control
// plane's private key.
func VerifySignature(payload []byte, signatureB64 string, pub *rsa.PublicKey) error {
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(signatureB64))
	if err != nil {
		return fmt.Errorf("controlplane: decode signature: %w", err)
	}
	sum := sha256.Sum256(payload)
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return fmt.Errorf("controlplane: signature verification failed: %w", err)
	}
	return nil
}

// PullDesiredState fetches, verifies (when signed) and decodes the desired state.
func (c *Client) PullDesiredState(ctx context.Context) (*DesiredState, error) {
	body, err := c.do(ctx, http.MethodGet, c.nodePath("/desired-state"), nil)
	if err != nil {
		return nil, err
	}
	payload, err := c.unwrap(body)
	if err != nil {
		return nil, err
	}
	var ds DesiredState
	if err := json.Unmarshal(payload, &ds); err != nil {
		return nil, fmt.Errorf("controlplane: decode desired state: %w", err)
	}
	if ds.ConfigHash == "" || len(ds.Config) == 0 {
		return nil, fmt.Errorf("controlplane: desired state without configHash/config")
	}
	return &ds, nil
}

// unwrap возвращает байты desired-state и попутно решает, проверять ли подпись.
//
// Подпись — root of trust агента, но control-plane её пока не ставит и отдаёт
// «голый» JSON. Отсюда правило, защищающее от даунгрейда:
//   - пришёл конверт {payload, signature} — подпись проверяется всегда;
//   - пришёл голый JSON — принимаем ТОЛЬКО если cp_public_key_path пуст, то есть
//     оператор осознанно не включал проверку;
//   - ключ задан, а подписи нет — ошибка. Иначе тот, кто подменил ответ, снимал
//     бы проверку простым удалением поля signature;
//   - конверт есть, а ключа нет — тоже ошибка: проверить нечем, а молча съесть
//     неподтверждённый конфиг хуже, чем громко встать (агент при этом продолжает
//     крутить последний применённый конфиг).
func (c *Client) unwrap(body []byte) (json.RawMessage, error) {
	var env signedEnvelope
	signed := json.Unmarshal(body, &env) == nil && len(env.Payload) > 0 && env.Signature != ""

	if signed {
		if c.cpPub == nil {
			return nil, fmt.Errorf("controlplane: desired state is signed but cp_public_key_path is not configured")
		}
		if err := VerifySignature(env.Payload, env.Signature, c.cpPub); err != nil {
			return nil, err
		}
		return env.Payload, nil
	}
	if c.cpPub != nil {
		return nil, fmt.Errorf("controlplane: cp_public_key_path is configured but desired state came unsigned")
	}
	return body, nil
}

// ReportState reports observed state (applied hash, versions, sys stats).
func (c *Client) ReportState(ctx context.Context, obs ObservedState) error {
	payload, err := json.Marshal(reportRequest{
		AppliedConfigHash: obs.AppliedConfigHash,
		AgentVersion:      obs.AgentVersion,
		XrayVersion:       obs.XrayVersion,
		SysStats:          obs.Sys,
		XrayError:         obs.XrayError,
	})
	if err != nil {
		return fmt.Errorf("controlplane: encode report: %w", err)
	}
	if _, err := c.do(ctx, http.MethodPost, c.nodePath("/report"), payload); err != nil {
		return err
	}
	return nil
}

// ShipStats ships one stats batch and reports whether the control plane took it.
//
// accepted=false — не ошибка: control-plane уже принимал этот report_id раньше.
// Батч надо ДРОПНУТЬ, а не ретраить — повтор даст тот же ответ вечно.
func (c *Client) ShipStats(ctx context.Context, batch StatsBatch) (bool, error) {
	if batch.Deltas == nil {
		batch.Deltas = []StatsDelta{}
	}
	payload, err := json.Marshal(batch)
	if err != nil {
		return false, fmt.Errorf("controlplane: encode stats batch: %w", err)
	}
	body, err := c.do(ctx, http.MethodPost, c.nodePath("/stats"), payload)
	if err != nil {
		return false, err
	}
	var ack statsAck
	if err := json.Unmarshal(body, &ack); err != nil {
		return false, fmt.Errorf("controlplane: decode stats ack: %w", err)
	}
	return ack.Accepted, nil
}

// BatchFromEntry converts one durable buffer entry into the wire batch: Xray
// counter names ("user>>>alice@example.com>>>traffic>>>uplink") collapse into one
// delta per subject, carrying the report_id the control plane dedups on.
func BatchFromEntry(e stats.Entry) StatsBatch {
	windowStart := e.WindowStart.UTC().Format(time.RFC3339Nano)
	windowEnd := e.CollectedAt.UTC().Format(time.RFC3339Nano)

	type subject struct{ typ, key string }
	agg := make(map[subject]*StatsDelta, len(e.Counters))
	order := make([]subject, 0, len(e.Counters))

	for _, c := range e.Counters {
		typ, key, direction, ok := parseCounterName(c.Name)
		if !ok {
			continue
		}
		s := subject{typ, key}
		d, seen := agg[s]
		if !seen {
			d = &StatsDelta{
				SubjectType: typ,
				SubjectKey:  key,
				WindowStart: windowStart,
				WindowEnd:   windowEnd,
			}
			agg[s] = d
			order = append(order, s)
		}
		if direction == "uplink" {
			d.UpDelta += c.Value
		} else {
			d.DownDelta += c.Value
		}
	}

	deltas := make([]StatsDelta, 0, len(order))
	for _, s := range order {
		deltas = append(deltas, *agg[s])
	}
	return StatsBatch{ReportID: e.ReportID, Deltas: deltas}
}

// parseCounterName splits an Xray stats counter name into its parts. Anything
// that does not look like "<subject>>>><key>>>>traffic>>><direction>" is skipped.
func parseCounterName(name string) (subjectType, subjectKey, direction string, ok bool) {
	parts := strings.Split(name, ">>>")
	if len(parts) != 4 || parts[2] != "traffic" {
		return "", "", "", false
	}
	switch parts[0] {
	case "user", "inbound", "outbound":
	default:
		return "", "", "", false
	}
	if parts[3] != "uplink" && parts[3] != "downlink" {
		return "", "", "", false
	}
	return parts[0], parts[1], parts[3], true
}

type reportRequest struct {
	AppliedConfigHash string   `json:"appliedConfigHash"`
	AgentVersion      string   `json:"agentVersion"`
	XrayVersion       string   `json:"xrayVersion"`
	SysStats          SysStats `json:"sysStats"`
	XrayError         string   `json:"xrayError,omitempty"`
}

func (c *Client) nodePath(suffix string) string {
	return "/internal/agent/nodes/" + url.PathEscape(c.nodeID) + suffix
}

func (c *Client) do(ctx context.Context, method, path string, body []byte) ([]byte, error) {
	return c.doAuth(ctx, method, path, body, c.token)
}

// doAuth sends the request with an explicit token; an empty token means no
// x-agent-token header at all (enrollment, which authenticates by bootstrap
// token in the body).
func (c *Client) doAuth(ctx context.Context, method, path string, body []byte, token string) ([]byte, error) {
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
	if err != nil {
		return nil, fmt.Errorf("controlplane: build request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	if token != "" {
		req.Header.Set("x-agent-token", token)
	}

	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, fmt.Errorf("controlplane: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, fmt.Errorf("controlplane: read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &HTTPError{
			Method: method,
			Path:   path,
			Status: resp.StatusCode,
			Body:   truncate(strings.TrimSpace(string(respBody)), 512),
		}
	}
	return respBody, nil
}

// truncate keeps an error message loggable: a control-plane 413 answers with an
// HTML page, and the whole page in every log line is noise.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}

func loadRSAPublicKey(path string) (*rsa.PublicKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("controlplane: read cp public key: %w", err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return nil, fmt.Errorf("controlplane: cp public key %s is not PEM", path)
	}
	pub, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("controlplane: parse cp public key: %w", err)
	}
	rsaPub, ok := pub.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("controlplane: cp public key is not RSA")
	}
	return rsaPub, nil
}
