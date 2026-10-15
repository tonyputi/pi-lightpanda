/** Offline checks for deterministic extraction, JSON budgets and the registered tool contract. */
import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import puppeteer from "puppeteer-core";
import extension from "./index.ts";
import {
	collectExtraction, extractionFailed, ExtractionOutputSchema, prepareExtraction,
	validateExtractionParams, type ExtractionParams, type ExtractionOutput,
} from "./extract.ts";

class ElementFixture {
	tagName = "SPAN";
	innerText: string;
	attributes: Record<string, string>;
	constructor(innerText: string, attributes: Record<string, string> = {}) {
		this.innerText = innerText;
		this.attributes = attributes;
	}
	get textContent() { return this.innerText; }
	getAttribute(name: string) { return this.attributes[name] ?? null; }
}
async function withDom(fn: (nodes: Map<string, ElementFixture[]>) => void | Promise<void>) {
	const nodes = new Map<string, ElementFixture[]>([
		["h1", [new ElementFixture("  Product\n Alpha  ")]],
		[".price", [new ElementFixture("€ 19,90")]],
		["a", [new ElementFixture("Docs", { href: "/docs?q=a%20b" })]],
		[".empty", [new ElementFixture("  ")]],
		[".items", [new ElementFixture("One"), new ElementFixture("Two"), new ElementFixture("Three")]],
		[".password", [Object.assign(new ElementFixture("", { type: "PASSWORD", value: "never-export-this" }), { tagName: "INPUT" })]],
	]);
	const names = ["document", "location"] as const;
	const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
	Object.defineProperty(globalThis, "document", { configurable: true, value: {
		title: "  Product fixture  ",
		querySelectorAll(selector: string) {
			if (selector === "[") throw new Error("invalid CSS");
			return nodes.get(selector) ?? [];
		},
	} });
	Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://fixture.test/final?lang=it" } });
	try { await fn(nodes); }
	finally {
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
		}
	}
}
const params = (fields: ExtractionParams["fields"]): ExtractionParams => ({ fields });
const extract = (input: ExtractionParams, budget = 12288) => prepareExtraction(
	collectExtraction(input.fields, input.maxValues ?? 20, budget), input, budget, "2026-10-15T12:00:00.000Z",
);

await test("parameter validation rejects malformed fields, unsafe URLs, duplicates and unbounded lists", () => {
	validateExtractionParams({ fields: [{ name: "price", selector: ".price" }] });
	for (const value of [
		{ fields: [] }, { fields: [{ name: "bad name", selector: "h1" }] },
		{ fields: [{ name: "x", selector: " " }] }, { fields: [{ name: "x", selector: "h1", attribute: "bad attr" }] },
		{ fields: [{ name: "x", selector: "h1" }, { name: "x", selector: "a" }] },
		{ fields: [{ name: "x", selector: "h1" }], maxValues: 51 },
		{ fields: [{ name: "x", selector: "h1" }], url: "file:///private" },
		{ fields: [{ name: "x", selector: "h1" }], url: "javascript:alert(1)" },
		{ fields: [{ name: "x", selector: "h1" }], waitForSelector: " " },
		{ fields: [{ name: "x", selector: "h1" }], expression: "arbitrary JS" },
	]) assert.throws(() => validateExtractionParams(value));
});

await test("text and attributes remain observed strings with exact source metadata", async () => withDom(() => {
	const input = params([
		{ name: "name", selector: "h1", required: true },
		{ name: "price", selector: ".price" },
		{ name: "link", selector: "a", attribute: "href" },
	]);
	const output = extract(input);
	assert.deepEqual(output.fields.map((field) => field.values), [["Product Alpha"], ["€ 19,90"], ["/docs?q=a%20b"]]);
	assert.deepEqual(output.source, { url: "https://fixture.test/final?lang=it", title: "Product fixture", retrievedAt: "2026-10-15T12:00:00.000Z" });
	assert.equal(output.complete, true);
	assert.equal(output.truncated, false);
	assert.equal(extractionFailed(output, input), false);
	assert.ok(Check(ExtractionOutputSchema, output));
}));

await test("missing elements/attributes and present-empty text are distinguished", async () => withDom(() => {
	const input = params([
		{ name: "missing", selector: ".absent" },
		{ name: "attribute", selector: "a", attribute: "data-absent" },
		{ name: "empty", selector: ".empty" },
	]);
	const output = extract(input);
	assert.deepEqual(output.fields.map((field) => [field.status, field.matches, field.values]), [
		["missing", 0, []], ["missing", 1, [null]], ["ok", 1, [""]],
	]);
	assert.equal(output.complete, false);
	assert.equal(extractionFailed(output, input), false, "optional missing values are explicit but not tool failures");
	input.fields[0].required = true;
	assert.equal(extractionFailed(output, input), true);
}));

