/**
 * pi-lightpanda — a lightweight headless browser for the Pi agent via Lightpanda.
 *
 * Lightpanda (lightpanda.io) is a headless browser built from scratch for
 * machines: ~16x less memory and ~9x faster than Chrome headless, with a
 * Chrome DevTools Protocol (CDP) server the agent can drive.
 *
 * What this extension gives Pi:
 *   - `lightpanda_fetch`     one-shot page dump (markdown/html/text tree) via
 *                            `lightpanda fetch` — no server needed, cheapest path
 *   - `lightpanda_navigate`  navigate the persistent CDP page
 *   - `lightpanda_snapshot`  list interactive elements (refs) + page text
 *   - `lightpanda_act`       click / fill / type / select / press / hover by
 *                            ref (from the last snapshot) or CSS selector
 *   - `lightpanda_eval`      evaluate JavaScript in the page, return JSON
 *   - `lightpanda_run`       run a trusted PandaScript file (`lightpanda run`)
 *   - `lightpanda_status`    binary / server / page health (also /lightpanda)
 *
 * Design notes (mirrors pi-github-app-auth: few files, no build, stdlib-first):
 *   - Two runtime deps: `typebox` (tool schemas) and `puppeteer-core` (the
 *     CDP client — Lightpanda's documented automation path). `puppeteer-core`
 *     ships no browser, so unlike `puppeteer`/`playwright` it does not drag
 *     Chromium back in. Everything else is Node built-ins + the Pi API.
 *   - One persistent page per session (browser context + page opened on first
 *     use), so logins and state survive across tool calls. The `serve`
 *     subprocess is spawned on demand (loopback only) and killed on
 *     `session_shutdown` — but only if *we* spawned it. An already-running
 *     server is reused untouched.
 *   - All tool output is truncated (default 12 KB text / 50 refs) so a huge
 *     page can never blow up the LLM context.
 *   - Loopback-only guard: PI_LIGHTPANDA_HOST must be 127.0.0.1 / localhost /
 *     ::1. CDP grants full control of the browser (cookies, sessions), so a
 *     remote endpoint is refused outright.
 *   - Lightpanda has partial Web API coverage and no graphical rendering:
 *     complex sites may fail and screenshots are not offered. When a page
 *     needs full Chromium, use a Chromium-backed extension instead.
 *
 * Setup runs entirely inside Pi: /lightpanda setup downloads the nightly
 * binary to ~/.pi/agent/bin/lightpanda and verifies it — after that the tools
 * work immediately, no restart and no .envrc needed.
 *
 * Configuration (environment variables, e.g. via direnv):
 *   PI_LIGHTPANDA_BIN           path to the `lightpanda` binary (optional —
 *                               resolution order at call time: this variable,
 *                               then ~/.pi/agent/bin/lightpanda, then PATH)
 *   PI_LIGHTPANDA_HOST          CDP host, loopback only (default 127.0.0.1)
 *   PI_LIGHTPANDA_PORT          CDP port (default 9222)
 *   PI_LIGHTPANDA_TIMEOUT_MS    per-operation timeout (default 30000)
 *   PI_LIGHTPANDA_MAX_BYTES     max text bytes returned per tool (default 12288)
 *   PI_LIGHTPANDA_MAX_REFS      max snapshot refs (default 50)
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { Type } from "typebox";
import { binaryUsable, checkForUpdate, defaultBinPath, runSetupWizard, runUpdateWizard, type WizardUI } from "./setup.ts";

// --- config ----------------------------------------------------------------

interface LightpandaConfig {
	host: string;
	port: number;
	timeoutMs: number;
	maxBytes: number;
	maxRefs: number;
}

const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 12_288;
const DEFAULT_MAX_REFS = 50;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function parsePort(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
	const n = Number.parseInt(raw.trim(), 10);
	if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
	return n;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number | null {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number.parseInt(raw.trim(), 10);
	if (!Number.isInteger(n) || n <= 0) return null;
	return n;
}

function readConfig(env: NodeJS.ProcessEnv = process.env): { config: LightpandaConfig; error?: undefined } | { config?: undefined; error: string } {
	const host = (env.PI_LIGHTPANDA_HOST?.trim() || "127.0.0.1").toLowerCase();
	if (!LOOPBACK_HOSTS.has(host)) {
		return { error: `PI_LIGHTPANDA_HOST must be loopback (127.0.0.1, localhost, ::1) — got "${host}"` };
	}
	const port = parsePort(env.PI_LIGHTPANDA_PORT);
	if (port === null) return { error: `PI_LIGHTPANDA_PORT must be 1-65535 — got "${env.PI_LIGHTPANDA_PORT}"` };
	const timeoutMs = parsePositiveInt(env.PI_LIGHTPANDA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
	if (timeoutMs === null) return { error: `PI_LIGHTPANDA_TIMEOUT_MS must be a positive integer — got "${env.PI_LIGHTPANDA_TIMEOUT_MS}"` };
	const maxBytes = parsePositiveInt(env.PI_LIGHTPANDA_MAX_BYTES, DEFAULT_MAX_BYTES);
	if (maxBytes === null) return { error: `PI_LIGHTPANDA_MAX_BYTES must be a positive integer — got "${env.PI_LIGHTPANDA_MAX_BYTES}"` };
	const maxRefs = parsePositiveInt(env.PI_LIGHTPANDA_MAX_REFS, DEFAULT_MAX_REFS);
	if (maxRefs === null) return { error: `PI_LIGHTPANDA_MAX_REFS must be a positive integer — got "${env.PI_LIGHTPANDA_MAX_REFS}"` };
	return {
		config: {
			host: host === "localhost" ? "127.0.0.1" : host,
			port,
			timeoutMs,
			maxBytes,
			maxRefs,
		},
	};
}

/**
 * Binary resolution at call time (not load time): PI_LIGHTPANDA_BIN, then the
 * /lightpanda setup install path, then PATH. Dynamic so a successful
 * /lightpanda setup works immediately, without restarting Pi.
 */
