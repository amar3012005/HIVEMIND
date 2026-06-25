//! mneme Node.js binding (napi-rs). Exposes the `.amr` engine as a drop-in vector store so
//! HIVEMIND's `indexer.js` can call it in place of Qdrant. Methods are synchronous over a
//! per-org shard held in the JS object; the JS wrapper (MnemeVectorStore) adapts them to the
//! async `upsert`/`search` interface HIVEMIND expects.

use mseg::{Filter, MemoryInput, Shard};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::path::PathBuf;

/// One recall hit returned to JS.
#[napi(object)]
pub struct MnemeHit {
    pub slot_id: u32,
    pub score: f64,
    pub text: String,
}

/// A per-org mneme store (wraps one `.amr` shard).
#[napi]
pub struct MnemeStore {
    shard: Shard,
    dim: usize,
}

#[napi]
impl MnemeStore {
    /// Open (or create) the shard for `org_id` under `data_root` with embedding dimension `dim`.
    #[napi(factory)]
    pub fn open(data_root: String, org_id: String, dim: u32) -> Result<Self> {
        let shard = Shard::open(&PathBuf::from(data_root), &org_id, dim as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(MnemeStore {
            shard,
            dim: dim as usize,
        })
    }

    /// Insert a memory (text + embedding). `valid_from` is nanoseconds (0 = unspecified).
    /// Returns the stable slot id.
    #[napi]
    pub fn insert(&mut self, text: String, vector: Float32Array, valid_from: i64) -> Result<u32> {
        let v: Vec<f32> = vector.to_vec();
        if v.len() != self.dim {
            return Err(Error::from_reason(format!(
                "vector dim {} != store dim {}",
                v.len(),
                self.dim
            )));
        }
        let mut m = MemoryInput::new(text, v);
        m.valid_from = valid_from;
        self.shard
            .segment()
            .insert(m)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Insert tagged with a layer (0=memory, 1=evidence, 2=cognitive). Lets one shard hold all 3
    /// HIVEMIND layers, separated, for layer-filtered recall.
    #[napi]
    pub fn insert_layered(
        &mut self,
        text: String,
        vector: Float32Array,
        valid_from: i64,
        layer: u8,
    ) -> Result<u32> {
        let v: Vec<f32> = vector.to_vec();
        if v.len() != self.dim {
            return Err(Error::from_reason(format!(
                "vector dim {} != store dim {}",
                v.len(),
                self.dim
            )));
        }
        let mut m = MemoryInput::new(text, v);
        m.valid_from = valid_from;
        m.layer = layer;
        self.shard
            .segment()
            .insert(m)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Build the HNSW overlay over all current vectors (call after a bulk load).
    #[napi]
    pub fn enable_hnsw(&mut self) -> Result<()> {
        self.shard
            .segment()
            .enable_hnsw()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Recall the top-`top_k` memories for `query`.
    #[napi]
    pub fn recall(&mut self, query: Float32Array, top_k: u32) -> Result<Vec<MnemeHit>> {
        let q: Vec<f32> = query.to_vec();
        let hits = self
            .shard
            .segment()
            .recall(&q, &Filter::default(), top_k as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.slot_id,
                score: h.score as f64,
                text: h.text,
            })
            .collect())
    }

    /// Layer-filtered recall: `layer` 0=memory, 1=evidence, 2=cognitive; pass -1 for all layers.
    /// This is how the 3 layers are queried separately from one shard (recall=memory,
    /// provenance=evidence, synthesis=cognitive), exactly like a Qdrant `layer` filter.
    #[napi]
    pub fn recall_layer(
        &mut self,
        query: Float32Array,
        top_k: u32,
        layer: i32,
    ) -> Result<Vec<MnemeHit>> {
        let q: Vec<f32> = query.to_vec();
        let filter = Filter {
            layer: if layer < 0 { None } else { Some(layer as u8) },
            ..Default::default()
        };
        let hits = self
            .shard
            .segment()
            .recall(&q, &filter, top_k as usize)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(hits
            .into_iter()
            .map(|h| MnemeHit {
                slot_id: h.slot_id,
                score: h.score as f64,
                text: h.text,
            })
            .collect())
    }

    /// Add a typed edge `slot_id` --(edge_type)--> `target` (unbounded; overflows to `.edg`).
    /// edge_type: 1=Mentions 2=Updates 3=Derives 4=Contradicts 5=PartOf 6=Extends.
    #[napi]
    pub fn add_edge(&mut self, slot_id: u32, target: u32, edge_type: u8, weight: u8) -> Result<()> {
        self.shard
            .segment()
            .add_edge(slot_id, target, edge_type, weight)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Typed graph traversal from `seed`, following ONLY `edge_type`, up to `max_hops`. Returns
    /// reachable slot ids (HIVEMIND `traverse_graph` parity, served from the one shard).
    #[napi]
    pub fn traverse_typed(&mut self, seed: u32, edge_type: u8, max_hops: u8) -> Result<Vec<u32>> {
        self.shard
            .segment()
            .traverse_typed(&[seed], edge_type, max_hops)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Bi-temporal point-in-time: the version of a memory current as of transaction time
    /// `txn_time` (ns), walking the Updates chain from `head_slot`. Returns the slot id, or -1 if
    /// not yet known (HIVEMIND `hivemind_at` / `timeline` parity).
    #[napi]
    pub fn as_of(&mut self, head_slot: u32, txn_time: i64) -> Result<i64> {
        let r = self
            .shard
            .segment()
            .as_of(head_slot, txn_time)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(r.map(|s| s as i64).unwrap_or(-1))
    }

    /// Insert with explicit bi-temporal stamps: `created_at` (transaction time — when learned)
    /// and `valid_from` (valid time — when true), both ns. `created_at` drives `as_of`.
    #[napi]
    pub fn insert_at(
        &mut self,
        text: String,
        vector: Float32Array,
        created_at: i64,
        valid_from: i64,
    ) -> Result<u32> {
        let mut m = MemoryInput::new(text, vector.to_vec());
        m.created_at = Some(created_at);
        m.valid_from = valid_from;
        self.shard
            .segment()
            .insert(m)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Update memory `old_slot` with a new version: inserts, auto-links new--Updates-->old, marks
    /// old superseded. Recall then returns only the latest; `as_of` reaches the history. `created_at`
    /// is the transaction time of the new version (drives `as_of`). Returns the new slot id.
    #[napi]
    pub fn update(
        &mut self,
        old_slot: u32,
        text: String,
        vector: Float32Array,
        created_at: i64,
        valid_from: i64,
    ) -> Result<u32> {
        let mut m = MemoryInput::new(text, vector.to_vec());
        m.created_at = Some(created_at);
        m.valid_from = valid_from;
        self.shard
            .segment()
            .update(old_slot, m)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Delete (tombstone) a memory by slot id.
    #[napi]
    pub fn delete(&mut self, slot_id: u32) -> Result<()> {
        self.shard
            .segment()
            .delete(slot_id)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Number of live memories in the shard.
    #[napi]
    pub fn live_count(&mut self) -> u32 {
        self.shard.segment().live_count()
    }

    /// Compact the text region, reclaiming bytes of deleted memories. Returns bytes reclaimed.
    /// A maintenance op — run when the shard is idle.
    #[napi]
    pub fn compact(&mut self) -> Result<f64> {
        self.shard
            .segment()
            .compact()
            .map(|n| n as f64)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Flush to disk.
    #[napi]
    pub fn flush(&mut self) -> Result<()> {
        self.shard
            .segment()
            .flush()
            .map_err(|e| Error::from_reason(e.to_string()))
    }
}