await test("ambiguous selectors never silently choose the first element; many is explicit", async () => withDom(() => {
	const input = params([{ name: "items", selector: ".items" }]);
	const ambiguous = extract(input);
	assert.equal(ambiguous.fields[0].status, "ambiguous");
	assert.equal(ambiguous.fields[0].matches, 3);
	assert.deepEqual(ambiguous.fields[0].values, []);
	assert.equal(extractionFailed(ambiguous, input), true);
	input.fields[0].many = true;
	assert.deepEqual(extract(input).fields[0].values, ["One", "Two", "Three"]);
	input.maxValues = 2;
	const bounded = extract(input);
	assert.deepEqual(bounded.fields[0].values, ["One", "Two"]);
	assert.equal(bounded.fields[0].matches, 3);
	assert.equal(bounded.truncated, true);
	assert.equal(bounded.complete, false);
	input.fields[0].required = true;
	assert.equal(extractionFailed(bounded, input), true, "required fields cannot silently accept partial lists");
}));

await test("invalid CSS and password attributes are explicit, without leaking secret values", async () => withDom(() => {
	const input = params([
		{ name: "invalid", selector: "[" },
		{ name: "password", selector: ".password", attribute: "VALUE", required: true },
	]);
	const output = extract(input);
	assert.equal(output.fields[0].status, "error");
	assert.equal(output.fields[1].status, "redacted");
	assert.deepEqual(output.fields[1].values, [null]);
	assert.ok(!JSON.stringify(output).includes("never-export-this"));
	assert.equal(extractionFailed(output, input), true);
}));

await test("DOM transfer limits mark truncated values and preserve complete field metadata", async () => withDom((nodes) => {
	nodes.set(".long", [new ElementFixture("x".repeat(3000))]);
	const input = params([{ name: "long", selector: ".long" }, { name: "price", selector: ".price" }]);
	const limited = collectExtraction(input.fields, 20, 10);
	assert.equal(limited.fields[0].values[0], "x".repeat(10));
	assert.equal(limited.fields[0].truncated, true);
	assert.deepEqual(limited.fields[1].values, [""]);
	assert.equal(limited.fields[1].truncated, true);
	const perValue = collectExtraction(input.fields, 20, 10000);
	assert.equal(perValue.fields[0].values[0]?.length, 2048);
	assert.equal(perValue.fields[0].truncated, true);
}));

await test("UTF-8/escaped-string budgets keep JSON valid, expose truncation and never split emoji", async () => withDom((nodes) => {
	nodes.set(".long", [new ElementFixture("", { "data-text": '😀"\\\n'.repeat(500) })]);
	const input = params([{ name: "long", selector: ".long", attribute: "data-text" }]);
	const raw = collectExtraction(input.fields, 20, 10000);
	for (const budget of [600, 1000, 1500]) {
		const output = prepareExtraction(raw, input, budget);
		const json = JSON.stringify(output);
		assert.ok(Buffer.byteLength(json) <= budget);
		assert.deepEqual(JSON.parse(json), output);
		assert.equal(output.truncated, true);
		assert.equal(output.complete, false);
		assert.ok(!/[\uD800-\uDFFF]/u.test(output.fields[0].values[0]!));
		assert.ok(Check(ExtractionOutputSchema, output));
	}
	assert.throws(() => prepareExtraction(raw, input, 50), /output budget/);
}));

await test("multi-field byte budgets retain provenance, missing fields and valid JSON", async () => withDom((nodes) => {
	nodes.set(".unicode", [new ElementFixture("😀".repeat(1000))]);
	nodes.set(".escaped", [new ElementFixture("", { content: '\\"\\\\\\n'.repeat(700) })]);
	const input = params([
		{ name: "unicode", selector: ".unicode" },
		{ name: "escaped", selector: ".escaped", attribute: "content", required: true },
		{ name: "missing", selector: ".absent" },
	]);
	const raw = collectExtraction(input.fields, 20, 20000);
	for (const budget of [900, 1024, 1400, 2048]) {
		const output = prepareExtraction(raw, input, budget);
		assert.ok(Buffer.byteLength(JSON.stringify(output)) <= budget);
		assert.deepEqual(output.fields.map((field) => field.name), ["unicode", "escaped", "missing"]);
		assert.equal(output.fields[2].status, "missing");
		assert.deepEqual(output.fields[2].values, []);
		assert.equal(output.source.url, raw.url);
		assert.equal(extractionFailed(output, input), true);
		assert.ok(Check(ExtractionOutputSchema, JSON.parse(JSON.stringify(output))));
	}
}));

