//! The database access of the native route.
//!
//! The Django ORM spends about ten milliseconds per save, almost all of it
//! in Python: building the query, the transaction handling and the trip
//! through the thread pool. The statement itself takes about half a
//! millisecond. Writing the document from Rust skips all of it.
//!
//! The connection is built from the `default` entry of `settings.DATABASES`,
//! handed over by `asgi.py` in the `configure(json)` payload — the same
//! source of truth Django itself uses. The three open-source SQL backends
//! Django supports (SQLite, PostgreSQL, MySQL/MariaDB) are served by a typed
//! enum of pools; `sqlx::Any` is deliberately not used because the JSON
//! columns, the placeholders and the `updated` handling differ per backend.
//! Oracle is refused: the caller (asgi.py) leaves the native route
//! unregistered and the Channels consumer keeps serving the path.
//!
//! Only the columns the collaboration owns are written: the content, the
//! version, the diff log, the title, the comments and the bibliography (the
//! images are still written by Django). Everything else (the template, the
//! owner, the E2EE fields) is untouched.

use std::sync::OnceLock;

use serde_json::Value;
use sqlx::Row;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::types::Json;

use crate::config::{Config, DatabaseConfig};

/// Run one of the generated statements on the matching pool.
///
/// The SQL text is generated per backend (placeholders, casts, the current
/// timestamp); the bind values are plain (`&str`, `i64`, `bool`), so the
/// same expression text type-checks against each pool and row type. The
/// binds expression is evaluated once per match arm.
macro_rules! run {
    ($db:expr, $sql:expr, ($($bind:expr),* $(,)?), execute) => {{
        match $db {
            Database::Sqlite(pool) => {
                let query = sqlx::query($sql) $(.bind($bind))*;
                query.execute(pool).await.map(|_| ()).map_err(|err| err.to_string())
            }
            Database::Postgres(pool) => {
                let query = sqlx::query($sql) $(.bind($bind))*;
                query.execute(pool).await.map(|_| ()).map_err(|err| err.to_string())
            }
            Database::MySql(pool) => {
                let query = sqlx::query($sql) $(.bind($bind))*;
                query.execute(pool).await.map(|_| ()).map_err(|err| err.to_string())
            }
        }
    }};
    ($db:expr, $sql:expr, ($($bind:expr),* $(,)?), fetch_optional | $row:ident | $decode:expr) => {{
        match $db {
            Database::Sqlite(pool) => {
                let query = sqlx::query($sql) $(.bind($bind))*;
                let row = query.fetch_optional(pool).await.map_err(|err| err.to_string())?;
                row.map(|$row| $decode).transpose()
            }
            Database::Postgres(pool) => {
                let query = sqlx::query($sql) $(.bind($bind))*;
                let row = query.fetch_optional(pool).await.map_err(|err| err.to_string())?;
                row.map(|$row| $decode).transpose()
            }
            Database::MySql(pool) => {
                let query = sqlx::query($sql) $(.bind($bind))*;
                let row = query.fetch_optional(pool).await.map_err(|err| err.to_string())?;
                row.map(|$row| $decode).transpose()
            }
        }
    }};
    ($db:expr, $sql:expr, ($($bind:expr),* $(,)?), fetch_all | $row:ident | $decode:expr) => {{
        match $db {
            Database::Sqlite(pool) => {
                let query = sqlx::query($sql) $(.bind($bind))*;
                let rows = query.fetch_all(pool).await.map_err(|err| err.to_string())?;
                rows.into_iter().map(|$row| $decode).collect::<Result<Vec<_>, String>>()
            }
            Database::Postgres(pool) => {
                let query = sqlx::query($sql) $(.bind($bind))*;
                let rows = query.fetch_all(pool).await.map_err(|err| err.to_string())?;
                rows.into_iter().map(|$row| $decode).collect::<Result<Vec<_>, String>>()
            }
            Database::MySql(pool) => {
                let query = sqlx::query($sql) $(.bind($bind))*;
                let rows = query.fetch_all(pool).await.map_err(|err| err.to_string())?;
                rows.into_iter().map(|$row| $decode).collect::<Result<Vec<_>, String>>()
            }
        }
    }};
}

