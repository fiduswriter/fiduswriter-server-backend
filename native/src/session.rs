//! The live state of a document being edited.
//!
//! The session holds the document itself (as a ProseMirror editor, in Rust
//! memory), the version counter, the log of the recent diffs and the list of
//! the connected participants. It is the Rust counterpart of the `session`
//! dictionary of the Python consumer (`document/consumers.py`).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex, RwLock};

use prosemirror::editor::Editor;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::protocol::ConnState;
use crate::rights::{self, RightsContext, can_communicate, sanitize_diff_message};

/// How many diffs are kept for the catch-up of lagging clients.
const HISTORY_LENGTH: usize = 1000;

/// A connected participant.
pub struct Participant {
    /// The participant id, unique within the document.
    pub id: u64,
    /// The message bookkeeping of the connection.
    pub state: Arc<Mutex<ConnState>>,
    /// The channel the serialized messages are sent to.
    pub tx: mpsc::UnboundedSender<String>,
    /// The display name of the participant.
    pub name: String,
    /// The access rights of the participant and its identity.
    pub context: RightsContext,
}

impl Participant {
    /// Send a message to the participant, stamping the message counters.
    pub fn send(&self, message: &Value) -> bool {
        let text = {
            let mut state = self.state.lock().unwrap();
            state.prepare(message)
        };
        self.tx.send(text).is_ok()
    }

    /// Whether the participant may see the other participants and chat.
    pub fn can_communicate(&self) -> bool {
        can_communicate(&self.context.rights)
    }
}

/// The live state of a document.
pub struct DocumentSession {
    /// The document id.
    pub document_id: i64,
    /// The owner of the document (the owner always keeps write access).
    #[allow(dead_code)]
    pub owner_id: i64,
    /// The document editor. `None` for encrypted documents, whose content the
    /// server cannot read (they never reach the native route).
    pub editor: Option<Editor>,
    /// The version of the document.
    pub version: u64,
    /// The version at which the document was last saved.
    pub last_saved_version: u64,
    /// Whether a save is already queued or running (saves are coalesced:
    /// the database write is slower than the collaboration under load).
    pub save_pending: bool,
    /// The log of the recent diffs, used to catch up lagging clients.
    pub diffs: VecDeque<Value>,
    /// The connected participants, by id.
    pub participants: BTreeMap<u64, Participant>,
    /// The id given to the next participant.
    next_participant_id: u64,
    /// The title of the document (persisted on save, like Django).
    pub title: String,
    /// The comments of the document (maintained like the Python consumer).
    pub comments: Value,
    /// The bibliography of the document.
    pub bibliography: Value,
}

impl DocumentSession {
    /// Create a session for a document from its database row.
    pub fn new(document_id: i64, brief: &rights::DocumentRowBrief, editor: Option<Editor>) -> Self {
        let mut diffs = VecDeque::new();
        if let Some(list) = brief.diffs.as_array() {
            for diff in list {
                diffs.push_back(diff.clone());
            }
            while diffs.len() > HISTORY_LENGTH {
                diffs.pop_front();
            }
        }
        Self {
            document_id,
            owner_id: brief.owner_id,
            editor,
            version: brief.version,
            last_saved_version: brief.version,
            save_pending: false,
            diffs,
            participants: BTreeMap::new(),
            next_participant_id: 0,
            title: brief.title.clone(),
            comments: brief.comments.clone(),
            bibliography: brief.bibliography.clone(),
        }
    }

    /// Add a participant to the session, returning its id.
    pub fn add_participant(&mut self, participant: Participant) -> u64 {
        let id = self.next_participant_id;
        self.next_participant_id += 1;
        self.participants.insert(id, participant);
        id
    }

    /// Remove a participant from the session.
    pub fn remove_participant(&mut self, id: u64) {
        self.participants.remove(&id);
    }

    /// Append a diff to the log, trimming it to the history length.
    pub fn push_diff(&mut self, message: Value) {
        self.diffs.push_back(message);
        while self.diffs.len() > HISTORY_LENGTH {
            self.diffs.pop_front();
        }
    }

