//! Access rights: the Rust counterpart of
//! `document/helpers/session_user_info.py`, `refresh_authorization()` in
//! `document/consumers.py` and `document/helpers/comment_filter.py`.
//!
//! The rights hierarchy (higher is better):
//! write > write-tracked > comment > review-tracked > review >
//! read > read-without-comments.
//!
//! At subscribe the rights are resolved from the database: the owner gets
//! `write`, everyone else needs an `AccessRight` row or a valid share token.
//! Afterwards the in-memory rights are enforced on every mutating frame and
//! re-read when the relay reports an `access_changed` event or when the
//! periodic safety net fires.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::config;

/// The rights hierarchy, best first (document/consumers.py).
pub const RIGHTS_ORDER: [&str; 7] = [
    "write",
    "write-tracked",
    "comment",
    "review-tracked",
    "review",
    "read",
    "read-without-comments",
];

/// Rights that may write document content (CAN_UPDATE_DOCUMENT).
pub const CAN_UPDATE_DOCUMENT: [&str; 5] = [
    "write",
    "write-tracked",
    "review",
    "review-tracked",
    "comment",
];

/// Rights that may see and talk to the other participants (CAN_COMMUNICATE).
pub const CAN_COMMUNICATE: [&str; 4] = ["read", "write", "comment", "write-tracked"];

/// Rights that may only touch their own comments.
pub const OWN_COMMENTS_ONLY_RIGHTS: [&str; 2] = ["review", "review-tracked"];

/// Rights that may not write document content (COMMENT_ONLY).
pub const COMMENT_ONLY: [&str; 2] = ["review", "comment"];

/// The rank of a rights string (lower is better); unknown rights rank worst.
pub fn rank(rights: &str) -> usize {
    RIGHTS_ORDER
        .iter()
        .position(|r| *r == rights)
        .unwrap_or(usize::MAX)
}

/// The better of two rights strings.
pub fn better<'a>(first: &'a str, second: &'a str) -> &'a str {
    if rank(first) <= rank(second) {
        first
    } else {
        second
    }
}

/// Who a participant is, for the participant list and the chat.
#[derive(Debug, Clone)]
pub enum Identity {
    /// A logged-in user.
    User(i64),
    /// A share-token guest, identified by the non-secret derived id.
    Guest(String),
}

impl Identity {
    /// The id as exposed to the other participants (and the chat `from`).
    pub fn id_string(&self) -> String {
        match self {
            Identity::User(id) => id.to_string(),
            Identity::Guest(id) => id.clone(),
        }
    }
}

/// Everything the session keeps about the authorization of a participant.
pub struct RightsContext {
    pub identity: Identity,
    pub rights: String,
    pub is_owner: bool,
    /// The path this participant may change (document path for the owner,
    /// access right path otherwise), for `path_change` persistence.
    pub path: String,
    pub path_owner: bool,
    pub checked_at: Instant,
    /// The share token the participant came in with (for the re-read).
    pub token: Option<String>,
    /// Set when the access was revoked: the connection closes itself.
    pub kicked: Arc<AtomicBool>,
    /// The signal waking the connection so it notices `kicked`.
    pub kick: Arc<Notify>,
}

impl RightsContext {
    pub fn new(identity: Identity) -> Self {
        Self {
            identity,
            rights: "read".to_string(),
            is_owner: false,
            path: String::new(),
            path_owner: false,
            checked_at: Instant::now(),
            token: None,
            kicked: Arc::new(AtomicBool::new(false)),
            kick: Arc::new(Notify::new()),
        }
    }
}

/// The document bits needed to open the session.
pub struct DocumentRowBrief {
    pub owner_id: i64,
    pub version: u64,
    pub content: Value,
    pub diffs: Value,
    pub comments: Value,
    pub bibliography: Value,
    pub title: String,
    #[allow(dead_code)]
    pub path: String,
    /// The content was empty and got initialized from the template: it has
    /// to be persisted right away (like `initialize_document_content`).
    pub initialized: bool,
}

/// The outcome of the subscribe-time rights resolution.
pub enum Resolution {
    /// The participant may join with these rights.
    Allowed(DocumentRowBrief, RightsContext),
    /// The access is denied (no such document, wrong version, E2EE, no rights).
    Denied,
}

/// Normalize a share token for comparison: lowercase, without dashes.
fn normalize_token(token: &str) -> String {
    token
        .chars()
        .filter(|c| *c != '-')
        .collect::<String>()
        .to_lowercase()
}

