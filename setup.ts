/** Install/update verified Lightpanda nightlies from inside Pi. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, existsSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rename, rm } from "node:fs/promises";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

const REPO = "lightpanda-io/browser";
const RELEASE_BASE = `https://github.com/${REPO}/releases/download/nightly`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/tags/nightly`;
const UPDATE_CHECK_TIMEOUT_MS = 3000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

export interface WizardUI {
	confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus?(key: string, text: string | undefined): void;
}

export interface SetupResult {
	target: string;
	version: string;
	skipped: boolean;
}

interface WizardOptions {
	env?: NodeJS.ProcessEnv;
	platform?: string;
	arch?: string;
	fetcher?: typeof fetch;
	signal?: AbortSignal;
	downloadTimeoutMs?: number;
}

export function assetName(platform: string, arch: string): string | null {
	if (platform === "darwin" && arch === "arm64") return "lightpanda-aarch64-macos";
	if (platform === "darwin" && arch === "x64") return "lightpanda-x86_64-macos";
	if (platform === "linux" && arch === "x64") return "lightpanda-x86_64-linux";
	if (platform === "linux" && arch === "arm64") return "lightpanda-aarch64-linux";
	return null;
}

export function defaultBinPath(): string {
	return join(homedir(), ".pi", "agent", "bin", "lightpanda");
}

/** Resolve bare command names exactly once, using the same PATH as child processes. */
function executableOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
	for (const directory of (env.PATH ?? process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
		const candidate = resolve(directory || ".", command);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch { /* try the next PATH entry */ }
	}
	return null;
}

function isCommandName(value: string): boolean {
	return !isAbsolute(value) && !value.includes("/") && !value.includes("\\");
}

/** Shared call-time resolution for tools, setup, status, and update detection. */
export function resolveBin(env: NodeJS.ProcessEnv = process.env, installedPath = defaultBinPath(), exists: (path: string) => boolean = existsSync): string {
	const configured = env.PI_LIGHTPANDA_BIN?.trim();
	if (configured) return isCommandName(configured) ? executableOnPath(configured, env) ?? configured : configured;
	if (exists(installedPath)) return installedPath;
	return "lightpanda";
}

/** Never silently install a bare override into the working directory. */
export function installTarget(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_LIGHTPANDA_BIN?.trim();
	if (!configured) return defaultBinPath();
	if (!isCommandName(configured)) return resolve(configured);
	const path = executableOnPath(configured, env);
	if (!path) throw new Error(`PI_LIGHTPANDA_BIN names "${configured}", but it was not found on PATH; set an explicit file path or unset the override`);
	return path;
}

export async function findInstalledBinary(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const selected = resolveBin(env);
	const path = isCommandName(selected) ? executableOnPath(selected, env) : resolve(selected);
	try {
		return path && statSync(path).isFile() ? path : null;
	} catch {
		return null;
	}
}

export function downloadUrl(asset: string): string {
	return `${RELEASE_BASE}/${asset}`;
}

/** Async even for status: a slow/broken binary must never freeze Pi's UI. */
export function binaryUsable(bin: string, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ usable: boolean; version?: string }> {
	return new Promise((resolve, reject) => {
		execFile(bin, ["version"], { encoding: "utf8", timeout: opts.timeoutMs ?? 15_000, maxBuffer: 64 * 1024, signal: opts.signal }, (err, stdout) => {
			if (opts.signal?.aborted) reject(opts.signal.reason);
			else resolve(err ? { usable: false } : { usable: true, version: stdout.trim().split("\n")[0] });
		});
	});
}

export function formatDownloadProgress(downloadedBytes: number, totalBytes?: number): string {
	const downloadedMb = (downloadedBytes / (1024 * 1024)).toFixed(1);
	if (totalBytes && totalBytes > 0) {
		const totalMb = (totalBytes / (1024 * 1024)).toFixed(1);
		const percent = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
		return `Downloading Lightpanda: ${downloadedMb} / ${totalMb} MB (${percent}%)`;
	}
	return `Downloading Lightpanda: ${downloadedMb} MB`;
}

