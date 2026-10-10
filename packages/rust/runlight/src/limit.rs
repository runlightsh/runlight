//! The tracker's rate limit, and turns taken one at a time per key.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use tokio::sync::OwnedMutexGuard;

use crate::hash::{hex, random_bytes};

/// Counts tracker requests per address in fixed one-minute windows, in
/// memory. Addresses are hashed with a key made at start, so the map never
/// holds an IP, and the whole map is dropped at the end of each window.
pub struct RateLimit {
    per_minute: f64,
    key: Vec<u8>,
    state: Mutex<(i64, HashMap<String, u64>)>,
}

impl RateLimit {
    /// A limit of `per_minute` requests per address.
    pub fn new(per_minute: f64) -> RateLimit {
        RateLimit { per_minute, key: random_bytes(16), state: Mutex::new((0, HashMap::new())) }
    }

    /// True while this address is under its limit for the current minute.
    pub fn allow(&self, ip: &str, now: i64) -> bool {
        // No address (a bare adapter with no context) cannot be told apart, so it is not limited.
        if ip.is_empty() {
            return true;
        }
        let window = now.div_euclid(60_000);
        let id = self.hash(ip);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if window != state.0 {
            state.0 = window;
            state.1.clear();
        }
        let count = state.1.entry(id).or_insert(0);
        *count += 1;
        (*count as f64) <= self.per_minute
    }

    fn hash(&self, ip: &str) -> String {
        let mut h = Sha256::new();
        h.update(&self.key);
        h.update(ip.as_bytes());
        hex(&h.finalize()[..8])
    }
}

/// One turn at a time per key, in this process. A key is kept only while someone holds or waits for its
/// turn, so the map never outlives the work (a visitor's hash past its day, say).
#[derive(Default)]
pub(crate) struct Turns(Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>);

/// A turn, held or waited for. Dropped, however the work ends (a cancelled request too), it ends the turn
/// and forgets the key when nobody else wants it.
pub(crate) struct Turn<'a> {
    turns: &'a Turns,
    key: String,
    lock: Arc<tokio::sync::Mutex<()>>,
    held: Option<OwnedMutexGuard<()>>,
}

impl Turns {
    /// Waits for the key's turn.
    pub(crate) async fn take(&self, key: &str) -> Turn<'_> {
        let lock = self.0.lock().unwrap_or_else(|e| e.into_inner()).entry(key.to_string()).or_default().clone();
        // Made before the wait, so a wait given up on still forgets the key.
        let mut turn = Turn { turns: self, key: key.to_string(), lock, held: None };
        turn.held = Some(turn.lock.clone().lock_owned().await);
        turn
    }

    /// How many keys are kept, for tests.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        self.held = None;
        let mut map = self.turns.0.lock().unwrap_or_else(|e| e.into_inner());
        // Nobody else holding or waiting: the map and this hold the only two.
        if map.get(&self.key).is_some_and(|l| Arc::ptr_eq(l, &self.lock) && Arc::strong_count(l) == 2) {
            map.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_key_is_forgotten_however_its_turn_ends() {
        let turns = Turns::default();
        drop(turns.take("a").await);
        assert_eq!(turns.len(), 0);
        let held = turns.take("a").await;
        // Given up on while waiting, and while holding the turn, as a cancelled request is.
        let waiting = tokio::time::timeout(std::time::Duration::from_millis(50), turns.take("a")).await;
        assert!(waiting.is_err());
        assert_eq!(turns.len(), 1);
        let holding = tokio::time::timeout(std::time::Duration::from_millis(50), async {
            drop(held);
            let _turn = turns.take("a").await;
            std::future::pending::<()>().await;
        })
        .await;
        assert!(holding.is_err());
        assert_eq!(turns.len(), 0);
    }
}
