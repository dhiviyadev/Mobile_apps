//! Lifecycle of the NEXUS core service (Python/FastAPI on 127.0.0.1:8765).
//!
//! * If the core is already running (e.g. via the LaunchAgent), the shell just connects.
//! * Otherwise it starts `python -m nexus_core` using the paths recorded by
//!   `scripts/setup.sh` in `<app config dir>/launcher.json`, and stops it on quit.
//! * A self-contained build carries the core inside the app (`Resources/core/nexus-core`,
//!   made by `scripts/build-standalone.sh`); that copy is used when present, so the
//!   app needs no Python, checkout or setup on the Mac it runs on.
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
    /// The app's resource directory (where a bundled core and phone app live in a self-contained build).
    pub resources: Mutex<Option<PathBuf>>,
}

/// The core shipped inside the app, if this is a self-contained build.
pub fn bundled_core(resources: &Option<PathBuf>) -> Option<PathBuf> {
    let exe = resources.as_ref()?.join("core").join("nexus-core");
    exe.is_file().then_some(exe)
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

fn tool_path() -> String {
    let h = home();
    let mut dirs: Vec<String> = vec![
        h.join(".local/bin").to_string_lossy().into_owned(),
        h.join(".cargo/bin").to_string_lossy().into_owned(),
        "/opt/homebrew/bin".into(),
        "/opt/homebrew/sbin".into(),
        "/usr/local/bin".into(),
        "/Applications/Tailscale.app/Contents/MacOS".into(),
    ];
    if let Ok(existing) = std::env::var("PATH") {
        dirs.extend(existing.split(':').map(String::from));
    }
    dirs.extend(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(String::from));
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| !d.is_empty() && seen.insert(d.clone()));
    dirs.join(":")
}

/// The commit this app was built from ("" when git wasn't available at build time).
pub const APP_BUILD: &str = env!("NEXUS_BUILD");

/// A tiny blocking HTTP exchange with the core — avoids pulling an HTTP client into the shell.
fn http(request: &str, read_ms: u64) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], CORE_PORT));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(read_ms)));
    s.write_all(request.as_bytes()).ok()?;
    let mut buf = String::new();
    let _ = s.read_to_string(&mut buf);
    Some(buf)
}

/// The body of GET /health if a NEXUS core is answering.
pub fn health() -> Option<String> {
    let buf = http("GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n", 800)?;
    (buf.starts_with("HTTP/1.1 200") && buf.contains("nexus-core")).then_some(buf)
}

pub fn healthy() -> bool {
    health().is_some()
}

/// True when the running core is old code: it says so itself ("stale": the code on disk changed after it
/// started, i.e. an update was installed under it), or it is too old to report a build at all.
pub fn core_is_other_version() -> bool {
    match health() {
        Some(h) => !h.contains("\"build\":") || h.contains("\"stale\":true"),
        None => false,
    }
}

fn wait_until(deadline_s: u64, want_up: bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(deadline_s);
    while Instant::now() < deadline {
        if healthy() == want_up {
            return true;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    healthy() == want_up
}

/// Stop whichever core is answering on the port: ours, or one left running by an earlier version,
/// ./scripts/dev.sh or a LaunchAgent. Asks politely first; falls back to a normal terminate signal.
pub fn stop_running(state: &CoreProcess) {
    stop(state);
    if !healthy() {
        return;
    }
    let l = state.launcher.lock().unwrap().clone();
    if let Ok(token) = fs::read_to_string(data_dir(&l).join("secrets/api_token")) {
        let req = format!(
            "POST /api/system/shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            token.trim()
        );
        let _ = http(&req, 1500);
    }
    if wait_until(5, false) {
        return;
    }
    // Cores older than the shutdown request: end the NEXUS core process the ordinary way (SIGTERM).
    #[cfg(unix)]
    {
        let _ = Command::new("pkill").args(["-TERM", "-f", "--", "-m nexus_core"]).status();
        let _ = Command::new("pkill").args(["-TERM", "-f", "--", "core/nexus-core"]).status();
    }
    wait_until(8, false);
}

pub fn spawn(state: &CoreProcess) -> Result<(), String> {
    let l = state.launcher.lock().unwrap().clone();
    let resources = state.resources.lock().unwrap().clone();
    let data = data_dir(&l);
    let logs = data.join("logs");
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let out = fs::File::create(logs.join("core-stdout.log")).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd;
    let what;
    if let (Some(exe), true) = (bundled_core(&resources), std::env::var_os("NEXUS_PYTHON").is_none()) {
        // Self-contained build: run the core that ships inside the app.
        what = exe.display().to_string();
        cmd = Command::new(&exe);
        cmd.current_dir(&data);
        if let Some(mobile) = resources.as_ref().map(|r| r.join("mobile")).filter(|m| m.is_dir()) {
            cmd.env("NEXUS_MOBILE_DIST", mobile);
        }
    } else {
        let python = l.python.clone().ok_or_else(|| {
            "No Python interpreter configured. Run scripts/setup.sh once, or start the core with scripts/dev.sh.".to_string()
        })?;
        let repo = l.repo_dir.clone().ok_or("repo_dir missing from launcher.json")?;
        what = python.display().to_string();
        cmd = Command::new(&python);
        cmd.args(["-m", "nexus_core"]).current_dir(repo.join("services/core"));
    }
    let child = cmd
        // Apps opened from Finder get a minimal PATH; add the usual tool locations so the core can
        // find hermes, ffmpeg, whisper-cli, piper and tailscale like it does from Terminal.
        .env("PATH", tool_path())
        .env("NEXUS_DATA_DIR", &data)
        .env("NEXUS_LAUNCHED_BY_APP", "1")
        .env("NEXUS_BUILD", APP_BUILD)
        .env("NEXUS_HOST", "127.0.0.1")
        .env("NEXUS_PORT", CORE_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()
        .map_err(|e| format!("Failed to start core with {what}: {e}"))?;
    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

pub fn ensure_running(state: &CoreProcess) {
    if healthy() {
        // An installed app replaces a background service left over from other code (for example the
        // previous version, still running after an update). Development builds leave it alone.
        let dev = cfg!(debug_assertions) && std::env::var_os("NEXUS_REPLACE_STALE").is_none();
        if dev || !core_is_other_version() {
            return;
        }
        stop_running(state);
        if healthy() {
            return; // couldn't replace it; the window shows a banner offering to try again
        }
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