/// The database the native route talks to.
pub enum Database {
    Sqlite(SqlitePool),
    Postgres(PgPool),
    MySql(MySqlPool),
}

/// A document row, as needed to open a collaboration session.
pub struct DocumentRow {
    pub owner_id: i64,
    pub template_id: i64,
    pub version: i64,
    pub content: Value,
    pub diffs: Value,
    pub comments: Value,
    pub bibliography: Value,
    pub title: String,
    pub path: String,
    pub e2ee: bool,
    pub doc_version: String,
}

static DB: OnceLock<Database> = OnceLock::new();

/// Store the connection. Only the first call has an effect.
pub fn set(database: Database) {
    let _ = DB.set(database);
}

/// The database connection, once `configure()` has set it up.
pub fn db() -> Option<&'static Database> {
    DB.get()
}

/// An SQL identifier (table or column name) from the configuration, quoted
/// for the backend. The names come from Django's model metadata, but they
/// are validated anyway: only the characters Django itself generates.
fn ident(name: &str, quote: char) -> Result<String, String> {
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        || name.is_empty()
    {
        return Err(format!("unsafe SQL identifier: {name:?}"));
    }
    Ok(format!("{quote}{name}{quote}"))
}

/// The flavour of the generated SQL statements.
struct Flavour {
    /// `?1`/`?`-style placeholders, 1-based.
    placeholder: fn(usize) -> String,
    /// The expression for the current UTC timestamp.
    now: &'static str,
    /// The identifier quoting character.
    quote: char,
    /// Suffix making a bound string acceptable for a JSON column.
    json_cast: &'static str,
}

impl Database {
    /// Connect to the database described by the Django settings dict.
    pub async fn connect(config: &DatabaseConfig) -> Result<Database, String> {
        match config.engine.as_str() {
            "django.db.backends.sqlite3" => {
                let mut options = SqliteConnectOptions::new()
                    .filename(&config.name)
                    .create_if_missing(false)
                    // The same pragmas the prototype ran with.
                    .journal_mode(sqlx::sqlite::SqliteJournalMode::Delete)
                    .synchronous(sqlx::sqlite::SqliteSynchronous::Full);
                if let Some(timeout) = config.options.get("timeout") {
                    let seconds = timeout.as_f64().unwrap_or(20.0);
                    options = options.busy_timeout(std::time::Duration::from_secs_f64(
                        seconds.max(0.0),
                    ));
                }
                // SQLite serialises writers anyway: one connection, like the
                // prototype's single mutex-guarded connection.
                let pool = SqlitePoolOptions::new()
                    .max_connections(1)
                    .connect_with(options)
                    .await
                    .map_err(|err| format!("Could not open {}: {err}", config.name))?;
                Ok(Database::Sqlite(pool))
            }
            "django.db.backends.postgresql" | "django.db.backends.postgresql_psycopg2" => {
                if matches!(
                    config.options.get("sslmode").and_then(|v| v.as_str()),
                    Some("require" | "verify-ca" | "verify-full")
                ) {
                    return Err(
                        "sslmode=require is not supported by the native route (no TLS)"
                            .to_string(),
                    );
                }
                let mut options = PgConnectOptions::new();
                options = options.host(if config.host.is_empty() {
                    "localhost"
                } else {
                    &config.host
                });
                if let Some(port) = config.port {
                    options = options.port(port);
                }
                options = options
                    .username(&config.user)
                    .password(&config.password)
                    .ssl_mode(PgSslMode::Disable);
                if !config.name.is_empty() {
                    options = options.database(&config.name);
                }
                let pool = PgPoolOptions::new()
                    .max_connections(5)
                    .connect_with(options)
                    .await
                    .map_err(|err| format!("Could not connect to PostgreSQL: {err}"))?;
                Ok(Database::Postgres(pool))
            }
            "django.db.backends.mysql" => {
                let mut options = MySqlConnectOptions::new();
                options = options.host(if config.host.is_empty() {
                    "localhost"
                } else {
                    &config.host
                });
                if let Some(port) = config.port {
                    options = options.port(port);
                }
                options = options
                    .username(&config.user)
                    .password(&config.password)
                    .database(&config.name);
                if let Some(charset) = config.options.get("charset").and_then(|v| v.as_str()) {
                    options = options.charset(charset);
                }
                if let Some(collation) =
                    config.options.get("collation").and_then(|v| v.as_str())
                {
                    options = options.collation(collation);
                }
                let pool = MySqlPoolOptions::new()
                    .max_connections(5)
                    .connect_with(options)
                    .await
                    .map_err(|err| format!("Could not connect to MySQL: {err}"))?;
                Ok(Database::MySql(pool))
            }
            "django.db.backends.oracle" => Err(
                "Oracle is not supported by the native route; the Channels consumer \
                 keeps serving the path"
                    .to_string(),
            ),
            other => Err(format!(
                "Unsupported database backend {other:?}: the native route only supports \
                 SQLite, PostgreSQL and MySQL"
            )),
        }
    }

