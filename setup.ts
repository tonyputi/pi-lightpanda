/**
 * pi-lightpanda setup — install the Lightpanda binary (nightly) from inside Pi.
 *
 * Invoked by `/lightpanda setup` (wired up in index.ts): picks the right asset
 * for the platform, downloads it from the lightpanda-io/browser GitHub
 * releases, writes it executable, and verifies it with `lightpanda version`.
 * The extension resolves the binary as PI_LIGHTPANDA_BIN ->
 * ~/.pi/agent/bin/lightpanda -> PATH, so after a successful setup the tools
 * work immediately — no restart, no .envrc.
 *
 * Secrets discipline: there are no secrets involved at all. The only thing
 * written is the binary itself.
 */

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { dirname, join } from "node:path";

const REPO = "lightpanda-io/browser";
const NIGHTLY_TAG = "nightly";
const RELEASE_BASE = `https://github.com/${REPO}/releases/download/${NIGHTLY_TAG}`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/tags/${NIGHTLY_TAG}`;
const UPDATE_CHECK_TIMEOUT_MS = 3000;

/** Minimal UI surface the wizard needs (structurally pi's ctx.ui). */
export interface WizardUI {
	confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus?(key: string, text: string | undefined): void;
}

export interface SetupResult {
	/** Where the binary was installed (or found already installed). */
	target: string;
	/** First line of `lightpanda version` ("" when it printed nothing). */
	version: string;
	/** True when a usable binary was already in place and nothing was downloaded. */
	skipped: boolean;
}

/**
 * Map node platform/arch to a Lightpanda nightly asset name.
 * Returns null for unsupported platforms (native Windows: use WSL).
 */
export function assetName(platform: string, arch: string): string | null {
	if (platform === "darwin" && arch === "arm64") return "lightpanda-aarch64-macos";
	if (platform === "darwin" && arch === "x64") return "lightpanda-x86_64-macos";
	if (platform === "linux" && arch === "x64") return "lightpanda-x86_64-linux";
	if (platform === "linux" && arch === "arm64") return "lightpanda-aarch64-linux";
	return null;
}

/** Default install location, shared with the extension's bin resolution. */
export function defaultBinPath(): string {
	return join(homedir(), ".pi", "agent", "bin", "lightpanda");
}

/** Where `/lightpanda setup` installs: PI_LIGHTPANDA_BIN if set, else the default path. */
export function installTarget(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_LIGHTPANDA_BIN?.trim() || defaultBinPath();
}

export function downloadUrl(asset: string): string {
	return `${RELEASE_BASE}/${asset}`;
}

/** True when `bin version` runs successfully. */
export function binaryUsable(bin: string): { usable: boolean; version?: string } {
	try {
		const out = execFileSync(bin, ["version"], { encoding: "utf8", timeout: 15_000 }).trim().split("\n")[0];
		return { usable: true, version: out };
	} catch {
		return { usable: false };
	}
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

export async function downloadBinary(url: string, dest: string, onProgress?: (downloadedBytes: number, totalBytes?: number) => void): Promise<string> {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} — check https://github.com/${REPO}/releases`);

	const contentLength = Number(res.headers.get("content-length"));
	const totalBytes = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let downloadedBytes = 0;
	let lastUpdate = 0;
	onProgress?.(0, totalBytes);
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		downloadedBytes += value.byteLength;
		const now = Date.now();
		if (now - lastUpdate >= 400) {
			onProgress?.(downloadedBytes, totalBytes);
			lastUpdate = now;
		}
	}
	onProgress?.(downloadedBytes, totalBytes);

	if (downloadedBytes < 1024 * 1024) {
		// A real binary is tens of MB; anything smaller is an error page.
		throw new Error(`downloaded file suspiciously small (${downloadedBytes} bytes) — the nightly asset may be missing`);
	}
	mkdirSync(dirname(dest), { recursive: true });
	const buf = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), downloadedBytes);
	writeFileSync(dest, buf, { mode: 0o755 });
	chmodSync(dest, 0o755);
	return createHash("sha256").update(buf).digest("hex");
}

/** GitHub metadata for the current platform's nightly executable asset. */
export interface LatestAssetInfo {
	sha256: string;
	updatedAt: string;
}

export type UpdateCheckResult =
	| { status: "missing" }
	| { status: "current"; binaryPath: string; updatedAt: string }
	| { status: "update"; binaryPath: string; target: string; updatedAt: string };

/** Look up the published asset digest; the API call is bounded and read-only. */
export async function fetchLatestAssetInfo(asset: string, fetcher: typeof fetch = fetch): Promise<LatestAssetInfo> {
	const response = await fetcher(RELEASE_API, {
		headers: { accept: "application/vnd.github+json", "user-agent": "pi-lightpanda" },
		signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`GitHub release API returned HTTP ${response.status}`);
	const release = (await response.json()) as { assets?: Array<{ name?: unknown; digest?: unknown; updated_at?: unknown }> };
	const found = release.assets?.find((item) => item.name === asset);
	const digest = typeof found?.digest === "string" ? found.digest.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase() : undefined;
	if (!digest || typeof found?.updated_at !== "string") throw new Error(`release asset metadata unavailable for ${asset}`);
	return { sha256: digest, updatedAt: found.updated_at };
}

export function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk: Buffer) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

function findOnPath(): Promise<string | null> {
	return new Promise((resolve) => {
		const command = process.platform === "win32" ? "where" : "which";
		execFile(command, ["lightpanda"], { timeout: 1500 }, (err, stdout) => {
			const path = err ? "" : stdout.toString().split(/\r?\n/)[0]?.trim() ?? "";
			resolve(path && existsSync(path) ? path : null);
		});
	});
}

