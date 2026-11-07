//! Lifecycle of the NEXUS core service (Python/FastAPI on 127.0.0.1:8765).
//!
//! * If the core is already running (e.g. via the LaunchAgent), the shell just connects.
//! * Otherwise it starts `python -m nexus_core` using the paths recorded by
//!   `scripts/setup.sh` in `<app config dir>/launcher.json`, and stops it on quit.
//! * The API token is read from `<data dir>/secrets/api_token` (0600) and handed
//!   only to this app's own webviews.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const CORE_PORT: u16 = 8765;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Launcher {
    /// Root of the NEXUS checkout (contains services/core).
    pub repo_dir: Option<PathBuf>,
    /// Python interpreter with nexus_core installed (the project venv).
    pub python: Option<PathBuf>,
    /// Where NEXUS keeps its database, workspace and logs.
    pub data_dir: Option<PathBuf>,
}

#[derive(Default)]
pub struct CoreProcess {
    pub child: Mutex<Option<Child>>,
    pub launcher: Mutex<Launcher>,
    pub last_error: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreInfo {
    pub base_url: String,
    pub token: Option<String>,
    pub spawned: bool,
    pub error: Option<String>,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn load_launcher(config_dir: Option<PathBuf>) -> Launcher {
    let mut l: Launcher = config_dir
        .map(|d| d.join("launcher.json"))
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if let Some(v) = std::env::var_os("NEXUS_REPO") {
        l.repo_dir = Some(PathBuf::from(v));
    }
    if let Some(v) = std::env::var_os("NEXUS_PYTHON") {
        l.python = Some(PathBuf::from(v));
    }
    if let Some(v) = std::env::var_os("NEXUS_DATA_DIR") {
        l.data_dir = Some(PathBuf::from(v));
    }
    if l.python.is_none() {
        if let Some(repo) = &l.repo_dir {
            let venv = repo.join("services/core/.venv/bin/python");
            if venv.exists() {
                l.python = Some(venv);
            }
        }
    }
    l
}

pub fn data_dir(l: &Launcher) -> PathBuf {
    if let Some(d) = &l.data_dir {
        return d.clone();
    }
    if let Some(repo) = &l.repo_dir {
        return repo.join("data");
    }
    home().join("Library/Application Support/NEXUS")
}

/// Minimal blocking GET /health — avoids pulling an HTTP client into the shell.
pub fn healthy() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], CORE_PORT));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    if s
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    buf.starts_with("HTTP/1.1 200") && buf.contains("nexus-core")
}

pub fn spawn(state: &CoreProcess) -> Result<(), String> {
    let l = state.launcher.lock().unwrap().clone();
    let python = l.python.clone().ok_or_else(|| {
        "No Python interpreter configured. Run scripts/setup.sh once, or start the core with scripts/dev.sh.".to_string()
    })?;
    let repo = l.repo_dir.clone().ok_or("repo_dir missing from launcher.json")?;
    let data = data_dir(&l);
    let logs = data.join("logs");
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let out = fs::File::create(logs.join("core-stdout.log")).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(&python)
        .args(["-m", "nexus_core"])
        .current_dir(repo.join("services/core"))
        .env("NEXUS_DATA_DIR", &data)
        .env("NEXUS_HOST", "127.0.0.1")
        .env("NEXUS_PORT", CORE_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("Failed to start core with {}: {e}", python.display()))?;
    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

pub fn ensure_running(state: &CoreProcess) {
    if healthy() {
        return;
    }
    if let Err(e) = spawn(state) {
        *state.last_error.lock().unwrap() = Some(e);
    }
}

pub fn info(state: &CoreProcess) -> CoreInfo {
    // Give a freshly spawned core time to apply migrations and bind.
    let deadline = Instant::now() + Duration::from_secs(20);
    let spawned = state.child.lock().unwrap().is_some();
    while !healthy() && spawned && Instant::now() < deadline {
        if let Some(child) = state.child.lock().unwrap().as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                *state.last_error.lock().unwrap() =
                    Some(format!("Core exited with {status}. See data/logs/core-stdout.log"));
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let l = state.launcher.lock().unwrap().clone();
    let token = fs::read_to_string(data_dir(&l).join("secrets/api_token"))
        .ok()
        .map(|t| t.trim().to_string());
    CoreInfo {
        base_url: format!("http://127.0.0.1:{CORE_PORT}"),
        token,
        spawned,
        error: state.last_error.lock().unwrap().clone(),
    }
}

/// Stop the core only if this shell started it (a LaunchAgent-managed core keeps running).
pub fn stop(state: &CoreProcess) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        #[cfg(unix)]
        {
            // SIGTERM lets uvicorn shut down gracefully (finish writes, close SQLite).
            let _ = Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
            let deadline = Instant::now() + Duration::from_secs(8);
            while Instant::now() < deadline {
                if let Ok(Some(_)) = child.try_wait() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}
