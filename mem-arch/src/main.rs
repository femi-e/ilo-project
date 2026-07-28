mod server;

use mem_arch::ladybug::LadybugStore;
use std::os::unix::io::AsRawFd;

use server::run_server;

/// Write our PID to a file so other instances can detect us.
fn write_pid_file(pid_path: &std::path::Path) {
    if let Err(e) = std::fs::write(pid_path, format!("{}", std::process::id())) {
        tracing::warn!("Failed to write PID file {:?}: {e}", pid_path);
    }
}

/// Remove the PID file on exit.
fn remove_pid_file(pid_path: &std::path::Path) {
    let _ = std::fs::remove_file(pid_path);
}

/// Try to acquire a BSD-style flock on a PID file.
/// Returns Ok if we got the lock, Err if another instance holds it.
fn try_lock(lock_path: &std::path::Path) -> Result<std::fs::File, String> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|e| format!("Cannot open lock file: {e}"))?;

    // Use flock via libc on macOS/Linux.
    // SAFETY: file was just opened successfully (valid fd), LOCK_NB prevents blocking,
    // and we only use the result code to check success/failure.
    let fd = file.as_raw_fd();
    let ret = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
    if ret != 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!("Another ILO instance holds the lock (flock: {err})"));
    }
    Ok(file)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    println!("ILO Memory Architecture — starting...");

    // Read config from env vars, with defaults
    let port: u16 = std::env::var("ILO_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(18090);
    let db_path = std::env::var("ILO_DB_PATH").unwrap_or_else(|_| "./var/ilo_data.lbug".into());
    let max_uptime_mins: u64 = std::env::var("ILO_MAX_UPTIME")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    println!("  port:   {port}");
    println!("  db:     {db_path}");
    if max_uptime_mins > 0 {
        println!("  max uptime: {} minutes", max_uptime_mins);
    }

    // Ensure the var/ directory exists (for socket and DB files)
    let var_dir = std::path::Path::new(&db_path).parent();
    if let Some(parent) = var_dir {
        std::fs::create_dir_all(parent).ok();
    }

    // ── Single-instance enforcement via flock ──
    let lock_dir = var_dir.unwrap_or(std::path::Path::new("."));
    let lock_path = lock_dir.join("ilo.lock");
    let _lock_file = match try_lock(&lock_path) {
        Ok(f) => f,
        Err(msg) => {
            tracing::error!("{} — exiting", msg);
            std::process::exit(1);
        }
    };
    // Write PID file for reference
    let pid_path = lock_dir.join("ilo.pid");
    write_pid_file(&pid_path);

    // Open or create the database (retry up to 5 times for lock contention)
    // With flock in place, lock contention should not occur — but we still
    // handle it defensively for the rare case where LadybugDB's internal
    // WAL lock persists from a crashed process.
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
                // Lock persisted after 5 retries — the previous process likely
                // crashed mid-transaction. Don't delete files; just exit and let
                // the OS release the lock on restart.
                tracing::error!(
                    "Database still locked after 5 retries at {}. \
                     The OS will release the lock when the zombie process exits. \
                     Retrying in 3 seconds...",
                    db_path
                );
                std::thread::sleep(std::time::Duration::from_secs(3));
                match LadybugStore::new(&db_path) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::error!(
                            "Database still locked at {} after retry: {}. Exiting.",
                            db_path, e
                        );
                        remove_pid_file(&pid_path);
                        std::process::exit(1);
                    }
                }
            }
        }
    };

    // No stale socket to clean — using TCP port

    // Check embedding server availability (non-fatal if offline)
    mem_arch::embed::warmup().await;

    // Warm cache (fast for small DBs, runs before server)
    let _ = store.warm_cache();

    // Start the HTTP server with optional uptime timer
    if max_uptime_mins > 0 {
        let duration = std::time::Duration::from_secs(max_uptime_mins * 60);
        tokio::select! {
            _ = run_server(store, port) => {}
            _ = tokio::time::sleep(duration) => {
                tracing::info!("Max uptime of {} minutes reached, shutting down", max_uptime_mins);
            }
        }
    } else {
        run_server(store, port).await;
    }

    // Cleanup PID file on exit
    remove_pid_file(&pid_path);
    tracing::info!("ILO shutdown complete");
}
