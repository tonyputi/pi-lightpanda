# Reproducible output-byte comparison (#15)

## Reproduce

Install dependencies and an actual Lightpanda binary, then run:

```sh
npm run test:smoke
```

The script does not download/update binaries or contact external sites. It
serves an ephemeral loopback page at `/budget` containing an `h1` product name,
a `.price` span, an `a.docs` link, 80 deterministic background paragraphs and an
end marker. The fixture lives in `smoke.ts` so it is versioned with the check.
The script sets the global output ceiling to 12,288 bytes.

It calls the registered tools against that **same page**:

1. `lightpanda_fetch` with Markdown, `waitMs: 0`, no per-call budget.
2. `lightpanda_fetch` with Markdown, `waitMs: 0`, `maxBytes: 4096`.
3. `lightpanda_extract` with `maxBytes: 4096` and three required fields:
   `name` (`h1`), `price` (`.price`), `docs` (`a.docs`, attribute `href`).

Each result is measured using `Buffer.byteLength(text, "utf8")`, including any
Markdown truncation marker and all extraction JSON metadata. Diagnostic output
is printed by the smoke script, not appended to tool payloads.

## Observed result

Environment: Linux aarch64, Node v26.8.2,
Lightpanda `1.1.0-nightly.12159+c89c9a448`.

| Tool path | Returned UTF-8 bytes | Required information complete | Truncated |
|---|---:|---|---|
| Default Markdown | 8,399 | yes | no |
| 4 KB Markdown | 4,096 | yes | yes |
| Three named fields (JSON) | 495 | yes | no |

Required information means exactly `Example Product`, `€ 19,90`, and `/docs`.
The Markdown checks verify all three strings remain present. The extraction
check asserts exact values and `complete: true`. For this controlled fixture,
Markdown truncation is established by the presence/absence of the known end
marker; extraction uses its explicit `truncated` flag.

These are **output/context-byte measurements**, not tokenizer-token savings,
latency or memory benchmarks. Output sizes may change with Lightpanda builds;
extraction provenance includes a dynamic loopback port and UTC timestamp, so
its byte count may also vary with port length. No tokenizer/model was used.
Upstream Lightpanda runtime benchmark numbers must not be attributed to this
extension.

The same smoke run separately checks that a required price survives an optional
long list at a 900-byte per-call budget in either field order, alongside redirect
provenance, JS-populated content, password redaction, cancellation, CDP refs,
stale-ref rejection, managed-server cleanup and external-server preservation.