/** Stream to a new file with bounded time/size and incremental hashing, not an in-memory binary. */
export async function downloadBinary(
	url: string,
	dest: string,
	onProgress?: (downloadedBytes: number, totalBytes?: number) => void,
	opts: { fetcher?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
	const timeout = AbortSignal.timeout(opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
	const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
	const res = await (opts.fetcher ?? fetch)(url, { redirect: "follow", signal });
	if (!res.ok || !res.body) {
		await res.body?.cancel();
		throw new Error(`download failed: HTTP ${res.status} — check https://github.com/${REPO}/releases`);
	}
	const source = Readable.fromWeb(res.body as NodeReadableStream<Uint8Array>);
	const contentLength = Number(res.headers.get("content-length"));
	const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
	const hash = createHash("sha256");
	let downloadedBytes = 0;
	let lastUpdate = 0;
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		signal.throwIfAborted();
		if (totalBytes && totalBytes > MAX_DOWNLOAD_BYTES) throw new Error("download exceeds the 256 MB safety limit");
		await mkdir(dirname(dest), { recursive: true });
		file = await open(dest, "wx", 0o700);
		onProgress?.(0, totalBytes);
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				downloadedBytes += chunk.length;
				if (downloadedBytes > MAX_DOWNLOAD_BYTES) return callback(new Error("download exceeds the 256 MB safety limit"));
				hash.update(chunk);
				try {
					const now = Date.now();
					if (now - lastUpdate >= 400) {
						onProgress?.(downloadedBytes, totalBytes);
						lastUpdate = now;
					}
					callback(null, chunk);
				} catch (err) {
					callback(err instanceof Error ? err : new Error(String(err)));
				}
			},
		});
		await pipeline(source, meter, file.createWriteStream(), { signal });
		if (downloadedBytes < 1024 * 1024) throw new Error(`downloaded file suspiciously small (${downloadedBytes} bytes) — the nightly asset may be missing`);
		if (totalBytes && downloadedBytes !== totalBytes) throw new Error("download size does not match Content-Length");
		signal.throwIfAborted();
		await chmod(dest, 0o755);
		onProgress?.(downloadedBytes, totalBytes);
		return hash.digest("hex");
	} catch (err) {
		if (file) {
			await file.close().catch(() => {});
			await rm(dest, { force: true });
		}
		throw err;
	} finally {
		// Cancel HTTP bodies even when opening the destination failed.
		source.destroy();
		await file?.close().catch(() => {});
	}
}

export interface LatestAssetInfo {
	sha256: string;
	updatedAt: string;
}

export type UpdateCheckResult =
	| { status: "missing" }
	| { status: "current"; binaryPath: string; updatedAt: string }
	| { status: "update"; binaryPath: string; target: string; updatedAt: string; sha256: string };

export async function fetchLatestAssetInfo(asset: string, fetcher: typeof fetch = fetch, parentSignal?: AbortSignal): Promise<LatestAssetInfo> {
	const timeout = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
	const response = await fetcher(RELEASE_API, {
		headers: { accept: "application/vnd.github+json", "user-agent": "pi-lightpanda" },
		signal: parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout,
	});
	if (!response.ok) throw new Error(`GitHub release API returned HTTP ${response.status}`);
	const release = (await response.json()) as { assets?: Array<{ name?: unknown; digest?: unknown; updated_at?: unknown }> };
	const found = release.assets?.find((item) => item.name === asset);
	const digest = typeof found?.digest === "string" ? found.digest.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase() : undefined;
	if (!digest || typeof found?.updated_at !== "string" || !Number.isFinite(Date.parse(found.updated_at))) throw new Error(`release asset metadata unavailable for ${asset}`);
	return { sha256: digest, updatedAt: found.updated_at };
}

