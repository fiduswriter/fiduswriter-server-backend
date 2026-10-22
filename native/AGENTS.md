# AGENTS.md — fiduswriter-native

Native Rust websockets route for the Fidus Writer collaboration protocol,
served by the maintainer's Granian fork through its "native routes" feature.
Replaces the Django Channels path (`/ws/document/<id>/`) on deployments that
run Granian; a no-op everywhere else. See `HANDOFF.md` in this directory for
the full picture (design, benchmarks, traps).

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

## Environment and traps (short list — HANDOFF §7 has the full one)

- The bench environments live in `/tmp/kilo` (gone after a reboot; recreate
  per HANDOFF §7.1).
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
  bootstrap frame and echo the server counter from *every* received frame.
- Django session rows are `signing.dumps` payloads (HMAC, optional zlib), not
  base64 pickles.
- Stock Granian modules for the "python" arm: `/tmp/kilo/granian-{cpython,pypy}.so`
  (rebuild after pulling the fork).