    fn flavour(&self) -> Flavour {
        match self {
            Database::Sqlite(_) => Flavour {
                placeholder: |index| format!("?{index}"),
                now: "strftime('%Y-%m-%d %H:%M:%f','now')",
                quote: '"',
                json_cast: "",
            },
            Database::Postgres(_) => Flavour {
                placeholder: |index| format!("${index}"),
                now: "now()",
                quote: '"',
                json_cast: "::jsonb",
            },
            Database::MySql(_) => Flavour {
                placeholder: |_| "?".to_string(),
                now: "UTC_TIMESTAMP(6)",
                quote: '`',
                json_cast: "",
            },
        }
    }

    /// Write the columns the collaboration owns (the periodic save).
    pub async fn save_document(
        &self,
        config: &Config,
        document_id: i64,
        content: &str,
        version: u64,
        diffs: &str,
        title: &str,
        comments: &str,
        bibliography: &str,
    ) -> Result<(), String> {
        let flavour = self.flavour();
        let table = ident(&config.document_table, flavour.quote)?;
        let p = flavour.placeholder;
        let sql = format!(
            "UPDATE {table} SET {c_content} = {p1}{json_cast}, {c_version} = {p2}, \
             {c_diffs} = {p3}{json_cast}, {c_title} = {p4}, {c_comments} = {p5}{json_cast}, \
             {c_bibliography} = {p6}{json_cast}, {c_updated} = {now} WHERE {c_id} = {p7}",
            c_content = ident("content", flavour.quote)?,
            c_version = ident("version", flavour.quote)?,
            c_diffs = ident("diffs", flavour.quote)?,
            c_title = ident("title", flavour.quote)?,
            c_comments = ident("comments", flavour.quote)?,
            c_bibliography = ident("bibliography", flavour.quote)?,
            c_updated = ident("updated", flavour.quote)?,
            c_id = ident("id", flavour.quote)?,
            p1 = p(1),
            p2 = p(2),
            p3 = p(3),
            p4 = p(4),
            p5 = p(5),
            p6 = p(6),
            p7 = p(7),
            now = flavour.now,
            json_cast = flavour.json_cast,
        );
        run!(
            self,
            &sql,
            (
                content,
                version as i64,
                diffs,
                title,
                comments,
                bibliography,
                document_id,
            ),
            execute
        )
    }

