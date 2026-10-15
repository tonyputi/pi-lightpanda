/** Deterministic DOM extraction: selectors in, observed strings/nulls out. No nested LLM calls. */
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

const FieldSpec = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]*$" }),
	selector: Type.String({ minLength: 1, maxLength: 512, description: "CSS selector; must match one element unless many is true" }),
	attribute: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z_:][A-Za-z0-9_.:-]*$", description: "Read this raw DOM attribute instead of text; no URL/number conversion" })),
	many: Type.Optional(Type.Boolean({ description: "Allow multiple elements (default false)" })),
	required: Type.Optional(Type.Boolean({ description: "Fail the tool if this field is missing, redacted, ambiguous or truncated" })),
}, { additionalProperties: false });

export const ExtractionParamsSchema = Type.Object({
	url: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "http(s) URL to navigate to; omit to extract from the current page without navigating" })),
	fields: Type.Array(FieldSpec, { minItems: 1, maxItems: 12 }),
	maxValues: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum values per many field (default 20); extra matches are explicitly marked truncated" })),
	waitForSelector: Type.Optional(Type.String({ minLength: 1, maxLength: 512, description: "Optional CSS selector to wait for before reading JS-populated content" })),
}, { additionalProperties: false });
export type ExtractionParams = Static<typeof ExtractionParamsSchema>;

const FieldResultSchema = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 64 }),
	selector: Type.String({ minLength: 1, maxLength: 512 }),
	attribute: Type.Optional(Type.String({ maxLength: 64 })),
	status: Type.Union([Type.Literal("ok"), Type.Literal("missing"), Type.Literal("ambiguous"), Type.Literal("redacted"), Type.Literal("error")]),
	matches: Type.Integer({ minimum: 0 }),
	values: Type.Array(Type.Union([Type.String({ maxLength: 2048 }), Type.Null()]), { maxItems: 50 }),
	truncated: Type.Boolean(),
	message: Type.Optional(Type.String({ maxLength: 160 })),
}, { additionalProperties: false });
export type ExtractedField = Static<typeof FieldResultSchema>;

const RawExtractionSchema = Type.Object({
	url: Type.String({ minLength: 1, maxLength: 8192 }),
	title: Type.String({ maxLength: 200 }),
	fields: Type.Array(FieldResultSchema, { minItems: 1, maxItems: 12 }),
}, { additionalProperties: false });
export type RawExtraction = Static<typeof RawExtractionSchema>;

export const ExtractionOutputSchema = Type.Object({
	source: Type.Object({
		url: Type.String({ minLength: 1, maxLength: 8192 }),
		title: Type.String({ maxLength: 200 }),
		retrievedAt: Type.String(),
	}, { additionalProperties: false }),
	fields: Type.Array(FieldResultSchema, { minItems: 1, maxItems: 12 }),
	complete: Type.Boolean(),
	truncated: Type.Boolean(),
}, { additionalProperties: false });
export type ExtractionOutput = Static<typeof ExtractionOutputSchema>;

export function validateExtractionParams(value: unknown): asserts value is ExtractionParams {
	if (!Check(ExtractionParamsSchema, value)) throw new Error("invalid extraction parameters: use 1–12 named CSS fields and maxValues between 1 and 50");
	if (new Set(value.fields.map((field) => field.name)).size !== value.fields.length) throw new Error("extraction field names must be unique");
	if (value.fields.some((field) => !field.selector.trim()) || value.waitForSelector !== undefined && !value.waitForSelector.trim()) throw new Error("CSS selectors cannot be blank");
	if (value.url !== undefined) {
		let url: URL;
		try { url = new URL(value.url); }
		catch { throw new Error("extraction URL must be http(s)"); }
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("extraction URL must be http(s)");
	}
}

