# pi-ntfy

Send push notifications via [ntfy.sh](https://ntfy.sh) when [pi](https://pi.dev) finishes a turn and needs your attention. Useful when you step away from the terminal while pi is working on a long task — get a notification on your phone or desktop when it's done.

Supports self-hosted ntfy servers, including those behind authentication (Basic username/password or Bearer token).

## Install

```bash
pi install git:github.com/<user>/pi-ntfy
```

Or from a local clone:

```bash
pi install /path/to/pi-ntfy
```

## Quick start

After installation, run pi and configure via the `/ntfy` command:

```
/ntfy
```

This opens the settings UI where you can set:

| Setting | Default | Description |
|---------|---------|-------------|
| Enabled | No | Master on/off switch |
| Server | `https://ntfy.sh` | ntfy server URL (self‑hosted or cloud) |
| Topic | _(required)_ | ntfy topic name; notifications are skipped while empty |
| Min Seconds | 10 | Minimum agent turn duration (seconds) before sending a notification |
| Timeout (ms) | 5000 | Fetch timeout; prevents a slow server from blocking pi |
| Auth Type | none | `none`, `basic` (username + password), or `bearer` (token) |

Settings are saved to `~/.pi/agent/ntfy.json` and take effect immediately — no restart needed.

## Authentication

### No authentication (default)

```json
{
  "auth": { "type": "none" }
}
```

### Basic auth (username + password)

```json
{
  "auth": {
    "type": "basic",
    "username": "alice",
    "password": "s3cret"
  }
}
```

Use the `/ntfy` command to set these without editing the JSON file directly.

### Bearer token

```json
{
  "auth": {
    "type": "bearer",
    "token": "tk_abc123..."
  }
}
```

## Notification behavior

- Sends a notification when `agent_end` fires **and** the turn lasted ≥ `minSeconds`
- **Normal turn**: Priority 4, tags `computer`, title "Pi needs attention"
- **Turn with errors**: Priority 5, tags `computer,warning`, title "Pi needs attention ⚠️"
- Notification failures (network errors, timeouts, HTTP errors) are logged via `console.warn` — pi continues normally
- Fetch requests have a bounded timeout (`timeoutMs`) and respect `Ctrl+C` abort

## Disable / Rollback

- **Disable**: Open `/ntfy` and toggle `Enabled` to `No` — notifications stop immediately
- **Pause**: Set `Topic` to empty via `/ntfy` — same effect  
- **Uninstall**: `pi remove git:github.com/<user>/pi-ntfy`
- **Reset config**: Delete `~/.pi/agent/ntfy.json` — the extension loads defaults on next start

## License

MIT