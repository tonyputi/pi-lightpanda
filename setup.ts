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

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { dirname, join } from "node:path";

const REPO = "lightpanda-io/browser";
const NIGHTLY_TAG = "nightly";
const RELEASE_BASE = `https://github.com/${REPO}/releases/download/${NIGHTLY_TAG}`;

/** Minimal UI surface the wizard needs (structurally pi's ctx.ui). */
export interface WizardUI {
	confirm(title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
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

export async function downloadBinary(url: string, dest: string): Promise<void> {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} — check https://github.com/${REPO}/releases`);
	mkdirSync(dirname(dest), { recursive: true });
	const buf = Buffer.from(await res.arrayBuffer());
	if (buf.length < 1024 * 1024) {
		// A real binary is tens of MB; anything smaller is an error page.
		throw new Error(`downloaded file suspiciously small (${buf.length} bytes) — the nightly asset may be missing`);
	}
	writeFileSync(dest, buf, { mode: 0o755 });
	chmodSync(dest, 0o755);
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
	ui.notify(`lightpanda: downloading ${asset} … (tens of MB, a moment)`, "info");
	await downloadBinary(downloadUrl(asset), target);
	const check = binaryUsable(target);
	if (!check.usable) {
		throw new Error(`installed to ${target} but \`lightpanda version\` does not run — wrong platform asset or missing system libs?`);
	}
	return { target, version: check.version ?? "", skipped: false };
}

// Exposed for self-check scripts only; pi itself uses the wizard via index.ts.
export const _setupInternals = {
	assetName,
	defaultBinPath,
	installTarget,
	downloadUrl,
	binaryUsable,
	downloadBinary,
	runSetupWizard,
};
