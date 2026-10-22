# AGENTS.md — fiduswriter-native

Native Rust websockets route for the Fidus Writer collaboration protocol,
served by Granian's native routes. Replaces the Django Channels path
(`/ws/document/<id>/`) on deployments that run Granian; a no-op everywhere
else.

## Layout

| Path | What |
|---|---|
| `src/lib.rs` | The `granian._granian` extension module: `configure(json)`, the runtime, the logger, the route handler |
| `src/config.rs` | The `configure(json)` payload (database, session, tables, intervals, relay, secrets) |
| `src/connection.rs` | The websocket protocol: counters, subscribe, auth/rights wiring, diff/chat/fan-out |
| `src/protocol.rs` | The per-connection `c`/`s` counters and the 10-entry resend ring buffer |
| `src/session.rs` | The live document sessions (editor, version, diff log, comments/bibliography, participants) |
| `src/store.rs` | The typed `sqlx` database enum (SQLite/Postgres/MySQL) and the direct document save |
| `src/auth.rs` | Session cookie → user (Django `signing.dumps` format, HMAC verified) |
| `src/rights.rs` | Rights resolution/enforcement/re-read, comment filtering ports |
| `src/relay.rs` | The `/ws/base/` relay client and the periodic rights re-read |
| `src/bin/wsload.rs` | The load generator |
| `bench/` | run.sh, matrix.sh, final.sh, h2_probe.py, h2_full.py, differential.py, setup_document.py |
| `install.py` | Installs the built `.so` over Granian's `_granian` (atomic rename) |

## Hard rules (invariants)

- **The native route is optional.** Never import the native module at
  application import time, never require it, never require a setting or a
  database a Channels-only site does not have. The one hook is the guarded
  `configure(json)` call in `fiduswriter-server-backend/fiduswriter/asgi.py`;
  a missing module must be a no-op. The route is registered by `configure()`
  only — never at module import — so unsupported deployments (E2EE enabled,
  non-db session engine, Oracle, missing schema) simply keep the Python
  consumer.
- **The wire protocol must stay byte-identical** to
  `base/base_consumer.py` + `document/consumers.py` (counters, ring buffer,
  message types). The frontend must not need changes; the Python consumer
  stays the reference implementation and stays covered by CI.
- **Keep the rlib model**: Granian is an rlib dependency; a handler change
  relinks the small crate (incremental ~1.65 s). Do not recompile Granian
  for handler changes; do not introduce a dlopen plugin.
- The committed dependencies are the git forks on GitHub
  (`fiduswriter/granian` branch `combined-patches`,
  `fiduswriter/prosemirror-rs` branch `main`). For development against
  local checkouts, run `dev-scripts/switch-local-deps.sh local` in the
  fiduswriter repo (it rewrites `Cargo.toml` to path dependencies on the
  sibling checkouts); run it with `npm` to switch back before committing.

## Commands

```bash
cargo build --release          # libfiduswriter_native.so + wsload
cargo test --release           # unit tests (protocol, auth, rights)
bash bench/run.sh native 1 10  # one benchmark arm (python|native)
bash bench/final.sh out.txt    # the matrix, 3 repeats (ARMS=native to limit)
python bench/differential.py   # same load through both backends, DB state compared
```

Installing the module into the benchmark venv:
`python install.py target/release/libfiduswriter_native.so`.

## Environment and traps

- The bench environments live in `/tmp/kilo` (gone after a reboot; recreate
  with `bench/install-pypy.sh` for PyPy and by installing
  `fiduswriter-server-backend/fiduswriter/requirements.txt` plus
  `pip install --no-build-isolation /path/to/granian` for CPython).
- Granian sets `SO_REUSEPORT`: stale benchmark servers keep load-balancing
  the port. `bench/run.sh` kills them before/after a run; never mix a
  `pkill -f <pattern>` with a server start in one shell command (the pattern
  matches the shell's own command line).
- Never overwrite a loaded `_granian.so` in place (SIGBUS); `install.py`
  renames atomically.
- `bench/run.sh` resets the benchmark document to version 0 before each run:
  the sessions load the document from the database, and a stale version
  breaks the load generator's catch-up.
- The load generator and the h2 probes must wait for the `connections`
  bootstrap frame and echo the server counter from *every* received frame;
  an h2 handshake read must keep `DataReceived` events (the first websocket
  frames arrive with the response headers).
- Django session rows are `signing.dumps` payloads (HMAC, optional zlib), not
  base64 pickles.
- Stock Granian modules for the "python" arm: `/tmp/kilo/granian-{cpython,pypy}.so`
  (rebuild after pulling the fork).
- Unthrottled `wsload` with several clients is a worst-case robustness test,
  not a throughput test: sibling diffs collide by design, both arms livelock,
  and clients recover only via `refetch_doc` (wsload reconnects). Use
  `RATE=10` (human-shaped) for any multi-client numbers.
- **Saves are coalesced on purpose** (one pending per session): at high
  throughput the fsync-bound SQLite queue grew without bound, throttled the
  collaboration, and could leave an older snapshot as the last writer. Do
  not remove the `save_pending` flag.
- The shutdown flush (`granian._granian.flush()`, called from the lifespan
  handler in `base/routing.py`) waits for in-flight saves before writing, so
  it must be the last writer.
- Worker RSS of ~1 GB after short bursts on a 24-core box is glibc malloc
  arenas across the tokio threads, most likely; revisit with an allocator or
  `MALLOC_ARENA_MAX` before shipping.
- PyPy is 2.4–2.6× slower than CPython for this workload (no orjson, no Rust
  ProseMirror engine); the native route removes the question entirely.

## Benchmarks (24-core shared box, load avg 2–8, medians)

| arm | clients | frames/s | p50 | p99 |
|---|---|---|---|---|
| native | 1 | 27 000–52 000 | 15–28 µs | 66–500 µs |
| python (Channels) | 1 | 1 200–2 200 | ~180 µs | 10–19 ms |
| native vs python | 5, 10 diffs/s/client | 105 vs 3 confirmed under load | | |

Single client is ~15–25× native. At 500 idle connections the python arm
spends ~100 ms CPU per accepted connection (~20 cores just to accept), the
native one ~7 ms. The periodic save dominates the Python consumer (5.4×
throughput when disabled); the coalesced Rust save is free on the hot path.
Python's p99 is the save: it runs before `confirm_diff`, so every 30th
keystroke waits for it.

## Known gaps

- E2EE documents stay on the Python consumer (`E2EE_MODE != "disabled"`
  disables the whole route).
- Image updates (`iu`) are not persisted (usermedia stays with Django).
- Participant avatars are sent as empty strings (usermedia lookup).
- Port pinning / `redirect` (multi-entry `PORTS`) is not implemented.
- The Postgres/MySQL store arms compile but are only exercised against
  SQLite.
- The Python consumer's teardown can deadlock under many simultaneous
  websocket disconnects (pre-existing); bounded by
  `--workers-kill-timeout` (wired into the `runserver` command, default 30s).
