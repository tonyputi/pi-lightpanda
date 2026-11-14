/** Verify the artifact users install, not only the checkout used by CI. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

await test("npm package contains the extension and linked documentation, but no tests or development files", async () => {
	const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: import.meta.dirname });
	const [artifact] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
	const files = new Set(artifact.files.map((file) => file.path));
	const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")) as { pi: { extensions: string[] } };
	for (const entry of manifest.pi.extensions) assert.ok(files.has(entry.replace(/^\.\//, "")), `extension entrypoint ${entry} is included`);
	for (const path of files) {
		assert.ok(!/test|node_modules|package-lock|tsconfig|\.github/.test(path), `development file excluded: ${path}`);
		if (!path.endsWith(".ts")) continue;
		const source = await readFile(new URL(path, import.meta.url), "utf8");
		for (const [, dependency] of source.matchAll(/from "\.\/([^"]+\.ts)"/g)) assert.ok(files.has(dependency), `${path} dependency ${dependency} is included`);
	}
	const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
	for (const [, target] of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
		if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
		const path = target.split("#")[0].replace(/^\.\//, "");
		assert.ok(files.has(path), `linked document ${path} is included`);
	}
});
