//! The websockets connection handling: the message protocol, on the Rust side.
//!
//! This is the counterpart of the Python consumer
//! (`base/base_consumer.py` and `document/consumers.py`): the message
//! counters, the resend logic, the authentication, the rights enforcement
//! and the document handling all happen here, without ever reaching the
//! Python interpreter.

use std::sync::{Arc, Mutex};

use futures::{SinkExt, StreamExt};
use granian::ws::WSStream;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use std::sync::atomic::{AtomicU64, Ordering};

use crate::protocol::{ConnState, Resend, resend};
use crate::rights::{self, Identity, Resolution, RightsContext};
use crate::session::{self, DocumentSession, Participant};
use crate::{auth, store};

/// Extract a query parameter (minimal form-url decoding, enough for the
/// share token).
fn query_param<'a>(query: &'a str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        if key != name {
            return None;
        }
        let decoded: String = value
            .chars()
            .map(|c| if c == '+' { ' ' } else { c })
            .collect();
        Some(decoded)
    })
}

/// The saves currently in flight, so the shutdown flush can wait for them
/// (the last writer must not be an older snapshot).
static SAVES_IN_FLIGHT: AtomicU64 = AtomicU64::new(0);

/// The number of periodic saves currently in flight.
pub fn saves_in_flight() -> u64 {
    SAVES_IN_FLIGHT.load(Ordering::SeqCst)
}

/// Decrements the in-flight save counter on drop.
struct SaveGuard;

