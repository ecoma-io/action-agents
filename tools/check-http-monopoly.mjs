#!/usr/bin/env node
/**
 * Invariant I2 — the raw-HTTP monopoly.
 *
 * An action here runs a model API key in the same process as a token that
 * writes to a consumer's issues and pull requests. If any module outside the
 * transport seam could open its own network socket, the boundary story —
 * every write and every read crosses one auditable seam — is a story about
 * one file, not the tree. So raw HTTP (the global `fetch`, and the `Request`
 * and `Headers` constructors) may appear only in `core/transport/`, and no
 * module may import a `*.test.mjs` module: test modules are not importable
 * production surface, and a production module reaching into one is the
 * loophole the monopoly would otherwise be readable through.
 *
 * WHY A LEXICAL SCAN. grep misreads the tree in both directions at once: a
 * comment saying "no fetch( here" reports a violation nobody committed, and
 * a line whose real code sits after a regex containing `://` is swallowed
 * whole. tools/code-scan.mjs masks comments, strings, regex bodies and
 * template text to spaces (offsets preserved), so patterns are matched
 * against code only, while string-literal CONTENT — import specifiers — is
 * read from the original text at the offsets the masked text names. The
 * canary fixtures under tools/fixtures/http-monopoly/ fail loudly if the
 * lexical layer ever stops matching the real tree.
 *
 * Usage:
 *   node tools/check-http-monopoly.mjs            scan the five real roots
 *   node tools/check-http-monopoly.mjs <dir>      scan a fixture tree instead
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { lineOf, maskCode } from "./code-scan.mjs";

/**
 * Scanned roots: every .mjs under them, regardless of filename. A
 * name-based test-file exclusion would be a bypass — a *.test.mjs inside
 * src/ is an ordinary importable module.
 */
const SCAN_ROOTS = "core/src core/transport triage/src review/src harmonise/src".split(" ");

/** The only directory whose modules may touch raw HTTP. */
const RAW_HTTP_ROOT = "core/transport";

/**
 * Raw-HTTP shapes, matched against masked (code-only) text. The lookbehind
 * keeps bare `fetch` and property access while excluding `fetchImpl` and
 * `prefetch` — a wrapper that captures the global is as much outside the
 * seam as a direct call.
 *
 * @type {{ re: RegExp, kind: string }[]}
 */
const HTTP_PATTERNS = [
  { re: /(?<![\w])fetch\b/g, kind: "fetch" },
  { re: /\bnew\s+Request\b/g, kind: "new Request" },
  { re: /\bnew\s+Headers\b/g, kind: "new Headers" },
];

/**
 * A test module named in a specifier, with no file:line ambiguity: the
 * production-import edge is the violation, wherever it appears.
 */
const TEST_MODULE = /\.test\.mjs$/;

/**
 * Whether `path` sits in the transport seam and may touch raw HTTP.
 *
 * @param {string} path repo-relative path of the module
 * @returns {boolean}
 */
export function isTransportPath(path) {
  return path === RAW_HTTP_ROOT || path.startsWith(RAW_HTTP_ROOT + "/");
}

/**
 * Whether `path` is scanned by this gate: under one of the scan roots, with
 * no filename exclusions.
 *
 * @param {string} path repo-relative path
 * @returns {boolean}
 */
export function isScannedPath(path) {
  return SCAN_ROOTS.some((root) => path === root || path.startsWith(root + "/"));
}

/**
 * The import edges of a module: static, export-from, side-effect and
 * dynamic, read off the masked text's `from`/`import` keywords with the
 * specifier literal read from the original source at the same offsets.
 * Specifiers ending in `.test.mjs` are flagged by suffix — no resolver is
 * needed, because every intermediary a transitive path could cross is itself
 * a scanned module whose own edges are checked, so a direct edge always
 * exists for any reachability.
 *
 * @param {string} source original module text
 * @param {string} masked code-only mask of the same text (same offsets)
 * @returns {{ index: number, raw: string, kind: "static" | "side-effect" | "dynamic" | "computed-dynamic" }[]}
 */
export function importSpecifiers(source, masked) {
  /** @type {{ index: number, raw: string, kind: "static" | "side-effect" | "dynamic" | "computed-dynamic" }[]} */
  const found = [];
  const push = (
    /** @type {number} */ index,
    /** @type {string} */ raw,
    /** @type {"static" | "side-effect" | "dynamic" | "computed-dynamic"} */ kind,
  ) => {
    found.push({ index, raw, kind });
  };

  for (const m of masked.matchAll(/\bfrom\b/g)) {
    const raw = readLiteralAfter(source, m.index + m[0].length);
    if (raw !== null) push(m.index, raw, "static");
  }

  for (const m of masked.matchAll(/\bimport\b/g)) {
    const at = m.index + m[0].length;
    const raw = readLiteralAfter(source, at);
    if (raw !== null) {
      push(at, raw, "side-effect");
      continue;
    }
    // Dynamic import: `import(` with a literal or a computed specifier. The
    // literal is read from the ORIGINAL at the offset (a blanked string is
    // spaces in masked text — skipping those blanks would land past the
    // literal and misread a resolved edge as computed).
    let j = at;
    while (j < masked.length && masked[j] === " ") j += 1;
    if (masked[j] === "(") {
      let k = j + 1;
      while (k < source.length && source[k] === " ") k += 1;
      const literal = readLiteralAt(source, k);
      if (literal !== null) {
        push(k, literal, "dynamic");
      } else {
        push(k, source.slice(k, k + 24).trim() || "computed specifier", "computed-dynamic");
      }
    }
  }

  found.sort((a, b) => a.index - b.index);
  return found;
}