    /// Persist a new title immediately, like `save_document_title`.
    pub async fn save_title(
        &self,
        config: &Config,
        document_id: i64,
        title: &str,
    ) -> Result<(), String> {
        let flavour = self.flavour();
        let table = ident(&config.document_table, flavour.quote)?;
        let p = flavour.placeholder;
        let sql = format!(
            "UPDATE {table} SET {c_title} = {p1}, {c_updated} = {now} WHERE {c_id} = {p2}",
            c_title = ident("title", flavour.quote)?,
            c_updated = ident("updated", flavour.quote)?,
            c_id = ident("id", flavour.quote)?,
            p1 = p(1),
            p2 = p(2),
            now = flavour.now,
        );
        run!(self, &sql, (&title[title.len().saturating_sub(255)..], document_id), execute)
    }

    /// Persist a changed document path (owner connection).
    pub async fn save_owner_path(
        &self,
        config: &Config,
        document_id: i64,
        path: &str,
    ) -> Result<(), String> {
        let flavour = self.flavour();
        let table = ident(&config.document_table, flavour.quote)?;
        let p = flavour.placeholder;
        let sql = format!(
            "UPDATE {table} SET {c_path} = {p1} WHERE {c_id} = {p2}",
            c_path = ident("path", flavour.quote)?,
            c_id = ident("id", flavour.quote)?,
            p1 = p(1),
            p2 = p(2),
        );
        run!(self, &sql, (path, document_id), execute)
    }

    /// Persist a changed document path (access right connection).
    pub async fn save_accessright_path(
        &self,
        config: &Config,
        document_id: i64,
        holder_id: i64,
        path: &str,
    ) -> Result<(), String> {
        let flavour = self.flavour();
        let table = ident(&config.accessright_table, flavour.quote)?;
        let p = flavour.placeholder;
        let sql = format!(
            "UPDATE {table} SET {c_path} = {p1} WHERE {c_doc} = {p2} \
             AND {c_holder_type} = {p3} AND {c_holder} = {p4}",
            c_path = ident("path", flavour.quote)?,
            c_doc = ident("document_id", flavour.quote)?,
            c_holder_type = ident("holder_type_id", flavour.quote)?,
            c_holder = ident("holder_id", flavour.quote)?,
            p1 = p(1),
            p2 = p(2),
            p3 = p(3),
            p4 = p(4),
        );
        run!(
            self,
            &sql,
            (
                path,
                document_id,
                config.user_content_type_id,
                holder_id,
            ),
            execute
        )
    }

    /// Load the document row, if the document exists.
    pub async fn load_document(
        &self,
        config: &Config,
        document_id: i64,
    ) -> Result<Option<DocumentRow>, String> {
        let flavour = self.flavour();
        let table = ident(&config.document_table, flavour.quote)?;
        let p = flavour.placeholder;
        let doc_version = match self {
            Database::Postgres(_) => {
                format!("{}::text", ident("doc_version", flavour.quote)?)
            }
            Database::Sqlite(_) => {
                format!("CAST({} AS TEXT)", ident("doc_version", flavour.quote)?)
            }
            Database::MySql(_) => {
                format!("CAST({} AS CHAR)", ident("doc_version", flavour.quote)?)
            }
        };
        let sql = format!(
            "SELECT {c_id}, {c_owner}, {c_template}, {c_version}, {c_content}, {c_diffs}, \
             {c_comments}, {c_bib}, {c_title}, {c_path}, {c_e2ee}, {doc_version} AS doc_version \
             FROM {table} WHERE {c_id} = {p1}",
            c_id = ident("id", flavour.quote)?,
            c_owner = ident("owner_id", flavour.quote)?,
            c_template = ident("template_id", flavour.quote)?,
            c_version = ident("version", flavour.quote)?,
            c_content = ident("content", flavour.quote)?,
            c_diffs = ident("diffs", flavour.quote)?,
            c_comments = ident("comments", flavour.quote)?,
            c_bib = ident("bibliography", flavour.quote)?,
            c_title = ident("title", flavour.quote)?,
            c_path = ident("path", flavour.quote)?,
            c_e2ee = ident("e2ee", flavour.quote)?,
            p1 = p(1),
        );
        run!(self, &sql, (document_id,), fetch_optional |row| {
            let json = |name: &str| -> Result<Value, String> {
                row.try_get::<Json<Value>, _>(name)
                    .map(|json| json.0)
                    .map_err(|err| err.to_string())
            };
            Ok(DocumentRow {
                owner_id: row.try_get("owner_id").map_err(|err| err.to_string())?,
                template_id: row.try_get("template_id").map_err(|err| err.to_string())?,
                version: row.try_get("version").map_err(|err| err.to_string())?,
                content: json("content")?,
                diffs: json("diffs")?,
                comments: json("comments")?,
                bibliography: json("bibliography")?,
                title: row.try_get("title").map_err(|err| err.to_string())?,
                path: row.try_get("path").map_err(|err| err.to_string())?,
                e2ee: row.try_get("e2ee").map_err(|err| err.to_string())?,
                doc_version: row
                    .try_get("doc_version")
                    .map_err(|err| err.to_string())?,
            })
        })
    }

