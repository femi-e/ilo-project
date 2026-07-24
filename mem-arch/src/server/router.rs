//! Server setup: route registration, socket binding, graceful shutdown.

use axum::{Router, routing::{get, post}, Extension};
use std::sync::Arc;
use std::time::Instant;
use tokio::net::UnixListener;
use tokio::signal;

use mem_arch::store::Store;
use super::AppState;
use super::handlers;

/// Uptime tracker — set when the server starts.
pub static START_TIME: std::sync::LazyLock<Instant> = std::sync::LazyLock::new(Instant::now);

/// Start the HTTP server and bind to the Unix socket.
pub async fn run_server(store: mem_arch::ladybug::LadybugStore, socket_path: &str) {
    // Build search index from node cache
    let search_idx = mem_arch::search::SearchIndex::build(
        &store.find_nodes_by_type(&mem_arch::types::NodeType::Entity).await.unwrap_or_default()
    );

    let state = Arc::new(AppState {
        store: tokio::sync::RwLock::new(store),
        search_index: tokio::sync::RwLock::new(search_idx),
    });

    let app = Router::new()
        .route("/status", get(handlers::status))
        .route("/remember", post(handlers::remember))
        .route("/recall", post(handlers::recall))
        .route("/learn", post(handlers::learn))
        .route("/extract", post(handlers::extract))
        .route("/embed", post(handlers::embed))
        .route("/ingest", post(handlers::ingest_handler))
        .route("/search", post(handlers::search_handler))
        .route("/entity/lookup", post(handlers::entity_lookup))
        .route("/connect", post(handlers::connect))
        .route("/entity/update", post(handlers::entity_update))
        .route("/debug", get(handlers::debug_state))
        .layer(Extension(state));

    let listener = match UnixListener::bind(socket_path) {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("Failed to bind socket at {socket_path}: {e}");
            return;
        }
    };

    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(socket_path,
        std::fs::Permissions::from_mode(0o700)
    ) {
        tracing::error!("Failed to set socket permissions: {e}");
        return;
    }

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        tracing::error!("Server exited with error: {e}");
    }
}

/// Wait for Ctrl+C or SIGTERM to initiate graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    tokio::select! {
        _ = ctrl_c => tracing::info!("received Ctrl+C, shutting down gracefully"),
        _ = terminate => tracing::info!("received SIGTERM, shutting down gracefully"),
    }
}
