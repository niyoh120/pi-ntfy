/**
 * pi-ntfy — Send ntfy notifications when pi needs attention
 *
 * Monitors agent lifecycle events and sends push notifications
 * via ntfy.sh when the agent finishes a turn that took longer
 * than a configurable threshold.
 *
 * Configuration via environment variables:
 *   PI_NTFY_TOPIC       — ntfy topic (required; extension disabled if unset)
 *   PI_NTFY_SERVER      — ntfy server URL (default: https://ntfy.sh)
 *   PI_NTFY_MIN_SECONDS — minimum turn duration to trigger notification (default: 10)
 *   PI_NTFY_TIMEOUT     — fetch timeout in milliseconds (default: 5000)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Parse an integer from an env value with safe fallback.
 * Returns `defaultVal` for undefined, empty, NaN, Infinity, or values below `min`.
 */
function parseEnvInt(
	raw: string | undefined,
	defaultVal: number,
	min: number,
): number {
	if (raw === undefined) return defaultVal;
	const trimmed = raw.trim();
	if (trimmed === "") return defaultVal;
	const num = Number(trimmed);
	if (!Number.isFinite(num)) return defaultVal;
	if (num < min) return defaultVal;
	return Math.floor(num);
}

const topic = process.env.PI_NTFY_TOPIC?.trim() || undefined;
const server = (process.env.PI_NTFY_SERVER?.trim() || "https://ntfy.sh").replace(
	/\/+$/,
	"",
);
const minSecs = parseEnvInt(process.env.PI_NTFY_MIN_SECONDS, 10, 1);
// Enforce a reasonable maximum (Node setTimeout truncates above ~2^31-1 ms)
const timeoutMs = Math.min(
	parseEnvInt(process.env.PI_NTFY_TIMEOUT, 5000, 1000),
	2_147_483_647,
);

// ---------------------------------------------------------------------------
// Notification helpers
// ---------------------------------------------------------------------------

interface NotifyParams {
	seconds: number;
	hasError: boolean;
	signal?: AbortSignal;
}

async function sendNotification(params: NotifyParams): Promise<void> {
	const url = `${server}/${encodeURIComponent(topic!)}`;

	const title = "Pi needs attention";
	const priority = params.hasError ? "5" : "4";
	const tags = params.hasError ? "computer,warning" : "computer";
	const body = params.hasError
		? `Pi turn finished after ${params.seconds}s (with errors)`
		: `Pi turn finished after ${params.seconds}s`;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	// Merge ctx.signal (user Ctrl+C) and timeout signal
	if (params.signal?.aborted) {
		clearTimeout(timeoutId);
		return;
	}
	let abortHandler: (() => void) | undefined;
	if (params.signal) {
		abortHandler = () => controller.abort();
		params.signal.addEventListener("abort", abortHandler, {
			once: true,
		});
	}

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Title: title,
				Priority: priority,
				Tags: tags,
			},
			body,
			signal: controller.signal,
		});
		if (!response.ok) {
			console.warn(
				`pi-ntfy: notification failed (HTTP ${response.status})`,
			);
		}
	} catch (error) {
		// Notification failure must not affect pi, but log for diagnostics
		console.warn(
			`pi-ntfy: notification request failed${error instanceof Error ? ` (${error.message})` : ""}`,
		);
	} finally {
		clearTimeout(timeoutId);
		if (abortHandler && params.signal) {
			params.signal.removeEventListener("abort", abortHandler);
		}
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function extension(pi: ExtensionAPI) {
	// No topic → extension fully disabled
	if (!topic) return;

	let startedAt = 0; // 0 = no valid start timestamp

	// Reset on session events (prevents stale startedAt after /reload)
	pi.on("session_start", async () => {
		startedAt = 0;
	});

	pi.on("agent_start", async () => {
		startedAt = Date.now();
	});

	pi.on("agent_end", async (event, ctx) => {
		// Guard: no valid start timestamp → skip
		if (startedAt === 0) return;

		// Save and reset immediately so all code paths (including early return)
		// clean up startedAt — prevents stale state after /reload or threshold skip
		const start = startedAt;
		startedAt = 0;

		const seconds = Math.round((Date.now() - start) / 1000);
		if (seconds < minSecs) return;

		// Detect error state: any toolResult with isError === true
		let hasError = false;
		for (const msg of event.messages) {
			if (msg.role === "toolResult" && msg.isError === true) {
				hasError = true;
				break;
			}
		}

		await sendNotification({
			seconds,
			hasError,
			signal: ctx.signal,
		});
	});
}
