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

## Remote access (phone app)

* **Off by default.** While off, device tokens are rejected and only loopback Host names are accepted.
* The core never binds to a network interface. Phones reach it through a reverse proxy running on
  the Mac — recommended `tailscale serve`, which gives WireGuard encryption, a valid HTTPS
  certificate, and reachability only from devices in your tailnet.
* Only hostnames you list (e.g. `my-mac.tail1234.ts.net`) pass the Host check; WebSocket origins must
  match them.
* **Pairing:** an 8-character one-time code (≈10¹² combinations, 5-minute expiry, single use, stored
  hashed, 10 attempts per 5 minutes) is exchanged for a per-device random token. Tokens are stored only
  as SHA-256 hashes and can be revoked individually.
* **Restricted role:** a phone cannot change folder permissions, secrets, scripts, settings, agent
  configuration, model routing or devices, run benchmarks or backups, open apps/files on the Mac, or
  read the API docs. It *can* chat, run agents, approve/deny, review memories, run/toggle automations,
  search, view status and trigger the emergency stop. Denied remote calls and every remote approval or
  stop are written to the audit log under `device:<name>`.
* The phone app's service worker caches only the app shell; it never caches API responses.

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

* Logs never contain tokens: a logging filter redacts `token=…` and `Bearer …` everywhere (including the web server's own WebSocket lines), and `data/logs` is readable only by you.

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
cloud disabled by default, agents unable to use tools outside their profile, and the remote-access rules (off by default, single-use/rate-limited pairing, hashed tokens, restricted role, host/origin checks, revocation).

Report a vulnerability privately to the repository owner.

## Web access, Apple apps, pictures and phone notifications

All of these are **off until you switch them on** in Settings, and a paired phone can never switch them on.

| Feature | What leaves the Mac | Safeguards |
|---|---|---|
| Web search / reading pages | The search phrase an agent writes (to DuckDuckGo) and requests for public pages. Never files, memories or chat history. | Only http/https on standard ports; loopback, private, link-local, Tailscale and metadata addresses are refused; the connection is pinned to the address that was checked (no DNS-rebinding window); redirects are re-checked; 2 MB cap; text only; every call is in the audit log; page text is labelled untrusted for the model. |
| Calendar, Reminders, Mail | Nothing. | Separate switch per app plus macOS's own permission prompt. Adding a reminder and opening a draft each need your approval. There is no code path that sends email. Your text is passed to AppleScript as arguments, never pasted into script source. |
| Pictures and screenshots | Nothing (local model). With cloud chat allowed for a message, attachments follow the existing cloud rules. | Screenshots are only taken when you press the button on the Mac; phones can't trigger them. |
| OCR | Nothing. Runs with Apple Vision (or Tesseract). | Can be turned off in Settings → Web & apps. |
| Phone notifications | A short title and one line, **encrypted end to end** (RFC 8291) so Apple/Google only see that a notification was sent. | Only after the phone itself turns notifications on; Mac-side master switch; subscriptions accepted only for Apple, Google, Mozilla and Microsoft push services; signing key stored 0600 in `data/secrets`. |
| Markets | The ticker symbols and search phrases you look up (to Yahoo Finance). Holdings, orders and cash never leave the Mac. | Off by default. Uses the same guarded fetcher as web access. Trading is a practice account only: there is no broker connection and no code that can place a real order; agents have a read-only price tool and no trading tool; phones can view but not trade. |
| Real-money trading (Zerodha) | Order details go to Zerodha, over HTTPS, only when you confirm an order. | Off until you connect and switch on "Allow real orders". API key, secret and the daily session live in the macOS Keychain and never appear in API answers, logs or the audit trail. Every order needs a preview and that preview's single-use code (bound to the exact order, expires in 2 minutes). Limits on order value and orders per day are re-checked at the moment of sending. Blocked by the emergency stop. Paired phones are refused for everything under `/api/broker`. Agents and automations have no code path to the broker (a test enforces this). The login callback accepts only a one-time state that NEXUS itself issued. |
| Trade ideas | Ticker symbols only (same as Markets). | Ideas are arithmetic on past prices, shown with their own back-test and caveats; confidence is never reported as "high". They are information, not advice. |
| TradingView chart | The symbol you are viewing (to TradingView), when you choose that chart. | TradingView's script runs only inside a sandboxed frame with an isolated origin, on a page that holds nothing private and carries its own strict content policy; the app's own pages still load no third-party scripts. It cannot read NEXUS data, the API token or the Keychain, and NEXUS cannot read prices out of it. |
| Quick actions | Nothing. | The clipboard is read only when you press ⌥⇧Q. |
| Hands-free voice | Nothing (local transcription). | The microphone is open only while the visible hands-free indicator is on; it switches itself off after two silent listens. No wake word, no background listening. |

Known limits: text from web pages can still try to mislead a model (prompt injection). NEXUS's tools
that change things require approval regardless of what a page says, which is the real protection.