    /// The access right of one user on one document, with the path.
    pub async fn right_for(
        &self,
        config: &Config,
        document_id: i64,
        user_id: i64,
    ) -> Result<Option<(String, String)>, String> {
        let flavour = self.flavour();
        let table = ident(&config.accessright_table, flavour.quote)?;
        let p = flavour.placeholder;
        let sql = format!(
            "SELECT {c_rights}, {c_path} FROM {table} WHERE {c_doc} = {p1} \
             AND {c_holder_type} = {p2} AND {c_holder} = {p3}",
            c_rights = ident("rights", flavour.quote)?,
            c_path = ident("path", flavour.quote)?,
            c_doc = ident("document_id", flavour.quote)?,
            c_holder_type = ident("holder_type_id", flavour.quote)?,
            c_holder = ident("holder_id", flavour.quote)?,
            p1 = p(1),
            p2 = p(2),
            p3 = p(3),
        );
        run!(
            self,
            &sql,
            (document_id, config.user_content_type_id, user_id),
            fetch_optional |row| {
                let rights: String = row.try_get("rights").map_err(|err| err.to_string())?;
                let path: String = row.try_get("path").map_err(|err| err.to_string())?;
                Ok((rights, path))
            }
        )
    }

    /// All access rights of a document, in one query (the rights re-read).
    pub async fn access_rights(
        &self,
        config: &Config,
        document_id: i64,
    ) -> Result<Vec<(i64, i64, String)>, String> {
        let flavour = self.flavour();
        let table = ident(&config.accessright_table, flavour.quote)?;
        let p = flavour.placeholder;
        let sql = format!(
            "SELECT {c_holder_type}, {c_holder}, {c_rights} FROM {table} WHERE {c_doc} = {p1}",
            c_holder_type = ident("holder_type_id", flavour.quote)?,
            c_holder = ident("holder_id", flavour.quote)?,
            c_rights = ident("rights", flavour.quote)?,
            c_doc = ident("document_id", flavour.quote)?,
            p1 = p(1),
        );
        run!(self, &sql, (document_id,), fetch_all |row| {
            let holder_type: i64 =
                row.try_get("holder_type_id").map_err(|err| err.to_string())?;
            let holder: i64 = row.try_get("holder_id").map_err(|err| err.to_string())?;
            let rights: String = row.try_get("rights").map_err(|err| err.to_string())?;
            Ok((holder_type, holder, rights))
        })
    }