/// The rights a share token grants on a document, if the token is valid.
async fn token_rights(document_id: i64, token: &str) -> Option<String> {
    let (config, database) = (config::get(), crate::store::db());
    let (Some(config), Some(database)) = (config, database) else {
        return None;
    };
    let wanted = normalize_token(token);
    let tokens = database.share_tokens(config, document_id).await.ok()?;
    tokens
        .into_iter()
        .find(|(stored, _)| normalize_token(stored) == wanted)
        .map(|(_, rights)| rights)
}

/// The derived, non-secret participant id of a share-token guest
/// (`token_access.guest_participant_id`).
fn guest_participant_id(token: &str, document_id: i64) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("{token}:{document_id}").as_bytes(),
    )
    .to_string()
}

/// Resolve the access rights at subscribe time.
///
/// Mirrors `SessionUserInfo.init_access`:
/// * a valid share token grants its rights (guest or logged-in user);
/// * the owner gets `write`;
/// * otherwise an `AccessRight` row is required;
/// * E2EE documents and foreign document versions are refused (they stay on
///   the Python consumer).
pub async fn resolve_subscribe(
    document_id: i64,
    user_id: Option<i64>,
    token: Option<&str>,
) -> Resolution {
    let (Some(config), Some(database)) = (config::get(), crate::store::db()) else {
        return Resolution::Denied;
    };
    let Ok(Some(row)) = database.load_document(config, document_id).await else {
        return Resolution::Denied;
    };
    if row.e2ee || row.doc_version != config.fw_document_version {
        return Resolution::Denied;
    }

    // The direct rights: the owner gets write, others need an AccessRight row.
    let direct: Option<(String, String)> = match user_id {
        Some(user_id) if user_id == row.owner_id => {
            Some(("write".to_string(), row.path.clone()))
        }
        Some(user_id) => database
            .right_for(config, document_id, user_id)
            .await
            .ok()
            .flatten(),
        None => None,
    };

    // A valid share token grants its rights; a guest needs one.
    let token_rights = match token {
        Some(token) => match token_rights(document_id, token).await {
            Some(rights) => Some(rights),
            None if user_id.is_none() => return Resolution::Denied,
            None => None,
        },
        None => None,
    };

    let identity = match (user_id, token) {
        (Some(user_id), Some(_)) if token_rights.is_some() => Identity::User(user_id),
        (Some(user_id), _) => Identity::User(user_id),
        (None, Some(token)) => Identity::Guest(guest_participant_id(token, document_id)),
        (None, None) => return Resolution::Denied,
    };

    let mut context = RightsContext::new(identity);
    context.token = token.map(str::to_string);

    match (direct, token_rights) {
        (Some((rights, path)), Some(token_rights)) => {
            context.rights = better(&rights, &token_rights).to_string();
            context.is_owner = user_id == Some(row.owner_id);
            context.path = path;
            context.path_owner = context.is_owner;
        }
        (Some((rights, path)), None) => {
            context.rights = rights;
            context.is_owner = user_id == Some(row.owner_id);
            context.path = path;
            context.path_owner = context.is_owner;
        }
        (None, Some(token_rights)) => {
            context.rights = token_rights;
        }
        (None, None) => return Resolution::Denied,
    }

    // Initialize the content of a fresh document from its template, like
    // `document_store.initialize_document_content`.
    let mut initialized = false;
    let content_is_dict_without_type = row
        .content
        .as_object()
        .map(|object| !object.contains_key("type"))
        .unwrap_or(false);
    let content = if content_is_dict_without_type {
        let mut content = database
            .template_content(config, row.template_id)
            .await
            .ok()
            .flatten()
            .unwrap_or_else(|| json!({}));
        if !content.as_object().map(|o| o.contains_key("type")).unwrap_or(false) {
            content["type"] = json!("doc");
        }
        if !content.as_object().map(|o| o.contains_key("content")).unwrap_or(false) {
            content["content"] = json!([{"type": "title"}]);
        }
        initialized = true;
        content
    } else {
        row.content
    };

    Resolution::Allowed(
        DocumentRowBrief {
            owner_id: row.owner_id,
            version: row.version.max(0) as u64,
            content,
            diffs: row.diffs,
            comments: row.comments,
            bibliography: row.bibliography,
            title: row.title,
            path: row.path,
            initialized,
        },
        context,
    )
}

/// Whether the rights allow sending document steps.
pub fn can_update_document(rights: &str) -> bool {
    CAN_UPDATE_DOCUMENT.contains(&rights)
}

/// Whether the rights allow seeing the other participants and chatting.
pub fn can_communicate(rights: &str) -> bool {
    CAN_COMMUNICATE.contains(&rights)
}