export function sha256File(path: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path, { signal });
		stream.on("data", (chunk: Buffer) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

/** A digest mismatch means different, not necessarily chronologically newer. */
export async function checkForUpdate(opts: WizardOptions = {}): Promise<UpdateCheckResult> {
	opts.signal?.throwIfAborted();
	const binaryPath = await findInstalledBinary(opts.env);
	if (!binaryPath) return { status: "missing" };
	const asset = assetName(opts.platform ?? osPlatform(), opts.arch ?? osArch());
	if (!asset) throw new Error(`unsupported platform ${opts.platform ?? osPlatform()}/${opts.arch ?? osArch()}`);
	const [localDigest, latest] = await Promise.all([
		sha256File(binaryPath, opts.signal),
		fetchLatestAssetInfo(asset, opts.fetcher, opts.signal),
	]);
	if (localDigest === latest.sha256) return { status: "current", binaryPath, updatedAt: latest.updatedAt };
	return { status: "update", binaryPath, target: installTarget(opts.env), ...latest };
}

/** Both setup and update keep the previous file intact until all checks succeed. */
async function installVerifiedBinary(ui: WizardUI, asset: string, target: string, digest: string, statusKey: string, opts: WizardOptions): Promise<string> {
	await mkdir(dirname(target), { recursive: true });
	const tempDir = await mkdtemp(join(dirname(target), ".lightpanda-download-"));
	const tempPath = join(tempDir, "lightpanda");
	try {
		ui.setStatus?.(statusKey, formatDownloadProgress(0));
		const downloadedDigest = await downloadBinary(downloadUrl(asset), tempPath, (downloaded, total) => {
			ui.setStatus?.(statusKey, formatDownloadProgress(downloaded, total));
		}, { fetcher: opts.fetcher, signal: opts.signal, timeoutMs: opts.downloadTimeoutMs });
		if (downloadedDigest !== digest) throw new Error("downloaded asset digest does not match GitHub release metadata; retry if the nightly changed during installation");
		const verified = await binaryUsable(tempPath, { signal: opts.signal });
		if (!verified.usable) throw new Error("downloaded nightly did not pass `lightpanda version`; original binary was left in place");
		opts.signal?.throwIfAborted();
		await rename(tempPath, target);
		return verified.version ?? "unknown version";
	} finally {
		try { ui.setStatus?.(statusKey, undefined); }
		finally { await rm(tempDir, { recursive: true, force: true }); }
	}
}

export async function runUpdateWizard(
	ui: WizardUI,
	opts: WizardOptions = {},
): Promise<Exclude<UpdateCheckResult, { status: "update" }> | { status: "updated"; target: string; version: string } | null> {
	const result = await checkForUpdate(opts);
	if (result.status !== "update") return result;
	const confirmed = await ui.confirm(
		"lightpanda — update",
		`The latest Lightpanda nightly asset (published ${result.updatedAt}) differs from your installed binary. Replace ${result.binaryPath} with the verified build at ${result.target}? This may replace a custom or stable build.`,
		{ signal: opts.signal },
	);
	if (!confirmed) {
		ui.notify("lightpanda: update cancelled.", "info");
		return null;
	}
	opts.signal?.throwIfAborted();
	const asset = assetName(opts.platform ?? osPlatform(), opts.arch ?? osArch())!;
	ui.notify(`lightpanda: downloading update ${asset} …`, "info");
	const version = await installVerifiedBinary(ui, asset, result.target, result.sha256, "pi-lightpanda-update", opts);
	return { status: "updated", target: result.target, version };
}

export async function runSetupWizard(ui: WizardUI, opts: WizardOptions = {}): Promise<SetupResult | null> {
	opts.signal?.throwIfAborted();
	const platform = opts.platform ?? osPlatform();
	const arch = opts.arch ?? osArch();
	const asset = assetName(platform, arch);
	if (!asset) throw new Error(`unsupported platform ${platform}/${arch} — Lightpanda has no native Windows binary; install and run both Pi and Lightpanda inside WSL2 (https://lightpanda.io/docs)`);
	const target = installTarget(opts.env);
	const existingPath = await findInstalledBinary(opts.env) ?? target;
	const existing = await binaryUsable(existingPath, { signal: opts.signal });
	if (existing.usable) return { target: existingPath, version: existing.version ?? "", skipped: true };
	const go = await ui.confirm(
		"lightpanda — setup",
		`Download the Lightpanda nightly build (${asset}) from github.com/${REPO} to ${target}?`,
		{ signal: opts.signal },
	);
	if (!go) {
		ui.notify("lightpanda: setup cancelled.", "info");
		return null;
	}
	opts.signal?.throwIfAborted();
	const latest = await fetchLatestAssetInfo(asset, opts.fetcher, opts.signal);
	ui.notify(`lightpanda: downloading ${asset} …`, "info");
	const version = await installVerifiedBinary(ui, asset, target, latest.sha256, "pi-lightpanda-setup", opts);
	return { target, version, skipped: false };
}

export const _setupInternals = {
	assetName, formatDownloadProgress, defaultBinPath, installTarget, resolveBin, downloadUrl,
	binaryUsable, downloadBinary, runSetupWizard, fetchLatestAssetInfo, sha256File,
	findInstalledBinary, checkForUpdate, runUpdateWizard,
};
