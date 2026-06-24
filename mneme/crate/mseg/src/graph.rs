//! Memory-engine layer: typed-edge traversal + bi-temporal "as of date X" version queries —
//! all served from the single mmap'd slot region (no join, no second store). This is the
//! capability that separates a memory *engine* from a vector *store*: relationships and version
//! history live in the byte layout next to the embedding, reachable by pointer-following within
//! one memory map.

use std::collections::{HashSet, VecDeque};

use mseg_format::{Result, EDGE_NONE, EDGE_SLOTS, EDGE_UPDATES, SENTINEL_U32};

use crate::Segment;

impl Segment {
    /// Write typed edge slot `i` (0..EDGE_SLOTS) on `slot_id`: `target` + `edge_type` + `weight`.
    pub fn set_edge(
        &mut self,
        slot_id: u32,
        i: usize,
        target: u32,
        edge_type: u8,
        weight: u8,
    ) -> Result<()> {
        let mut s = self.slot(slot_id as usize)?;
        s.set_edge(i, target, edge_type, weight);
        self.write_slot(slot_id as usize, &s)
    }

    /// Read `slot_id`'s typed edges as `(target, type, weight)`, skipping empty slots.
    pub fn edges(&self, slot_id: u32) -> Result<Vec<(u32, u8, u8)>> {
        let s = self.slot(slot_id as usize)?;
        let mut out = Vec::new();
        for i in 0..EDGE_SLOTS {
            let (t, ty, w) = s.edge(i);
            if t != SENTINEL_U32 && ty != EDGE_NONE {
                out.push((t, ty, w));
            }
        }
        Ok(out)
    }

    /// Typed graph traversal: from `seeds`, follow ONLY edges of `edge_type`, up to `max_hops`
    /// levels. Returns reachable LIVE slot ids (excluding seeds) in BFS order. One mmap, no join.
    pub fn traverse_typed(&self, seeds: &[u32], edge_type: u8, max_hops: u8) -> Result<Vec<u32>> {
        let mut seen: HashSet<u32> = seeds.iter().copied().collect();
        let mut q: VecDeque<(u32, u8)> = seeds.iter().map(|&s| (s, 0)).collect();
        let mut out = Vec::new();
        while let Some((node, depth)) = q.pop_front() {
            if depth >= max_hops {
                continue;
            }
            let s = match self.slot(node as usize) {
                Ok(s) => s,
                Err(_) => continue,
            };
            for i in 0..EDGE_SLOTS {
                let (t, ty, _w) = s.edge(i);
                if t == SENTINEL_U32 || ty != edge_type {
                    continue;
                }
                if seen.insert(t) {
                    if let Ok(ts) = self.slot(t as usize) {
                        if !ts.is_tombstoned() {
                            out.push(t);
                            q.push_back((t, depth + 1));
                        }
                    }
                }
            }
        }
        Ok(out)
    }

    /// Bi-temporal point-in-time. Given the head (newest) of a version chain linked by
    /// `EDGE_UPDATES` (v_new --Updates--> v_old), return the slot that was CURRENT as of
    /// transaction time `txn_time` — the newest version whose `created_at <= txn_time`. Returns
    /// `None` if the fact was not yet known at `txn_time`. Answers "what did we know on date X".
    pub fn as_of(&self, head_slot: u32, txn_time: i64) -> Result<Option<u32>> {
        let mut cur = head_slot;
        let mut guard = 0usize;
        loop {
            let s = self.slot(cur as usize)?;
            if s.created_at() <= txn_time {
                return Ok(Some(cur));
            }
            let mut prev = None;
            for i in 0..EDGE_SLOTS {
                let (t, ty, _w) = s.edge(i);
                if ty == EDGE_UPDATES && t != SENTINEL_U32 {
                    prev = Some(t);
                    break;
                }
            }
            match prev {
                Some(p) => cur = p,
                None => return Ok(None),
            }
            guard += 1;
            if guard > 10_000 {
                return Ok(None);
            }
        }
    }
}
