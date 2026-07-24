//! HTTP server for ILO cognitive memory runtime.
//!
//! This module is split into:
//! - `types.rs` — request/response structs for all endpoints
//! - `helpers.rs` — entity resolution, mutation builders
//! - `handlers.rs` — all 10 endpoint handler functions
//! - `router.rs` — route definitions, server startup, graceful shutdown

mod types;
mod helpers;
mod handlers;
mod crud;
mod router;

// Public API — used by main.rs
pub use router::run_server;

use tokio::sync::RwLock;

/// Shared application state injected into every handler via Axum's Extension.
pub struct AppState {
    pub store: RwLock<mem_arch::ladybug::LadybugStore>,
    pub search_index: RwLock<mem_arch::search::SearchIndex>,
}
