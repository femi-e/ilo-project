//! Server setup: route registration, socket binding, graceful shutdown.

use axum::{Router, routing::{get, post, patch, delete}, Extension};
use std::sync::Arc;
use std::time::Instant;
use tokio::signal;
use std::net::SocketAddr;

use mem_arch::store::Store;
use super::AppState;
use super::handlers;
use super::crud;

/// Uptime tracker — set when the server starts.
pub static START_TIME: std::sync::LazyLock<Instant> = std::sync::LazyLock::new(Instant::now);

/// Start the HTTP server on the given TCP port (127.0.0.1 only).
pub async fn run_server(store: mem_arch::ladybug::LadybugStore, port: u16) {
    // Build search index from node cache
    let search_idx = mem_arch::search::SearchIndex::build(
        &store.find_nodes_by_type(&mem_arch::types::NodeType::Entity).await.unwrap_or_default()
    );

    let state = Arc::new(AppState {
        store: tokio::sync::RwLock::new(store),
        search_index: tokio::sync::RwLock::new(search_idx),
    });

    let app = Router::new()
        // Existing endpoints (keep unchanged)
        .route("/status", get(crud::status))
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
        // New REST CRUD endpoints
        .route("/entities", post(crud::create_entities))
        .route("/entities/search", post(crud::search_entities))
        .route("/entities/{id}", get(crud::get_entity))
        .route("/entities/{id}", patch(crud::update_entity))
        .route("/entities/{id}", delete(crud::delete_entity))
        .route("/lookup/{label}", get(crud::get_entity))
        .route("/claims", post(crud::create_claims))
        .route("/claims/{id}", get(crud::get_claim))
        .route("/claims/{id}", patch(crud::update_claim))
        .route("/claims/{id}", delete(crud::delete_claim))
        .route("/links", post(crud::create_link))
        .route("/links/{id}", patch(crud::update_link))
        .route("/links/{id}", delete(crud::delete_link))
        .route("/batch", post(crud::batch))
        .layer(Extension(state));

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("Listening on {}", addr);

    if let Err(e) = axum::serve(
        tokio::net::TcpListener::bind(addr).await.unwrap_or_else(|e| {
            tracing::error!("Failed to bind to {addr}: {e}");
            std::process::exit(1);
        }),
        app,
    )
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
