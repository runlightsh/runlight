//! Settings written once when requests race: a signing key made on first use is the same for every
//! request that asks at once, and a count moves only from the value read, on every database at hand.

#![cfg(all(feature = "sqlite", feature = "postgres", feature = "mysql"))]

mod common;

#[tokio::test(flavor = "multi_thread")]
async fn a_setting_is_added_once_and_swapped_only_from_the_value_read() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let store = fresh.store.clone();
        store.migrate().await.unwrap();
        assert!(store.add_setting("a", "1").await.unwrap(), "{kind}");
        assert!(!store.add_setting("a", "2").await.unwrap(), "{kind}: a second add finds it there");
        assert_eq!(store.setting("a").await.unwrap().as_deref(), Some("1"), "{kind}");
        assert!(!store.swap_setting("a", "9", "3").await.unwrap(), "{kind}: not the value read");
        assert!(store.swap_setting("a", "1", "2").await.unwrap(), "{kind}");
        assert!(!store.swap_setting("a", "1", "2").await.unwrap(), "{kind}: and only once");
        assert!(!store.swap_setting("missing", "1", "2").await.unwrap(), "{kind}");
        assert_eq!(store.setting("a").await.unwrap().as_deref(), Some("2"), "{kind}");

        let runs: Vec<_> = (0..12)
            .map(|_| {
                let store = store.clone();
                tokio::spawn(
                    async move { store.setting_or_add("key", || runlight::hash::random_id(32)).await.unwrap() },
                )
            })
            .collect();
        let mut keys = Vec::new();
        for run in runs {
            keys.push(run.await.unwrap());
        }
        keys.dedup();
        assert_eq!(keys.len(), 1, "{kind}: every racer gets the key written first");
        assert_eq!(store.setting("key").await.unwrap().as_deref(), Some(keys[0].as_str()), "{kind}");

        let counts: Vec<_> = (0..8)
            .map(|_| {
                let store = store.clone();
                tokio::spawn(async move {
                    loop {
                        let seen = store.setting("count").await.unwrap();
                        let done = match seen {
                            None => store.add_setting("count", "1").await.unwrap(),
                            Some(n) => {
                                let next = (n.parse::<i64>().unwrap() + 1).to_string();
                                store.swap_setting("count", &n, &next).await.unwrap()
                            }
                        };
                        if done {
                            return;
                        }
                    }
                })
            })
            .collect();
        for run in counts {
            run.await.unwrap();
        }
        assert_eq!(store.setting("count").await.unwrap().as_deref(), Some("8"), "{kind}: none lost");
        fresh.done().await;
    }
}
