//! The state of a single websockets connection.
//!
//! This mirrors the message bookkeeping of the Python consumer
//! (`base/base_consumer.py`): every connection keeps a server side and a
//! client side message counter, plus a ring buffer with the last ten
//! messages sent, so that lost messages can be resent.

use std::collections::VecDeque;

use serde_json::{Value, json};

/// The number of messages kept for the resend.
const RING_BUFFER_SIZE: usize = 10;

/// The per connection message bookkeeping.
#[derive(Debug, Default)]
pub struct ConnState {
    /// The counter of the messages sent by the server.
    pub server: u64,
    /// The counter of the messages received from the client.
    pub client: u64,
    /// The last messages sent, used to resend them on demand.
    pub last_ten: VecDeque<Value>,
}

impl ConnState {
    /// Prepare a message for sending: bump the server counter, stamp the
    /// counters on the message and push it to the ring buffer.
    ///
    /// Returns the serialized message.
    pub fn prepare(&mut self, message: &Value) -> String {
        self.server += 1;
        let mut message = message.clone();
        if let Some(map) = message.as_object_mut() {
            map.insert("c".to_string(), json!(self.client));
            map.insert("s".to_string(), json!(self.server));
        }
        self.last_ten.push_back(message.clone());
        while self.last_ten.len() > RING_BUFFER_SIZE {
            self.last_ten.pop_front();
        }
        serde_json::to_string(&message).unwrap_or_default()
    }
}

/// The outcome of a resend request.
#[derive(Debug, PartialEq, Eq)]
pub enum Resend {
    /// The messages have been resent.
    Done,
    /// Too many messages were missing: the client is too far behind.
    Unfixable,
}

/// Compute the messages to resend, given the last message the client saw.
///
/// This mirrors `BaseWebsocketConsumer.resend_messages`: the server counter
/// is rewound by the number of missing messages, and the messages are then
/// sent again (which bumps the counter back).
pub fn resend(state: &mut ConnState, from_no: u64) -> (Resend, Vec<Value>) {
    let to_send = state.server.saturating_sub(from_no);
    state.server -= to_send;
    if to_send > state.last_ten.len() as u64 {
        return (Resend::Unfixable, Vec::new());
    }
    let skip = state.last_ten.len() - to_send as usize;
    let messages = state.last_ten.iter().skip(skip).cloned().collect();
    (Resend::Done, messages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_are_stamped_on_the_message() {
        let mut state = ConnState::default();
        let text = state.prepare(&json!({"type": "welcome"}));
        assert_eq!(text, r#"{"type":"welcome","c":0,"s":1}"#);
        let text = state.prepare(&json!({"type": "subscribed"}));
        assert_eq!(text, r#"{"type":"subscribed","c":0,"s":2}"#);
    }

    #[test]
    fn the_ring_buffer_holds_ten_messages() {
        let mut state = ConnState::default();
        for i in 0..15 {
            state.prepare(&json!({"type": "ping", "i": i}));
        }
        assert_eq!(state.last_ten.len(), RING_BUFFER_SIZE);
        assert_eq!(state.last_ten[0]["i"], json!(5));
    }

    #[test]
    fn resend_rewinds_the_server_counter() {
        let mut state = ConnState::default();
        for i in 0..3 {
            state.prepare(&json!({"type": "ping", "i": i}));
        }
        let (outcome, messages) = resend(&mut state, 1);
        assert_eq!(outcome, Resend::Done);
        assert_eq!(messages.len(), 2);
        assert_eq!(state.server, 1);
    }

    #[test]
    fn resend_of_too_many_messages_is_unfixable() {
        let mut state = ConnState::default();
        // More messages than the ring buffer holds: they cannot be resent.
        for i in 0..15 {
            state.prepare(&json!({"type": "ping", "i": i}));
        }
        let (outcome, _) = resend(&mut state, 0);
        assert_eq!(outcome, Resend::Unfixable);
    }

    #[test]
    fn resend_within_the_ring_buffer_is_possible() {
        let mut state = ConnState::default();
        for i in 0..3 {
            state.prepare(&json!({"type": "ping", "i": i}));
        }
        let (outcome, messages) = resend(&mut state, 0);
        assert_eq!(outcome, Resend::Done);
        assert_eq!(messages.len(), 3);
    }
}
