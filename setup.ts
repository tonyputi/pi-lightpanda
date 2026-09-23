#!/usr/bin/env node
/**
 * pi-lightpanda setup — install the Lightpanda binary (nightly) for the Pi agent.
 *
 * Lightpanda ships as a single binary per platform (no npm wrapper needed
 * here — downloading straight from GitHub releases keeps zero runtime deps).
 * This command picks the right asset, downloads it, chmods +x, verifies it
 * with `lightpanda version`, and prints the `.envrc` block.
 *
 *   npx pi-lightpanda-setup [--bin <path>] [--envrc <path>] [--check]
 *
 * Secrets discipline: there are no secrets involved at all. The only thing
 * emitted is a file path.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "lightpanda-io/browser";
const NIGHTLY_TAG = "nightly";
const RELEASE_BASE = `https://github.com/${REPO}/releases/download/${NIGHTLY_TAG}`;

interface SetupArgs {
	binPath?: string;
	envrcPath?: string;
	check?: boolean;
	help?: boolean;
}

const USAGE = `pi-lightpanda setup — install the Lightpanda binary (nightly)

Usage: pi-lightpanda-setup [--bin <path>] [--envrc <path>] [--check]

  --bin <path>    where to install the binary
                  (default: ~/.pi/agent/bin/lightpanda)
  --envrc <path>  append the export block to <path> instead of only printing it
  --check         only report platform asset + whether a binary is already usable
  -h, --help      this text

No secrets: the output is just PI_LIGHTPANDA_BIN pointing at the binary.`;

function parseArgs(argv: string[]): SetupArgs {
	const args: SetupArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--bin") {
			const v = argv[++i];
			if (!v) throw new Error("missing value for --bin\n\n" + USAGE);
			args.binPath = v;
		} else if (a === "--envrc") {
			const v = argv[++i];
			if (!v) throw new Error("missing value for --envrc\n\n" + USAGE);
			args.envrcPath = v;
		} else if (a === "--check") {
			args.check = true;
		} else if (a === "-h" || a === "--help") {
			args.help = true;
		} else {
			throw new Error(`unknown argument "${a}"\n\n${USAGE}`);
		}
	}
	return args;
}

/**
 * Map node platform/arch to a Lightpanda nightly asset name.
 * Returns null for unsupported platforms (native Windows: use WSL).
 */
function assetName(platform: string, arch: string): string | null {
	if (platform === "darwin" && arch === "arm64") return "lightpanda-aarch64-macos";
	if (platform === "darwin" && arch === "x64") return "lightpanda-x86_64-macos";
	if (platform === "linux" && arch === "x64") return "lightpanda-x86_64-linux";
	if (platform === "linux" && arch === "arm64") return "lightpanda-aarch64-linux";
	return null;
}

function defaultBinPath(): string {
	return join(homedir(), ".pi", "agent", "bin", "lightpanda");
}

function downloadUrl(asset: string): string {
	return `${RELEASE_BASE}/${asset}`;
}

/** `.envrc` block for direnv (no secrets — just the binary path). */
function formatEnvrc(binPath: string): string {
	return `export PI_LIGHTPANDA_BIN="${binPath}"`;
}

/** True when `bin version` runs successfully. */
function binaryUsable(bin: string): { usable: boolean; version?: string } {
	try {
		const out = execFileSync(bin, ["version"], { encoding: "utf8", timeout: 15_000 }).trim().split("\n")[0];
		return { usable: true, version: out };
	} catch {
		return { usable: false };
	}
}

async function downloadBinary(url: string, dest: string): Promise<void> {
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

/** The setup CLI runs standalone under plain node (native type stripping since 22.18). */
function checkNodeVersion(version: string): void {
	const [major, minor] = version.split(".").map(Number);
	if (!Number.isInteger(major) || major < 22 || (major === 22 && (!Number.isInteger(minor) || minor < 18))) {
		throw new Error(`node ${version} is too old — setup needs node >= 22.18 (native type stripping)`);
	}
}

async function main(argv: string[]): Promise<void> {
	checkNodeVersion(process.versions.node);
	const args = parseArgs(argv);
	if (args.help) {
		console.log(USAGE);
		return;
	}
	const asset = assetName(osPlatform(), osArch());
	if (!asset) {
		throw new Error(
			`unsupported platform ${osPlatform()}/${osArch()} — Lightpanda has no native Windows binary; run it inside WSL2 following the Linux steps (https://lightpanda.io/docs), then set PI_LIGHTPANDA_BIN to a wrapper or leave the default port 9222 with an external server`,
		);
	}
	const binPath = args.binPath ?? process.env.PI_LIGHTPANDA_BIN?.trim() ?? defaultBinPath();

	if (args.check) {
		const found = binaryUsable(process.env.PI_LIGHTPANDA_BIN?.trim() || binPath) .usable
			? binPath
			: binaryUsable("lightpanda").usable
				? "lightpanda (PATH)"
				: null;
		console.log(`platform asset: ${asset}\n${found ? `binary usable: ${found}` : `no usable binary — run: pi-lightpanda-setup --bin "${binPath}"`}`);
		return;
	}

	console.log(`Installing Lightpanda (${asset}) -> ${binPath}`);
	const existing = binaryUsable(binPath);
	if (existing.usable) {
		console.log(`Binary already usable (${existing.version}). Skipping download.`);
	} else {
		await downloadBinary(downloadUrl(asset), binPath);
		const check = binaryUsable(binPath);
		if (!check.usable) throw new Error(`installed but \`${binPath} version\` does not run — wrong platform asset or missing system libs?`);
		console.log(`Verified: ${check.version}`);
	}
	emit(binPath, args.envrcPath);
}

function emit(binPath: string, envrcPath?: string): void {
	const block = formatEnvrc(binPath);
	if (envrcPath) {
		appendFileSync(envrcPath, (needsLeadingNewline(envrcPath) ? "\n" : "") + block + "\n", { mode: 0o600 });
		console.log(`\nAppended to ${envrcPath}. Reload direnv, restart Pi, then run /lightpanda status.`);
	} else {
		console.log(`\nStore this block (e.g. in .envrc via direnv):\n\n${block}\n\nThen reload direnv, restart Pi, and run /lightpanda status.`);
	}
}

function needsLeadingNewline(path: string): boolean {
	try {
		const tail = readFileSync(path, "utf8").slice(-1);
		return tail !== "" && tail !== "\n";
	} catch {
		return false;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main(process.argv.slice(2)).catch((err: unknown) => {
		console.error(`pi-lightpanda setup: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}

// Exposed for self-check scripts only.
export const _setupInternals = {
	parseArgs,
	assetName,
	defaultBinPath,
	downloadUrl,
	formatEnvrc,
	binaryUsable,
	checkNodeVersion,
	USAGE,
};