    /// Apply the comment updates of a diff to the in-memory comments
    /// (`WebsocketConsumer.update_comments`).
    pub fn update_comments(&mut self, updates: &[Value]) {
        let Some(comments) = self.comments.as_object_mut() else {
            return;
        };
        for update in updates {
            let (Some(id), Some(update_type)) = (
                update.get("id").and_then(|id| id.as_str()),
                update.get("type").and_then(|t| t.as_str()),
            ) else {
                continue;
            };
            match update_type {
                "create" => {
                    let entry = json!({
                        "user": update.get("user"),
                        "username": update.get("username"),
                        "assignedUser": update.get("assignedUser"),
                        "assignedUsername": update.get("assignedUsername"),
                        "date": update.get("date"),
                        "comment": update.get("comment"),
                        "isMajor": update.get("isMajor"),
                        "resolved": update.get("resolved"),
                        "isGlobal": update.get("isGlobal").unwrap_or(&json!(false)),
                    });
                    comments.insert(id.to_string(), entry);
                }
                "delete" => {
                    comments.remove(id);
                }
                "update" => {
                    let Some(entry) = comments.get_mut(id).and_then(|e| e.as_object_mut()) else {
                        continue;
                    };
                    if let Some(comment) = update.get("comment") {
                        entry.insert("comment".to_string(), comment.clone());
                    }
                    if let Some(is_major) = update.get("isMajor") {
                        entry.insert("isMajor".to_string(), is_major.clone());
                    }
                    if update.get("assignedUser").is_some() {
                        entry.insert(
                            "assignedUser".to_string(),
                            update.get("assignedUser").unwrap().clone(),
                        );
                        entry.insert(
                            "assignedUsername".to_string(),
                            update.get("assignedUsername").unwrap_or(&Value::Null).clone(),
                        );
                    }
                    if let Some(resolved) = update.get("resolved") {
                        entry.insert("resolved".to_string(), resolved.clone());
                    }
                }
                "add_answer" => {
                    let Some(entry) = comments.get_mut(id).and_then(|e| e.as_object_mut()) else {
                        continue;
                    };
                    let answers = entry
                        .entry("answers".to_string())
                        .or_insert_with(|| json!([]));
                    if let Some(answers) = answers.as_array_mut() {
                        answers.push(json!({
                            "id": update.get("answerId"),
                            "user": update.get("user"),
                            "username": update.get("username"),
                            "date": update.get("date"),
                            "answer": update.get("answer"),
                        }));
                    }
                }
                "delete_answer" => {
                    let Some(entry) = comments.get_mut(id).and_then(|e| e.as_object_mut()) else {
                        continue;
                    };
                    let answer_id = update.get("answerId").and_then(|a| a.as_str());
                    if let Some(answers) = entry.get_mut("answers").and_then(|a| a.as_array_mut())
                    {
                        answers.retain(|answer| {
                            answer
                                .get("id")
                                .and_then(|a| a.as_str())
                                .zip(answer_id)
                                .map(|(a, b)| a != b)
                                .unwrap_or(true)
                        });
                    }
                }
                "update_answer" => {
                    let Some(entry) = comments.get_mut(id).and_then(|e| e.as_object_mut()) else {
                        continue;
                    };
                    let answer_id = update.get("answerId").and_then(|a| a.as_str());
                    if let Some(answers) = entry.get_mut("answers").and_then(|a| a.as_array_mut())
                    {
                        for answer in answers.iter_mut() {
                            if answer
                                .get("id")
                                .and_then(|a| a.as_str())
                                .zip(answer_id)
                                .map(|(a, b)| a == b)
                                .unwrap_or(false)
                            {
                                if let Some(body) = update.get("answer") {
                                    answer
                                        .as_object_mut()
                                        .map(|map| map.insert("answer".to_string(), body.clone()));
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Apply the bibliography updates of a diff (`update_bibliography`).
    pub fn update_bibliography(&mut self, updates: &[Value]) {
        let Some(bibliography) = self.bibliography.as_object_mut() else {
            return;
        };
        for update in updates {
            let (Some(id), Some(update_type)) = (
                update.get("id").and_then(|id| id.as_str()),
                update.get("type").and_then(|t| t.as_str()),
            ) else {
                continue;
            };
            match update_type {
                "update" => {
                    if let Some(reference) = update.get("reference") {
                        bibliography.insert(id.to_string(), reference.clone());
                    }
                }
                "delete" => {
                    bibliography.remove(id);
                }
                _ => {}
            }
        }
    }

    /// Send a message to the other participants, filtering per recipient
    /// rights (`WebsocketConsumer.send_updates`).
    pub fn broadcast(&self, message: &Value, sender_id: Option<u64>, sender_user: &str) {
        let message_type = message
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        for participant in self.participants.values() {
            if Some(participant.id) == sender_id {
                continue;
            }
            let rights = &participant.context.rights;
            let user_id = participant.context.identity.id_string();
            let mut to_send = message.clone();

            // Comment updates inside diffs are filtered per recipient.
            if message_type == "diff"
                && message.get("cu").is_some()
                && (rights == "read-without-comments"
                    || rights::OWN_COMMENTS_ONLY_RIGHTS.contains(&rights.as_str()))
            {
                to_send = sanitize_diff_message(message, rights, &user_id, &self.comments);
            }
            if (message_type == "chat" || message_type == "connections")
                && !participant.can_communicate()
            {
                continue;
            }
            if message_type == "selection_change"
                && !participant.can_communicate()
                && sender_user != user_id
            {
                continue;
            }
            if message_type == "path_change" && sender_user != user_id {
                continue;
            }
            participant.send(&to_send);
        }
    }

    /// The list of the participants, as sent in the `connections` message
    /// (only the ones the recipient may know about).
    pub fn participant_list(&self) -> Value {
        let list: Vec<Value> = self
            .participants
            .values()
            .filter(|participant| participant.can_communicate())
            .map(|participant| {
                json!({
                    "session_id": participant.id,
                    "id": participant.context.identity.id_string(),
                    "name": participant.name,
                    "avatar": "",
                })
            })
            .collect();
        json!({"type": "connections", "participant_list": list})
    }
}

/// The registry of the live document sessions.
static REGISTRY: LazyLock<RwLock<HashMap<i64, Arc<Mutex<DocumentSession>>>>> =
    LazyLock::new(Default::default);

/// Serializes the *creation* of a session: two subscribers connecting at the
/// same moment must not create two sessions for the same document (the
/// subscribe path does database work first, so the window is real).
static CREATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The lock guarding the session creation.
pub fn creation_lock() -> &'static std::sync::Mutex<()> {
    &CREATION_LOCK
}

/// Return the session of a document, if any.
pub fn get_session(document_id: i64) -> Option<Arc<Mutex<DocumentSession>>> {
    REGISTRY.read().unwrap().get(&document_id).cloned()
}

/// Set the session of a document.
pub fn set_session(document_id: i64, session: Arc<Mutex<DocumentSession>>) {
    REGISTRY.write().unwrap().insert(document_id, session);
}

/// Remove the session of a document.
pub fn remove_session(document_id: i64) {
    REGISTRY.write().unwrap().remove(&document_id);
}

/// All the live sessions (the rights re-read safety net).
pub fn all_sessions() -> Vec<Arc<Mutex<DocumentSession>>> {
    REGISTRY.read().unwrap().values().cloned().collect()
}

/// The document schema, loaded once from the schema file.
static SCHEMA: LazyLock<Option<String>> = LazyLock::new(|| {
    let path = std::env::var("FIDUSWRITER_SCHEMA_PATH")
        .ok()
        .or_else(|| crate::config::get()?.schema_path.clone())
        .or_else(|| {
            std::env::var("PROJECT_PATH")
                .ok()
                .map(|project| format!("{project}/static-libs/json/schema.json"))
        })?;
    match std::fs::read_to_string(&path) {
        Ok(content) => Some(content),
        Err(err) => {
            log::warn!("Could not read the document schema from {path}: {err}");
            None
        }
    }
});

/// The document schema, as a JSON string.
pub fn schema_json() -> Option<&'static str> {
    SCHEMA.as_deref()
}
