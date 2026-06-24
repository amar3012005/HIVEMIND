//! T2-PROBE — the fork between "vector store" and "first single-file memory engine".
//!
//! Builds a typed memory graph + a bi-temporal version chain, FLUSHES, REOPENS the mmap, then
//! answers two queries Postgres would normally serve — entirely from the single `.amr` map: a
//! typed 2-hop traversal (follow only `Mentions`, not other edge types), and a "what did we know
//! on date X" bi-temporal point-in-time over an `Updates` version chain. Each is checked against
//! the reference answer computed in-test. PASS here = the format holds the whole memory, not just
//! embeddings.

use mseg::{MemoryInput, Segment};
use mseg_format::{EDGE_DERIVES, EDGE_MENTIONS, EDGE_UPDATES};
use tempfile::tempdir;

fn mem(text: &str, x: f32, created_at: i64) -> MemoryInput {
    let mut m = MemoryInput::new(text.to_string(), vec![x, 1.0, 0.0, 0.0]);
    m.created_at = Some(created_at);
    m
}

#[test]
fn typed_traversal_and_bitemporal_from_one_mmap() {
    let dir = tempdir().unwrap();

    // --- build the graph + version chain, then flush ---
    let (a, b, c, d, v1, v2, v3);
    {
        let mut seg = Segment::create(dir.path(), "g", 4).unwrap();
        // entity graph: A --Mentions--> B --Mentions--> C ; A --Derives--> D
        a = seg.insert(mem("A", 1.0, 100)).unwrap();
        b = seg.insert(mem("B", 2.0, 100)).unwrap();
        c = seg.insert(mem("C", 3.0, 100)).unwrap();
        d = seg.insert(mem("D", 4.0, 100)).unwrap();
        seg.set_edge(a, 0, b, EDGE_MENTIONS, 200).unwrap();
        seg.set_edge(b, 0, c, EDGE_MENTIONS, 200).unwrap();
        seg.set_edge(a, 1, d, EDGE_DERIVES, 200).unwrap();

        // version chain of one fact: v1@100 -> v2@200 -> v3@300, each Updates the prior.
        v1 = seg.insert(mem("price=10", 9.0, 100)).unwrap();
        v2 = seg.insert(mem("price=20", 9.0, 200)).unwrap();
        v3 = seg.insert(mem("price=30", 9.0, 300)).unwrap();
        seg.set_edge(v2, 0, v1, EDGE_UPDATES, 0).unwrap();
        seg.set_edge(v3, 0, v2, EDGE_UPDATES, 0).unwrap();
        seg.flush().unwrap();
    }

    // --- REOPEN: everything below is served from the persistent mmap, no in-memory state ---
    let mut seg = Segment::open(dir.path(), "g").unwrap();

    // 1) typed 2-hop following ONLY Mentions: A -> {B, C}. D (Derives) must NOT appear.
    let reached = seg.traverse_typed(&[a], EDGE_MENTIONS, 2).unwrap();
    let set: std::collections::HashSet<u32> = reached.iter().copied().collect();
    assert!(
        set.contains(&b) && set.contains(&c),
        "2-hop Mentions must reach B and C: {reached:?}"
    );
    assert!(
        !set.contains(&d),
        "Derives edge must NOT be followed by a Mentions traversal"
    );

    // typed 1-hop: only B.
    let one = seg.traverse_typed(&[a], EDGE_MENTIONS, 1).unwrap();
    assert_eq!(one, vec![b], "1-hop Mentions = [B]");

    // a Derives traversal from A reaches only D.
    let der = seg.traverse_typed(&[a], EDGE_DERIVES, 2).unwrap();
    assert_eq!(der, vec![d], "Derives traversal = [D]");

    // 2) bi-temporal "what did we know on date X" over the Updates chain (head = v3).
    assert_eq!(seg.as_of(v3, 50).unwrap(), None, "nothing known at t=50");
    assert_eq!(
        seg.as_of(v3, 150).unwrap(),
        Some(v1),
        "at t=150 the current version is v1 (price=10)"
    );
    assert_eq!(
        seg.as_of(v3, 250).unwrap(),
        Some(v2),
        "at t=250 -> v2 (price=20)"
    );
    assert_eq!(
        seg.as_of(v3, 350).unwrap(),
        Some(v3),
        "at t=350 -> v3 (price=30)"
    );

    // and the as-of result's TEXT is correct (served from the same map).
    assert_eq!(
        seg.get(seg.as_of(v3, 250).unwrap().unwrap()).unwrap().text,
        "price=20"
    );
}