/// Whether a diff only touches comments (`WebsocketConsumer.only_comments`).
pub fn only_comments(message: &Value) -> bool {
    if message.get("ti").is_some()
        || message.get("bu").is_some()
        || message.get("iu").is_some()
    {
        return false;
    }
    let Some(steps) = message.get("ds").and_then(|ds| ds.as_array()) else {
        return false;
    };
    steps.iter().all(|step| {
        step.get("stepType")
            .and_then(|t| t.as_str())
            .map(|t| t == "addMark" || t == "removeMark")
            .unwrap_or(false)
            && step
                .get("mark")
                .and_then(|mark| mark.get("type"))
                .and_then(|t| t.as_str())
                == Some("comment")
    })
}

/// The id of a JSON value the way Python's `str()` would render it, for
/// comparing the user ids of comments (which may be strings or numbers).
fn id_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Whether a comment entry is visible to a user (`_entry_visible`).
fn entry_visible(entry: &Value, user_id: &str, doc_comments: &Value) -> bool {
    let Some(entry) = entry.as_object() else {
        return false;
    };
    if entry.get("user").and_then(id_string).as_deref() == Some(user_id)
        || entry
            .get("assignedUser")
            .and_then(id_string)
            .as_deref()
            .map(|assigned| assigned == user_id)
            .unwrap_or(false)
    {
        return true;
    }
    if entry.get("type").and_then(|t| t.as_str()) == Some("delete") {
        let stored = entry
            .get("id")
            .and_then(|id| id.as_str())
            .and_then(|id| doc_comments.get(id));
        return match stored.and_then(|stored| stored.get("user")).and_then(id_string) {
            Some(owner) => owner == user_id,
            None => true,
        };
    }
    false
}

/// Whether all comment updates of a diff reference only the caller's own
/// comments (`owns_comment_updates`).
pub fn owns_comment_updates(cu: &Value, user_id: &str, doc_comments: &Value) -> bool {
    let Some(entries) = cu.as_array() else {
        return false;
    };
    entries.iter().all(|entry| {
        let Some(object) = entry.as_object() else {
            return false;
        };
        if object.get("type").and_then(|t| t.as_str()) == Some("delete") {
            let id = object.get("id").and_then(|id| id.as_str()).unwrap_or("");
            let stored = doc_comments.as_object().and_then(|comments| comments.get(id));
            return match stored.and_then(|stored| stored.get("user")).and_then(id_string) {
                Some(owner) => owner == user_id,
                None => true,
            };
        }
        if object.get("user").and_then(id_string).as_deref() != Some(user_id) {
            return false;
        }
        object
            .get("answers")
            .and_then(|answers| answers.as_array())
            .map(|answers| {
                answers
                    .iter()
                    .all(|answer| answer.get("user").and_then(id_string).as_deref() == Some(user_id))
            })
            .unwrap_or(true)
    })
}

/// The recipient-appropriate copy of a diff message
/// (`sanitize_diff_message`): `read-without-comments` never sees comment
/// updates, `review`/`review-tracked` only see their own.
pub fn sanitize_diff_message(
    message: &Value,
    rights: &str,
    user_id: &str,
    doc_comments: &Value,
) -> Value {
    if !message.get("cu").is_some() {
        return message.clone();
    }
    if rights == "read-without-comments" {
        let mut message = message.clone();
        if let Some(map) = message.as_object_mut() {
            map.remove("cu");
        }
        return message;
    }
    if OWN_COMMENTS_ONLY_RIGHTS.contains(&rights) {
        let filtered: Vec<Value> = message
            .get("cu")
            .and_then(|cu| cu.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| entry_visible(entry, user_id, doc_comments))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let mut message = message.clone();
        if let Some(map) = message.as_object_mut() {
            map.insert("cu".to_string(), json!(filtered));
        }
        return message;
    }
    message.clone()
}