function resolveBin(env: NodeJS.ProcessEnv = process.env, installedPath = defaultBinPath(), exists: (p: string) => boolean = existsSync): string {
	const fromEnv = env.PI_LIGHTPANDA_BIN?.trim();
	if (fromEnv) return fromEnv;
	if (exists(installedPath)) return installedPath;
	return "lightpanda";
}

// --- small pure helpers (tested) -------------------------------------------

const TRUNC_MARKER = "[truncated]";

function truncateText(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back to a UTF-8 boundary
	return buf.subarray(0, end).toString("utf8") + TRUNC_MARKER;
}

function isHttpUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/** First whitespace-separated token of raw command args ("" when blank). */
function parseSubcommand(args: string): string {
	return args.trim().split(/\s+/)[0] ?? "";
}

export interface SnapshotRef {
	ref: string;
	tag: string;
	text: string;
	selector: string;
	href?: string;
	type?: string;
}

function formatSnapshot(refs: SnapshotRef[], pageText: string, maxBytes: number): string {
	const lines = refs.map((r) => {
		const extra = [r.href ? `<${r.href}>` : "", r.type ? `[${r.type}]` : ""].filter(Boolean).join(" ");
		return `[${r.ref}] ${r.tag}${r.text ? ` "${r.text}"` : ""}${extra ? ` ${extra}` : ""} :: ${r.selector}`;
	});
	return truncateText(`refs:\n${lines.join("\n") || "(no interactive elements)"}\n\ntext:\n${pageText}`, maxBytes);
}

/**
 * Runs inside the page via page.evaluate(fn, maxRefs, maxBytes).
 * Self-contained (no closures) so puppeteer can serialize it.
 */
