//! Native websockets route for the Fidus Writer collaboration protocol.
//!
//! The crate embeds [Aethonan](https://github.com/fiduswriter/granian) — a
//! fork of [Granian](https://github.com/emmett-framework/granian) — as
//! a library and registers a native route serving the document websockets
//! path. The requests matching the route are handled entirely in Rust: the
//! message protocol, the authentication, the access rights, the ProseMirror
//! step engine and the fan-out to the participants never reach the Python
//! interpreter.
//!
//! The Python side is entirely stock Aethonan: this crate provides the
//! `aethonan._aethonan` extension module, which replaces the one shipped
//! with the Aethonan package.
//!
//! The route is registered by the `configure(json)` call, which the Django
//! application (`fiduswriter/asgi.py`) makes once after `django.setup()`.
//! Deployments that cannot be served natively (E2EE enabled, a session
//! engine that is not database backed, an Oracle database) simply never
//! register the route, and Aethonan keeps serving the path through the
//! Django Channels consumer — an advantage where Aethonan is used, a no-op
//! everywhere else.

use std::sync::OnceLock;

use futures::future::BoxFuture;
use http_body_util::BodyExt;
use aethonan::{HTTPRequest, HTTPResponse, NativeContext, NativeRouteKind};
use pyo3::prelude::*;

mod auth;
mod config;
mod connection;
mod protocol;
mod relay;
mod rights;
mod session;
mod store;

/// The runtime the background tasks (the relay client, the rights re-read)
/// and the database pool live on. Created by `configure()`.
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// The runtime of the native service.
pub fn runtime() -> Option<&'static tokio::runtime::Runtime> {
    RUNTIME.get()
}

/// A minimal stderr logger: Aethonan routes its own logs to Python, but the
/// native route's `log` crate output would otherwise be silently dropped.
struct StderrLogger;

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[fiduswriter-native] {}: {}", record.level(), record.args());
        }
    }
    fn flush(&self) {}
}

/// The path prefix served natively.
pub const WS_ROUTE: &str = "/ws/document";

#[pyo3::pymodule(gil_used = false)]
fn _aethonan(py: Python, module: &Bound<PyModule>) -> PyResult<()> {
    // Initialise the Aethonan module: this provides the workers, the callback
    // scheduler and everything else the Python side expects to find.
    aethonan::init_py_module(py, module)?;

    // The native route is registered by `configure(json)`, once the Django
    // application has decided that this deployment can be served natively.
    module.add_function(wrap_pyfunction!(configure, module)?)?;
    module.add_function(wrap_pyfunction!(flush, module)?)?;

    Ok(())
}