impl Drop for SaveGuard {
    fn drop(&mut self) {
        SAVES_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A websockets connection.
struct Connection {
    /// The document the connection is about.
    document_id: i64,
    /// The message bookkeeping of the connection.
    state: Arc<Mutex<ConnState>>,
    /// The channel the serialized messages are sent to.
    tx: mpsc::UnboundedSender<String>,
    /// The participant id, once subscribed.
    participant_id: Option<u64>,
    /// The session of the document, once subscribed.
    session: Option<Arc<Mutex<DocumentSession>>>,
    /// The rights context of this connection, once subscribed.
    context: Option<RightsContext>,
    /// The raw share token from the query string.
    token: Option<String>,
    /// The `Cookie` header of the handshake, for the session resolution.
    cookie: Option<String>,
}

impl Connection {
    /// Create a connection for a document.
    fn new(
        document_id: i64,
        tx: mpsc::UnboundedSender<String>,
        token: Option<String>,
        cookie: Option<String>,
    ) -> Self {
        Self {
            document_id,
            state: Arc::new(Mutex::new(ConnState::default())),
            tx,
            participant_id: None,
            session: None,
            context: None,
            token,
            cookie,
        }
    }

    /// Send a message, applying the message counters.
    fn send(&self, message: &Value) {
        let text = {
            let mut state = self.state.lock().unwrap();
            state.prepare(message)
        };
        let _ = self.tx.send(text);
    }

    /// Send a raw message, without the counters (the pong).
    fn send_raw(&self, text: &str) {
        let _ = self.tx.send(text.to_string());
    }

    /// Handle an incoming frame.
    ///
    /// Returns `Err` when the connection has to be closed.
    async fn handle_text(&mut self, text: &str) -> Result<(), ()> {
        // A malformed frame is fatal, like the json.loads error in Python.
        let message: Value = serde_json::from_str(text).map_err(|err| {
            log::warn!("Malformed websocket frame: {err}");
        })?;

        let message_type = message
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();

        if message_type == "ping" {
            self.send_raw("{\"type\": \"pong\"}");
            return Ok(());
        }

        if message_type == "request_resend" {
            let from = message
                .get("from")
                .and_then(|value| value.as_u64())
                .unwrap_or_default();
            self.do_resend(from);
            return Ok(());
        }

        let (client_counter, server_counter) = match (
            message.get("c").and_then(|value| value.as_u64()),
            message.get("s").and_then(|value| value.as_u64()),
        ) {
            (Some(client), Some(server)) => (client, server),
            _ => {
                // The message does not carry the counters: deny the access.
                self.access_denied();
                return Err(());
            }
        };

        let (server, client) = {
            let state = self.state.lock().unwrap();
            (state.server, state.client)
        };

        if client_counter < client + 1 {
            // A message already received: ignore it.
            return Ok(());
        }

        if client_counter > client + 1 {
            // Messages from the client have been lost: ask for a resend.
            self.send(&json!({"type": "request_resend", "from": client}));
            return Ok(());
        }

        if server_counter < server {
            // The message was sent simultaneously with one of ours, or one of
            // ours never arrived: resend the missing messages.
            self.state.lock().unwrap().client += 1;
            self.do_resend(server_counter);
            self.reject_message(&message);
            return Ok(());
        }

        self.state.lock().unwrap().client += 1;

        match message_type.as_str() {
            "subscribe" => {
                let connection_count = message
                    .get("connection")
                    .and_then(|value| value.as_u64())
                    .unwrap_or_default();
                let client_version = message.get("v").and_then(|value| value.as_u64());
                self.subscribe(connection_count, client_version).await
            }
            _ => {
                self.handle_message(&message).await;
                Ok(())
            }
        }
    }

    /// Resend the messages the client has not seen.
    fn do_resend(&self, from_no: u64) {
        let (outcome, messages) = {
            let mut state = self.state.lock().unwrap();
            resend(&mut state, from_no)
        };
        match outcome {
            Resend::Unfixable => {
                // Too many messages are missing: the client has to refetch the
                // document.
                self.send(&json!({"type": "refetch_doc"}));
            }
            Resend::Done => {
                for message in messages {
                    self.send(&message);
                }
            }
        }
    }

    /// Deny the access and close the connection.
    fn access_denied(&self) {
        self.send(&json!({"type": "access_denied"}));
    }

    /// Reject a message the client sent simultaneously with one of ours.
    fn reject_message(&self, message: &Value) {
        if message.get("type").and_then(|value| value.as_str()) == Some("diff") {
            if let Some(rid) = message.get("rid") {
                self.send(&json!({"type": "reject_diff", "rid": rid}));
            }
        }
    }

    /// The user id behind the session cookie, if any.
    async fn cookie_user_id(&self, cookie: Option<&str>) -> Option<i64> {
        let config = crate::config::get()?;
        let database = store::db()?;
        let cookie = cookie?;
        let session_key = auth::session_key_from_cookie(cookie, &config.session_cookie)?;
        let session_data = database.session_data(config, &session_key).await.ok()??;
        auth::user_id_from_session_data(&session_data, &config.secret_keys)
    }

    /// Subscribe the connection to the document.
    async fn subscribe(
        &mut self,
        connection_count: u64,
        client_version: Option<u64>,
    ) -> Result<(), ()> {
        // Authentication: the session cookie resolves to the user id.
        let user_id = self.cookie_user_id(self.cookie.as_deref()).await;

        // Authorization: resolve the rights at subscribe.
        let (brief, context) = match rights::resolve_subscribe(
            self.document_id,
            user_id,
            self.token.as_deref(),
        )
        .await
        {
            Resolution::Allowed(brief, context) => (brief, context),
            Resolution::Denied => {
                self.access_denied();
                return Err(());
            }
        };

        let session = match self.session_for_document(&brief).await {
            Some(session) => session,
            None => {
                self.access_denied();
                return Err(());
            }
        };

        // The display name.
        let name = match (&context.identity, store::db(), crate::config::get()) {
            (Identity::User(user_id), Some(database), Some(config)) => database
                .user_display_name(config, *user_id)
                .await
                .ok()
                .flatten()
                .unwrap_or_else(|| "Unknown".to_string()),
            _ => String::new(), // "Guest N" below, once the id is known
        };

        let participant = Participant {
            id: 0,
            state: self.state.clone(),
            tx: self.tx.clone(),
            name,
            context,
        };

        let participant_id = {
            let mut session = session.lock().unwrap();
            let id = session.add_participant(participant);
            if let Some(participant) = session.participants.get_mut(&id) {
                if matches!(participant.context.identity, Identity::Guest(_)) {
                    participant.name = format!("Guest {id}");
                }
            }
            id
        };

        self.participant_id = Some(participant_id);
        self.session = Some(session.clone());
        let (rights_str, guest_id) = {
            let session = session.lock().unwrap();
            let context = &session.participants[&participant_id].context;
            self.context = Some(RightsContext {
                identity: context.identity.clone(),
                rights: context.rights.clone(),
                is_owner: context.is_owner,
                path: context.path.clone(),
                path_owner: context.path_owner,
                checked_at: context.checked_at,
                token: context.token.clone(),
                kicked: context.kicked.clone(),
                kick: context.kick.clone(),
            });
            let guest_id = match &context.identity {
                Identity::Guest(id) => Some(id.clone()),
                Identity::User(_) => None,
            };
            (context.rights.clone(), guest_id)
        };

        self.send(&json!({"type": "subscribed"}));

        if connection_count < 1 {
            // Send session_id so the client knows its participant ID.
            let mut session_info = json!({
                "type": "session_info",
                "session_id": participant_id,
                "access_right": rights_str,
            });
            if let Some(guest_id) = guest_id {
                session_info["guest_id"] = json!(guest_id);
            }
            self.send(&session_info);
            self.check_version(client_version, false).await;
        } else {
            // Reconnecting user — send access rights for comparison.
            let mut reconnect = json!({
                "type": "access_right",
                "access_right": rights_str,
            });
            if let Some(guest_id) = guest_id {
                reconnect["guest_id"] = json!(guest_id);
            }
            self.send(&reconnect);
        }

        // The participant list is sent to everybody (filtered per recipient).
        {
            let session = session.lock().unwrap();
            if session
                .participants
                .get(&participant_id)
                .map(|p| p.can_communicate())
                .unwrap_or(false)
            {
                let list = session.participant_list();
                session.broadcast(&list, None, "");
            }
        }
        Ok(())
    }

    /// Reconcile the version of the client with the one of the server.
    async fn check_version(&self, client_version: Option<u64>, offline: bool) {
        let Some(session) = self.session.clone() else {
            return;
        };
        let (server_version, diffs, comments) = {
            let session = session.lock().unwrap();
            (
                session.version,
                session.diffs.iter().cloned().collect::<Vec<_>>(),
                session.comments.clone(),
            )
        };

        let Some(client_version) = client_version else {
            self.send(&json!({"type": "confirm_version", "v": server_version}));
            return;
        };

        if client_version == server_version {
            self.send(&json!({"type": "confirm_version", "v": server_version}));
            return;
        }

        if client_version < server_version && !offline {
            let behind = (server_version - client_version) as usize;
            if client_version as usize + diffs.len() >= server_version as usize {
                // We have enough diffs to catch the client up.
                for message in diffs.iter().rev().take(behind).rev() {
                    let mut message = message.clone();
                    message["server_fix"] = json!(true);
                    let message = self.sanitize(&message, &comments);
                    self.send(&message);
                }
                self.send(&json!({"type": "confirm_version", "v": server_version}));
            } else {
                // Too far behind: the client has to refetch the document.
                self.unfixable().await;
            }
            return;
        }

        // The client is ahead of the server, or offline and behind: it has
        // to refetch the document.
        self.unfixable().await;
    }

    /// A diff this client receives, filtered for its own rights.
    fn sanitize(&self, message: &Value, comments: &Value) -> Value {
        let Some(context) = self.context.as_ref() else {
            return message.clone();
        };
        rights::sanitize_diff_message(
            message,
            &context.rights,
            &context.identity.id_string(),
            comments,
        )
    }

    /// Snapshot the session and write it in the background, so the hot path
    /// is not blocked by the database.
    fn spawn_save(session: &Arc<Mutex<DocumentSession>>) {
        Self::spawn_save_inner(session, false)
    }

    /// Like `spawn_save`, but also writes when the version was not bumped
    /// (the initialization of a fresh document).
    fn spawn_save_forced(session: &Arc<Mutex<DocumentSession>>) {
        Self::spawn_save_inner(session, true)
    }

    fn spawn_save_inner(session: &Arc<Mutex<DocumentSession>>, force: bool) {
        let Some((db, config)) = store::db().and_then(|db| crate::config::get().map(|c| (db, c)))
        else {
            return;
        };
        let (document_id, version, content, diffs, title, comments, bibliography) = {
            let mut session = session.lock().unwrap();
            if !force && session.version == session.last_saved_version {
                return;
            }
            if session.save_pending {
                // A save is already queued or running; it would be overtaken
                // by this one anyway. When it lands, the next save check
                // spawns a fresh one.
                return;
            }
            session.save_pending = true;
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
        SAVES_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            let _guard = SaveGuard;
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
                    session.save_pending = false;
                }
                Err(err) => {
                    let mut session = session.lock().unwrap();
                    session.save_pending = false;
                    log::warn!("Could not save document {document_id}: {err}");
                }
            }
        });
    }

    /// Save the document, like `unfixable()` and the periodic save do.
    async fn save(&self) {
        let Some(session) = self.session.clone() else {
            return;
        };
        let (document_id, version, content, diffs, title, comments, bibliography) = {
            let session = session.lock().unwrap();
            if session.version == session.last_saved_version {
                return;
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
        let database = match store::db().and_then(|db| crate::config::get().map(|c| (db, c))) {
            Some(pair) => pair,
            None => return,
        };
        let (db, config) = database;
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
                session.last_saved_version = session.version;
            }
            Err(err) => log::warn!("Could not save document {document_id}: {err}"),
        }
    }

    /// The client cannot be fixed: save the document and ask for a refetch.
    async fn unfixable(&self) {
        self.save().await;
        self.send(&json!({"type": "refetch_doc"}));
    }

    /// Handle a message that is not a subscription.
    async fn handle_message(&mut self, message: &Value) {
        let Some(context) = self.context.as_ref() else {
            return;
        };
        let message_type = message
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let rights = context.rights.clone();
        let sender_user = context.identity.id_string();

        match message_type {
            "diff" => {
                if rights::can_update_document(&rights) {
                    self.handle_diff(message).await;
                }
            }
            "chat" => {
                if rights::can_communicate(&rights) {
                    self.handle_chat(message);
                }
            }
            "participant_update" => {
                if rights::can_communicate(&rights) {
                    self.broadcast_participant_list();
                }
            }
            "check_version" => {
                let client_version = message.get("v").and_then(|v| v.as_u64());
                let offline = message
                    .get("offline")
                    .and_then(|o| o.as_bool())
                    .unwrap_or(false);
                self.check_version(client_version, offline).await;
            }
            "selection_change" => {
                let current = self
                    .session
                    .as_ref()
                    .map(|session| session.lock().unwrap().version);
                if current.is_some() && current == message.get("v").and_then(|v| v.as_u64()) {
                    self.broadcast(message, &sender_user);
                }
            }
            "path_change" => {
                self.handle_path_change(message).await;
            }
            // E2EE frames never reach the native route (E2EE documents are
            // refused at subscribe; the mode disables the route entirely).
            _ => {}
        }
    }

    /// Handle a chat message: the server wraps it in its own envelope.
    fn handle_chat(&mut self, message: &Value) {
        let Some(context) = self.context.as_ref() else {
            return;
        };
        let Some(body) = message.get("body") else {
            return;
        };
        let chat = json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "body": body,
            "from": context.identity.id_string(),
            "type": "chat",
        });
        let sender = context.identity.id_string();
        self.broadcast(&chat, &sender);
    }

    /// Handle a path change: persist it, then relay it to the others.
    async fn handle_path_change(&mut self, message: &Value) {
        let (Some(context), Some(session)) = (self.context.as_ref(), self.session.clone()) else {
            return;
        };
        // Only the owner and the holders of a direct access right have a
        // path to change; guests do not.
        let has_path = match &context.identity {
            Identity::User(_) => true,
            Identity::Guest(_) => false,
        };
        if !has_path {
            return;
        }
        let Some(path) = message.get("path").and_then(|p| p.as_str()) else {
            return;
        };
        let document_id = session.lock().unwrap().document_id;
        let saved = match (store::db(), crate::config::get()) {
            (Some(db), Some(config)) => {
                if context.path_owner {
                    db.save_owner_path(config, document_id, path).await
                } else if let Identity::User(user_id) = context.identity {
                    db.save_accessright_path(config, document_id, user_id, path)
                        .await
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        };
        if let Err(err) = saved {
            log::warn!("Could not save the path of document {document_id}: {err}");
            return;
        }
        if let Some(context) = self.context.as_mut() {
            context.path = path.to_string();
        }
        let sender = self
            .context
            .as_ref()
            .map(|c| c.identity.id_string())
            .unwrap_or_default();
        self.broadcast(message, &sender);
    }

    /// Broadcast the current participant list to everybody.
    fn broadcast_participant_list(&self) {
        let Some(session) = self.session.clone() else {
            return;
        };
        let session = session.lock().unwrap();
        let list = session.participant_list();
        session.broadcast(&list, None, "");
    }

    /// Handle a diff: apply the steps, bump the version and relay the diff.
    async fn handle_diff(&mut self, message: &Value) {
        let Some(session) = self.session.clone() else {
            return;
        };
        let Some(context) = self.context.as_ref() else {
            return;
        };
        let pv = message.get("v").and_then(|v| v.as_u64());
        let (dv, comments) = {
            let session = session.lock().unwrap();
            (session.version, session.comments.clone())
        };

        let Some(pv) = pv else {
            return;
        };

        // Rights enforcement on the content (like the Python consumer, the
        // frames that violate the rights are dropped silently).
        if rights::COMMENT_ONLY.contains(&context.rights.as_str()) && !rights::only_comments(message)
        {
            log::debug!(
                "Dropped a non-comment diff from a {} collaborator on document {}",
                context.rights,
                self.document_id
            );
            return;
        }
        if rights::OWN_COMMENTS_ONLY_RIGHTS.contains(&context.rights.as_str())
            && message.get("cu").is_some()
            && !rights::owns_comment_updates(
                &message["cu"],
                &context.identity.id_string(),
                &comments,
            )
        {
            log::debug!(
                "Dropped a foreign comment update from a {} collaborator on document {}",
                context.rights,
                self.document_id
            );
            return;
        }

        if pv == dv {
            if let Some(steps) = message.get("ds") {
                let steps = match serde_json::to_string(steps) {
                    Ok(steps) => steps,
                    Err(err) => {
                        log::warn!("Could not serialize the steps: {err}");
                        return;
                    }
                };
                let applied = {
                    let mut session = session.lock().unwrap();
                    match session.editor.as_mut() {
                        Some(editor) => editor.apply_steps_json(&steps).unwrap_or(false),
                        None => true,
                    }
                };
                if !applied {
                    // The steps could not be applied: reset the collaboration,
                    // like the Python consumer does.
                    self.reset_collaboration().await;
                    return;
                }
            }

            {
                let mut session = session.lock().unwrap();
                session.push_diff(message.clone());
                session.version += 1;
                if let Some(title) = message.get("ti").and_then(|t| t.as_str()) {
                    session.title = title.to_string();
                }
                if let Some(cu) = message.get("cu").and_then(|cu| cu.as_array()) {
                    session.update_comments(cu);
                }
                if let Some(bu) = message.get("bu").and_then(|bu| bu.as_array()) {
                    session.update_bibliography(bu);
                }
            }

            // Persist the title immediately (like save_document_title).
            if message.get("ti").is_some() {
                let title = session.lock().unwrap().title.clone();
                if let (Some(db), Some(config)) = (store::db(), crate::config::get()) {
                    let id = self.document_id;
                    tokio::spawn(async move {
                        if let Err(err) = db.save_title(config, id, &title).await {
                            log::warn!("Could not save the title of {id}: {err}");
                        }
                    });
                }
            }

            // Save the document every DOC_SAVE_INTERVAL versions. The write
            // happens in the background, so the save does not delay the
            // confirm_diff of this frame (the Python consumer pays the save
            // on every 30th frame; the native route does not).
            let save_interval = crate::config::get().map(|c| c.save_interval).unwrap_or(30);
            let version = session.lock().unwrap().version;
            if save_interval > 0 && version % save_interval == 0 {
                Self::spawn_save(&session);
            }

            if let Some(rid) = message.get("rid") {
                self.send(&json!({"type": "confirm_diff", "rid": rid}));
            }
            let sender = context.identity.id_string();
            self.broadcast(message, &sender);
        } else if pv < dv {
            let behind = (dv - pv) as usize;
            let (diffs, comments) = {
                let session = session.lock().unwrap();
                (
                    session.diffs.iter().cloned().collect::<Vec<_>>(),
                    session.comments.clone(),
                )
            };
            if pv as usize + diffs.len() >= dv as usize {
                // We have enough diffs stored to fix it.
                for message in diffs.iter().rev().take(behind).rev() {
                    let mut fixed = message.clone();
                    fixed["server_fix"] = json!(true);
                    let fixed = self.sanitize(&fixed, &comments);
                    self.send(&fixed);
                }
            } else {
                // The client has a version that is too old to be fixed.
                self.unfixable().await;
            }
        } else {
            // The client has a higher version than the server: fishy.
            log::warn!(
                "User has a higher document version than the server on document {}",
                self.document_id
            );
            self.unfixable().await;
        }
    }

    /// The steps of a diff could not be applied: tell everybody, save and
    /// let them refetch (`reset_collaboration`).
    async fn reset_collaboration(&mut self) {
        let Some(session) = self.session.clone() else {
            return;
        };
        let sender_id = self.participant_id;
        let user_id = self
            .context
            .as_ref()
            .map(|context| context.identity.id_string())
            .unwrap_or_default();
        let patch_error = json!({"type": "patch_error", "user_id": user_id});
        {
            let session = session.lock().unwrap();
            for participant in session.participants.values() {
                if Some(participant.id) == sender_id {
                    participant.send(&patch_error);
                } else {
                    participant.send(&patch_error);
                    participant.send(&json!({"type": "refetch_doc"}));
                }
            }
        }
        self.save().await;
    }

    /// Relay a message to the other participants of the document.
    fn broadcast(&self, message: &Value, sender_user: &str) {
        let Some(session) = self.session.clone() else {
            return;
        };
        let session = session.lock().unwrap();
        session.broadcast(message, self.participant_id, sender_user);
    }

    /// The session of the document, creating it from the database if needed.
    async fn session_for_document(
        &self,
        brief: &rights::DocumentRowBrief,
    ) -> Option<Arc<Mutex<DocumentSession>>> {
        if let Some(session) = session::get_session(self.document_id) {
            return Some(session);
        }

        // Serialize the creation: two simultaneous first subscribers must
        // not create two sessions. The guard is dropped before any await.
        let guard = session::creation_lock().lock().ok()?;
        if let Some(session) = session::get_session(self.document_id) {
            return Some(session);
        }

        let schema = session::schema_json()?;
        let editor =
            prosemirror::editor::Editor::new(schema, &brief.content.to_string()).ok()?;
        let initialized = brief.initialized;
        let session = Arc::new(Mutex::new(DocumentSession::new(
            self.document_id,
            brief,
            Some(editor),
        )));
        session::set_session(self.document_id, session.clone());
        drop(guard);
        if initialized {
            // A fresh document: persist the template content immediately,
            // like `initialize_document_content` does.
            Self::spawn_save_forced(&session);
        }
        Some(session)
    }

    /// Remove the participant from the session.
    async fn cleanup(&self) {
        let (Some(session), Some(participant_id)) = (self.session.clone(), self.participant_id)
        else {
            return;
        };
        let empty;
        {
            let mut session = session.lock().unwrap();
            session.remove_participant(participant_id);
            empty = session.participants.is_empty();
            if !empty {
                let list = session.participant_list();
                session.broadcast(&list, None, "");
            }
        }
        if empty {
            // Save before the cleanup, like the Python consumer does.
            self.save().await;
            session::remove_session(self.document_id);
        }
    }
}

/// Run a websockets connection until it is closed.
pub async fn run(
    document_id: i64,
    stream: WSStream,
    cookie: Option<String>,
    query: String,
) {
    let (mut sink, mut source) = stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let token = query_param(&query, "token");
    let mut connection = Connection::new(document_id, tx.clone(), token, cookie);
    // The Python consumer welcomes every connection.
    connection.send(&json!({"type": "welcome"}));

    loop {
        // The rights re-read may have revoked the access while this
        // connection was idle: watch the kick handle of the subscribed
        // context (when there is one yet).
        let kick = connection
            .context
            .as_ref()
            .map(|context| context.kick.clone());
        let kicked = connection
            .context
            .as_ref()
            .map(|context| context.kicked.load(std::sync::atomic::Ordering::SeqCst))
            .unwrap_or(false);
        if kicked {
            break;
        }
        tokio::select! {
            _ = wait_for_kick(kick) => {
                break;
            }
            message = source.next() => {
                match message {
                    Some(Ok(Message::Text(data))) => {
                        if connection.handle_text(&data).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        log::debug!("Websocket client error: {err:?}");
                        break;
                    }
                }
            }
            outgoing = rx.recv() => {
                match outgoing {
                    Some(text) => {
                        if sink.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    // Flush the messages the handler queued before the close (the
    // access_denied and its kin would otherwise be lost).
    while let Ok(text) = rx.try_recv() {
        if sink.send(Message::Text(text.into())).await.is_err() {
            break;
        }
    }

    connection.cleanup().await;
}

/// Wait until the access is revoked, forever when the connection is not
/// subscribed yet (there is nothing to revoke before the subscribe).
async fn wait_for_kick(kick: Option<Arc<tokio::sync::Notify>>) {
    match kick {
        Some(kick) => kick.notified().await,
        None => std::future::pending().await,
    }
}