function collectSnapshot(maxRefs: number, maxBytes: number): { refs: SnapshotRef[]; text: string } {
	const els = Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"], [onclick]'));
	const seen = new Set<string>();
	const refs: SnapshotRef[] = [];
	for (const el of els) {
		if (refs.length >= maxRefs) break;
		if (!(el instanceof Element)) continue;
		const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
		if (rect && rect.width === 0 && rect.height === 0) continue;
		const tag = el.tagName.toLowerCase();
		const htmlEl = el as HTMLElement & { value?: string };
		const text = ((htmlEl.innerText || htmlEl.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "") as string)
			.trim()
			.replace(/\s+/g, " ")
			.slice(0, 120);
		const id = el.getAttribute("id");
		const name = el.getAttribute("name");
		let sel: string;
		if (id) sel = `#${id}`;
		else if (name) sel = `${tag}[name="${name}"]`;
		else {
			const cls = (el.getAttribute("class") || "").trim().split(/\s+/)[0] ?? "";
			sel = cls ? `${tag}.${cls}` : tag;
		}
		const key = `${tag}|${sel}|${text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push({
			ref: `e${refs.length + 1}`,
			tag,
			text,
			selector: sel,
			href: el.getAttribute("href") || undefined,
			type: el.getAttribute("type") || undefined,
		});
	}
	const body = (document.body?.innerText || document.documentElement.innerText || "").replace(/\s+/g, " ").trim();
	return { refs, text: body.slice(0, maxBytes) };
}

// --- binary + server lifecycle ----------------------------------------------

function endpointUrl(config: LightpandaConfig): string {
	const host = config.host.includes(":") ? `[${config.host}]` : config.host;
	return `ws://${host}:${config.port}`;
}

function httpBase(config: LightpandaConfig): string {
	const host = config.host.includes(":") ? `[${config.host}]` : config.host;
	return `http://${host}:${config.port}`;
}

async function probeServer(config: LightpandaConfig): Promise<{ ok: boolean; version?: string }> {
	try {
		const res = await fetch(`${httpBase(config)}/json/version`, { signal: AbortSignal.timeout(3000) });
		if (!res.ok) return { ok: false };
		const data = (await res.json().catch(() => null)) as { Browser?: unknown } | null;
		return { ok: true, version: typeof data?.Browser === "string" ? data.Browser : undefined };
	} catch {
		return { ok: false };
	}
}

let serverChild: ChildProcess | null = null;
let serverOurs = false;

async function waitForServer(config: LightpandaConfig, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if ((await probeServer(config)).ok) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** Reuse an already-running server, or spawn `lightpanda serve` and wait for it. */
async function ensureServer(config: LightpandaConfig): Promise<{ reused: boolean } | { error: string }> {
	if ((await probeServer(config)).ok) return { reused: true };
	if (serverChild && serverOurs) {
		// We spawned it but it is not answering (yet?) — wait briefly.
		if (await waitForServer(config, 5000)) return { reused: false };
		return { error: `the managed lightpanda server on port ${config.port} is not responding` };
	}
	let child: ChildProcess;
	const bin = resolveBin();
	try {
		child = spawn(bin, ["serve", "--host", config.host, "--port", String(config.port)], {
			stdio: "ignore",
			detached: process.platform !== "win32",
		});
	} catch (err) {
		return { error: `could not spawn "${bin} serve" — is lightpanda installed? (run /lightpanda setup): ${err instanceof Error ? err.message : String(err)}` };
	}
	child.unref();
	child.on("exit", () => {
		if (serverChild === child) {
			serverChild = null;
			serverOurs = false;
		}
	});
	serverChild = child;
	serverOurs = true;
	if (await waitForServer(config, 15_000)) return { reused: false };
	return { error: `"${resolveBin()} serve" did not answer on ${config.host}:${config.port} within 15s — is the binary working? Try \`${resolveBin()} version\`.` };
}

function stopManagedServer(): boolean {
	if (serverChild && serverOurs) {
		try {
			serverChild.kill();
		} catch {
			// already gone
		}
		serverChild = null;
		serverOurs = false;
		return true;
	}
	return false;
}

// --- persistent page via puppeteer-core (Lightpanda's documented CDP path) ---

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

function dropPage(): void {
	browser = null;
	context = null;
	page = null;
}

async function closePage(): Promise<void> {
	const b = browser;
	dropPage();
	try {
		await b?.disconnect();
	} catch {
		// already gone
	}
}

function isPageAlive(): boolean {
	return !!page && !page.isClosed();
}

/** One browser context + one page per session, shared by all tools. */
async function ensurePage(config: LightpandaConfig): Promise<{ page: Page; fresh: boolean } | { error: string }> {
	const srv = await ensureServer(config);
	if ("error" in srv) return srv;
	if (isPageAlive()) return { page: page!, fresh: false };
	await closePage().catch(() => {});
	try {
		browser = await puppeteer.connect({ browserWSEndpoint: endpointUrl(config) });
		context = await browser.createBrowserContext();
		page = await context.newPage();
		page.setDefaultTimeout(config.timeoutMs);
		return { page, fresh: true };
	} catch (err) {
		await closePage().catch(() => {});
		return { error: `could not open a Lightpanda page: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** Best-effort ready wait: domcontentloaded already happened in goto. */
async function waitForReady(p: Page, timeoutMs: number): Promise<void> {
	try {
		await p.waitForFunction("document.readyState === 'complete'", { timeout: Math.min(timeoutMs, 10_000) });
	} catch {
		// return what we have; never hang the agent on restless pages
	}
}

// --- fetch via CLI (no server needed) -----------------------------------------

function fetchArgs(url: string, format: string, waitMs: number, maxBytes: number): string[] {
	return ["fetch", url, "--dump", format, "--dump-max-bytes", String(maxBytes), "--wait-ms", String(waitMs)];
}

function runFetch(config: LightpandaConfig, url: string, format: string, waitMs: number, maxBytes: number): Promise<{ text: string } | { error: string }> {
	return new Promise((resolve) => {
		execFile(resolveBin(), fetchArgs(url, format, waitMs, maxBytes), { timeout: config.timeoutMs + 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				const detail = (stderr?.toString().trim() || err.message).slice(0, 500);
				resolve({ error: `lightpanda fetch failed: ${detail}${/ENOENT/.test(detail) ? " — binary not found, run /lightpanda setup" : ""}` });
				return;
			}
			resolve({ text: truncateText(stdout.toString(), maxBytes + TRUNC_MARKER.length) });
		});
	});
}

// --- tool result helper --------------------------------------------------------

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	return { content: [{ type: "text", text }], details: {} };
}

function toolError(err: unknown, what: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	const msg = err instanceof Error ? err.message : String(err);
	if (/closed|disconnected|detached|Target closed|Session closed|not connected/i.test(msg)) dropPage();
	return textResult(`error: ${what}: ${msg.slice(0, 800)}`);
}

// --- setup command (/lightpanda setup) -----------------------------------------

/** Install/verify the Lightpanda binary, entirely inside Pi — mirrors pi-github-app-auth's wizard pattern. */
async function runSetupCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"lightpanda: the setup wizard needs an interactive session (pi in a terminal). Headless alternative: install the binary yourself (https://lightpanda.io/docs) and set PI_LIGHTPANDA_BIN.",
			"warning",
		);
		return;
	}
	const ui: WizardUI = ctx.ui;
	try {
		const result = await runSetupWizard(ui);
		if (!result) return; // cancelled
		if (result.skipped) {
			ui.notify(`lightpanda: already usable at ${result.target}${result.version ? ` (${result.version})` : ""} — nothing to do.`, "info");
		} else {
			ui.notify(`lightpanda: installed ${result.version} at ${result.target} — tools work immediately, no restart needed (PI_LIGHTPANDA_BIN stays optional).`, "info");
		}
	} catch (err) {
		ui.notify(`lightpanda: setup failed — ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

/** Check releases in the background: network/API errors are intentionally silent. */
let startupUpdateCheckStarted = false;
function startBackgroundUpdateCheck(ctx: { hasUI: boolean; ui: Pick<WizardUI, "notify"> }): void {
	if (!ctx.hasUI || startupUpdateCheckStarted) return;
	startupUpdateCheckStarted = true;
	void checkForUpdate()
		.then((result) => {
			if (result.status === "update") {
				ctx.ui.notify(
					`lightpanda: a newer nightly build is available (published ${new Date(result.updatedAt).toLocaleDateString()}). Run /lightpanda update to review and install it.`,
					"info",
				);
			}
		})
		.catch(() => {
			// Offline, rate-limited, or unsupported metadata: never delay or warn at startup.
		});
}

async function runUpdateCommand(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("lightpanda: update needs an interactive session so you can confirm replacing the binary.", "warning");
		return;
	}
	const ui: WizardUI = ctx.ui;
	try {
		const result = await runUpdateWizard(ui);
		if (!result) return; // cancelled
		if (result.status === "missing") {
			ui.notify("lightpanda: no installed binary found — run /lightpanda setup first.", "warning");
		} else if (result.status === "current") {
			ui.notify(`lightpanda: already up to date (${result.binaryPath}).`, "info");
		} else {
			ui.notify(`lightpanda: updated to ${result.version} at ${result.target}.`, "info");
		}
	} catch (err) {
		ui.notify(`lightpanda: update failed — ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

// --- extension -----------------------------------------------------------------

export default function piLightpanda(pi: ExtensionAPI): void {
	const loaded = readConfig();
	if (loaded.error !== undefined) {
		console.error(`pi-lightpanda: ${loaded.error} — tools not registered`);
		pi.registerCommand("lightpanda", {
			description: "Lightweight browser status (misconfigured)",
			handler: async (_args, ctx) => {
				ctx.ui.notify(`lightpanda: ${loaded.error}`, "error");
			},
		});
		return;
	}
	const cfg = loaded.config;

	// ref -> selector map from the last snapshot (per session, in memory).
	let refMap = new Map<string, string>();

	pi.registerTool({
		name: "lightpanda_fetch",
		label: "Lightpanda fetch",
		description: "Fetch a page with the lightweight Lightpanda browser and return markdown/text. Cheapest path: no CDP server needed. Use for reading pages, scraping, checking content.",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL to fetch" }),
			format: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("html"), Type.Literal("semantic_tree_text")], { description: "Dump format" })),
			waitMs: Type.Optional(Type.Number({ description: "Wait after load, ms (default 3000, max 30000)" })),
		}),
		promptSnippet: "Fetch pages with lightpanda_fetch (lightweight, no server)",
		promptGuidelines: ["Prefer lightpanda_fetch for read-only page access; use navigate/snapshot/act only for multi-step interaction."],
		async execute(_toolCallId, params) {
			const p = params as { url: string; format?: string; waitMs?: number };
			if (!isHttpUrl(p.url)) return textResult(`error: refusing non-http(s) URL "${p.url}"`);
			const format = p.format ?? "markdown";
			const waitMs = Math.min(Math.max(p.waitMs ?? 3000, 0), 30_000);
			const out = await runFetch(cfg, p.url, format, waitMs, cfg.maxBytes);
			if ("error" in out) return textResult(`error: ${out.error}`);
			return textResult(out.text || "(empty page)");
		},
	});

	pi.registerTool({
		name: "lightpanda_navigate",
		label: "Lightpanda navigate",
		description: "Navigate the persistent Lightpanda page to a URL and wait for load. Starts the local server on demand; page state persists across tool calls.",
		parameters: Type.Object({
			url: Type.String({ description: "http(s) URL to open" }),
		}),
		async execute(_toolCallId, params) {
			const p = params as { url: string };
			if (!isHttpUrl(p.url)) return textResult(`error: refusing non-http(s) URL "${p.url}"`);
			const held = await ensurePage(cfg);
			if ("error" in held) return textResult(`error: ${held.error}`);
			try {
				await held.page.goto(p.url, { waitUntil: "domcontentloaded", timeout: cfg.timeoutMs });
				await waitForReady(held.page, 10_000);
				const title = await held.page.title().catch(() => "");
				refMap = new Map();
				return textResult(`ok: ${held.page.url()}${title ? ` — "${title.slice(0, 200)}"` : ""}`);
			} catch (err) {
				return toolError(err, "navigate failed");
			}
		},
	});

	pi.registerTool({
		name: "lightpanda_snapshot",
		label: "Lightpanda snapshot",
		description: "Snapshot the current Lightpanda page: interactive elements as [ref] markers plus page text. Follow with lightpanda_act using a ref.",
		parameters: Type.Object({}),
		async execute() {
			const held = await ensurePage(cfg);
			if ("error" in held) return textResult(`error: ${held.error}`);
			try {
				const data = await held.page.evaluate(collectSnapshot, cfg.maxRefs, cfg.maxBytes);
				const refs = Array.isArray(data.refs) ? data.refs.slice(0, cfg.maxRefs) : [];
				refMap = new Map(refs.map((r) => [r.ref, r.selector]));
				return textResult(`page: ${held.page.url()}\n${formatSnapshot(refs, String(data.text ?? ""), cfg.maxBytes)}`);
			} catch (err) {
				return toolError(err, "snapshot failed");
			}
		},
	});

	pi.registerTool({
		name: "lightpanda_act",
		label: "Lightpanda act",
		description: "Click / fill / type / select / press / hover on the current Lightpanda page, by snapshot ref (e.g. e3) or CSS selector. Re-snapshot after acting.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("click"), Type.Literal("fill"), Type.Literal("type"), Type.Literal("select"), Type.Literal("press"), Type.Literal("hover")], { description: "Action to perform" }),
			target: Type.String({ description: "Snapshot ref like e3, or a CSS selector" }),
			value: Type.Optional(Type.String({ description: "Value for fill/type/select/press" })),
		}),
		async execute(_toolCallId, params) {
			const p = params as { action: string; target: string; value?: string };
			const selector = refMap.get(p.target) ?? p.target;
			if (!selector.trim()) return textResult("error: empty target");
			const held = await ensurePage(cfg);
			if ("error" in held) return textResult(`error: ${held.error}`);
			try {
				const pg = held.page;
				if (p.action === "click") await pg.click(selector);
				else if (p.action === "hover") await pg.hover(selector);
				else if (p.action === "type") await pg.type(selector, p.value ?? "", { delay: 0 });
				else if (p.action === "fill") {
					await pg.$eval(
						selector,
						(el, v) => {
							const input = el as HTMLInputElement;
							input.focus();
							input.value = v as string;
							input.dispatchEvent(new Event("input", { bubbles: true }));
							input.dispatchEvent(new Event("change", { bubbles: true }));
						},
						p.value ?? "",
					);
				} else if (p.action === "select") await pg.select(selector, p.value ?? "");
				else if (p.action === "press") {
					await pg.focus(selector);
					const key = (p.value ?? "Enter") as Parameters<Page["keyboard"]["press"]>[0];
					await pg.keyboard.press(key);
				} else return textResult(`error: unknown action "${p.action}"`);
				await waitForReady(pg, 5000);
				refMap = new Map(); // stale — force a fresh snapshot next
				return textResult(`ok: ${p.action} ${p.target} — re-run lightpanda_snapshot to see the result`);
			} catch (err) {
				return toolError(err, "act failed");
			}
		},
	});

	pi.registerTool({
		name: "lightpanda_eval",
		label: "Lightpanda eval",
		description: "Evaluate JavaScript in the current Lightpanda page and return the JSON-serialized result. Keep expressions small and side-effect aware.",
		parameters: Type.Object({
			expression: Type.String({ description: "JS expression to evaluate" }),
		}),
		async execute(_toolCallId, params) {
			const p = params as { expression: string };
			if (!p.expression.trim()) return textResult("error: empty expression");
			if (p.expression.length > 4000) return textResult("error: expression too long (max 4000 chars)");
			const held = await ensurePage(cfg);
			if ("error" in held) return textResult(`error: ${held.error}`);
			try {
				const value = await held.page.evaluate(p.expression as unknown as string);
				const text = truncateText(typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined"), cfg.maxBytes);
				return textResult(text || "(undefined)");
			} catch (err) {
				return toolError(err, "eval failed");
			}
		},
	});

	pi.registerTool({
		name: "lightpanda_run",
		label: "Lightpanda run",
		description: "Run a trusted PandaScript file headlessly (`lightpanda run`). Only run scripts you trust, like a shell script. Produces reproducible automation without an LLM.",
		parameters: Type.Object({
			script: Type.String({ description: "Path to a .js PandaScript file in the workspace" }),
		}),
		async execute(_toolCallId, params) {
			const p = params as { script: string };
			if (!p.script.endsWith(".js")) return textResult("error: refusing non-.js script (PandaScript files end in .js)");
			if (p.script.includes("..")) return textResult("error: refusing path with ..");
			const out: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } = await new Promise((resolve) => {
				execFile(resolveBin(), ["run", p.script], { timeout: cfg.timeoutMs + 10_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
					if (err) {
						resolve(textResult(`error: lightpanda run failed: ${(stderr?.toString().trim() || err.message).slice(0, 800)}`));
						return;
					}
					resolve(textResult(truncateText(stdout.toString() || "(no output)", cfg.maxBytes)));
				});
			});
			return out;
		},
	});

	pi.registerTool({
		name: "lightpanda_status",
		label: "Lightpanda status",
		description: "Report Lightpanda binary version, CDP server reachability, and current page. No side effects.",
		parameters: Type.Object({}),
		async execute() {
			return textResult(await statusText(cfg));
		},
	});

	pi.registerCommand("lightpanda", {
		description: "Lightweight browser — subcommands: status | start | stop | setup | update",
		handler: async (args, ctx) => {
			const sub = parseSubcommand(args) || "status";
			if (sub === "status") {
				ctx.ui.notify(await statusText(cfg), "info");
			} else if (sub === "start") {
				const srv = await ensureServer(cfg);
				ctx.ui.notify("error" in srv ? `lightpanda: ${srv.error}` : `lightpanda: server up on ${cfg.host}:${cfg.port}${srv.reused ? " (already running)" : " (started)"}`, "error" in srv ? "error" : "info");
			} else if (sub === "stop") {
				await closePage().catch(() => {});
				ctx.ui.notify(stopManagedServer() ? "lightpanda: managed server stopped" : "lightpanda: no managed server to stop (external servers are left alone)", "info");
			} else if (sub === "setup") {
				await runSetupCommand(ctx);
			} else if (sub === "update") {
				await runUpdateCommand(ctx);
			} else {
				ctx.ui.notify(`lightpanda: unknown subcommand "${sub}" — try /lightpanda status, setup, or update`, "warning");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		startBackgroundUpdateCheck(ctx);
	});

	pi.on("session_shutdown", () => {
		void closePage().catch(() => {});
		stopManagedServer();
	});
}

async function statusText(config: LightpandaConfig): Promise<string> {
	const bin = resolveBin();
	const check = binaryUsable(bin);
	const version = check.usable ? check.version || "unknown version" : null;
	const probe = await probeServer(config);
	let pageLine = "page: —";
	if (isPageAlive()) {
		try {
			pageLine = `page: ${page!.url() || "(blank)"} (persistent session)`;
		} catch {
			dropPage();
		}
	}
	return [
		`binary: ${bin}${version ? ` (${version})` : " (not found — run /lightpanda setup)"}`,
		`server: ${config.host}:${config.port} — ${probe.ok ? `up${probe.version ? ` (${probe.version})` : ""}${serverOurs ? " (managed)" : " (external)"}` : "down"}`,
		pageLine,
		"note: partial Web API coverage, no screenshots — use Chromium-backed tools for complex sites",
	].join("\n");
}

// Exposed for self-check scripts only; pi itself only uses the default export.
export const _internals = {
	readConfig,
	resolveBin,
	parseSubcommand,
	truncateText,
	isHttpUrl,
	formatSnapshot,
	collectSnapshot,
	fetchArgs,
	endpointUrl,
	TRUNC_MARKER,
	LOOPBACK_HOSTS,
};