/// Save every live native session to the database.
///
/// Called by the ASGI lifespan shutdown handler (like
/// `WebsocketConsumer.save_all_docs` for the Python consumer), so the last
/// edits are not lost when the server stops. A no-op without configuration.
#[pyfunction]
fn flush() {
    let Some(runtime) = runtime() else {
        return;
    };
    // Wait for the periodic saves that are still in flight: the last writer
    // must not be an older snapshot (bounded wait, then proceed anyway).
    for _ in 0..400 {
        if crate::connection::saves_in_flight() == 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let sessions = session::all_sessions();
    if sessions.is_empty() {
        return;
    }
    let handle = runtime.handle().clone();
    for session in sessions {
        // The same snapshot-and-write the periodic save performs.
        let Some((db, config)) = store::db().and_then(|db| config::get().map(|c| (db, c))) else {
            return;
        };
        let (document_id, version, content, diffs, title, comments, bibliography) = {
            let session = session.lock().unwrap();
            if session.version == session.last_saved_version {
                continue;
            }
            (
                session.document_id,
                session.version,
                session
                    .editor
                    .as_ref()
                    .and_then(|editor| editor.doc_json(true).ok())
                    .unwrap_or_default(),
                serde_json::to_string(&session.diffs).unwrap_or_default(),
                session.title.clone(),
                session.comments.to_string(),
                session.bibliography.to_string(),
            )
        };
        let session = session.clone();
        let save = async move {
            let result = db
                .save_document(
                    config,
                    document_id,
                    &content,
                    version,
                    &diffs,
                    &title,
                    &comments,
                    &bibliography,
                )
                .await;
            match result {
                Ok(()) => {
                    let mut session = session.lock().unwrap();
                    session.last_saved_version = session.version.max(version);
                }
                Err(err) => log::warn!("Could not flush document {document_id}: {err}"),
            }
        };
        // The lifespan handler runs in a thread pool thread, so blocking on
        // our runtime here is safe (it is not this thread's own runtime).
        let _ = handle.block_on(save);
    }
}

/// Configure the native websockets route.
///
/// Called once by `fiduswriter/asgi.py` after `django.setup()`, with a JSON
/// payload carrying the database settings, the session store, the table and
/// column names, the intervals and the relay credentials.
///
/// Returns `True` when the native route now serves `/ws/document/<id>/`.
/// Raises when the payload is malformed; a deployment that cannot be served
/// natively returns `False` and nothing is registered.
#[pyfunction]
fn configure(payload: &str) -> PyResult<bool> {
    let parsed: config::Config = serde_json::from_str(payload).map_err(|err| {
        pyo3::exceptions::PyValueError::new_err(format!(
            "invalid native websockets configuration: {err}"
        ))
    })?;
    Ok(setup(parsed))
}

/// Apply the configuration: validate, connect, start the background tasks
/// and register the route. `false` means the route stays unregistered.
fn setup(parsed: config::Config) -> bool {
    let _ = log::set_logger(&StderrLogger);
    if log::max_level() == log::LevelFilter::Off {
        log::set_max_level(log::LevelFilter::Warn);
    }
    if !parsed.enabled {
        return false;
    }
    if parsed.session_backend != "django.contrib.sessions.backends.db" {
        log::warn!(
            "The native route needs the database session engine, not {:?}: \
             the Channels consumer keeps serving the document websockets.",
            parsed.session_backend
        );
        return false;
    }
    let Some(database_config) = parsed.database.clone() else {
        log::warn!("No database configuration: the native route stays off.");
        return false;
    };
    match database_config.engine.as_str() {
        "django.db.backends.oracle" => {
            log::warn!("Oracle is not supported by the native route: the Channels consumer keeps serving the document websockets.");
            return false;
        }
        _ => {}
    }

    if RUNTIME.get().is_none() {
        match tokio::runtime::Runtime::new() {
            Ok(runtime) => {
                // Another thread may have won the race: keep the first.
                let _ = RUNTIME.set(runtime);
            }
            Err(err) => {
                log::error!("Could not start the native websockets runtime: {err}");
                return false;
            }
        }
    }
    let runtime = RUNTIME.get().expect("the runtime was just initialised");

    let database = match runtime.block_on(store::Database::connect(&database_config)) {
        Ok(database) => database,
        Err(err) => {
            log::error!("The native route is disabled: {err}");
            return false;
        }
    };

    config::set(parsed);
    store::set(database);
    crate::relay_start(runtime);

    // Register the native route: from here on, the document websockets are
    // served by the Rust side, without ever reaching the Python application.
    aethonan::register_native_route(WS_ROUTE, NativeRouteKind::Websocket, ws_handler);
    log::info!("The native websockets route serves {WS_ROUTE}/");
    true
}

/// Start the relay client and the rights re-read safety net.
fn relay_start(runtime: &tokio::runtime::Runtime) {
    relay::start(runtime);
}

/// The native websockets handler.
fn ws_handler(req: HTTPRequest, ctx: NativeContext) -> BoxFuture<'static, HTTPResponse> {
    Box::pin(async move {
        let mut req = req;
        // HTTP/1.1 upgrades and HTTP/2 extended CONNECT (RFC 8441) are both
        // recognised by Aethonan.
        if !aethonan::ws::is_upgrade_request(&req) {
            return response_400();
        }

        let path = req.uri().path().to_string();
        let document_id = document_id_from_path(&path);
        // The AllowedHostsOriginValidator of the Python path: the origin of
        // the handshake must match ALLOWED_HOSTS (a missing origin is fine).
        if !origin_allowed(req.headers().get(hyper::header::ORIGIN)) {
            return response_400();
        }
        // The authentication material of the handshake.
        let cookie = req
            .headers()
            .get(hyper::header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let query = req.uri().query().unwrap_or_default().to_string();

        match aethonan::ws::upgrade_intent(&mut req, None) {
            Ok((builder, ws)) => {
                ctx.rt.spawn(async move {
                    match ws.await {
                        Ok(stream) => {
                            connection::run(document_id, stream, cookie, query).await;
                        }
                        Err(err) => {
                            log::warn!("Native websockets upgrade failed with {err:?}");
                        }
                    }
                });

                builder.body(aethonan::http::empty_body()).unwrap()
            }
            Err(err) => {
                log::info!("Native websockets handshake failed with {err:?}");
                response_400()
            }
        }
    })
}

/// Whether the `Origin` header of the handshake is allowed: matching the
/// `AllowedHostsOriginValidator`, a missing origin passes, otherwise the
/// origin host must match one of the `ALLOWED_HOSTS` patterns (`*`, exact,
/// `*.` prefix and leading-dot subdomain patterns).
fn origin_allowed(origin: Option<&hyper::header::HeaderValue>) -> bool {
    use std::str::FromStr;
    let Some(origin) = origin else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(uri) = hyper::Uri::from_str(origin) else {
        return false;
    };
    let Some(host) = uri.host() else {
        return false;
    };
    let host = host.to_lowercase();
    let config = match config::get() {
        Some(config) => config,
        None => return true,
    };
    config.allowed_hosts.iter().any(|pattern| {
        let pattern = pattern.to_lowercase();
        if pattern == "*" {
            return true;
        }
        if let Some(suffix) = pattern.strip_prefix("*.") {
            // Both "*.example.com" and ".example.com" match subdomains.
            if host == suffix {
                return false; // the bare domain does not match the wildcard
            }
            return host.ends_with(&format!(".{suffix}"));
        }
        if let Some(suffix) = pattern.strip_prefix('.') {
            return host == suffix || host.ends_with(&format!(".{suffix}"));
        }
        host == pattern
    })
}

/// Extract the document id from the request path.
fn document_id_from_path(path: &str) -> i64 {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|part| part.parse().ok())
        .unwrap_or_default()
}

/// A `400 Bad Request` response.
fn response_400() -> HTTPResponse {
    let mut builder = hyper::Response::builder().status(400);
    let headers = builder.headers_mut().unwrap();
    headers.insert(hyper::header::SERVER, hyper::header::HeaderValue::from_static("aethonan"));
    builder
        .body(
            http_body_util::Full::new("Bad request".into())
                .map_err(|e| match e {})
                .boxed(),
        )
        .unwrap()
}
