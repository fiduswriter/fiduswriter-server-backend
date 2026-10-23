//! The system message relay client.
//!
//! The native service joins the *existing* cross-server relay as a client of
//! the local `/ws/base/` endpoint (`base.consumers.SystemMessageConsumer`),
//! presenting the service credential like any other Fidus Writer server
//! (`User-Agent: Fidus Writer`, `Authorization: Bearer <secret>`).
//!
//! `document.views.notify_access_change` fans the message
//! `{"type": "access_changed", "document_id": X}` out to these relay
//! clients, locally and via the other servers' presences. On it, the rights
//! of the document's participants are re-read; a periodic re-read is the
//! safety net for the events that are lost (a dropped relay, a restart, a
//! mutation that does not notify).

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use tokio::runtime::Runtime;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::rights;

/// Start the relay client and the rights re-read safety net on the runtime.
pub fn start(runtime: &Runtime) {
    let Some(config) = crate::config::get() else {
        return;
    };
    if let Some(relay_url) = config.relay_url.clone() {
        if !config.broadcast_secret.is_empty() {
            runtime.spawn(async move { relay_loop(&relay_url).await });
        }
    }
    if config.rights_recheck_seconds > 0 {
        runtime.spawn(rights_refresher());
    }
}

/// Connect, listen, reconnect with a backoff: the relay is an optimisation,
/// its loss must not lose the service.
async fn relay_loop(relay_url: &str) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match connect(relay_url).await {
            Ok(connection) => {
                backoff = Duration::from_secs(1);
                listen(connection).await;
            }
            Err(err) => {
                log::info!("Native relay: {err}; retrying in {backoff:?}");
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

type Ws = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Open the authenticated relay connection.
async fn connect(relay_url: &str) -> Result<Ws, String> {
    let config = crate::config::get().ok_or("no configuration")?;
    let mut request = relay_url
        .into_client_request()
        .map_err(|err| err.to_string())?;
    let headers = request.headers_mut();
    headers.insert(
        "User-Agent",
        "Fidus Writer".parse().map_err(|err| format!("{err}"))?,
    );
    headers.insert(
        "Authorization",
        format!("Bearer {}", config.broadcast_secret)
            .parse()
            .map_err(|err| format!("{err}"))?,
    );
    headers.insert(
        "Origin",
        config
            .relay_origin
            .parse()
            .map_err(|err| format!("{err}"))?,
    );
    let (stream, _response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|err| format!("could not connect to {relay_url}: {err}"))?;
    Ok(stream)
}

/// Read the relay frames until the connection drops.
async fn listen(connection: Ws) {
    let (mut sink, mut source) = connection.split();
    while let Some(message) = source.next().await {
        let text = match message {
            Ok(Message::Text(text)) => text,
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            Ok(_) => continue,
        };
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        match frame.get("type").and_then(|t| t.as_str()) {
            // The relay asks for a pong only through the explicit ping.
            Some("ping") => {
                let _ = sink.send(Message::Text("{\"type\": \"pong\"}".into())).await;
            }
            Some("relay_message") | Some("system_message") => {
                let Some(payload) = frame.get("message") else {
                    continue;
                };
                if payload.get("type").and_then(|t| t.as_str()) == Some("access_changed") {
                    if let Some(document_id) =
                        payload.get("document_id").and_then(|id| id.as_i64())
                    {
                        log::debug!("Native relay: access changed on document {document_id}");
                        tokio::spawn(rights::refresh_session_rights(document_id));
                    }
                }
            }
            _ => {}
        }
    }
    log::info!("Native relay: connection lost");
}

/// Re-read the rights of every document with live participants, every
/// `rights_recheck_seconds`, so a missed `access_changed` event cannot leave
/// a revoked participant connected forever.
async fn rights_refresher() {
    let interval = crate::config::get()
        .map(|config| config.rights_recheck_seconds)
        .unwrap_or(5)
        .max(1);
    let mut ticker = tokio::time::interval(Duration::from_secs(interval));
    ticker.tick().await;
    loop {
        ticker.tick().await;
        for session in crate::session::all_sessions() {
            let document_id = session.lock().unwrap().document_id;
            tokio::spawn(rights::refresh_session_rights(document_id));
        }
    }
}