await test("untrusted browser output must satisfy schema and correspond to the requested fields", async () => withDom(() => {
	const input = params([{ name: "name", selector: "h1" }]);
	const raw = collectExtraction(input.fields, 20, 1000);
	assert.throws(() => prepareExtraction({ ...raw, fields: [] }, input, 12000), /invalid extraction/);
	assert.throws(() => prepareExtraction({ ...raw, extra: "unexpected" }, input, 12000), /invalid extraction/);
	assert.throws(() => prepareExtraction({ ...raw, fields: [{ ...raw.fields[0], values: [123] }] }, input, 12000), /invalid extraction/);
	assert.throws(() => prepareExtraction({ ...raw, fields: [{ ...raw.fields[0], name: "different" }] }, input, 12000), /invalid extraction/);
	assert.throws(() => prepareExtraction({ ...raw, url: "file:///private" }, input, 12000), /source must be http/);
}));

await test("the DOM collector serializes without closures and only reads the page", async () => withDom(() => {
	const source = collectExtraction.toString();
	assert.ok(!/process\.|require\(|fetch\(|setAttribute\(|eval\(/.test(source));
	const serialized = new Function(`return (${source})`)() as typeof collectExtraction;
	assert.equal(serialized([{ name: "name", selector: "h1" }], 20, 1000).fields[0].values[0], "Product Alpha");
}));

await test("registered tool returns matching JSON/structuredContent, supports current page and keeps partial failure data", async () => withDom(async () => {
	const savedConnect = puppeteer.connect;
	const savedFetch = globalThis.fetch;
	type RegisteredTool = {
		name: string; executionMode?: string; outputSchema?: unknown;
		execute(id: string, params: unknown): Promise<{ content: Array<{ text?: string }>; structuredContent?: ExtractionOutput; isError?: boolean }>;
	};
	const tools = new Map<string, RegisteredTool>();
	let shutdown: (() => Promise<void>) | undefined;
	let navigations = 0;
	let waitedFor = "";
	let currentUrl = "about:blank";
	const page = {
		isClosed: () => false, setDefaultTimeout: () => {},
		goto: async () => { navigations++; currentUrl = "https://fixture.test/final?lang=it"; },
		url: () => currentUrl, waitForFunction: async () => {},
		waitForSelector: async (selector: string) => { waitedFor = selector; },
		evaluate: async (fn: (...args: never[]) => unknown, ...args: unknown[]) => fn(...args as never[]),
	};
	puppeteer.connect = (async () => ({
		createBrowserContext: async () => ({ newPage: async () => page, close: async () => {} }),
		disconnect: async () => {},
	})) as unknown as typeof puppeteer.connect;
	globalThis.fetch = async () => Response.json({ Browser: "external fixture" });
	try {
		extension({
			registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
			registerCommand: () => {},
			on: (name: string, handler: () => Promise<void>) => { if (name === "session_shutdown") shutdown = handler; },
		} as unknown as ExtensionAPI);
		const tool = tools.get("lightpanda_extract")!;
		assert.ok(tool.outputSchema);
		assert.equal(tool.executionMode, "sequential");
		const fields = [{ name: "name", selector: "h1", required: true }];
		await assert.rejects(tool.execute("none", { fields }), /no current page/);
		const result = await tool.execute("url", { url: "https://fixture.test/start", fields, waitForSelector: "h1" });
		assert.equal(navigations, 1);
		assert.equal(waitedFor, "h1");
		assert.equal(result.isError, false);
		assert.deepEqual(JSON.parse(result.content[0].text!), result.structuredContent);
		assert.ok(Check(ExtractionOutputSchema, result.structuredContent));
		assert.equal(result.structuredContent.source.url, "https://fixture.test/final?lang=it");
		await tool.execute("current", { fields });
		assert.equal(navigations, 1, "omitting URL does not navigate or discard the current page");
		const missing = await tool.execute("missing", { fields: [{ name: "missing", selector: ".absent", required: true }] });
		assert.equal(missing.isError, true);
		assert.equal(missing.structuredContent?.fields[0].status, "missing");
		assert.ok(Check(ExtractionOutputSchema, missing.structuredContent));
	} finally {
		await shutdown?.();
		puppeteer.connect = savedConnect;
		globalThis.fetch = savedFetch;
	}
}));
