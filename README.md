# pulse

Protocol for synchronizing multiple clients. It has the following characteristics:
- aimed at scenarios where the goal is to make all the clients appear to share a monotonic clock,
the primary usecase for creating it was to synchronize audio-devices like sequencers, drum machines, synths - ie things you might otherwise use midi-cables for.
- the clients don't need to communicate among themselves or know about each other
- the server doesn't need to know about individual clients, it only broadcasts uni-directionally
- the time-difference between clients are not in any way guaranteed to be as a small as theoretically possible but rather within the error-boundaries of what one might audibly perceive while keeping the protocol simple and stateless.

* Includes a reference implementation for a server (Go 1.22+) and any number clients (TypeScript).
* If you plan on using it, running everything on the same local network will achieve the best results.
An edge-server or a server in the same city/country works ok as well. Farther away than that and "results may vary".

## details

### server
- Broadcasts pulse messages over a WebSocket at a fixed interval.
- Each pulse contains:
  - `now_ms`: server send timestamp (Unix milliseconds)
  - `next_ms`: expected next pulse timestamp (Unix milliseconds)
  - `period_ms` and `seq`

### client(s)
  - predicts next pulse arrival locally
  - compares actual arrival vs prediction
  - smooths arrival bias
  - marks itself as `locked` when its predicted error is within threshold for N pulses
  - aftr that it "locks" its own clock, disconnects, and continues from lock time as local ground zero
  - in other words, once a client is "synchronized" it's done, it doesn't need to talk to the server after that.

### building / running 
#### server

* requires Go (1.22+)

```bash
# Run directly
go run ./server

# Or build a binary
go build -C server -o bin/pulse .
./bin/pulse
```

#### configuration

| Variable | Default | Description |
|---|---|---|
| `PULSE_ADDR` | `:8080` | Listen address |
| `PULSE_PERIOD_MS` | `1000` | Pulse interval in milliseconds |

```bash
PULSE_ADDR=":9090" PULSE_PERIOD_MS=250 go run ./server
```

#### endpoints

| Endpoint | Description |
|---|---|
| `ws://<host>/ws` | WebSocket — pulse stream |
| `GET /healthz` | Health check → `{"ok":true}` |

#### demo-client
* uses typescript, vite, npm

```bash
npm install

npm run dev        # Vite dev server at http://localhost:5173
npm run build:lib  # Build library → dist/pulse-sync.{js,umd.cjs,d.ts}
npm run build:demo # Build demo   → dist/demo/index.html
npm run build      # Both of the above
```

```bash
# env variable (set at dev/build time)
VITE_WS_URL=ws://my-server.example.com/ws npm run dev

# query param (set at runtime in the browser)
http://localhost:5173?url=ws://my-server.example.com/ws
# shorthand query param also works
http://localhost:5173?url=my-server.example.com:8080/ws
```

Query param takes precedence over the env variable. Start the server separately (see above).

The demo now also includes a single server input field (no query param required). The field accepts:
- `host` (defaults to `ws://<host>:8080/ws`)
- `host:port` (defaults path to `/ws`)
- `host:port/path`
- full `ws://` / `wss://` URLs
- full `http://` / `https://` URLs (auto-converted to `ws://` / `wss://`)

### library usage

```js
import { PulseSyncClient } from "./dist/pulse-sync.js";

const client = new PulseSyncClient({ url: "ws://localhost:8080/ws" });

client.addEventListener("pulse", (ev) => {
  const { seq, errorMs, locked } = ev.detail;
  console.log(seq, errorMs, locked);
});

client.addEventListener("lock", (ev) => {
  console.log("locked:", ev.detail.locked);
});

client.connect();
```

By default lock is sticky (`stickyLock: true`): once lock is acquired, the client
disconnects and keeps time locally from the lock instant.

For higher-jitter (non-local) networks, tune lock acquisition to tolerate occasional outliers:

```js
const client = new PulseSyncClient({
  url: "ws://localhost:8080/ws",
  thresholdMs: 8,             // per-pulse inlier threshold
  requiredStablePulses: 20,   // rolling window size
  allowedUnstablePulses: 4,   // tolerated outliers in that window
  maxBiasCorrectionMs: 30,    // clip one-off spikes for bias updates
  stickyLock: false,          // optional: keep listening after lock
});
```

This keeps lock acquisition achievable across WAN jitter while still requiring most pulses to be stable.

### demo sync mode

On lock, the demo automatically switches to a fullscreen sync view that emits two
metronome-like sounds in order to make it easier to compare several devices.
(It's meant for synching audio-devices, after all).

## Wire format

```json
{
  "type": "pulse",
  "seq": 42,
  "period_ms": 1000,
  "now_ms": 1739700000000,
  "next_ms": 1739700001000
}
```
