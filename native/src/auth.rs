//! Resolving the user from the session cookie.
//!
//! The Django Channels stack resolves the websocket user through
//! `SessionMiddleware` + `AuthMiddleware`: the `sessionid` cookie names a row
//! in `django_session`, whose `session_data` is a `signing.dumps` payload:
//!
//! ```text
//! urlsafe_b64(json | zlib(json)) : base62_timestamp : urlsafe_b64(hmac_sha256)
//! ```
//!
//! signed with `salt = "django.contrib.sessions.SessionStore" + "signer"` and
//! `key = SHA256(salt + SECRET_KEY)` (Django's `salted_hmac`, the fallback
//! keys included). The native route replicates exactly that, including the
//! signature verification, without ever entering Python.

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// The salt the session signer uses (`SessionBase.key_salt`).
const SESSION_SALT: &str = "django.contrib.sessions.SessionStore";

type HmacSha256 = Hmac<Sha256>;

/// Extract the value of the session cookie from a `Cookie` header value.
pub fn session_key_from_cookie(cookie_header: &str, cookie_name: &str) -> Option<String> {
    cookie_header.split(';').find_map(|part| {
        let (name, value) = part.trim().split_once('=')?;
        if name == cookie_name {
            Some(value.to_string())
        } else {
            None
        }
    })
}

/// The user id stored in a Django session (`_auth_user_id`), if the payload
/// is authentic.
///
/// * `data` is `django_session.session_data`;
/// * `secret_keys` is `SECRET_KEY` followed by `SECRET_KEY_FALLBACKS`.
pub fn user_id_from_session_data(data: &str, secret_keys: &[String]) -> Option<i64> {
    if secret_keys.is_empty() {
        return None;
    }
    // value = "base64d:timestamp", signature = the last field.
    let (value, signature) = data.rsplit_once(':')?;
    if !signature_is_valid(value, signature, secret_keys) {
        log::debug!("The session signature does not verify.");
        return None;
    }
    // The value itself is "base64d:timestamp"; only the base64d is decoded.
    let (base64d, _timestamp) = value.split_once(':').unwrap_or((value, ""));
    let payload = decode_payload(base64d)?;
    session_user_id(&payload)
}

/// Whether the HMAC-SHA256 signature of `value` matches, for any of the keys.
fn signature_is_valid(value: &str, signature: &str, secret_keys: &[String]) -> bool {
    let Ok(provided) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    secret_keys.iter().any(|secret| {
        // Django's salted_hmac: key = SHA256(key_salt + secret).
        let salted = format!("{SESSION_SALT}signer{secret}");
        let key = <Sha256 as sha2::Digest>::digest(salted.as_bytes());
        let Ok(mut mac) = HmacSha256::new_from_slice(&key) else {
            return false;
        };
        mac.update(value.as_bytes());
        mac.finalize().into_bytes().as_slice() == provided.as_slice()
    })
}

/// The payload of the signed value: URL-safe base64, zlib compressed when it
/// starts with a dot (`Signer.sign_object`).
fn decode_payload(value: &str) -> Option<Vec<u8>> {
    let (compressed, encoded) = match value.strip_prefix('.') {
        Some(rest) => (true, rest),
        None => (false, value),
    };
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()?;
    if compressed {
        miniz_oxide::inflate::decompress_to_vec_zlib(&bytes).ok()
    } else {
        Some(bytes)
    }
}

/// The `_auth_user_id` from the serialized session dictionary, whether it was
/// stored with the JSON serializer (the default) or the pickle serializer.
fn session_user_id(payload: &[u8]) -> Option<i64> {
    let value: Option<serde_json::Value> = serde_json::from_slice(payload).ok();
    if let Some(user_id) = value
        .as_ref()
        .and_then(|value| value.get("_auth_user_id"))
    {
        return match user_id {
            serde_json::Value::String(id) => id.parse().ok(),
            serde_json::Value::Number(id) => id.as_i64(),
            _ => None,
        };
    }
    let value: serde_json::Value = serde_pickle::from_slice(
        payload,
        serde_pickle::DeOptions::new().decode_strings(),
    )
    .ok()?;
    value
        .get("_auth_user_id")
        .and_then(|user_id| user_id.as_str())
        .and_then(|user_id| user_id.parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "django-insecure-test-secret-key";

    fn signed_session(data: &[u8], compress: bool) -> String {
        // The exact algorithm of django.core.signing.dumps.
        let compressed = compress && {
            let c = miniz_oxide::deflate::compress_to_vec_zlib(data, 6);
            c.len() < data.len()
        };
        let payload = if compressed {
            miniz_oxide::deflate::compress_to_vec_zlib(data, 6)
        } else {
            data.to_vec()
        };
        let base64d = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&payload);
        // The compression flag is a prefix of the base64 text itself.
        let base64d = if compressed {
            format!(".{base64d}")
        } else {
            base64d
        };
        let timestamp = "1mjB3J";
        let value = format!("{base64d}:{timestamp}");
        let salted = format!("{SESSION_SALT}signer{SECRET}");
        let key = <Sha256 as sha2::Digest>::digest(salted.as_bytes());
        let mut mac = HmacSha256::new_from_slice(&key).unwrap();
        mac.update(value.as_bytes());
        let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{value}:{sig}")
    }

    #[test]
    fn a_signed_json_session_resolves_to_the_user() {
        let data = signed_session(br#"{"_auth_user_id":"42"}"#, false);
        assert_eq!(user_id_from_session_data(&data, &[SECRET.to_string()]), Some(42));
    }

    #[test]
    fn a_signed_compressed_json_session_resolves_to_the_user() {
        let data = signed_session(
            br#"{"_auth_user_id":"42","_auth_user_backend":"django.contrib.auth.backends.ModelBackend"}"#,
            true,
        );
        assert_eq!(user_id_from_session_data(&data, &[SECRET.to_string()]), Some(42));
    }

    #[test]
    fn a_signed_pickle_session_resolves_to_the_user() {
        // pickle.dumps({"_auth_user_id": "7"}, 2), from CPython.
        let pickle = base64::engine::general_purpose::STANDARD
            .decode("gAJ9cQBYDQAAAF9hdXRoX3VzZXJfaWRxAVgBAAAAN3ECcy4=")
            .unwrap();
        let data = signed_session(&pickle, false);
        assert_eq!(user_id_from_session_data(&data, &[SECRET.to_string()]), Some(7));
    }

    #[test]
    fn a_wrong_signature_is_rejected() {
        let data = signed_session(br#"{"_auth_user_id":"42"}"#, false);
        let tampered = data.replacen('4', "5", 1);
        assert_eq!(user_id_from_session_data(&tampered, &[SECRET.to_string()]), None);
        assert_eq!(user_id_from_session_data(&data, &["another-secret".to_string()]), None);
    }

    #[test]
    fn a_fallback_key_is_accepted() {
        let data = signed_session(br#"{"_auth_user_id":"9"}"#, false);
        assert_eq!(
            user_id_from_session_data(&data, &["new-secret".to_string(), SECRET.to_string()]),
            Some(9)
        );
    }

    #[test]
    fn the_session_cookie_is_extracted() {
        assert_eq!(
            session_key_from_cookie("sessionid=abc123; other=1", "sessionid"),
            Some("abc123".to_string())
        );
        assert_eq!(session_key_from_cookie("other=1", "sessionid"), None);
        assert_eq!(
            session_key_from_cookie("a=1; sessionid=xyz; b=2", "sessionid"),
            Some("xyz".to_string())
        );
    }
}