/**
 * The string literal beginning after `at` (spaces skipped), or null when no
 * literal begins there.
 *
 * @param {string} source original text
 * @param {number} at offset just past a keyword
 * @returns {string | null}
 */
function readLiteralAfter(source, at) {
  let j = at;
  while (j < source.length && source[j] === " ") j += 1;
  return readLiteralAt(source, j);
}

/**
 * The quoted literal starting exactly at `i`, or null. Escape-aware; back-
 * slash escapes are stepped over so a quote inside them cannot close it.
 *
 * @param {string} source original text
 * @param {number} i offset of the opening quote
 * @returns {string | null}
 */
function readLiteralAt(source, i) {
  const quote = source[i];
  if (quote !== '"' && quote !== "'") return null;
  let j = i + 1;
  while (j < source.length) {
    const c = source[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return source.slice(i + 1, j);
    if (c === "\n") return null; // a literal cannot span lines
    j += 1;
  }
  return null;
}

/**
 * Judges the module list. Pure: reads no filesystem, holds no state.
 *
 * `modules` is every .mjs under the scan roots. Paths are repo-relative in
 * real-tree mode; in canary mode they are fixture-root-relative, so a
 * violation in a fixture names `triage/src/violation.mjs` exactly as a real
 * violation names the real path.
 *
 * @param {{ modules: { path: string, source: string }[] }} input
 * @returns {{ failures: string[], modulesScanned: number, edges: number }}
 */
export function evaluate({ modules }) {
  /** @type {string[]} */
  const failures = [];
  let edges = 0;

  for (const mod of modules) {
    const masked = maskCode(mod.source);

    for (const { re, kind } of HTTP_PATTERNS) {
      re.lastIndex = 0;
      let m = re.exec(masked);
      while (m !== null) {
        if (!isTransportPath(mod.path)) {
          failures.push(
            mod.path +
              ":" +
              lineOf(masked, m.index) +
              ': raw HTTP "' +
              kind +
              '" outside core/transport/ (invariant I2)',
          );
        }
        m = re.exec(masked);
      }
    }

    for (const spec of importSpecifiers(mod.source, masked)) {
      edges += 1;
      const line = lineOf(masked, spec.index);
      if (spec.kind === "computed-dynamic") {
        failures.push(
          mod.path +
            ":" +
            line +
            ": dynamic import with a computed specifier cannot be verified (invariant I2)",
        );
      } else if (TEST_MODULE.test(spec.raw)) {
        failures.push(
          mod.path +
            ":" +
            line +
            ': imports test module "' +
            spec.raw +
            '" — test modules are not importable production surface (invariant I2)',
        );
      }
    }
  }

  return { failures, modulesScanned: modules.length, edges };
}

/**
 * Collects every .mjs under `dir`, recursively, skipping node_modules and
 * .git. `prefix` becomes the reported path: repo-relative in real-tree mode,
 * empty in canary mode so findings name fixture-relative paths.
 *
 * @param {string} dir absolute-or-relative directory to walk
 * @param {string} prefix reported-path prefix ("core/src/" in real-tree mode)
 * @param {{ path: string, source: string }[]} out collected modules
 */
function collectModules(dir, prefix, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const at = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectModules(at, prefix + entry.name + "/", out);
    } else if (entry.name.endsWith(".mjs")) {
      out.push({ path: prefix + entry.name, source: readFileSync(at, "utf8") });
    }
  }
}

/**
 * Whether this file was RUN rather than imported, compared on real paths.
 *
 * @param {string} moduleUrl
 * @param {string | undefined} [argv1]
 * @returns {boolean}
 */
function isProgramEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (/** @type {string} */ path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}

function main() {
  const rootArg = process.argv[2];
  const fixtureMode = rootArg !== undefined;
  /** @type {{ path: string, source: string }[]} */
  const modules = [];

  if (fixtureMode) {
    if (!existsSync(rootArg)) {
      console.error("✗ fixture root does not exist: " + rootArg);
      process.exit(1);
    }
    collectModules(rootArg, "", modules);
  } else {
    for (const root of SCAN_ROOTS) {
      if (!existsSync(root)) {
        console.error("✗ scan root missing — run this gate from the repository root: " + root);
        process.exit(1);
      }
      collectModules(root, root + "/", modules);
    }
    for (const root of SCAN_ROOTS) {
      if (!modules.some((mod) => mod.path.startsWith(root + "/"))) {
        console.error("✗ scan root produced no modules — refusing to pass vacuously: " + root);
        process.exit(1);
      }
    }
  }

  const { failures, modulesScanned, edges } = evaluate({ modules });
  if (failures.length > 0) {
    for (const f of failures) console.error("✗ " + f);
    console.error(
      "\n" +
        String(failures.length) +
        " raw-HTTP monopoly violation(s) across " +
        String(modulesScanned) +
        " modules (" +
        String(edges) +
        " import edges).",
    );
    process.exit(1);
  }

  console.log(
    "✔ " +
      String(modulesScanned) +
      " modules scanned, " +
      String(edges) +
      " import edges, raw HTTP confined to core/transport/ (invariant I2 holds)",
  );
}

if (isProgramEntry(import.meta.url)) main();