/// Re-read the rights of every participant of a document and apply them:
/// close the sessions that lost all access, downgrade the ones that lost
/// write. Triggered by the `access_changed` relay event and by the periodic
/// safety net. Mirrors `refresh_authorization(force=True)`.
pub async fn refresh_session_rights(document_id: i64) {
    let (Some(config), Some(database)) = (config::get(), crate::store::db()) else {
        return;
    };
    let Some(session) = crate::session::get_session(document_id) else {
        return;
    };
    let rights_rows = match database.access_rights(config, document_id).await {
        Ok(rows) => rows,
        Err(err) => {
            log::warn!("Could not re-read the rights of document {document_id}: {err}");
            return;
        }
    };
    let tokens = database
        .share_tokens(config, document_id)
        .await
        .unwrap_or_default();

    {
        let mut session = session.lock().unwrap();
        let mut kick_ids = Vec::new();
        for (id, participant) in session.participants.iter_mut() {
            let context = &mut participant.context;
            let still_ok = if context.is_owner {
                true
            } else {
                match &context.identity {
                    Identity::User(user_id) => {
                        match rights_rows.iter().find(|(_, holder, _)| holder == user_id) {
                            Some((_, _, rights)) => {
                                context.rights = rights.clone();
                                true
                            }
                            None => false,
                        }
                    }
                    Identity::Guest(_) => {
                        let Some(token) = context.token.as_deref() else {
                            kick_ids.push(*id);
                            continue;
                        };
                        let wanted = normalize_token(token);
                        match tokens
                            .iter()
                            .find(|(stored, _)| normalize_token(stored) == wanted)
                        {
                            Some((_, rights)) => {
                                context.rights = rights.clone();
                                true
                            }
                            None => false,
                        }
                    }
                }
            };
            context.checked_at = Instant::now();
            if !still_ok {
                kick_ids.push(*id);
            }
        }
        for id in kick_ids {
            if let Some(participant) = session.participants.remove(&id) {
                // Tell the client and close its connection.
                participant.send(&json!({"type": "access_denied"}));
                participant
                    .context
                    .kicked
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                participant.context.kick.notify_one();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_rights_hierarchy_ranks_write_best() {
        assert_eq!(better("write", "read"), "write");
        assert_eq!(better("comment", "write-tracked"), "write-tracked");
        assert_eq!(better("review", "review-tracked"), "review-tracked");
        assert!(rank("unknown") > rank("read-without-comments"));
    }

    #[test]
    fn comment_only_diffs_only_touch_comment_marks() {
        let diff = json!({"type": "diff", "ds": [
            {"stepType": "addMark", "mark": {"type": "comment"}},
            {"stepType": "removeMark", "mark": {"type": "comment"}},
        ]});
        assert!(only_comments(&diff));

        let with_replace = json!({"type": "diff", "ds": [
            {"stepType": "replace", "mark": {"type": "comment"}},
        ]});
        assert!(!only_comments(&with_replace));

        let with_title = json!({"type": "diff", "ti": "New title", "ds": []});
        assert!(!only_comments(&with_title));

        let empty = json!({"type": "diff"});
        assert!(!only_comments(&empty));
    }

    #[test]
    fn comment_updates_are_sanitized_per_recipient() {
        let message = json!({"type": "diff", "v": 1, "cu": [
            {"type": "create", "id": "a", "user": "7", "comment": "mine"},
            {"type": "create", "id": "b", "user": "8", "comment": "theirs"},
        ]});
        let comments = json!({});

        // Full rights: unchanged.
        let full = sanitize_diff_message(&message, "write", "7", &comments);
        assert_eq!(full["cu"].as_array().unwrap().len(), 2);

        // read-without-comments: no comment updates at all.
        let none = sanitize_diff_message(&message, "read-without-comments", "7", &comments);
        assert!(none.get("cu").is_none());

        // review: only own entries.
        let own = sanitize_diff_message(&message, "review", "7", &comments);
        let cu = own["cu"].as_array().unwrap();
        assert_eq!(cu.len(), 1);
        assert_eq!(cu[0]["id"], json!("a"));
    }

    #[test]
    fn owns_comment_updates_checks_user_and_answers() {
        let comments = json!({});
        let own = json!([
            {"type": "create", "id": "a", "user": "7"},
            {"type": "add_answer", "id": "a", "user": "7", "answers": [{"user": "7"}]},
        ]);
        assert!(owns_comment_updates(&own, "7", &comments));

        let foreign = json!([{"type": "create", "id": "a", "user": "8"}]);
        assert!(!owns_comment_updates(&foreign, "7", &comments));

        let foreign_answer = json!([
            {"type": "add_answer", "id": "a", "user": "7", "answers": [{"user": "8"}]},
        ]);
        assert!(!owns_comment_updates(&foreign_answer, "7", &comments));
    }

    #[test]
    fn the_guest_id_matches_the_python_derivation() {
        // token_access.guest_participant_id with the Fidus Writer namespace.
        let derived = guest_participant_id("12345678-1234-1234-1234-123456789012", 3);
        assert_eq!(derived.len(), 36);
        // Stable for the same input.
        assert_eq!(
            derived,
            guest_participant_id("12345678-1234-1234-1234-123456789012", 3)
        );
    }
}
