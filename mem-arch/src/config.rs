//! Configuration types for retrieval and learning algorithms.
//! All config values have sensible defaults.

/// Configuration for a single retrieval operation.
/// Can be overridden per-request or sourced from a View node.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RetrievalConfig {
    /// PPR damping factor. Validated at 0.85.
    pub damping: f64,

    /// Maximum propagation depth.
    pub max_hops: u8,

    /// Minimum score to include a node in results.
    pub min_score: f64,

    /// Maximum characters in the assembled Anchor context block.
    pub context_budget: usize,

    /// Number of recent conversation turns to include in context.
    pub window_size: usize,

    /// Whether to include evidence paths in the output.
    pub include_paths: bool,

    /// Whether to include recent turns in the output.
    pub include_turns: bool,

    /// Entity subtype filter (empty = all subtypes).
    pub entity_filter: Vec<String>,

    pub purpose: String,
}

impl Default for RetrievalConfig {
    fn default() -> Self {
        RetrievalConfig {
            damping: 0.85,
            max_hops: 4,
            min_score: 0.02,
            context_budget: 8000,
            window_size: 15,
            include_paths: true,
            include_turns: true,
            entity_filter: vec![],
            purpose: String::new(),
        }
    }
}

/// Learning loop configuration.
///
/// Uses counter-based frequency×recency formula.
/// weight = ((useful+1)/(retrieved+2)) × exp(-Δt × ln(2) / half_life_ms)
/// where Δt is wall-clock time in milliseconds since last use.
///
/// Real-world time grounds the agent in episodic reality — a link decays
/// based on how much real time has passed, not how many turns occurred.
/// This means a link from yesterday is half as strong regardless of
/// whether you had 5 turns or 500 turns in between.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LearningConfig {
    /// Half-life of an edge's recency in milliseconds.
    /// After this much real time without use, recency drops by 50%.
    /// Default: 7,776,000,000 ms = 90 days (~1 quarter).
    ///
    /// 90 days maps to the human habit-formation cycle:
    ///   - One-off mentions fade below retrieval threshold within ~6 months
    ///   - Regularly reinforced links (weekly+ use) stay at full frequency forever
    ///   - Last quarter's context is fuzzy but accessible
    ///   - Noise from a year ago is effectively gone
    pub half_life_ms: f64,

    /// How often to check for consolidation (in turns).
    pub consolidation_interval: u32,

    /// Total incident weight before a node is considered a hub.
    pub hub_threshold: f64,
}

impl Default for LearningConfig {
    fn default() -> Self {
        LearningConfig {
            half_life_ms: 7_776_000_000.0,  // 90 days in milliseconds
            consolidation_interval: 50,
            hub_threshold: 5.0,
        }
    }
}
