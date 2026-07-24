mod server;

use mem_arch::ladybug::LadybugStore;

use server::run_server;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    println!("ILO Memory Architecture — starting...");

    // Read config from env vars, with defaults in ./var/
    let socket_path = std::env::var("ILO_SOCKET").unwrap_or_else(|_| "./var/ilo.sock".into());
    let db_path = std::env::var("ILO_DB_PATH").unwrap_or_else(|_| "./var/ilo_data.lbug".into());
    let max_uptime_mins: u64 = std::env::var("ILO_MAX_UPTIME")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    println!("  socket: {socket_path}");
    println!("  db:     {db_path}");
    if max_uptime_mins > 0 {
        println!("  max uptime: {} minutes", max_uptime_mins);
    }

    // Ensure the var/ directory exists (for socket and DB files)
    if let Some(parent) = std::path::Path::new(&db_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    // Open or create the database (retry up to 5 times for lock contention)
    let store = {
        let mut retries = 0;
        let store = loop {
            match LadybugStore::new(&db_path) {
                Ok(s) => break Some(s),
                Err(e) => {
                    let err_str = e.to_string();
                    if err_str.contains("Lock is held") && retries < 5 {
                        retries += 1;
                        tracing::warn!("Database locked (attempt {}/5), retrying...", retries);
                        std::thread::sleep(std::time::Duration::from_secs(1));
                        continue;
                    }
                    break None;
                }
            }
        };
        match store {
            Some(s) => s,
            None => {
                // Lock persisted after 5 retries. Don't delete the DB — that
                // would destroy data if another live process holds the lock.
                // Just exit; the pi extension's auto-restart will retry.
                tracing::error!(
                    "Database still locked after 5 retries at {}. \
                     If no other ILO process is running, delete the .lbug files manually \
                     or wait for the OS lock to expire.",
                    db_path
                );
                std::process::exit(1);
            }
        }
    };

    // Remove stale socket from a previous run
    let _ = std::fs::remove_file(&socket_path);

    // Try to warm the embedding model (non-fatal if offline)
    mem_arch::embed::warmup();

    // Warm cache (fast for small DBs, runs before server)
    let _ = store.warm_cache();

    // Start the HTTP server with optional uptime timer
    if max_uptime_mins > 0 {
        let duration = std::time::Duration::from_secs(max_uptime_mins * 60);
        let socket_path = socket_path.clone();
        tokio::select! {
            _ = run_server(store, &socket_path) => {}
            _ = tokio::time::sleep(duration) => {
                tracing::info!("Max uptime of {} minutes reached, shutting down", max_uptime_mins);
            }
        }
    } else {
        run_server(store, &socket_path).await;
    }

    // Cleanup socket on exit
    let _ = std::fs::remove_file(&socket_path);
    tracing::info!("ILO shutdown complete");
}