    /// The session data of a live session (the expiry is checked in SQL).
    pub async fn session_data(
        &self,
        config: &Config,
        session_key: &str,
    ) -> Result<Option<String>, String> {
        let flavour = self.flavour();
        let table = ident(&config.session_table, flavour.quote)?;
        let p = flavour.placeholder;
        let sql = format!(
            "SELECT {c_data} FROM {table} WHERE {c_key} = {p1} AND {c_expire} > {now}",
            c_data = ident("session_data", flavour.quote)?,
            c_key = ident("session_key", flavour.quote)?,
            c_expire = ident("expire_date", flavour.quote)?,
            p1 = p(1),
            now = flavour.now,
        );
        run!(self, &sql, (session_key,), fetch_optional |row| {
            row.try_get("session_data").map_err(|err| err.to_string())
        })
    }

    /// The display name of a user (`readable_name` on the user model).
    pub async fn user_display_name(
        &self,
        config: &Config,
        user_id: i64,
    ) -> Result<Option<String>, String> {
        let flavour = self.flavour();
        let table = ident(&config.user_table, flavour.quote)?;
        let p = flavour.placeholder;
        let sql = format!(
            "SELECT {c_first}, {c_last}, {c_name} FROM {table} WHERE {c_id} = {p1}",
            c_first = ident("first_name", flavour.quote)?,
            c_last = ident("last_name", flavour.quote)?,
            c_name = ident("username", flavour.quote)?,
            c_id = ident("id", flavour.quote)?,
            p1 = p(1),
        );
        Ok(
            run!(self, &sql, (user_id,), fetch_optional |row| {
                // User.readable_name: the full name, or the username.
                let full = format!(
                    "{} {}",
                    row.try_get::<String, _>("first_name").unwrap_or_default(),
                    row.try_get::<String, _>("last_name").unwrap_or_default()
                );
                let full = full.trim().to_string();
                Ok::<String, String>(if full.is_empty() {
                    row.try_get::<String, _>("username").unwrap_or_default()
                } else {
                    full
                })
            })?,
        )
    }

    /// The active, unexpired share tokens of a document.
    pub async fn share_tokens(
        &self,
        config: &Config,
        document_id: i64,
    ) -> Result<Vec<(String, String)>, String> {
        let flavour = self.flavour();
        let table = ident(&config.sharetoken_table, flavour.quote)?;
        let p = flavour.placeholder;
        let token = if matches!(self, Database::Postgres(_)) {
            format!("{}::text AS token", ident("token", flavour.quote)?)
        } else {
            format!("{} AS token", ident("token", flavour.quote)?)
        };
        let sql = format!(
            "SELECT {token}, {c_rights} FROM {table} WHERE {c_doc} = {p1} \
             AND {c_active} AND ({c_expires} IS NULL OR {c_expires} > {now})",
            c_rights = ident("rights", flavour.quote)?,
            c_doc = ident("document_id", flavour.quote)?,
            c_active = ident("is_active", flavour.quote)?,
            c_expires = ident("expires_at", flavour.quote)?,
            p1 = p(1),
            now = flavour.now,
        );
        run!(self, &sql, (document_id,), fetch_all |row| {
            let token: String = row.try_get("token").map_err(|err| err.to_string())?;
            let rights: String = row.try_get("rights").map_err(|err| err.to_string())?;
            Ok((token, rights))
        })
    }

    /// The content of a document template (for the initialization of a fresh
    /// document), if the template exists.
    pub async fn template_content(
        &self,
        config: &Config,
        template_id: i64,
    ) -> Result<Option<Value>, String> {
        let flavour = self.flavour();
        let table = ident(&config.documenttemplate_table, flavour.quote)?;
        let p = flavour.placeholder;
        let sql = format!(
            "SELECT {c_content} FROM {table} WHERE {c_id} = {p1}",
            c_content = ident("content", flavour.quote)?,
            c_id = ident("id", flavour.quote)?,
            p1 = p(1),
        );
        run!(self, &sql, (template_id,), fetch_optional |row| {
            row.try_get::<Json<Value>, _>("content")
                .map(|json| json.0)
                .map_err(|err| err.to_string())
        })
    }
}
