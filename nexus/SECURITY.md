# NEXUS security model

Principle: **a local process is not automatically safe.** Agents act through narrow,
permission-checked tools; anything destructive is a *proposal* until you approve it.

## Local API

* Binds to `127.0.0.1` only; the core refuses to start on any other address.
* Every `/api` request and the `/ws` stream need a 256-bit bearer token generated on first run,
  stored at `data/secrets/api_token` with mode `0600` (directory `0700`). The Tauri shell reads it
  and gives it only to its own webviews.
* **DNS-rebinding guard**: requests whose `Host` header isn't a loopback name get `421`.
* CORS and WebSocket `Origin` are limited to the Tauri origins and the local dev server.
* Webview CSP allows connections only to itself and `127.0.0.1:8765`; Markdown rendering never
  injects raw HTML; search highlights use control-character markers, not HTML.

## File access

* Nothing is readable until you **approve a folder**. The NEXUS workspace (`data/workspace`) is the
  only built-in grant.
* **Read, write and execute are separate** per folder (write is off by default).
* Paths are resolved with `realpath` before checks — `..` and symlinks can't escape a grant.
* Never approvable: `/`, system folders, your whole home folder, `~/Library`.
* Always blocked, even inside an approved folder: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`,
  `~/.docker`, `.netrc`, `.npmrc`, `.git-credentials`, `~/.hermes/.env`, Keychains, Cookies, Mail,
  Messages, Safari/Chrome/Firefox/Brave/Edge/Arc profiles, 1Password, Group Containers, `.env*`
  files and private key filenames.
* Writes are atomic (temp file + rename). **Overwrites** need approval and keep a backup in
  `data/trash`; **deletions** need approval and move to `data/trash` (recoverable).
* NEXUS does not need Full Disk Access.

## Tools & execution

* No general shell tool. Agents can: list/read/search in approved folders, write files, search
  knowledge, recall/propose memory, notify, **request** to open an installed app, **request** to
  run a script you registered from `data/scripts/`.
* Scripts run without a shell, with argument limits, a timeout and a minimal environment.
* Each agent has an explicit tool allowlist (Agents → Permissions); calls to other tools are rejected.
* Hermes runs: NEXUS never passes `--yolo`. With the API server, Hermes' approval requests appear
  in NEXUS and your decision is relayed back. Hermes' own tools (terminal, web, files) follow
  **Hermes'** permission model, not NEXUS's folder allowlist — restrict Hermes toolsets in Hermes'
  configuration if you need tighter limits, or pin sensitive agents to the NEXUS native runtime.

## Approvals & emergency stop

* Proposed actions are listed with what will happen; nothing runs until approved. Unanswered
  approvals expire as *denied* (10 min) and pending ones are expired on restart.
* **Emergency stop** (title bar, tray menu, command palette) cancels every running task (including
  Hermes runs via `/stop` / SIGINT), denies all pending approvals and blocks new actions,
  generations and automations until you press **Resume**.

## Data & secrets

* Data stays in `data/` (SQLite, workspace, logs, backups) — never in the source tree or git.
* Cloud API keys and the Hermes key are stored in the **macOS Keychain**; the API only reports
  whether a key exists.
* Cloud models are **off by default**. When enabled, every message needs explicit per-message
  consent, and including local documents requires a second setting. Every cloud request is audited.
* Memory: automatic extraction only creates *proposals*; content resembling passwords, keys, card or
  ID numbers is refused for automatic memory and flagged if you add it yourself.
* Microphone: opened only during push-to-talk and released immediately; no continuous listening.

## Audit log

Every permission decision, approval, file write/delete, script run, app launch, folder grant,
settings change to cloud options and emergency stop is appended to `audit_log` (Settings → Security).

## Verified by tests

`services/core/tests/test_security.py` and `test_files_approvals.py` cover: auth and token
permissions, WebSocket auth, Host-header rejection, unapprovable folders, `..` and symlink escapes,
separate R/W/X grants, credential-path denial, audited denials, overwrite/delete approval with
backups, emergency stop blocking chat/agents/files and denying pending approvals, script allowlist,
cloud disabled by default, and agents unable to use tools outside their profile.

Report a vulnerability privately to the repository owner.