export async function findInstalledBinary(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
	const configured = env.PI_LIGHTPANDA_BIN?.trim();
	if (configured) return existsSync(configured) ? configured : null;
	const installed = defaultBinPath();
	if (existsSync(installed)) return installed;
	return findOnPath();
}

/** Compare the installed executable with the platform asset's published SHA-256. */
export async function checkForUpdate(
	opts: { env?: NodeJS.ProcessEnv; platform?: string; arch?: string; fetcher?: typeof fetch } = {},
): Promise<UpdateCheckResult> {
	const binaryPath = await findInstalledBinary(opts.env);
	if (!binaryPath) return { status: "missing" };
	const asset = assetName(opts.platform ?? osPlatform(), opts.arch ?? osArch());
	if (!asset) throw new Error(`unsupported platform ${opts.platform ?? osPlatform()}/${opts.arch ?? osArch()}`);
	const [localDigest, latest] = await Promise.all([
		sha256File(binaryPath),
		fetchLatestAssetInfo(asset, opts.fetcher),
	]);
	if (localDigest === latest.sha256) return { status: "current", binaryPath, updatedAt: latest.updatedAt };
	return { status: "update", binaryPath, target: installTarget(opts.env), updatedAt: latest.updatedAt };
}

/** Download, verify the release digest and executable, then atomically replace the installed binary. */
export async function runUpdateWizard(
	ui: WizardUI,
	opts: { env?: NodeJS.ProcessEnv; platform?: string; arch?: string; fetcher?: typeof fetch } = {},
): Promise<Exclude<UpdateCheckResult, { status: "update" }> | { status: "updated"; target: string; version: string } | null> {
	const result = await checkForUpdate(opts);
	if (result.status === "missing") return result;
	if (result.status === "current") return result;
	const asset = assetName(opts.platform ?? osPlatform(), opts.arch ?? osArch())!;
	const confirmed = await ui.confirm(
		"lightpanda — update",
		`A newer Lightpanda nightly asset is available (published ${result.updatedAt}). Replace ${result.binaryPath} with the verified build at ${result.target}?`,
	);
	if (!confirmed) {
		ui.notify("lightpanda: update cancelled.", "info");
		return null;
	}
	const tempPath = `${result.target}.download-${process.pid}-${Date.now()}`;
	const statusKey = "pi-lightpanda-update";
	ui.notify(`lightpanda: downloading update ${asset} …`, "info");
	try {
		ui.setStatus?.(statusKey, formatDownloadProgress(0));
		const downloadedDigest = await downloadBinary(downloadUrl(asset), tempPath, (downloaded, total) => {
			ui.setStatus?.(statusKey, formatDownloadProgress(downloaded, total));
		});
		const latest = await fetchLatestAssetInfo(asset, opts.fetcher);
		if (downloadedDigest !== latest.sha256) throw new Error("downloaded asset digest does not match GitHub release metadata");
		const verified = binaryUsable(tempPath);
		if (!verified.usable) throw new Error("downloaded nightly did not pass `lightpanda version`; original binary was left in place");
		renameSync(tempPath, result.target);
		chmodSync(result.target, 0o755);
		return { status: "updated", target: result.target, version: verified.version ?? "unknown version" };
	} finally {
		ui.setStatus?.(statusKey, undefined);
		rmSync(tempPath, { force: true });
	}
}

/**
 * The interactive setup flow, as run by /lightpanda setup. Throws on hard
 * failures (the caller surfaces them); returns null when the user cancelled.
 * Never touches the pi runtime itself — the extension resolves the binary
 * dynamically, so no reload is needed after a successful install.
 */
export async function runSetupWizard(
	ui: WizardUI,
	opts: { platform?: string; arch?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SetupResult | null> {
	const platform = opts.platform ?? osPlatform();
	const arch = opts.arch ?? osArch();
	const asset = assetName(platform, arch);
	if (!asset) {
		throw new Error(
			`unsupported platform ${platform}/${arch} — Lightpanda has no native Windows binary; run it inside WSL2 (https://lightpanda.io/docs) and set PI_LIGHTPANDA_BIN to the host serving CDP`,
		);
	}
	const target = installTarget(opts.env);
	const existing = binaryUsable(target);
	if (existing.usable) {
		return { target, version: existing.version ?? "", skipped: true };
	}
	const go = await ui.confirm(
		"lightpanda — setup",
		`Download the Lightpanda nightly build (${asset}) from github.com/${REPO} to ${target}?`,
	);
	if (!go) {
		ui.notify("lightpanda: setup cancelled.", "info");
		return null;
	}
	ui.notify(`lightpanda: downloading ${asset} …`, "info");
	const statusKey = "pi-lightpanda-setup";
	try {
		ui.setStatus?.(statusKey, formatDownloadProgress(0));
		await downloadBinary(downloadUrl(asset), target, (downloaded, total) => {
			ui.setStatus?.(statusKey, formatDownloadProgress(downloaded, total));
		});
	} finally {
		ui.setStatus?.(statusKey, undefined);
	}
	const check = binaryUsable(target);
	if (!check.usable) {
		throw new Error(`installed to ${target} but \`lightpanda version\` does not run — wrong platform asset or missing system libs?`);
	}
	return { target, version: check.version ?? "", skipped: false };
}

// Exposed for self-check scripts only; pi itself uses the wizard via index.ts.
export const _setupInternals = {
	assetName,
	formatDownloadProgress,
	defaultBinPath,
	installTarget,
	downloadUrl,
	binaryUsable,
	downloadBinary,
	runSetupWizard,
	fetchLatestAssetInfo,
	sha256File,
	findInstalledBinary,
	checkForUpdate,
	runUpdateWizard,
};
