/** Per-instance CDP lifecycle: reuse external servers, own only our context and child. */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";
import { resolveBin } from "./setup.ts";

export interface BrowserConfig {
	host: string;
	port: number;
	timeoutMs: number;
}

export function endpointUrl(config: BrowserConfig, protocol: "ws" | "http" = "ws"): string {
	const host = config.host.includes(":") ? `[${config.host}]` : config.host;
	return `${protocol}://${host}:${config.port}`;
}

export async function probeServer(config: BrowserConfig, parentSignal?: AbortSignal): Promise<{ ok: boolean; version?: string }> {
	try {
		const timeout = AbortSignal.timeout(3000);
		const res = await fetch(`${endpointUrl(config, "http")}/json/version`, { signal: parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout });
		if (!res.ok) return { ok: false };
		const data = (await res.json().catch(() => null)) as { Browser?: unknown } | null;
		return { ok: true, version: typeof data?.Browser === "string" ? data.Browser : undefined };
	} catch {
		return { ok: false };
	}
}

/** Own resources per extension instance, never across sessions or harnesses. */
export function createBrowserSession() {
	let serverChild: ChildProcess | null = null;

	async function waitForServer(config: BrowserConfig, timeoutMs: number, parentSignal?: AbortSignal): Promise<boolean> {
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
		while (!signal.aborted) {
			if ((await probeServer(config, signal)).ok && !signal.aborted) return true;
			await delay(100, undefined, { signal }).catch(() => {});
		}
		return false;
	}

	type ServerResult = { reused: boolean } | { error: string };
	let serverStarting: Promise<ServerResult> | null = null;

	/** Share startup even if callers bypass Pi's sequential tool scheduling. */
	async function ensureServer(config: BrowserConfig, signal?: AbortSignal): Promise<ServerResult> {
		if (serverStarting) return serverStarting;
		const starting = startServer(config, signal);
		serverStarting = starting;
		try { return await starting; }
		finally { if (serverStarting === starting) serverStarting = null; }
	}

	async function startServer(config: BrowserConfig, signal?: AbortSignal): Promise<ServerResult> {
		if (signal?.aborted) return { error: "server startup cancelled" };
		const existing = await probeServer(config, signal);
		if (signal?.aborted) return { error: "server startup cancelled" };
		if (existing.ok) return { reused: true };
		if (serverChild) {
			if (await waitForServer(config, Math.min(config.timeoutMs, 5000), signal)) return { reused: false };
			return { error: `the managed lightpanda server on port ${config.port} is not responding` };
		}
		const bin = resolveBin();
		let child: ChildProcess;
		try {
			child = spawn(bin, ["serve", "--host", config.host, "--port", String(config.port)], {
				stdio: "ignore", detached: process.platform !== "win32",
			});
		} catch (err) {
			return { error: `could not spawn "${bin} serve" — run /lightpanda setup: ${err instanceof Error ? err.message : String(err)}` };
		}
		const exited = new AbortController();
		let failure: string | undefined;
		const clear = () => { if (serverChild === child) serverChild = null; };
		// spawn() reports ENOENT/EACCES asynchronously, outside the try/catch above.
		child.once("error", (err) => {
			failure = `could not spawn "${bin} serve" — run /lightpanda setup: ${err.message}`;
			clear();
			exited.abort();
		});
		child.once("exit", (code, sig) => {
			failure = `"${bin} serve" exited before becoming ready (${sig ?? code})`;
			clear();
			exited.abort();
		});
		serverChild = child;
		child.unref();
		const startupSignal = signal ? AbortSignal.any([signal, exited.signal]) : exited.signal;
		const startupTimeoutMs = Math.min(config.timeoutMs, 15_000);
		if (await waitForServer(config, startupTimeoutMs, startupSignal)) return { reused: false };
		const error = failure ?? (signal?.aborted ? "server startup cancelled" : `"${bin} serve" did not answer on ${config.host}:${config.port} within ${startupTimeoutMs}ms`);
		if (serverChild === child) await stopManagedServer();
		return { error };
	}

	function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
		if (!child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
		return new Promise((resolve) => {
			const finish = (exited: boolean) => {
				clearTimeout(timer);
				child.removeListener("exit", onExit);
				child.removeListener("error", onExit);
				resolve(exited);
			};
			const onExit = () => finish(true);
			const timer = setTimeout(() => finish(false), timeoutMs);
			child.once("exit", onExit);
			child.once("error", onExit);
		});
	}

	async function stopManagedServer(): Promise<boolean> {
		const child = serverChild;
		if (!child) return false;
		const exited = waitForExit(child, 2000);
		child.kill();
		if (!(await exited)) {
			const killed = waitForExit(child, 1000);
			child.kill("SIGKILL");
			if (!(await killed)) throw new Error("managed Lightpanda server did not stop; refusing to start a second server");
		}
		if (serverChild === child) serverChild = null;
		return true;
	}

	// --- persistent page via puppeteer-core (Lightpanda's documented CDP path) ---

	let browser: Browser | null = null;
	let context: BrowserContext | null = null;
	let page: Page | null = null;

	async function closePage(): Promise<void> {
		const connection = browser;
		const ownedContext = context;
		browser = null;
		context = null;
		page = null;
		try { await ownedContext?.close(); }
		catch { /* already gone */ }
		finally { await connection?.disconnect().catch(() => {}); }
	}

	function isPageAlive(): boolean {
		return !!page && !page.isClosed();
	}

	/** One browser context + one page per session, shared by all tools. */
	async function ensurePage(config: BrowserConfig, signal?: AbortSignal): Promise<{ page: Page } | { error: string }> {
		const srv = await ensureServer(config, signal);
		if ("error" in srv) return srv;
		if (signal?.aborted) return { error: "browser operation cancelled" };
		if (isPageAlive()) return { page: page! };
		await closePage();
		// Do not publish half-open resources: a late connection must not resurrect
		// a shut-down session or clean up a newer session's browser by accident.
		let openedBrowser: Browser | undefined;
		let openedContext: BrowserContext | undefined;
		try {
			signal?.throwIfAborted();
			openedBrowser = await puppeteer.connect({ browserWSEndpoint: endpointUrl(config), protocolTimeout: config.timeoutMs });
			signal?.throwIfAborted();
			openedContext = await openedBrowser.createBrowserContext();
			signal?.throwIfAborted();
			const openedPage = await openedContext.newPage();
			signal?.throwIfAborted();
			openedPage.setDefaultTimeout(config.timeoutMs);
			browser = openedBrowser;
			context = openedContext;
			page = openedPage;
			return { page: openedPage };
		} catch (err) {
			await openedContext?.close().catch(() => {});
			await openedBrowser?.disconnect().catch(() => {});
			return { error: `could not open a Lightpanda page: ${err instanceof Error ? err.message : String(err)}` };
		}
	}

	return {
		ensureServer, stopManagedServer, ensurePage, closePage, isPageAlive,
		get managed() { return serverChild !== null; },
		pageUrl: () => isPageAlive() ? page!.url() : undefined,
	};
}

export type BrowserSession = ReturnType<typeof createBrowserSession>;
