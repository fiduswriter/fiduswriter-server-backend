//! A websockets load generator for the Fidus Writer collaboration protocol.
//!
//! It connects a number of clients to the same document and has them type
//! continuously: every iteration sends a diff frame and waits for the
//! `confirm_diff` answer, which carries the request id of the diff. The round
//! trip time of the frame is the latency the server is measured with.
//!
//! The clients track the version of the document (the server rejects a diff
//! whose version is behind and catches the client up instead), like the real
//! editor does.
//!
//! ```text
//! wsload --url ws://127.0.0.1:8000/ws/document/1/ --clients 10 --duration 30
//! ```

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clap::Parser;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

/// The step inserting a character, and the step removing it again. The two
/// are applied in turn, so that the document keeps the same size.
const INSERT_STEP: &str = r#"{"stepType": "replace", "from": 4, "to": 4, "slice": {"content": [{"type": "text", "text": "!"}]}}"#;
const DELETE_STEP: &str = r#"{"stepType": "replace", "from": 4, "to": 5}"#;

/// How long we wait for the confirmation of a diff before giving up on it.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Parser, Debug)]
#[command(about = "Websockets load generator for the Fidus Writer protocol")]
struct Args {
    /// The websockets URL of the document.
    #[arg(long)]
    url: String,
    /// The number of clients.
    #[arg(long, default_value = "1")]
    clients: usize,
    /// The duration of the run, in seconds.
    #[arg(long, default_value = "10")]
    duration: u64,
    /// The frames per second and client. 0 means as fast as possible.
    #[arg(long, default_value = "0")]
    rate: f64,
    /// The session cookie, for the clients that need to authenticate.
    #[arg(long)]
    cookie: Option<String>,
    /// The document id.
    #[arg(long, default_value = "1")]
    document: i64,
    /// Only connect and stay connected, without sending any diff.
    #[arg(long, default_value = "false")]
    idle: bool,
}

/// The latency samples, in microseconds.
type Samples = Arc<Mutex<Vec<u64>>>;

/// The state shared between the reader and the writer of a connection.
#[derive(Default)]
struct Shared {
    /// The version of the document, as the client believes it to be.
    version: AtomicU64,
    /// The last message counter of the server.
    server_counter: AtomicU64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let sent = Arc::new(AtomicU64::new(0));
    let confirmed = Arc::new(AtomicU64::new(0));
    let dropped = Arc::new(AtomicU64::new(0));
    let samples: Samples = Arc::new(Mutex::new(Vec::new()));

    let deadline = Instant::now() + Duration::from_secs(args.duration);
    let mut tasks = Vec::new();

