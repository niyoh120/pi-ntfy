# pi-ntfy

Send push notifications via [ntfy.sh](https://ntfy.sh) when [pi](https://pi.dev) agent finishes a turn and needs your attention.

Useful when you step away from the terminal while pi is working on a long task — you'll get a notification on your phone or desktop when it's done.

## Install

```bash
pi install git:github.com/<user>/pi-ntfy
```

Or install from a local clone:

```bash
pi install /path/to/pi-ntfy
```

## Configuration

All configuration is via environment variables.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PI_NTFY_TOPIC` | **Yes** | — | ntfy topic name. If unset or empty, the extension is silently disabled. |
| `PI_NTFY_SERVER` | No | `https://ntfy.sh` | ntfy server URL. Trailing slashes are stripped. |
| `PI_NTFY_MIN_SECONDS` | No | `10` | Minimum agent turn duration (seconds) to trigger a notification. Short turns mean you're likely still watching the screen, so notifications would be noisy. Invalid values (NaN, negative, empty) fall back to 10. |
| `PI_NTFY_TIMEOUT` | No | `5000` | Fetch timeout in milliseconds. Prevents a slow ntfy server from blocking pi. Invalid values fall back to 5000; minimum is 1000. |

### Quick setup

```bash
# Set your topic in shell profile
export PI_NTFY_TOPIC=my_pi_alerts

# Optional: use a self-hosted ntfy server
export PI_NTFY_SERVER=https://ntfy.mycompany.com
```

Then start pi normally — the extension is loaded via the package manifest (`extensions/` directory).

## Notification behavior

- Sends a notification when `agent_end` fires **and** the turn lasted ≥ `PI_NTFY_MIN_SECONDS`
- **Normal turn**: Priority 4, tags `computer`, title "Pi needs attention"
- **Turn with errors**: Priority 5, tags `computer,warning`, title "Pi needs attention ⚠️"
- Notification failures (network errors, timeouts, HTTP errors) are logged via `console.warn` — pi continues normally
- Fetch requests have a bounded timeout (`PI_NTFY_TIMEOUT`) and respect `Ctrl+C` abort

## Local testing

```bash
# Quick test with a single extension file
PI_NTFY_TOPIC=test_topic pi -e extensions/ntfy.ts

# Test with a self-hosted server
PI_NTFY_SERVER=http://localhost:8080 PI_NTFY_TOPIC=test_topic pi -e extensions/ntfy.ts

# Local ntfy server for testing
docker run -p 8080:80 binwiederhier/ntfy
```

## Disable / Rollback

- **Runtime disable**: `unset PI_NTFY_TOPIC` — the extension loads but does nothing
- **Full uninstall**: `pi remove git:github.com/<user>/pi-ntfy` or delete `extensions/ntfy.ts`, `package.json`, `README.md`

## License

MIT