package main

import (
	"io"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type pulseMessage struct {
	Type     string `json:"type"`
	Seq      uint64 `json:"seq"`
	PeriodMS int64  `json:"period_ms"`
	NowMS    int64  `json:"now_ms"`
	NextMS   int64  `json:"next_ms"`
}

type wsConn struct {
	conn net.Conn
	mu   sync.Mutex
}

func (c *wsConn) close() error {
	return c.conn.Close()
}

//TODO: Consider not doing bit-fiddling unless it's really worth it
//TODO: Or just support a binary protocol and a normal slow JSON protocol
func (c *wsConn) writeText(payload []byte) error {
	const (
		finAndText = 0x81
	)

	frame := make([]byte, 0, len(payload)+10)
	frame = append(frame, finAndText)
	n := len(payload)
	switch {
	case n < 126:
		frame = append(frame, byte(n))
	case n <= 65535:
		frame = append(frame, 126, byte(n>>8), byte(n))
	default:
		frame = append(frame, 127,
			byte(uint64(n)>>56),
			byte(uint64(n)>>48),
			byte(uint64(n)>>40),
			byte(uint64(n)>>32),
			byte(uint64(n)>>24),
			byte(uint64(n)>>16),
			byte(uint64(n)>>8),
			byte(uint64(n)),
		)
	}
	frame = append(frame, payload...)

	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	_, err := c.conn.Write(frame)
	return err
}

type hub struct {
	mu    sync.RWMutex
	conns map[*wsConn]struct{}
}

func newHub() *hub {
	return &hub{
		conns: make(map[*wsConn]struct{}),
	}
}

func (h *hub) add(c *wsConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.conns[c] = struct{}{}
}

func (h *hub) remove(c *wsConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns, c)
	_ = c.close()
}

func (h *hub) count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.conns)
}

func (h *hub) broadcastJSON(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		log.Printf("marshal pulse: %v", err)
		return
	}

	h.mu.RLock()
	conns := make([]*wsConn, 0, len(h.conns))
	for c := range h.conns {
		conns = append(conns, c)
	}
	h.mu.RUnlock()

	for _, c := range conns {
		if err := c.writeText(data); err != nil {
			h.remove(c)
		}
	}
}

func containsToken(headerVal, want string) bool {
	for _, part := range strings.Split(headerVal, ",") {
		if strings.EqualFold(strings.TrimSpace(part), want) {
			return true
		}
	}
	return false
}

func wsAccept(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func upgradeWebSocket(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if !containsToken(r.Header.Get("Connection"), "Upgrade") {
		return nil, fmt.Errorf("missing connection upgrade")
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, fmt.Errorf("missing websocket upgrade")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, fmt.Errorf("unsupported websocket version")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, fmt.Errorf("missing websocket key")
	}

	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, fmt.Errorf("response writer does not support hijacking")
	}

	conn, rw, err := hj.Hijack()
	if err != nil {
		return nil, fmt.Errorf("hijack connection: %w", err)
	}

	accept := wsAccept(key)
	if _, err := rw.WriteString(
		"HTTP/1.1 101 Switching Protocols\r\n" +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			"Sec-WebSocket-Accept: " + accept + "\r\n\r\n",
	); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("write handshake: %w", err)
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("flush handshake: %w", err)
	}

	return &wsConn{conn: conn}, nil
}

func startPulseLoop(h *hub, period time.Duration) {
	if period <= 0 {
		period = time.Second
	}
	periodMS := period.Milliseconds()

	var seq uint64
	next := time.Now().Add(period)

	// Emit one pulse immediately so new clients can start predicting without
	// waiting a full interval.
	//TODO: Use a monotonic timer, those also provides better precsion
	now := time.Now()
	h.broadcastJSON(pulseMessage{
		Type:     "pulse",
		Seq:      seq,
		PeriodMS: periodMS,
		NowMS:    now.UnixMilli(),
		NextMS:   next.UnixMilli(),
	})
	seq++

	//TODO: Don't just sleep like this it's inaccurate, try using a ticker 
	// or sleeping in shorter "segments"
	// and also make sure to send the actual elapsed time or some drift-delta so clients
	// can use that to compensate
	for {
		sleepFor := time.Until(next)
		if sleepFor > 0 {
			time.Sleep(sleepFor)
		}

		now = time.Now()
		//TODO: Use a monotonic timer, those also provides better precsion
		msg := pulseMessage{
			Type:     "pulse",
			Seq:      seq,
			PeriodMS: periodMS,
			NowMS:    now.UnixMilli(),
			NextMS:   next.Add(period).UnixMilli(),
		}
		h.broadcastJSON(msg)

		seq++
		next = next.Add(period)
		for time.Until(next) <= 0 {
			next = next.Add(period)
		}
	}
}

func parsePeriodMS() time.Duration {
	raw := strings.TrimSpace(os.Getenv("PULSE_PERIOD_MS"))
	if raw == "" {
		return time.Second
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || ms <= 0 {
		log.Printf("invalid PULSE_PERIOD_MS=%q, defaulting to 1000", raw)
		return time.Second
	}
	return time.Duration(ms) * time.Millisecond
}

func main() {
	addr := os.Getenv("PULSE_ADDR")
	if strings.TrimSpace(addr) == "" {
		addr = ":8080"
	}
	period := parsePeriodMS()
	h := newHub()

	go startPulseLoop(h, period)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := upgradeWebSocket(w, r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		h.add(c)
		log.Printf("client connected (%d total)", h.count())

		go func(conn *wsConn) {
			defer func() {
				h.remove(conn)
				log.Printf("client disconnected (%d total)", h.count())
			}()
			_, _ = io.Copy(io.Discard, conn.conn)
		}(c)
	})

	log.Printf("pulse server listening on %s (period=%s)", addr, period)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