/** Serialized into the page: no Node imports, closures, eval or arbitrary expressions. */
export function collectExtraction(fields: ExtractionParams["fields"], maxValues: number, charBudget: number): RawExtraction {
	// Inline helper: avoid splitting a surrogate pair when limiting observed strings.
	function prefix(value: string, length: number): string {
		let end = Math.min(value.length, length);
		if (end > 0 && end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
		return value.slice(0, end);
	}
	const results: ExtractedField[] = [];
	for (const spec of fields) {
		const result: ExtractedField = {
			name: spec.name, selector: spec.selector,
			...(spec.attribute ? { attribute: spec.attribute } : {}),
			status: "ok", matches: 0, values: [], truncated: false,
		};
		results.push(result);
		let elements: NodeListOf<Element>;
		try { elements = document.querySelectorAll(spec.selector); }
		catch {
			result.status = "error";
			result.message = "Invalid or unsupported CSS selector.";
			continue;
		}
		result.matches = elements.length;
		if (!elements.length) {
			result.status = "missing";
			result.message = "No matching element.";
			continue;
		}
		if (!spec.many && elements.length > 1) {
			result.status = "ambiguous";
			result.message = "Multiple elements matched; narrow the selector or set many=true.";
			continue;
		}
		const count = Math.min(elements.length, spec.many ? maxValues : 1);
		result.truncated = count < elements.length;
		for (let index = 0; index < count; index++) {
			const element = elements[index];
			// Never expose a password value, even through an explicit attribute request.
			if (element.tagName.toLowerCase() === "input" && element.getAttribute("type")?.toLowerCase() === "password" && spec.attribute?.toLowerCase() === "value") {
				result.status = "redacted";
				result.message = "Password input values are not extracted.";
				result.values.push(null);
				continue;
			}
			const raw = spec.attribute ? element.getAttribute(spec.attribute) : ((element as HTMLElement).innerText ?? element.textContent ?? "");
			if (raw === null) {
				if (result.status === "ok") result.status = "missing";
				result.message ??= "Requested attribute is absent; null marks the missing value.";
				result.values.push(null);
				continue;
			}
			// Preserve raw attributes, but normalize whitespace in human-facing text.
			const normalized = spec.attribute ? raw : raw.replace(/\s+/g, " ").trim();
			const value = prefix(normalized, 2048);
			if (value.length < normalized.length) result.truncated = true;
			result.values.push(value);
		}
	}
	// Collect bounded values before allocating transfer space: an early optional
	// list must not starve a required scalar later in the request. Keep output order.
	let remaining = Math.max(0, charBudget);
	for (const required of [true, false]) {
		const group = results.map((field, index) => ({
			field, index, cost: field.values.reduce<number>((sum, value) => sum + (value?.length ?? 0), 0),
		})).filter((entry) => Boolean(fields[entry.index].required) === required && entry.cost > 0)
			.sort((a, b) => a.cost - b.cost || (a.field.name < b.field.name ? -1 : a.field.name > b.field.name ? 1 : 0));
		for (let index = 0; index < group.length; index++) {
			const { field, cost } = group[index];
			let quota = Math.min(cost, Math.floor(remaining / (group.length - index)));
			const values = field.values.map((value, index) => ({ value, index }))
				.filter((entry): entry is { value: string; index: number } => typeof entry.value === "string" && entry.value.length > 0)
				.sort((a, b) => a.value.length - b.value.length || a.index - b.index);
			for (let item = 0; item < values.length; item++) {
				const original = values[item];
				const share = Math.min(original.value.length, Math.floor(quota / (values.length - item)));
				const value = prefix(original.value, share);
				field.values[original.index] = value;
				if (value !== original.value) field.truncated = true;
				quota -= value.length;
				remaining -= value.length;
			}
		}
	}
	return { url: location.href, title: prefix(document.title.replace(/\s+/g, " ").trim(), 200), fields: results };
}

function summary(output: ExtractionOutput): void {
	output.truncated = output.fields.some((field) => field.truncated);
	output.complete = output.fields.every((field) => field.status === "ok" && !field.truncated);
}

/** Preserve valid JSON/provenance/field statuses when applying the UTF-8 output budget. */
export function fitExtraction(output: ExtractionOutput, maxBytes: number, requiredNames: ReadonlySet<string> = new Set()): ExtractionOutput {
	const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
	if (size(output) <= maxBytes) return output;
	const bounded = structuredClone(output);
	for (const field of bounded.fields) {
		field.values = field.values.map((value) => value === null ? null : "");
		field.truncated = true;
	}
	summary(bounded);
	// Replacing true with false costs one extra byte per flag. Reserve that cost.
	let remaining = maxBytes - size(bounded) - bounded.fields.length - 2;
	if (remaining < 0) throw new Error("extraction metadata exceeds the output budget; request fewer/shorter fields or increase PI_LIGHTPANDA_MAX_BYTES");
	const entries = output.fields.map((original, index) => {
		bounded.fields[index].truncated = original.truncated;
		const values = original.values.map((value, index) => ({ value, index, cost: typeof value === "string" ? size(value) - 2 : 0 }))
			.filter((entry): entry is { value: string; index: number; cost: number } => typeof entry.value === "string" && entry.cost > 0)
			.sort((a, b) => a.cost - b.cost || a.index - b.index);
		return { original, index, values, cost: values.reduce((sum, value) => sum + value.cost, 0) };
	});
	// Required fields first, max-min sharing within each tier (including list
	// values). Stable names break ties, not the caller's field order.
	for (const required of [true, false]) {
		const group = entries.filter((entry) => requiredNames.has(entry.original.name) === required && entry.cost > 0)
			.sort((a, b) => a.cost - b.cost || (a.original.name < b.original.name ? -1 : a.original.name > b.original.name ? 1 : 0));
		for (let index = 0; index < group.length; index++) {
			const entry = group[index];
			const field = bounded.fields[entry.index];
			let quota = Math.min(entry.cost, Math.floor(remaining / (group.length - index)));
			for (let item = 0; item < entry.values.length; item++) {
				const { value: raw, index: valueIndex, cost } = entry.values[item];
				const share = Math.min(cost, Math.floor(quota / (entry.values.length - item)));
				let low = 0;
				let high = raw.length;
				while (low < high) {
					const middle = Math.ceil((low + high) / 2);
					if (size(raw.slice(0, middle)) - 2 <= share) low = middle;
					else high = middle - 1;
				}
				// A prefix ending halfway through an emoji would invent a lone surrogate.
				if (low > 0 && low < raw.length && /[\uD800-\uDBFF]/.test(raw[low - 1]) && /[\uDC00-\uDFFF]/.test(raw[low])) low--;
				const value = raw.slice(0, low);
				const used = size(value) - 2;
				quota -= used;
				remaining -= used;
				field.values[valueIndex] = value;
				if (value !== raw) field.truncated = true;
			}
		}
	}
	summary(bounded);
	return bounded;
}

export function prepareExtraction(raw: unknown, params: ExtractionParams, maxBytes: number, retrievedAt = new Date().toISOString()): ExtractionOutput {
	if (!Check(RawExtractionSchema, raw) || raw.fields.length !== params.fields.length || raw.fields.some((field, index) => {
		const spec = params.fields[index];
		return field.name !== spec.name || field.selector !== spec.selector || field.attribute !== spec.attribute;
	})) throw new Error("browser returned invalid extraction data");
	const source = new URL(raw.url);
	if (source.protocol !== "http:" && source.protocol !== "https:") throw new Error("extraction source must be http(s)");
	const output: ExtractionOutput = {
		source: { url: raw.url, title: raw.title, retrievedAt },
		fields: structuredClone(raw.fields), complete: false, truncated: false,
	};
	summary(output);
	const bounded = fitExtraction(output, maxBytes, new Set(params.fields.filter((field) => field.required).map((field) => field.name)));
	if (!Check(ExtractionOutputSchema, bounded)) throw new Error("extraction output failed schema validation");
	return bounded;
}

export function extractionFailed(output: ExtractionOutput, params: ExtractionParams): boolean {
	return output.fields.some((field, index) => field.status === "error" || field.status === "ambiguous" ||
		params.fields[index].required && (field.status !== "ok" || field.truncated));
}
