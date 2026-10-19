# Fleet Version Drift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Linux unit reports its NVIDIA driver, CUDA toolkit, kernel, OS and DGX OS versions. A worker whose versions differ from its head's shows on the Overview strip and can notify.

**Architecture:**
- **Collection.** A file-read script runs on each unit, on the host itself (local units via nsenter, remote ones over SSH). It is collected by a new `software` poll domain in `SparkMonitor` and published as `snapshot.software`.
- **Drift logic.** One shared pure module, `src/shared/softwareDrift.js`, decides drift. The browser strip, the unit page header and the server's alert engine all use it, so they cannot disagree.
- **Prometheus.** It gets one info metric.

**Tech Stack:**
- Node 20 ESM (Express server, `node:test` with `node:assert/strict`).
- React 19 with TypeScript (vitest).
- No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-fleet-consistency-design.md`, section A.

## Global Constraints

- Compared fields are `driver`, `cuda`, `kernel` and `dgxOs`. `os` is shown but never compared.
- A field is compared only when both the worker and its head have a non-null value.
- Only a **worker** is ever flagged, and only against its **head**. Standalone units and heads are never flagged.
- An offline worker gets no drift condition. An offline head still counts, with its last-known `software`.
- Head resolution: the worker's `workerHeadId` when that id exists in the fleet, otherwise the fleet's only other head, otherwise none. This is the same as `makeHeadResolver` in `src/shared/sparkHead.ts`.
- The alert rule is `drift`: name "Software differs from head", `source: "strip"`, severity `warning` only, defaults `{ enabled: true, forSec: 1800 }`.
- The poll interval is `POLL_INTERVAL_SOFTWARE` (env), default `600000` ms. Software is also collected once when a unit comes online, including the first time.
- Linux units only. A unit with `platform` `"windows"` or `"darwin"` has `software: null` and runs nothing.
- `software.changed` Activity event: emitted when a compared field changes between two non-null readings. It is never emitted on the first reading.
- Prometheus: `sparkdash_software_info{driver,cuda,kernel,os,dgx_os} 1`, for online units with `software` set.
- Every version string is capped at 100 characters.

## Review Focus

1. **A plain Ubuntu GPU host** has no `/etc/dgx-release` and possibly no `/usr/local/cuda`. The probe must still succeed and return the fields it could read; one missing file must not throw the whole reading away. *(Task 1 test "a non-DGX host…")*
2. **A host whose NVIDIA module is not loaded** (`/proc/driver/nvidia/version` missing) gets `driver: null`. That worker must not drift on `driver`. *(Task 2 test "null on either side…")*
3. **A worker whose `workerHeadId` names a unit that was removed** has no head. It gets no drift and the code must not crash. *(Task 2 test "a dangling workerHeadId…")*
4. **Legacy config with `workerNode: true` and no `role`** is a worker and must be compared like one. *(Task 2 test "legacy workerNode…")*
5. **Odd or long strings** (quoted `PRETTY_NAME`, kernel strings with `+`, a 5 kB garbage file) must come out trimmed, unquoted and at most 100 characters. They must never reach a Prometheus label or the UI uncapped. *(Task 1 test "values are unquoted and capped")*

Expected behaviour that is not a bug: the Overview strip shows drift at once, because the browser derives it from snapshots, while notifications wait the rule's 30 minutes. During a rolling upgrade the strip is truthful and the phone stays quiet.

---

### Task 1: Software probe script and parser

**Files:**
- Create: `server/collectors/softwareInventory.js`
- Modify: `server/collectors/SystemCollector.js:191-210` (`splitRemoteGpuSections` takes an optional allowed set)
- Test: `server/collectors/__tests__/softwareInventory.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SOFTWARE_FILES: Readonly<Record<"DRIVER"|"CUDA"|"KERNEL"|"OSREL"|"DGXREL", string>>`
  - `SOFTWARE_SECTIONS: Set<string>`
  - `buildSoftwareScript(): string`
  - `parseSoftware(sections: Record<string,string>, now: number): { driver, cuda, kernel, os, dgxOs: string|null, collectedAt: number } | null`
  - `splitRemoteGpuSections(output: string, allowed?: Set<string>): Record<string,string>` (exported from `SystemCollector.js`)

- [ ] **Step 1: Write the failing test**

Create `server/collectors/__tests__/softwareInventory.test.js`:

```js
/**
 * The software probe: one script of plain file reads and its parser. A missing file
 * is a null field, never a failed reading.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SOFTWARE_FILES, SOFTWARE_SECTIONS, buildSoftwareScript, parseSoftware } from "../softwareInventory.js";
import { splitRemoteGpuSections } from "../SystemCollector.js";

const OPEN_MODULE = "NVRM version: NVIDIA UNIX Open Kernel Module for aarch64  580.95.05  Release Build  (dvs-builder@U22-I3-AF03-09-1)  Tue Sep 23 22:11:58 UTC 2025\nGCC version:  gcc version 13.3.0 (Ubuntu 13.3.0-6ubuntu2~24.04)";
const PROPRIETARY_MODULE = "NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.14  Thu Feb 22 01:44:30 UTC 2024\nGCC version:  gcc version 12.3.0";
const CUDA_JSON = '{\n  "cuda" : { "name" : "CUDA SDK", "version" : "13.0.1" },\n  "cuda_cudart" : { "version" : "13.0.96" }\n}';
const OS_RELEASE = 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu';
const DGX_RELEASE = 'DGX_NAME="DGX Spark"\nDGX_SWBUILD_VERSION="7.2.0"\nDGX_OTA_VERSION="7.2.1"\nDGX_OTA_VERSION="7.2.3"';

function output(parts) {
  return Object.entries(parts).map(([name, body]) => `\n__${name}__\n${body}`).join("\n");
}

test("the script reads exactly the five files and never fails on a missing one", () => {
  const script = buildSoftwareScript();
  for (const file of Object.values(SOFTWARE_FILES)) assert.ok(script.includes(`cat ${file} 2>/dev/null`), file);
  for (const name of SOFTWARE_SECTIONS) assert.ok(script.includes(`__${name}__`), name);
  assert.match(script, /; true$/, "a missing last file must not make the script exit non-zero");
});

test("a DGX Spark reading parses every field; the latest DGX OTA version wins", () => {
  const sections = splitRemoteGpuSections(
    output({ DRIVER: OPEN_MODULE, CUDA: CUDA_JSON, KERNEL: "6.11.0-1016-nvidia\n", OSREL: OS_RELEASE, DGXREL: DGX_RELEASE }),
    SOFTWARE_SECTIONS
  );
  assert.deepEqual(parseSoftware(sections, 42), {
    driver: "580.95.05",
    cuda: "13.0.1",
    kernel: "6.11.0-1016-nvidia",
    os: "Ubuntu 24.04.3 LTS",
    dgxOs: "7.2.3",
    collectedAt: 42,
  });
});

test("the proprietary module's version line parses too", () => {
  assert.equal(parseSoftware({ DRIVER: PROPRIETARY_MODULE }, 1).driver, "550.54.14");
});

test("a non-DGX host without dgx-release or CUDA still returns what it could read", () => {
  const sections = splitRemoteGpuSections(output({ DRIVER: "", CUDA: "", KERNEL: "6.8.0-147-generic", OSREL: OS_RELEASE, DGXREL: "" }), SOFTWARE_SECTIONS);
  assert.deepEqual(parseSoftware(sections, 7), {
    driver: null,
    cuda: null,
    kernel: "6.8.0-147-generic",
    os: "Ubuntu 24.04.3 LTS",
    dgxOs: null,
    collectedAt: 7,
  });
});

test("nothing readable is a failed reading (null), and garbage never throws", () => {
  assert.equal(parseSoftware({}, 1), null);
  assert.equal(parseSoftware({ CUDA: "{not json", DRIVER: "nonsense", KERNEL: "" }, 1), null);
});

test("values are unquoted and capped at 100 characters", () => {
  const long = "x".repeat(5000);
  const r = parseSoftware({ KERNEL: long, OSREL: `PRETTY_NAME='${long}'` }, 1);
  assert.equal(r.kernel, null, "a kernel release is one token; 5000 chars of junk is not one");
  assert.equal(r.os.length, 100);
  assert.equal(parseSoftware({ OSREL: 'PRETTY_NAME="DGX OS 7 (Ubuntu 24.04)"' }, 1).os, "DGX OS 7 (Ubuntu 24.04)");
});

test("splitRemoteGpuSections with an allowed set ignores the GPU markers, and the default is unchanged", () => {
  const mixed = "\n__NVIDIA__\ngpu line\n__KERNEL__\n6.8.0\n";
  assert.deepEqual(splitRemoteGpuSections(mixed, SOFTWARE_SECTIONS), { KERNEL: "6.8.0" });
  assert.equal(splitRemoteGpuSections(mixed).NVIDIA, "gpu line\n__KERNEL__\n6.8.0");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/collectors/__tests__/softwareInventory.test.js`
Expected: FAIL with `Cannot find module '.../softwareInventory.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/collectors/softwareInventory.js`:

```js
/**
 * Software versions of a Linux unit: NVIDIA driver, CUDA toolkit, kernel, OS and DGX OS.
 * One script of plain file reads, run on the host itself (local units through nsenter,
 * remote ones over SSH), so the container's own /etc never answers for the host.
 */

