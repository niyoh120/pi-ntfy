/**
 * pi-ntfy — Send ntfy notifications when pi needs attention
 *
 * Monitors agent lifecycle events and sends push notifications
 * via ntfy.sh (or self-hosted ntfy) when the agent finishes a turn
 * that took longer than a configurable threshold.
 *
 * Configuration is stored in ~/.pi/agent/ntfy.json and managed
 * via the /ntfy command in pi's TUI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Config types & defaults
// ---------------------------------------------------------------------------

type AuthType = "none" | "basic" | "bearer";

interface NtfyAuthConfig {
	type: AuthType;
	username?: string;
	password?: string;
	token?: string;
}

interface NtfyConfig {
	enabled: boolean;
	server: string;
	topic: string;
	minSeconds: number;
	timeoutMs: number;
	auth: NtfyAuthConfig;
}

const DEFAULT_CONFIG: NtfyConfig = {
	enabled: false,
	server: "https://ntfy.sh",
	topic: "",
	minSeconds: 10,
	timeoutMs: 5000,
	auth: { type: "none" },
};

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

let configFilePath: string | undefined;

function initConfigPath(): void {
	if (configFilePath) return;
	const agentDir = getAgentDir();
	configFilePath = join(agentDir, "ntfy.json");
}

function getConfigPath(): string {
	initConfigPath();
	return configFilePath!;
}

// ---------------------------------------------------------------------------
// Config I/O
// ---------------------------------------------------------------------------

function parseStrictInt(raw: unknown, defaultVal: number, min: number): number {
	if (typeof raw !== "number") return defaultVal;
	if (!Number.isFinite(raw)) return defaultVal;
	if (raw < min) return defaultVal;
	return Math.floor(raw);
}

function normalizeConfig(raw: unknown): NtfyConfig {
	const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const authRaw = (root.auth && typeof root.auth === "object" ? root.auth : {}) as Record<string, unknown>;

	const authType: AuthType =
		authRaw.type === "basic" ? "basic" : authRaw.type === "bearer" ? "bearer" : "none";

	const auth: NtfyAuthConfig = {
		type: authType,
		username: typeof authRaw.username === "string" ? authRaw.username : undefined,
		password: typeof authRaw.password === "string" ? authRaw.password : undefined,
		token: typeof authRaw.token === "string" ? authRaw.token : undefined,
	};

	return {
		enabled: typeof root.enabled === "boolean" ? root.enabled : DEFAULT_CONFIG.enabled,
		server: normalizeServer(root.server),
		topic: typeof root.topic === "string" ? root.topic.trim() : DEFAULT_CONFIG.topic,
		minSeconds: parseStrictInt(root.minSeconds, DEFAULT_CONFIG.minSeconds, 1),
		timeoutMs: Math.min(parseStrictInt(root.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1000), 2_147_483_647),
		auth,
	};
}

function normalizeServer(raw: unknown): string {
	if (typeof raw !== "string" || !raw.trim()) return DEFAULT_CONFIG.server;
	try {
		const url = new URL(raw.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_CONFIG.server;
		url.search = "";
		url.hash = "";
		return (url.origin + url.pathname).replace(/\/+$/, "") || DEFAULT_CONFIG.server;
	} catch {
		return DEFAULT_CONFIG.server;
	}
}

function readConfig(): NtfyConfig {
	try {
		const file = getConfigPath();
		if (!existsSync(file)) return { ...DEFAULT_CONFIG };
		const raw = readFileSync(file, "utf-8");
		return normalizeConfig(JSON.parse(raw));
	} catch (err) {
		console.warn(`pi-ntfy: failed to read config: ${err instanceof Error ? err.message : String(err)}`);
		return { ...DEFAULT_CONFIG };
	}
}

function writeConfig(cfg: NtfyConfig): boolean {
	try {
		const file = getConfigPath();
		const dir = dirname(file);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const tmpFile = `${file}.${process.pid}.tmp`;
		writeFileSync(tmpFile, JSON.stringify(cfg, null, "\t") + "\n", { encoding: "utf-8", mode: 0o600 });
		chmodSync(tmpFile, 0o600);
		renameSync(tmpFile, file);
		return true;
	} catch (err) {
		console.warn(`pi-ntfy: failed to write config: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Auth header
// ---------------------------------------------------------------------------

function authHeader(cfg: NtfyConfig): Record<string, string> | undefined {
	const a = cfg.auth;
	if (a.type === "basic") {
		if (!a.username || !a.password) return undefined;
		const cred = `${a.username}:${a.password}`;
		return { Authorization: `Basic ${Buffer.from(cred).toString("base64")}` };
	}
	if (a.type === "bearer") {
		if (!a.token) return undefined;
		return { Authorization: `Bearer ${a.token}` };
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Runtime config (in-memory, reloaded from file on demand)
// ---------------------------------------------------------------------------

let runtimeCfg: NtfyConfig = { ...DEFAULT_CONFIG };

function loadConfig(): void {
	runtimeCfg = readConfig();
}

function isActive(): boolean {
	return runtimeCfg.enabled && runtimeCfg.topic !== "";
}

// ---------------------------------------------------------------------------
// Notification helper
// ---------------------------------------------------------------------------

interface NotifyMeta {
	projectPath: string;
	projectName: string;
	sessionName: string;
	sessionId: string;
}

function buildNotifyMeta(
	cwd: string,
	sessionFile: string | undefined,
	sessionName: string | undefined,
): NotifyMeta {
	return {
		projectPath: cwd,
		projectName: basename(cwd) || cwd,
		sessionName: sessionName || "(unnamed)",
		sessionId: sessionFile
			? basename(sessionFile).replace(/\.jsonl$/, "")
			: "(ephemeral)",
	};
}

interface NotifyParams {
	seconds: number;
	hasError: boolean;
	signal?: AbortSignal;
	meta: NotifyMeta;
}

async function sendNotification(params: NotifyParams): Promise<void> {
	const cfg = runtimeCfg;
	const url = `${cfg.server}/${encodeURIComponent(cfg.topic)}`;

	const title = params.meta.projectName;
	const priority = params.hasError ? "5" : "4";
	const tags = params.hasError ? "computer,warning" : "computer";

	const lines: string[] = [
		`Path: ${params.meta.projectPath}`,
		`Session: ${params.meta.sessionName}`,
		`ID: ${params.meta.sessionId}`,
		`Duration: ${params.seconds}s`,
	];
	if (params.hasError) {
		lines.push("Status: errors detected");
	}
	const body = lines.join("\n");

	const headers: Record<string, string> = {
		Title: title,
		Priority: priority,
		Tags: tags,
	};

	const auth = authHeader(cfg);
	if (auth) Object.assign(headers, auth);

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs);

	if (params.signal?.aborted) {
		clearTimeout(timeoutId);
		return;
	}
	let abortHandler: (() => void) | undefined;
	if (params.signal) {
		abortHandler = () => controller.abort();
		params.signal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
		});
		if (!response.ok) {
			console.warn(`pi-ntfy: notification failed (HTTP ${response.status})`);
		}
	} catch (error) {
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
// /ntfy command — TUI settings
// ---------------------------------------------------------------------------

/** Minimal shape needed for ctx.ui dialogs in the settings loop. */
interface SettingsUI {
	ui: {
		select(title: string, items: string[]): Promise<string | undefined>;
		input(title: string, prefill?: string): Promise<string | undefined>;
		notify(message: string, level: "info" | "warning" | "error"): void;
	};
}

