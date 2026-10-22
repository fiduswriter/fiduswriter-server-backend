//! The configuration of the native route.
//!
//! The Django application hands the configuration over as one JSON payload
//! through the `configure(json)` function of the extension module (called
//! from `asgi.py` after `django.setup()`). The payload is the single source
//! of truth for everything the native side cannot discover on its own: the
//! database connection, the session store, the table and column names, the
//! intervals and the relay credentials.
//!
//! When the payload says the deployment cannot be served natively (E2EE
//! enabled, a session engine that is not database backed, an Oracle
//! database, ...), the route is simply not registered and Granian keeps
//! serving `/ws/document/<id>/` through the Django Channels consumer.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

/// The database connection settings of the `default` entry of
/// `settings.DATABASES`, as handed over by Django.
#[derive(Debug, Clone, Deserialize)]
pub struct DatabaseConfig {
    /// The Django backend name, e.g. `django.db.backends.sqlite3`.
    pub engine: String,
    /// The database name (the file path for SQLite).
    pub name: String,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub host: String,
    pub port: Option<u16>,
    /// The `OPTIONS` dict of the database setting.
    #[serde(default)]
    pub options: HashMap<String, Value>,
}

/// The configuration of the native route.
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Whether the native route may serve this deployment at all.
    pub enabled: bool,
    /// The database the document lives in.
    pub database: Option<DatabaseConfig>,
    /// The name of the session cookie (`settings.SESSION_COOKIE_NAME`).
    pub session_cookie: String,
    /// The session store backend (`settings.SESSION_ENGINE`). Only the
    /// database backend is supported by the native route.
    pub session_backend: String,
    /// The session table (`django_session`).
    pub session_table: String,
    /// The content type id of the user model (for the access rights query).
    pub user_content_type_id: i64,
    /// The table of `document.models.Document`.
    pub document_table: String,
    /// The table of `document.models.AccessRight`.
    pub accessright_table: String,
    /// The table of `document.models.ShareToken`.
    pub sharetoken_table: String,
    /// The table of `document.models.DocumentTemplate` (the content new
    /// documents are initialized from).
    pub documenttemplate_table: String,
    /// The table of the user model (for the display name).
    pub user_table: String,
    /// How many versions between two saves of the document
    /// (`settings.DOC_SAVE_INTERVAL`, 0 disables).
    pub save_interval: u64,
    /// The periodic rights re-read safety net, in seconds (0 disables).
    pub rights_recheck_seconds: u64,
    /// `base.helpers.ws.get_broadcast_secret()`.
    pub broadcast_secret: String,
    /// `settings.SECRET_KEY` followed by `SECRET_KEY_FALLBACKS`: the keys the
    /// session signatures are verified against.
    pub secret_keys: Vec<String>,
    /// The local system message relay, e.g. `ws://127.0.0.1:8000/ws/base/`.
    pub relay_url: Option<String>,
    /// The Origin header the relay client presents (must match
    /// `ALLOWED_HOSTS` on the receiving side).
    pub relay_origin: String,
    /// The path of the document schema JSON file.
    pub schema_path: Option<String>,
    /// `settings.ALLOWED_HOSTS`: the origins a websocket handshake may come
    /// from (the AllowedHostsOriginValidator of the Python path).
    pub allowed_hosts: Vec<String>,
    /// The document format version the backend accepts
    /// (`FW_DOCUMENT_VERSION`).
    pub fw_document_version: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            database: None,
            session_cookie: "sessionid".to_string(),
            session_backend: String::new(),
            session_table: "django_session".to_string(),
            user_content_type_id: 0,
            document_table: "document_document".to_string(),
            accessright_table: "document_accessright".to_string(),
            sharetoken_table: "document_sharetoken".to_string(),
            documenttemplate_table: "document_documenttemplate".to_string(),
            user_table: "user_user".to_string(),
            save_interval: 30,
            rights_recheck_seconds: 5,
            broadcast_secret: String::new(),
            secret_keys: Vec::new(),
            relay_url: None,
            relay_origin: "http://localhost".to_string(),
            schema_path: None,
            allowed_hosts: Vec::new(),
            fw_document_version: "3.7".to_string(),
        }
    }
}

static CONFIG: OnceLock<Config> = OnceLock::new();

/// Store the configuration. Only the first call has an effect.
pub fn set(config: Config) {
    let _ = CONFIG.set(config);
}

/// The configuration handed over by the Django application.
pub fn get() -> Option<&'static Config> {
    CONFIG.get()
}