export const SOFTWARE_FILES = Object.freeze({
  DRIVER: "/proc/driver/nvidia/version",
  CUDA: "/usr/local/cuda/version.json",
  KERNEL: "/proc/sys/kernel/osrelease",
  OSREL: "/etc/os-release",
  DGXREL: "/etc/dgx-release",
});

export const SOFTWARE_SECTIONS = new Set(Object.keys(SOFTWARE_FILES));

const MAX_CHARS = 100;

/** `__NAME__` marker then the file, per field; the trailing `true` keeps a missing last file from failing the call. */
export function buildSoftwareScript() {
  const reads = Object.entries(SOFTWARE_FILES).map(([name, file]) => `printf '\\n__${name}__\\n'; cat ${file} 2>/dev/null`);
  return `${reads.join("; ")}; true`;
}

function cap(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s.slice(0, MAX_CHARS) : null;
}

/** KEY=value lines (os-release / dgx-release); quotes stripped, a later key wins. */
function keyValues(text) {
  const out = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function parseDriver(text) {
  // Open: "... Open Kernel Module for aarch64  580.95.05  ..."; proprietary: "... x86_64 Kernel Module  550.54.14  ..."
  const m = /Kernel Module(?:\s+for\s+\S+)?\s+(\d+\.\d+(?:\.\d+)?)\b/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

function parseCuda(text) {
  try {
    const v = JSON.parse(String(text ?? ""))?.cuda?.version;
    return typeof v === "string" ? cap(v) : null;
  } catch {
    return null;
  }
}

function parseKernel(text) {
  const first = String(text ?? "").trim().split(/\r?\n/)[0] ?? "";
  return /^[\w.+~-]{1,100}$/.test(first) ? first : null;
}

/**
 * @param {Record<string, string>} sections output of splitRemoteGpuSections(out, SOFTWARE_SECTIONS)
 * @param {number} now epoch ms
 * @returns {{ driver: string|null, cuda: string|null, kernel: string|null, os: string|null, dgxOs: string|null, collectedAt: number } | null}
 *   null when no field could be read (treat as a failed reading)
 */
export function parseSoftware(sections, now) {
  const s = sections || {};
  const dgx = keyValues(s.DGXREL);
  const result = {
    driver: parseDriver(s.DRIVER),
    cuda: parseCuda(s.CUDA),
    kernel: parseKernel(s.KERNEL),
    os: cap(keyValues(s.OSREL).PRETTY_NAME),
    // OTA updates append DGX_OTA_VERSION lines; the install image is DGX_SWBUILD_VERSION.
    dgxOs: cap(dgx.DGX_OTA_VERSION ?? dgx.DGX_SWBUILD_VERSION),
  };
  if (Object.values(result).every((v) => v == null)) return null;
  return { ...result, collectedAt: now };
}
```

In `server/collectors/SystemCollector.js`, change `splitRemoteGpuSections` (lines 191-210) to take the allowed set. Leave `REMOTE_GPU_SECTIONS` as it is:

```js
export function splitRemoteGpuSections(output, allowed = REMOTE_GPU_SECTIONS) {
  const sections = {};
  let current = null;
  const lines = [];
  const flush = () => { if (current) sections[current] = lines.join("\n").trim(); lines.length = 0; };
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const m = /^__([A-Z_]+)__$/.exec(line.trim());
    if (m && allowed.has(m[1])) { flush(); current = m[1]; continue; }
    if (current) lines.push(line);
  }
  flush();
  return sections;
}
```

Also update its doc comment: "A section starts at a line that is exactly one of the `allowed` `__NAME__` markers (the GPU probe's by default)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/collectors/__tests__/softwareInventory.test.js server/collectors/__tests__/*.test.js`
Expected: PASS, with every existing collector test still passing.

- [ ] **Step 5: Commit**

```bash
git add server/collectors/softwareInventory.js server/collectors/SystemCollector.js server/collectors/__tests__/softwareInventory.test.js
git commit -m "feat: software version probe script and parser"
```

---

### Task 2: Shared drift logic and snapshot type

**Files:**
- Create: `src/shared/softwareDrift.js`
- Create: `src/shared/softwareDrift.d.ts`
- Modify: `src/api/types.ts`: add `SoftwareInfo` after `HardwareInfo` (~:184), and `software?: SoftwareInfo | null` on `SparkSnapshot` after `hardware: HardwareInfo;` (:702)
- Test: `server/alerts/__tests__/softwareDrift.test.js` (`node:test`, so it runs in `test:server` next to the alert tests that use it)

**Interfaces:**
- Consumes: the snapshot fields `id`, `name`, `online`, `role`, `workerNode`, `workerHeadId` and `software` (from Task 3; the tests build them by hand).
- Produces:
  - `COMPARED_FIELDS: ReadonlyArray<{ field: "driver"|"cuda"|"kernel"|"dgxOs", label: string }>`
  - `DRIFT_LABEL: "Software differs from head"`
  - `driftHead(unit, units): unit | null`
  - `softwareDrift(units): Map<unitId, { headId: string, headName: string, diffs: Array<{ field, label, value, headValue }> }>`
  - `driftSummary(entry): string`, e.g. `"driver 580.95 vs 580.82 on spark-1"`
  - TS: `SoftwareInfo`, `DriftEntry`, `DriftDiff`

- [ ] **Step 1: Write the failing test**

Create `server/alerts/__tests__/softwareDrift.test.js`:

```js
/**
 * Which workers drift from their head. Shared by the strip, the unit header and the
 * alert engine, so the cases here are the behaviour everywhere.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { COMPARED_FIELDS, driftHead, driftSummary, softwareDrift } from "../../../src/shared/softwareDrift.js";

const sw = (over = {}) => ({ driver: "580.82.07", cuda: "13.0.1", kernel: "6.11.0-1016-nvidia", os: "Ubuntu 24.04.3 LTS", dgxOs: "7.2.3", collectedAt: 1, ...over });
const head = (over = {}) => ({ id: "spark-1", name: "spark-1", online: true, role: "head", software: sw(), ...over });
const worker = (over = {}) => ({ id: "spark-2", name: "spark-2", online: true, role: "worker", workerHeadId: "spark-1", software: sw(), ...over });

test("a worker matching its head has no drift", () => {
  assert.equal(softwareDrift([head(), worker()]).size, 0);
});

test("a driver mismatch names the field and both values", () => {
  const drift = softwareDrift([head(), worker({ software: sw({ driver: "580.95.05" }) })]);
  assert.deepEqual(drift.get("spark-2"), {
    headId: "spark-1",
    headName: "spark-1",
    diffs: [{ field: "driver", label: "driver", value: "580.95.05", headValue: "580.82.07" }],
  });
  assert.equal(driftSummary(drift.get("spark-2")), "driver 580.95.05 vs 580.82.07 on spark-1");
});

test("several fields are listed in COMPARED_FIELDS order and joined with '; '", () => {
  const entry = softwareDrift([head(), worker({ software: sw({ kernel: "6.11.0-1017-nvidia", driver: "580.95.05" }) })]).get("spark-2");
  assert.deepEqual(entry.diffs.map((d) => d.field), ["driver", "kernel"]);
  assert.equal(driftSummary(entry), "driver 580.95.05 vs 580.82.07 on spark-1; kernel 6.11.0-1017-nvidia vs 6.11.0-1016-nvidia on spark-1");
  assert.deepEqual(COMPARED_FIELDS.map((f) => f.field), ["driver", "cuda", "kernel", "dgxOs"]);
});

test("os is shown, never compared", () => {
  assert.equal(softwareDrift([head(), worker({ software: sw({ os: "Ubuntu 24.04.2 LTS" }) })]).size, 0);
});

test("null on either side skips that field (a Linux GPU host worker has no dgxOs)", () => {
  assert.equal(softwareDrift([head(), worker({ software: sw({ dgxOs: null }) })]).size, 0);
  assert.equal(softwareDrift([head({ software: sw({ driver: null }) }), worker({ software: sw({ driver: "580.95.05" }) })]).size, 0);
  assert.equal(softwareDrift([head({ software: null }), worker()]).size, 0);
  assert.equal(softwareDrift([head(), worker({ software: null })]).size, 0);
});

test("an offline worker gets no entry; an offline head keeps the comparison with its last-known versions", () => {
  const drifting = worker({ software: sw({ driver: "580.95.05" }) });
  assert.equal(softwareDrift([head(), { ...drifting, online: false }]).size, 0);
  assert.equal(softwareDrift([head({ online: false }), drifting]).size, 1);
});

test("without workerHeadId, the fleet's only head is the head; two heads mean no comparison", () => {
  const w = worker({ workerHeadId: null, software: sw({ driver: "580.95.05" }) });
  assert.equal(softwareDrift([head(), w]).get("spark-2").headId, "spark-1");
  assert.equal(softwareDrift([head(), head({ id: "spark-9", name: "spark-9" }), w]).size, 0);
});

test("a dangling workerHeadId means no head and no drift (and no crash)", () => {
  const w = worker({ workerHeadId: "removed-unit", software: sw({ driver: "580.95.05" }) });
  assert.equal(driftHead(w, [head(), w]), null);
  assert.equal(softwareDrift([head(), w]).size, 0);
});

test("legacy workerNode: true without a role is a worker and is compared", () => {
  const legacy = { id: "spark-2", name: "spark-2", online: true, workerNode: true, software: sw({ driver: "580.95.05" }) };
  assert.equal(softwareDrift([head(), legacy]).size, 1);
});

test("standalone units and heads are never flagged", () => {
  const odd = sw({ driver: "1.0" });
  assert.equal(softwareDrift([head(), { id: "s", name: "s", online: true, role: "standalone", software: odd }]).size, 0);
  assert.equal(softwareDrift([head({ software: odd }), head({ id: "spark-9", name: "spark-9" })]).size, 0);
});

test("bad input is an empty map", () => {
  assert.equal(softwareDrift(null).size, 0);
  assert.equal(softwareDrift([null, undefined, {}]).size, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/alerts/__tests__/softwareDrift.test.js`
Expected: FAIL with `Cannot find module '.../src/shared/softwareDrift.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/softwareDrift.js`:

```js
/**
 * Software drift: a worker whose driver, CUDA, kernel or DGX OS version differs from its
 * head's. One copy, read by the Overview strip (FleetAlertStrip.deriveAlerts), the unit page
 * header and the server's alert notifications (server/alerts/engine.js).
 */

export const DRIFT_LABEL = "Software differs from head";

/** Compared in this order; `os` is shown elsewhere but never compared. */
export const COMPARED_FIELDS = Object.freeze([
  { field: "driver", label: "driver" },
  { field: "cuda", label: "CUDA" },
  { field: "kernel", label: "kernel" },
  { field: "dgxOs", label: "DGX OS" },
]);

function roleOf(u) {
  if (u?.role === "head" || u?.role === "worker" || u?.role === "standalone") return u.role;
  return u?.workerNode ? "worker" : "standalone";
}

/**
 * A worker's head: its workerHeadId when that unit is in the fleet, else the fleet's only
 * other head. Same rule as makeHeadResolver (src/shared/sparkHead.ts), which the server cannot import.
 */
export function driftHead(unit, units) {
  if (!unit || roleOf(unit) !== "worker") return null;
  const list = Array.isArray(units) ? units.filter(Boolean) : [];
  if (unit.workerHeadId) return list.find((u) => u.id === unit.workerHeadId) ?? null;
  const heads = list.filter((u) => u.id !== unit.id && roleOf(u) === "head");
  return heads.length === 1 ? heads[0] : null;
}

/** unitId → { headId, headName, diffs } for each online worker that differs from its head. */
export function softwareDrift(units) {
  const out = new Map();
  const list = Array.isArray(units) ? units.filter(Boolean) : [];
  for (const unit of list) {
    if (!unit.id || !unit.online || !unit.software) continue;
    const head = driftHead(unit, list);
    // An offline head counts with its last-known versions: a head reboot must not resolve
    // every worker's alert and fire it again once the head is back.
    if (!head?.software) continue;
    const diffs = [];
    for (const { field, label } of COMPARED_FIELDS) {
      const value = unit.software[field];
      const headValue = head.software[field];
      if (value && headValue && value !== headValue) diffs.push({ field, label, value, headValue });
    }
    if (diffs.length > 0) out.set(unit.id, { headId: head.id, headName: head.name || head.id, diffs });
  }
  return out;
}

/** "driver 580.95 vs 580.82 on spark-1; kernel …" — the strip detail and the alert summary. */
export function driftSummary(entry) {
  return entry.diffs.map((d) => `${d.label} ${d.value} vs ${d.headValue} on ${entry.headName}`).join("; ");
}
```

Create `src/shared/softwareDrift.d.ts`:

```ts
import type { SparkSnapshot } from "../api/types";

export type DriftField = "driver" | "cuda" | "kernel" | "dgxOs";

export interface DriftDiff {
  field: DriftField;
  label: string;
  value: string;
  headValue: string;
}

export interface DriftEntry {
  headId: string;
  headName: string;
  diffs: DriftDiff[];
}

export const DRIFT_LABEL: string;
export const COMPARED_FIELDS: ReadonlyArray<{ field: DriftField; label: string }>;
export function driftHead(unit: SparkSnapshot, units: SparkSnapshot[]): SparkSnapshot | null;
export function softwareDrift(units: SparkSnapshot[]): Map<string, DriftEntry>;
export function driftSummary(entry: DriftEntry): string;
```

In `src/api/types.ts`, after the `HardwareInfo` interface (~:184), add:

```ts
// ─── Software versions ───────────────────────────────────
/** Linux units only; null until read, and on Windows / macOS units. */
export interface SoftwareInfo {
  /** NVIDIA kernel module version, e.g. "580.95.05". */
  driver: string | null;
  /** CUDA toolkit on the host (/usr/local/cuda/version.json). */
  cuda: string | null;
  kernel: string | null;
  /** os-release PRETTY_NAME; shown, never compared. */
  os: string | null;
  dgxOs: string | null;
  /** Epoch ms of the reading. */
  collectedAt: number;
}
```

In `SparkSnapshot`, after `hardware: HardwareInfo;` (:702), add:

```ts
  /** Optional so a dashboard talking to an older server still type-checks. */
  software?: SoftwareInfo | null;
```

- [ ] **Step 4: Run the tests and typecheck to verify they pass**

Run: `node --test server/alerts/__tests__/softwareDrift.test.js && npm run typecheck`
Expected: PASS, and `tsc` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/softwareDrift.js src/shared/softwareDrift.d.ts src/api/types.ts server/alerts/__tests__/softwareDrift.test.js
git commit -m "feat: shared software drift rule for workers against their head"
```

---

### Task 3: Collect software on each unit

**Files:**
- Modify: `server/config.js:78` (add `POLL_INTERVAL_SOFTWARE`) and the export list (:228)
- Modify: `server/collectors/SystemCollector.js`: import from `./softwareInventory.js` (top, next to `RoceSampler` at :8), and add `collectSoftware()` right after `collectRoce()` (:559-576)
- Modify: `server/sparks/SparkMonitor.js`:
  - config import (:18-27);
  - constructor (`this._health = []` at ~:134);
  - `start()` (:597-614);
  - `_noteOnline` (:739-749);
  - `_pollDomain`, both switches (~:1037 and ~:1100);
  - `snapshot()` (~:688);
  - a new `_noteSoftwareChange`.
- Modify: `README.md:981` (Configuration table)
- Test: `server/sparks/__tests__/monitor-software.test.js`, `server/collectors/__tests__/softwareInventory.test.js` (append)

**Interfaces:**
- Consumes:
  - `buildSoftwareScript`, `parseSoftware` and `SOFTWARE_SECTIONS` (Task 1);
  - `splitRemoteGpuSections(out, allowed)` (Task 1);
  - `COMPARED_FIELDS` (Task 2).
- Produces:
  - `SystemCollector.prototype.collectSoftware(): Promise<SoftwareInfo | null>`;
  - `snapshot().software: SoftwareInfo | null`;
  - Activity event `{ type: "software.changed", severity: "info", message, data: { changes: [{ field, from, to }] } }`.

- [ ] **Step 1: Write the failing tests**

In `server/collectors/__tests__/softwareInventory.test.js`, widen the existing `SystemCollector.js` import to `import { SystemCollector, splitRemoteGpuSections } from "../SystemCollector.js";`, then append:

```js
test("collectSoftware runs the script on the host (not in the container) for a local Docker unit", async () => {
  const c = new SystemCollector({ id: "local", isLocal: true });
  c._hasHostProc = () => true;
  const calls = [];
  c._execOnHost = async (cmd, opts) => (calls.push({ cmd, opts }), "\n__KERNEL__\n6.11.0-1016-nvidia\n");
  c._exec = async () => assert.fail("the container's /etc must never answer for the host");
  const r = await c.collectSoftware();
  assert.equal(r.kernel, "6.11.0-1016-nvidia");
  assert.deepEqual(calls, [{ cmd: buildSoftwareScript(), opts: { allowContainerFallback: false } }]);
});

test("collectSoftware reads directly when sparkDash runs on the host without Docker", async () => {
  const c = new SystemCollector({ id: "local", isLocal: true });
  c._hasHostProc = () => false;
  c._exec = async () => "\n__OSREL__\nPRETTY_NAME=\"Ubuntu 24.04.3 LTS\"\n";
  assert.equal((await c.collectSoftware()).os, "Ubuntu 24.04.3 LTS");
});

test("collectSoftware is null on Windows and macOS units and runs nothing", async () => {
  for (const platform of ["windows", "darwin"]) {
    const c = new SystemCollector({ id: "x", isLocal: true, platform });
    c._exec = async () => assert.fail("must not run");
    c._execOnHost = async () => assert.fail("must not run");
    assert.equal(await c.collectSoftware(), null);
  }
});

test("collectSoftware turns a failing command into null instead of throwing", async (t) => {
  t.mock.method(console, "error", () => {});
  const c = new SystemCollector({ id: "local", isLocal: true });
  c._hasHostProc = () => false;
  c._exec = async () => { throw new Error("boom"); };
  assert.equal(await c.collectSoftware(), null);
});
```

Create `server/sparks/__tests__/monitor-software.test.js`:

```js
/**
 * The software poll domain: readings land on the snapshot, a failed reading keeps the
 * last one, a version change is an Activity event (never the first reading), and a unit
 * coming online is read straight away instead of waiting for the 10-minute timer.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SparkMonitor } from "../SparkMonitor.js";

const V1 = { driver: "580.82.07", cuda: "13.0.1", kernel: "6.11.0-1016-nvidia", os: "Ubuntu 24.04.3 LTS", dgxOs: "7.2.3", collectedAt: 1 };

function monitor(overrides = {}) {
  const m = new SparkMonitor({
    id: "spark-2",
    name: "spark-2",
    kind: "spark",
    lanIp: "192.168.10.12",
    isLocal: false,
    llmMonitoring: false,
    comfyMonitoring: false,
    hermesMonitoring: false,
    tailscaleMonitoring: false,
    storagePollDisabled: true,
    ...overrides,
  });
  m._running = true;
  m.online = true;
  const events = [];
  m._onEvent = (e) => events.push(e);
  const readings = [];
  let calls = 0;
  m.collector.collectSoftware = async () => (calls += 1, readings.length ? readings.shift() : null);
  return { m, events, readings, calls: () => calls };
}

test("a reading lands on the snapshot; before any, software is null", async () => {
  const { m, readings } = monitor();
  assert.equal(m.snapshot().software, null);
  readings.push(V1);
  await m._pollDomain("software");
  assert.deepEqual(m.snapshot().software, V1);
});

test("a failed reading (null) keeps the previous one", async () => {
  const { m, readings } = monitor();
  readings.push(V1, null);
  await m._pollDomain("software");
  await m._pollDomain("software");
  assert.deepEqual(m.snapshot().software, V1);
});

test("the first reading is a baseline: no event; a changed driver is one event naming both versions", async () => {
  const { m, events, readings } = monitor();
  readings.push(V1, { ...V1, collectedAt: 2 }, { ...V1, driver: "580.95.05", collectedAt: 3 });
  await m._pollDomain("software");
  await m._pollDomain("software");
  assert.equal(events.length, 0, "baseline and an unchanged reading are silent");
  await m._pollDomain("software");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "software.changed");
  assert.equal(events[0].severity, "info");
  assert.equal(events[0].message, "spark-2: driver 580.82.07 → 580.95.05");
  assert.deepEqual(events[0].data, { changes: [{ field: "driver", from: "580.82.07", to: "580.95.05" }] });
});

test("an os-only change or a field going null is not an event", async () => {
  const { m, events, readings } = monitor();
  readings.push(V1, { ...V1, os: "Ubuntu 24.04.4 LTS" }, { ...V1, cuda: null });
  for (let i = 0; i < 3; i++) await m._pollDomain("software");
  assert.equal(events.length, 0);
});

test("Windows and macOS units never poll software", async () => {
  for (const platform of ["windows", "darwin"]) {
    const { m, calls } = monitor({ platform });
    await m._pollDomain("software");
    assert.equal(calls(), 0, platform);
  }
});

test("coming online — the first time and after an outage — reads software at once", async () => {
  const { m, readings, calls } = monitor();
  readings.push(V1, V1);
  m._noteOnline(true); // first liveness result (baseline)
  await new Promise((r) => setImmediate(r));
  assert.equal(calls(), 1);
  m._noteOnline(true); // still online: no extra read
  await new Promise((r) => setImmediate(r));
  assert.equal(calls(), 1);
  m._noteOnline(false);
  m._noteOnline(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls(), 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/collectors/__tests__/softwareInventory.test.js server/sparks/__tests__/monitor-software.test.js`
Expected: FAIL with `c.collectSoftware is not a function`, and `software` undefined on the snapshot.

- [ ] **Step 3: Write the implementation**

`server/config.js`: after line 78 (`POLL_INTERVAL_HERMES`) add:

```js
// Driver / CUDA / kernel / OS versions: a handful of file reads, re-read on every reconnect too.
const POLL_INTERVAL_SOFTWARE = parseInt(process.env.POLL_INTERVAL_SOFTWARE || "600000", 10);
```

Then add `POLL_INTERVAL_SOFTWARE,` to the `export { … }` list after `POLL_INTERVAL_HERMES,` (:228).

`server/collectors/SystemCollector.js`: add the import after line 8:

```js
import { SOFTWARE_SECTIONS, buildSoftwareScript, parseSoftware } from "./softwareInventory.js";
```

Add this method after `collectRoce()` (ends :576):

```js
  /** Driver, CUDA, kernel, OS and DGX OS versions; null on Windows / macOS or when nothing could be read. */
  async collectSoftware() {
    if (this.isWindows || this.isMac) return null;
    const script = buildSoftwareScript();
    try {
      const out = this.spark.isLocal
        ? this._hasHostProc()
          ? // The container's /etc describes the image, not the host.
            await this._execOnHost(script, { allowContainerFallback: false })
          : await this._exec(script)
        : await sshExec(this.spark, script, { timeoutMs: 8000 });
      return parseSoftware(splitRemoteGpuSections(out, SOFTWARE_SECTIONS), Date.now());
    } catch (err) {
      console.error(`[SystemCollector] software error for ${this.spark.id}:`, err.message);
      return null;
    }
  }
```

`server/sparks/SparkMonitor.js`:

1. Add `POLL_INTERVAL_SOFTWARE,` to the `../config.js` import (:18-27), and add this import below the `HealthEvaluator` import (:12):

```js
import { COMPARED_FIELDS } from "../../src/shared/softwareDrift.js";
```

2. In the constructor, after `this._health = [];` (~:134):

```js
    /** Last good software reading (snapshot().software); null until the first one. */
    this._software = null;
```

3. In `start()`, after the storage/residentModels `setInterval` lines (:606-607):

```js
    this._intervals.push(setInterval(() => this._pollDomain("software"), POLL_INTERVAL_SOFTWARE));
```

(The first reading comes from `_noteOnline` once liveness succeeds; see item 6.)

4. In `_pollDomain`, next to the other per-domain guards (after `if (domain === "tailscale" && …) return;`, ~:1022):

```js
    if (domain === "software" && !this._softwareEnabled()) return;
```

In the collect switch (after `case "memory": … break;`, ~:1048):

```js
        case "software":
          result = await this.collector.collectSoftware(); // null = could not read
          break;
```

In the store switch (after `case "memory": … break;`, ~:1120):

```js
        case "software":
          if (result) {
            this._noteSoftwareChange(this._software, result);
            this._software = result;
          }
          break;
```

5. Add these methods next to `_hermesMonitoringEnabled` (~:493):

```js
  /** Software versions are read from Linux files; Windows and macOS units have none. */
  _softwareEnabled() {
    return this.spark.platform !== "windows" && this.spark.platform !== "darwin";
  }

  /** Activity event when a compared version changes; the first reading is a baseline. */
  _noteSoftwareChange(prev, next) {
    if (!prev) return;
    const changes = [];
    for (const { field, label } of COMPARED_FIELDS) {
      if (prev[field] && next[field] && prev[field] !== next[field]) {
        changes.push({ field, label, from: prev[field], to: next[field] });
      }
    }
    if (changes.length === 0) return;
    const name = this.spark.name || this.spark.id;
    this._emit({
      type: "software.changed",
      severity: "info",
      message: `${name}: ${changes.map((c) => `${c.label} ${c.from} → ${c.to}`).join(", ")}`,
      data: { changes: changes.map(({ field, from, to }) => ({ field, from, to })) },
    });
  }
```

6. In `_noteOnline` (:739), read software whenever the unit becomes online, including the first liveness result. `_checkOnline` sets `this.online = true` before calling `_noteOnline`, so the offline guard in `_pollDomain` does not swallow this poll:

```js
  _noteOnline(next) {
    const prev = this._prevOnline;
    this._prevOnline = next;
    // Versions change across reboots: read them as soon as the unit answers, not 10 minutes later.
    if (next && prev !== true) void this._pollDomain("software");
    if (prev == null || prev === next) return;
    // … unchanged …
```

7. In `snapshot()`, after `hardware: this._hardwareSummary,` (~:688):

```js
      software: this._software,
```

`README.md` Configuration table: after the `POLL_INTERVAL_HERMES` row (:981), add:

```markdown
| `POLL_INTERVAL_SOFTWARE` | `600000` | Software versions poll (ms): driver, CUDA, kernel, OS, DGX OS. Also read when a unit comes online |
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/collectors/__tests__/softwareInventory.test.js server/sparks/__tests__/*.test.js`
Expected: PASS, with the existing monitor tests (lifecycle, offline polls, poll intervals) unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/config.js server/collectors/SystemCollector.js server/sparks/SparkMonitor.js server/collectors/__tests__/softwareInventory.test.js server/sparks/__tests__/monitor-software.test.js README.md
git commit -m "feat: collect driver, CUDA, kernel and OS versions on every Linux unit"
```

---

### Task 4: `drift` alert rule

**Files:**
- Modify: `server/alerts/conditions.js`: import (:18-19), `RULES` (:35-51), `collectConditions` (:89-123)
- Modify: `server/alerts/engine.js`: import, and `evaluate()` (:156-192)
- Modify: `README.md` "What notifies" list (~:540)
- Test: `server/alerts/__tests__/conditions.test.js`, `server/alerts/__tests__/engine.test.js` (append)

**Interfaces:**
- Consumes: `softwareDrift`, `driftSummary` and `DRIFT_LABEL` (Task 2).
- Produces:
  - `collectConditions(unit, { drift }?: { drift?: DriftEntry })`: the second argument is optional, and every existing caller stays valid.
  - The rule `drift` in `RULES`.

- [ ] **Step 1: Write the failing tests**

Append to `server/alerts/__tests__/conditions.test.js`:

```js
const DRIFT = { headId: "spark-1", headName: "spark-1", diffs: [{ field: "driver", label: "driver", value: "580.95.05", headValue: "580.82.07" }] };

test("software drift is one warning condition with the shared wording", () => {
  const r = collectConditions(unit({ id: "spark-2", role: "worker" }), { drift: DRIFT });
  assert.deepEqual(r.conditions, [{
    ruleId: "drift",
    ruleName: "Software differs from head",
    severity: "warning",
    label: "Software differs from head",
    summary: "driver 580.95.05 vs 580.82.07 on spark-1",
  }]);
  assert.equal(r.judged("drift"), true);
});

test("an offline worker raises no drift condition and the rule is not judged (its alert holds)", () => {
  const r = collectConditions(unit({ online: false, offlineReason: "timed out" }), { drift: DRIFT });
  assert.deepEqual(r.conditions.map((c) => c.ruleId), ["offline"]);
  assert.equal(r.judged("drift"), false);
});

test("the drift rule waits 30 minutes by default and is on", () => {
  assert.deepEqual(effectiveRuleConfig("drift"), { enabled: true, forSec: 1800 });
  assert.equal(RULES.find((r) => r.id === "drift").source, "strip");
});
```

Append to `server/alerts/__tests__/engine.test.js`:

```js
const sw = (driver) => ({ driver, cuda: "13.0.1", kernel: "6.11.0-1016-nvidia", os: "Ubuntu 24.04.3 LTS", dgxOs: "7.2.3", collectedAt: 1 });
const driftHeadUnit = (over = {}) => unit({ id: "spark-1", name: "spark-1", role: "head", software: sw("580.82.07"), ...over });
const driftWorker = (driver, over = {}) => unit({ id: "spark-2", name: "spark-2", role: "worker", workerHeadId: "spark-1", software: sw(driver), ...over });

test("a worker's driver drift fires on the worker after its wait, and resolves after the fix holds", () => {
  const { now, engine } = setup({ drift: { forSec: 1800 } });
  engine.evaluate([driftHeadUnit(), driftWorker("580.95.05")]);
  assert.equal(engine.pending().length, 1);
  now.advance(1_800_000);
  engine.evaluate([driftHeadUnit(), driftWorker("580.95.05")]);
  const [a] = engine.active();
  assert.equal(a.key, "spark-2:drift");

  engine.evaluate([driftHeadUnit(), driftWorker("580.82.07")]);
  assert.equal(engine.active().length, 1, "clears only after staying clear for the wait");
  now.advance(1_800_000);
  engine.evaluate([driftHeadUnit(), driftWorker("580.82.07")]);
  assert.equal(engine.active().length, 0);
});

test("a rebooting head does not resolve the worker's drift alert", () => {
  const { now, engine } = setup({ drift: { forSec: 1800 } });
  const fleet = (headOver) => [driftHeadUnit(headOver), driftWorker("580.95.05")];
  engine.evaluate(fleet());
  now.advance(1_800_000);
  engine.evaluate(fleet());
  assert.equal(engine.active().length, 1);
  for (let i = 0; i < 3; i++) {
    now.advance(1_800_000);
    engine.evaluate(fleet({ online: false, offlineReason: "timed out" }));
  }
  assert.deepEqual(engine.active().map((x) => x.key), ["spark-2:drift"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/alerts/__tests__/conditions.test.js server/alerts/__tests__/engine.test.js`
Expected: FAIL. `effectiveRuleConfig("drift")` returns the unknown-rule defaults `{ enabled: true, forSec: 60 }`, no `drift` condition is produced, and the engine tests see no pending alert.

- [ ] **Step 3: Write the implementation**

`server/alerts/conditions.js`, after the `fleetExceptions` import (:18):

```js
import { DRIFT_LABEL, driftSummary } from "../../src/shared/softwareDrift.js";
```

Add to `RULES`, after the `tailnet` entry:

```js
  { id: "drift", source: "strip", name: "Software differs from head", description: "A worker's driver, CUDA, kernel or DGX OS version differs from its head's (Overview strip). The 30-minute wait covers a rolling upgrade.", defaults: { enabled: true, forSec: 1800 } },
```

Change the `collectConditions` signature and JSDoc:

```js
 * @param {any} unit SparkMonitor snapshot
 * @param {{ drift?: { headId: string, headName: string, diffs: any[] } }} [fleet] this unit's entry from softwareDrift(units), when it has one
 ...
export function collectConditions(unit, { drift } = {}) {
```

Inside `if (unit.online) {`, before the Health findings loop:

```js
    if (drift) {
      conditions.push({
        ruleId: "drift",
        ruleName: ruleName("drift"),
        severity: "warning",
        label: DRIFT_LABEL,
        summary: capText(driftSummary(drift)),
      });
    }
```

`server/alerts/engine.js`: add the import next to the `conditions.js` import:

```js
import { softwareDrift } from "../../src/shared/softwareDrift.js";
```

In `evaluate(units)`, after `const cfgCache = new Map();` / `cfgFor` (before `for (const unit of list)`):

```js
    // Drift compares a worker with its head, so it is worked out over the whole fleet once.
    const drift = softwareDrift(list);
```

In the loop, replace `result = collectConditions(unit);` with:

```js
        result = collectConditions(unit, { drift: drift.get(unit.id) });
```

`src/components/AlertsDialog.tsx` needs no change. It lists `config.rules` from the server, grouped by `source` (:34, :281), so `drift` appears under the strip section with its own switch and wait.

`README.md`, "What notifies", in the second bullet (Overview exceptions), change the list to:
"… storage at or above 90 %, LLM unavailable, tailnet unavailable, and a worker whose driver, CUDA, kernel or DGX OS version differs from its head's (`drift`, 30 min wait by default so a rolling upgrade stays quiet)."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/alerts/__tests__/*.test.js`
Expected: PASS, including `store.test.js`, which now accepts `drift` as a known rule id.

- [ ] **Step 5: Commit**

```bash
git add server/alerts/conditions.js server/alerts/engine.js server/alerts/__tests__/conditions.test.js server/alerts/__tests__/engine.test.js README.md
git commit -m "feat: drift alert rule for workers whose versions differ from their head"
```

---

### Task 5: Prometheus `sparkdash_software_info`

**Files:**
- Modify: `server/prometheus.js`: `METRIC_FAMILIES` (after `sparkdash_gpu_info`, ~:49), and `addUnit` (after `sparkdash_uptime_seconds`, ~:354)
- Modify: `README.md`, the Prometheus metrics table (after the `sparkdash_gpu_info` row)
- Test: `server/__tests__/prometheus.test.js` (append)

**Interfaces:**
- Consumes: `snapshot.software` (Task 3).
- Produces: the metric family `sparkdash_software_info`.

- [ ] **Step 1: Write the failing test**

Append to `server/__tests__/prometheus.test.js`:

```js
test("software versions are one info sample per online unit; null versions are dropped", () => {
  const software = { driver: "580.95.05", cuda: "13.0.1", kernel: "6.11.0-1016-nvidia", os: "Ubuntu 24.04.3 LTS", dgxOs: null, collectedAt: 1 };
  const families = parseExposition(renderPrometheusMetrics([{ ...gb10Head(), software }]));
  const [s] = samplesOf(families, "sparkdash_software_info");
  assert.equal(s.value, 1);
  assert.equal(s.labels.unit, "spark-1");
  assert.equal(s.labels.driver, "580.95.05");
  assert.equal(s.labels.cuda, "13.0.1");
  assert.equal(s.labels.kernel, "6.11.0-1016-nvidia");
  assert.equal(s.labels.os, "Ubuntu 24.04.3 LTS");
  assert.equal("dgx_os" in s.labels, false);

  assert.equal(samplesOf(parseExposition(renderPrometheusMetrics([gb10Head()])), "sparkdash_software_info").length, 0, "no reading, no sample");
  const offline = { ...gb10Head(), online: false, software };
  assert.equal(samplesOf(parseExposition(renderPrometheusMetrics([offline])), "sparkdash_software_info").length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/__tests__/prometheus.test.js`
Expected: FAIL on `s.value`, because `s` is undefined.

- [ ] **Step 3: Write the implementation**

In `METRIC_FAMILIES`, after the `sparkdash_gpu_info` entry:

```js
  {
    name: "sparkdash_software_info",
    type: "gauge",
    help: "Always 1; carries the unit's NVIDIA driver, CUDA toolkit, kernel, OS and DGX OS versions as labels (Linux units).",
  },
```

In `addUnit`, after `samples.add("sparkdash_uptime_seconds", base, snapshot.uptime);`:

```js
  const sw = snapshot.software;
  if (sw && typeof sw === "object") {
    samples.add(
      "sparkdash_software_info",
      { ...base, driver: sw.driver ?? null, cuda: sw.cuda ?? null, kernel: sw.kernel ?? null, os: sw.os ?? null, dgx_os: sw.dgxOs ?? null },
      1
    );
  }
```

In the `README.md` Prometheus table, after the `sparkdash_gpu_info` row:

```markdown
| `sparkdash_software_info` | gauge | `driver`, `cuda`, `kernel`, `os`, `dgx_os` | Always 1, on Linux units once versions are read. A label is absent when that version could not be read (no DGX OS on a plain Ubuntu host). `count by (driver) (sparkdash_software_info)` shows driver spread across the fleet |
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/__tests__/prometheus.test.js`
Expected: PASS, including "every line of a mixed fleet parses" and "an offline unit exports sparkdash_up 0 and nothing else".

- [ ] **Step 5: Commit**

```bash
git add server/prometheus.js server/__tests__/prometheus.test.js README.md
git commit -m "feat: export software versions as sparkdash_software_info"
```

---

### Task 6: Overview strip, unit header, docs

**Files:**
- Modify: `src/components/OverviewPage/FleetAlertStrip.tsx`: import (:3), and `deriveAlerts` (:21-38)
- Modify: `src/components/SparkPage/SparkHeader.tsx`: props (:8-13), body (:27-49), JSX (after the `<p className="sp-header__meta">` block, ~:120)
- Modify: `src/components/SparkPage/SparkPage.tsx`: the `<SparkHeader …>` call (:260)
- Modify: `src/components/ActivityPage/activityStats.ts:56-66` (`categorize`): route `software.*` to "Fleet changes" instead of "Other"
- Modify: `README.md` Features table (after the "Health findings" row), `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Test: `src/components/OverviewPage/FleetAlertStrip.test.tsx`, `src/components/SparkPage/SparkHeader.test.tsx`, `src/components/ActivityPage/activityStats.test.ts` (append)

No CSS change: `.sp-header__meta` is `flex-wrap: wrap` (`src/styles/spark.css:67`), and mobile renders the same `SparkHeader`, so the versions line wraps on a phone.

**Interfaces:**
- Consumes: `softwareDrift`, `driftSummary`, `DRIFT_LABEL` and `DriftEntry` (Task 2); `SparkSnapshot.software` (Task 2 type, Task 3 data).
- Produces:
  - `SparkHeader` prop `drift?: DriftEntry | null`;
  - strip rows keyed `"<unitId>:drift"`, the same key as the server alert, so `serverAlertRows` uses the live text.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/OverviewPage/FleetAlertStrip.test.tsx` (new `describe` at the end; `makeSpark` and `SparkSnapshot` are already imported):

```tsx
function withSoftware(id: string, driver: string, role: "head" | "worker"): SparkSnapshot {
  const s = makeSpark(id);
  s.role = role;
  s.workerHeadId = role === "worker" ? "spark-1" : null;
  s.software = { driver, cuda: "13.0.1", kernel: "6.11.0-1016-nvidia", os: "Ubuntu 24.04.3 LTS", dgxOs: "7.2.3", collectedAt: 1 };
  return s;
}

describe("deriveAlerts: software drift", () => {
  it("lists a worker whose driver differs from its head, with the server's key and wording", () => {
    const alerts = deriveAlerts([withSoftware("spark-1", "580.82.07", "head"), withSoftware("spark-2", "580.95.05", "worker")]);
    expect(alerts).toEqual([
      {
        key: "spark-2:drift",
        unitId: "spark-2",
        unitName: "Spark spark-2",
        label: "Software differs from head",
        detail: "driver 580.95.05 vs 580.82.07 on Spark spark-1",
        severity: "warning",
        startsAt: null,
      },
    ]);
  });

  it("matching versions raise nothing", () => {
    expect(deriveAlerts([withSoftware("spark-1", "580.82.07", "head"), withSoftware("spark-2", "580.82.07", "worker")])).toEqual([]);
  });
});
```

Append to `src/components/SparkPage/SparkHeader.test.tsx`:

```tsx
describe("SparkHeader software line", () => {
  const software = { driver: "580.95.05", cuda: null, kernel: "6.11.0-1016-nvidia", os: "Ubuntu 24.04.3 LTS", dgxOs: "7.2.3", collectedAt: 1 };

  it("shows the known versions and skips missing ones", () => {
    const spark = makeSpark();
    spark.software = software;
    const { container } = render(<SparkHeader spark={spark} />);
    const text = container.querySelector(".sp-header__software")?.textContent ?? "";
    expect(text).toContain("Driver 580.95.05");
    expect(text).toContain("Kernel 6.11.0-1016-nvidia");
    expect(text).toContain("DGX OS 7.2.3");
    expect(text).not.toContain("CUDA");
    expect(container.querySelector(".sp-header__software .text-warning")).toBeNull();
  });

  it("marks a drifting value and names the head's version", () => {
    const spark = makeSpark("spark-2");
    spark.software = software;
    const drift = { headId: "spark-1", headName: "Spark spark-1", diffs: [{ field: "driver" as const, label: "driver", value: "580.95.05", headValue: "580.82.07" }] };
    const { container } = render(<SparkHeader spark={spark} drift={drift} />);
    const marked = container.querySelectorAll(".sp-header__software .text-warning");
    expect(marked).toHaveLength(1);
    expect(marked[0].textContent).toBe("Driver 580.95.05");
    expect(marked[0].getAttribute("title")).toBe("Spark spark-1 has 580.82.07");
  });

  it("renders no line before versions are known", () => {
    const { container } = render(<SparkHeader spark={makeSpark()} />);
    expect(container.querySelector(".sp-header__software")).toBeNull();
  });
});
```

Append to `src/components/ActivityPage/activityStats.test.ts`, inside the `describe` that holds the `categorize` assertions (~:24):

```ts
    expect(categorize("software.changed")).toBe("fleet");
    expect(typeLabel("software.changed")).toBe("Software changed");
```

If `typeLabel` is not already imported in that file, add it to the existing `./activityStats` import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/OverviewPage/FleetAlertStrip.test.tsx src/components/SparkPage/SparkHeader.test.tsx src/components/ActivityPage/activityStats.test.ts`
Expected: FAIL. The drift row is missing, `.sp-header__software` is null, and `categorize("software.changed")` is `"other"`.

- [ ] **Step 3: Write the implementation**

`src/components/OverviewPage/FleetAlertStrip.tsx`, after the `fleetExceptions` import:

```ts
import { DRIFT_LABEL, driftSummary, softwareDrift } from "../../shared/softwareDrift";
```

In `deriveAlerts`, after the `for (const spark of sparks) { … }` loop and before `return alerts;`:

```ts
  // Drift compares a worker with its head, so it comes from the whole fleet, not one unit.
  for (const [unitId, entry] of softwareDrift(sparks)) {
    const spark = sparks.find((s) => s.id === unitId);
    if (!spark) continue;
    alerts.push({
      key: `${unitId}:drift`,
      unitId,
      unitName: spark.name,
      label: DRIFT_LABEL,
      detail: driftSummary(entry),
      severity: "warning",
      startsAt: null,
    });
  }
```

`src/components/SparkPage/SparkHeader.tsx`: add the import:

```ts
import type { DriftEntry } from "../../shared/softwareDrift";
```

Add to `SparkHeaderProps`:

```ts
  /** This unit's software drift from its head (softwareDrift over the fleet), if any. */
  drift?: DriftEntry | null;
```

Change the signature to `export function SparkHeader({ spark, drift, onEdit, onNavigate }: SparkHeaderProps) {`. After the `hw` array, add:

```ts
  const sw = spark.software;
  const driftBy = new Map((drift?.diffs ?? []).map((d) => [d.field, d] as const));
  const versions = sw
    ? (
        [
          ["driver", "Driver"],
          ["cuda", "CUDA"],
          ["kernel", "Kernel"],
          ["dgxOs", "DGX OS"],
        ] as const
      ).flatMap(([field, label]) => (sw[field] ? [{ field, label, value: sw[field] as string, diff: driftBy.get(field) }] : []))
    : [];
```

In the JSX, directly after the closing `</p>` of `sp-header__meta` (inside `sp-header__id`):

```tsx
        {versions.length > 0 && (
          <p className="sp-header__meta sp-header__software">
            {versions.map((v, i) => (
              <span key={v.field}>
                {i > 0 && <span className="sp-sep">·</span>}
                <span
                  className={v.diff ? "text-warning" : undefined}
                  title={v.diff && drift ? `${drift.headName} has ${v.diff.headValue}` : undefined}
                >
                  {v.label} <span className="mono">{v.value}</span>
                </span>
              </span>
            ))}
          </p>
        )}
```

`src/components/SparkPage/SparkPage.tsx`: add the import:

```ts
import { softwareDrift } from "../../shared/softwareDrift";
```

Change the header call (:260) to:

```tsx
      <SparkHeader
        spark={spark}
        drift={softwareDrift(fleet ?? [spark]).get(spark.id) ?? null}
        onEdit={onEdit}
        onNavigate={onNavigate}
      />
```

`src/components/ActivityPage/activityStats.ts`, in `categorize`, after the `spark.added` / `spark.removed` line (:58):

```ts
  if (type.startsWith("software.")) return "fleet";
```

(`typeLabel` already turns `software.changed` into "Software changed" through `sentence()`; no `KNOWN_LABELS` entry is needed.)

`README.md` Features table, after the "Health findings" row:

```markdown
| **Software versions** | NVIDIA driver, CUDA toolkit, kernel, OS and DGX OS per Linux unit, under the unit page header, re-read every 10 min and whenever a unit comes back. A worker whose driver, CUDA, kernel or DGX OS differs from its head's is flagged on the Overview strip and can notify (`drift`, 30 min wait). Version changes are logged to **Activity**; Prometheus gets `sparkdash_software_info` |
```

`CHANGELOG.md`, under `## [Unreleased]` → `### Added`:

```markdown
- **Software versions and drift**: each Linux unit reports its NVIDIA driver, CUDA toolkit, kernel, OS and DGX OS (unit page header, `sparkdash_software_info`). A worker whose versions differ from its head's shows on the Overview strip and, with alert notifications on, notifies after 30 minutes (`drift`). Version changes are recorded in Activity (`software.changed`).
```

- [ ] **Step 4: Run the whole suite, typecheck and build**

Run: `npm test && npm run typecheck && npm run build`
Expected: every server and frontend test passes, `tsc` reports no errors, and `vite build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/ActivityPage/activityStats.ts src/components/ActivityPage/activityStats.test.ts src/components/OverviewPage/FleetAlertStrip.tsx src/components/OverviewPage/FleetAlertStrip.test.tsx src/components/SparkPage/SparkHeader.tsx src/components/SparkPage/SparkHeader.test.tsx src/components/SparkPage/SparkPage.tsx README.md CHANGELOG.md
git commit -m "feat: show software versions and drift on the unit header and Overview strip"
```

---

## After the last task: verify on real Sparks (needs the user's hardware)

This development machine is x86 Ubuntu, so these checks wait for a deploy to a fleet with real Sparks:

- [ ] On a Spark, run `cat /etc/dgx-release`. Confirm that `DGX_OTA_VERSION` and/or `DGX_SWBUILD_VERSION` exist and that the last OTA line is the current build. If the key differs, change it in `parseSoftware` and its test.
- [ ] On a Spark, run `cat /usr/local/cuda/version.json`. Confirm it exists and that `.cuda.version` is set.
- [ ] On a Spark, run `head -1 /proc/driver/nvidia/version`. Confirm the open-module regex matches the GB10 wording.
- [ ] With sparkDash in Docker on a Spark, check that the local unit's header shows the host's DGX OS and not the image's `os-release`.
- [ ] Head and worker on the same versions: the strip is quiet. Downgrade or hold one package on the worker, or edit a test snapshot, and check the strip row and the notification after 30 minutes.