function buildSettingItems(cfg: NtfyConfig): string[] {
	const items: string[] = [];
	items.push(`Enabled: ${cfg.enabled ? "Yes" : "No"}`);
	items.push(`Server: ${cfg.server}`);
	items.push(`Topic: ${cfg.topic || "(not set)"}`);
	items.push(`Min Seconds: ${cfg.minSeconds}`);
	items.push(`Timeout (ms): ${cfg.timeoutMs}`);
	items.push(`Auth Type: ${cfg.auth.type}`);

	if (cfg.auth.type === "basic") {
		items.push(`Username: ${cfg.auth.username || "(not set)"}`);
		items.push(`Password: ${cfg.auth.password ? "••••" : "(not set)"}`);
	}
	if (cfg.auth.type === "bearer") {
		items.push(`Token: ${cfg.auth.token ? "••••" : "(not set)"}`);
	}

	items.push("--- Save & exit ---");
	return items;
}

async function handleSetting(ctx: SettingsUI, label: string, cfg: NtfyConfig): Promise<void> {
	if (label.startsWith("Enabled:")) {
		cfg.enabled = !cfg.enabled;
	} else if (label.startsWith("Server:")) {
		const v = await ctx.ui.input("ntfy server URL:", cfg.server);
		if (v !== undefined && v.trim()) {
			try {
				const url = new URL(v.trim());
				if (url.protocol === "http:" || url.protocol === "https:") {
					url.search = "";
					url.hash = "";
					cfg.server = (url.origin + url.pathname).replace(/\/+$/, "");
				} else {
					ctx.ui.notify("ntfy server must use http or https", "warning");
				}
			} catch {
				ctx.ui.notify("invalid ntfy server URL", "warning");
			}
		}
	} else if (label.startsWith("Topic:")) {
		const v = await ctx.ui.input("ntfy topic:", cfg.topic);
		if (v !== undefined) cfg.topic = v.trim();
	} else if (label.startsWith("Min Seconds:")) {
		const v = await ctx.ui.input("Minimum seconds to trigger:", String(cfg.minSeconds));
		if (v !== undefined) {
			const n = Number(v);
			if (Number.isFinite(n) && n >= 1) cfg.minSeconds = Math.floor(n);
		}
	} else if (label.startsWith("Timeout (ms):")) {
		const v = await ctx.ui.input("Fetch timeout in ms:", String(cfg.timeoutMs));
		if (v !== undefined) {
			const n = Number(v);
			if (Number.isFinite(n) && n >= 1000) cfg.timeoutMs = Math.min(Math.floor(n), 2_147_483_647);
		}
	} else if (label.startsWith("Auth Type:")) {
		const choice = await ctx.ui.select("Authentication type:", [
			"none (no auth)",
			"basic (username + password)",
			"bearer (token)",
		]);
		if (choice) {
			if (choice.startsWith("none")) {
				cfg.auth = { type: "none" };
			} else if (choice.startsWith("basic")) {
				cfg.auth = {
					type: "basic",
					username: cfg.auth.type === "basic" ? cfg.auth.username : undefined,
					password: cfg.auth.type === "basic" ? cfg.auth.password : undefined,
				};
			} else {
				cfg.auth = {
					type: "bearer",
					token: cfg.auth.type === "bearer" ? cfg.auth.token : undefined,
				};
			}
		}
	} else if (label.startsWith("Username:")) {
		const v = await ctx.ui.input("ntfy username:", cfg.auth.username ?? "");
		if (v !== undefined) cfg.auth.username = v.trim() || undefined;
	} else if (label.startsWith("Password:")) {
		const v = await ctx.ui.input("ntfy password (leave blank to keep, '-' to clear):", "");
		if (v !== undefined) {
			if (v === "-") cfg.auth.password = undefined;
			else if (v !== "") cfg.auth.password = v;
		}
	} else if (label.startsWith("Token:")) {
		const v = await ctx.ui.input("ntfy bearer token (leave blank to keep, '-' to clear):", "");
		if (v !== undefined) {
			if (v === "-") cfg.auth.token = undefined;
			else if (v !== "") cfg.auth.token = v;
		}
	}
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function extension(pi: ExtensionAPI) {
	// Load config from file on startup
	loadConfig();

	let startedAt = 0; // 0 = no valid start timestamp

	// /ntfy command — always available, even when notifications are disabled
	pi.registerCommand("ntfy", {
		description: "Configure ntfy notifications",
		handler: async (_args, ctx) => {
			const cfg = readConfig();
			let editing = true;

			while (editing) {
				const items = buildSettingItems(cfg);
				const choice = await ctx.ui.select("ntfy Configuration", items);
				if (choice === undefined) {
					editing = false;
					break;
				}
				if (choice.startsWith("---")) {
					if (cfg.enabled && !cfg.topic) {
						ctx.ui.notify("topic is required when ntfy is enabled", "warning");
						continue;
					}
					if (cfg.auth.type === "basic" && (!cfg.auth.username || !cfg.auth.password)) {
						ctx.ui.notify("basic auth requires both username and password", "warning");
						continue;
					}
					if (cfg.auth.type === "bearer" && !cfg.auth.token) {
						ctx.ui.notify("bearer auth requires a token", "warning");
						continue;
					}
					if (!writeConfig(cfg)) {
						ctx.ui.notify("failed to save ntfy config", "error");
						continue;
					}
					loadConfig();
					ctx.ui.notify("ntfy config saved", "info");
					editing = false;
					break;
				}
				await handleSetting(ctx, choice, cfg);
				// Changes are held in-memory only; saved on explicit "Save & exit"
			}
		},
	});

	// Always subscribe to events — isActive() guards behaviour so enabling via
	// /ntfy takes effect immediately without a /reload.
	pi.on("session_start", async () => {
		startedAt = 0;
		loadConfig();
	});

	pi.on("agent_start", async () => {
		if (!isActive()) return;
		startedAt = Date.now();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!isActive() || startedAt === 0) {
			startedAt = 0;
			return;
		}

		const start = startedAt;
		startedAt = 0;

		const seconds = Math.round((Date.now() - start) / 1000);
		if (seconds < runtimeCfg.minSeconds) return;

		let hasError = false;
		for (const msg of event.messages) {
			if (msg.role === "toolResult" && msg.isError === true) {
				hasError = true;
				break;
			}
		}

		const meta = buildNotifyMeta(
			ctx.cwd,
			ctx.sessionManager.getSessionFile() ?? undefined,
			pi.getSessionName() ?? undefined,
		);

		await sendNotification({ seconds, hasError, signal: ctx.signal, meta });
	});
}