    for client in 0..args.clients {
        let url = args.url.clone();
        let cookie = args.cookie.clone();
        let document = args.document;
        let rate = args.rate;
        let sent = sent.clone();
        let confirmed = confirmed.clone();
        let dropped = dropped.clone();
        let samples = samples.clone();
        let deadline = deadline;
        tasks.push(tokio::spawn(async move {
            if let Err(err) = run_client(
                &url,
                cookie,
                document,
                rate,
                deadline,
                client,
                &sent,
                &confirmed,
                &dropped,
                &samples,
                args.idle,
            )
            .await
            {
                eprintln!("client {client}: {err}");
                dropped.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }

    for task in tasks {
        let _ = task.await;
    }

    let sent = sent.load(Ordering::Relaxed);
    let confirmed = confirmed.load(Ordering::Relaxed);
    let dropped = dropped.load(Ordering::Relaxed);

    let mut samples = samples.lock().unwrap().clone();
    samples.sort_unstable();

    let duration = args.duration as f64;
    println!("clients: {}", args.clients);
    println!("duration: {duration:.1}s");
    println!("sent: {sent}");
    println!("confirmed: {confirmed}");
    println!("dropped: {dropped}");
    println!("throughput: {:.1} frames/s", confirmed as f64 / duration);
    if !samples.is_empty() {
        println!("latency us p50: {}", percentile(&samples, 50));
        println!("latency us p90: {}", percentile(&samples, 90));
        println!("latency us p99: {}", percentile(&samples, 99));
        println!("latency us max: {}", samples[samples.len() - 1]);
        let mean: u64 = samples.iter().sum::<u64>() / samples.len() as u64;
        println!("latency us mean: {mean}");
    }
    Ok(())
}

/// The percentile of the samples.
fn percentile(samples: &[u64], percentile: usize) -> u64 {
    let index = (samples.len() * percentile / 100).min(samples.len() - 1);
    samples[index]
}

/// Run a single client.
#[allow(clippy::too_many_arguments)]
async fn run_client(
    url: &str,
    cookie: Option<String>,
    _document: i64,
    rate: f64,
    deadline: Instant,
    client: usize,
    sent: &AtomicU64,
    confirmed: &AtomicU64,
    dropped: &AtomicU64,
    samples: &Samples,
    idle: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::header::COOKIE;

    let build_request = || -> Result<_, Box<dyn std::error::Error + Send + Sync>> {
        let mut request = url.into_client_request()?;
        if let Some(cookie) = &cookie {
            request
                .headers_mut()
                .insert(COOKIE, cookie.parse().unwrap());
        }
        // The browser sends an origin header, and the Django side refuses the
        // connections without one.
        if let Ok(url) = url::Url::parse(url) {
            let scheme = match url.scheme() {
                "wss" => "https",
                _ => "http",
            };
            // The allowed hosts of the benchmark installation are "localhost".
            let origin = format!("{scheme}://localhost");
            let origin = match url.port() {
                Some(port) => format!("{origin}:{port}"),
                None => origin,
            };
            if let Ok(value) = origin.parse() {
                request
                    .headers_mut()
                    .insert("Origin", value);
            }
        }
        Ok(request)
    };

    let mut step_index = 0usize;

    // The load runs until the deadline; a refetch_doc (the server cannot
    // reconcile the version) reconnects and resubscribes, like the frontend
    // reloading the document.
    loop {
        // The message counter is per connection: the subscribe below is c:1.
        let mut counter: u64 = 2;
        let (stream, _) = tokio_tungstenite::connect_async(build_request()?).await?;
        let (mut sink, mut source) = stream.split();

        let shared = Arc::new(Shared::default());
        let (confirm_tx, mut confirm_rx) = mpsc::unbounded_channel::<String>();
        let (catchup_tx, mut catchup_rx) = mpsc::unbounded_channel::<()>();
        let (ready_tx, mut ready_rx) = mpsc::unbounded_channel::<()>();
        let (refetch_tx, mut refetch_rx) = mpsc::unbounded_channel::<()>();

        // The reader keeps track of the version of the document and of the
        // message counter of the server, and forwards the confirmations.
        let reader_shared = shared.clone();
        let reader = tokio::spawn(async move {
            while let Some(message) = source.next().await {
                let Ok(message) = message else { break };
                let Message::Text(text) = message else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let kind = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if let Some(counter) = value.get("s").and_then(|v| v.as_u64()) {
                    reader_shared.server_counter.fetch_max(counter, Ordering::Relaxed);
                }
                match kind {
                    "confirm_diff" => {
                        if let Some(rid) = value.get("rid").and_then(|v| v.as_str()) {
                            let _ = confirm_tx.send(rid.to_string());
                        }
                    }
                    // The version reconciliation of the bootstrap: the exact
                    // version the document is at.
                    "confirm_version" => {
                        if let Some(v) = value.get("v").and_then(|v| v.as_u64()) {
                            reader_shared.version.store(v, Ordering::Relaxed);
                        }
                    }
                    // A diff from another participant: the document moved on.
                    // The bootstrap is over once the participant list is sent.
                    "connections" => {
                        let _ = ready_tx.send(());
                    }
                    // The server rejected the diff (it was sent simultaneously
                    // with one of the server messages): it has to be sent again.
                    "reject_diff" => {
                        let _ = catchup_tx.send(());
                    }
                    // The server cannot reconcile the version: the document
                    // has to be refetched, which means reconnecting here.
                    "refetch_doc" => {
                        let _ = refetch_tx.send(());
                    }
                    "diff" => {
                        reader_shared.version.fetch_add(1, Ordering::Relaxed);
                        // A diff sent to catch us up means our own diff was
                        // rejected: it has to be sent again.
                        if value
                            .get("server_fix")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false)
                        {
                            let _ = catchup_tx.send(());
                        }
                    }
                    _ => {}
                }
            }
        });

        // Subscribe.
        sink.send(Message::Text(
            json!({"type": "subscribe", "c": 1, "s": 1, "connection": 0, "v": 0})
                .to_string()
                .into(),
        ))
        .await?;

        let interval = if rate > 0.0 {
            Some(Duration::from_secs_f64(1.0 / rate))
        } else {
            None
        };

        // Wait for the bootstrap to be over, so that the message counter of
        // the server is known.
        let _ = ready_rx.recv().await;

        if idle {
            // Just stay connected until the end of the run.
            while Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            let _ = reader.abort();
            return Ok(());
        }

        let mut refetched = false;
        'send: loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }

            if let Some(interval) = interval {
                tokio::time::sleep_until((now + interval).into()).await;
            }

            let step = if step_index % 2 == 0 {
                INSERT_STEP
            } else {
                DELETE_STEP
            };
            step_index += 1;

            let mut rid = format!("r{client}-{counter}");
            let version = shared.version.load(Ordering::Relaxed);
            let message = json!({
                "type": "diff",
                "c": counter,
                "s": shared.server_counter.load(Ordering::Relaxed),
                "v": version,
                "rid": rid,
                "ds": [serde_json::from_str::<Value>(step).unwrap()],
            });
            counter += 1;

            let sent_at = Instant::now();
            if sink.send(Message::Text(message.to_string().into())).await.is_err() {
                break;
            }
            sent.fetch_add(1, Ordering::Relaxed);

            // Wait for the confirmation of the diff. When the server catches us
            // up, the diff is rejected and has to be sent again.
            let mut got = false;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                tokio::select! {
                    confirmation = confirm_rx.recv() => {
                        match confirmation {
                            Some(confirmed_rid) => {
                                if confirmed_rid == rid {
                                    got = true;
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                    catchup = catchup_rx.recv() => {
                        if catchup.is_none() {
                            break;
                        }
                        // The server was ahead of us: send the diff again, with
                        // the version we have now.
                        let new_rid = format!("r{client}-{counter}");
                        let message = json!({
                            "type": "diff",
                            "c": counter,
                            "s": shared.server_counter.load(Ordering::Relaxed),
                            "v": shared.version.load(Ordering::Relaxed),
                            "rid": new_rid,
                            "ds": [serde_json::from_str::<Value>(step).unwrap()],
                        });
                        counter += 1;
                        rid = new_rid;
                        if sink.send(Message::Text(message.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    refetch = refetch_rx.recv() => {
                        if refetch.is_some() {
                            // The server asked for a refetch: reconnect.
                            refetched = true;
                        }
                        break;
                    }
                    _ = tokio::time::sleep(remaining.min(CONFIRM_TIMEOUT)) => break,
                }
            }

            if refetched {
                dropped.fetch_add(1, Ordering::Relaxed);
                break 'send;
            }
            if got {
                confirmed.fetch_add(1, Ordering::Relaxed);
                shared.version.fetch_add(1, Ordering::Relaxed);
                let elapsed = sent_at.elapsed().as_micros() as u64;
                samples.lock().unwrap().push(elapsed);
            } else {
                // The diff was dropped: the server was ahead and caught us up.
                dropped.fetch_add(1, Ordering::Relaxed);
            }
        }

        let _ = reader.abort();
        if !refetched || Instant::now() >= deadline {
            break;
        }
        // Reconnect after a short pause.
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    Ok(())
}
