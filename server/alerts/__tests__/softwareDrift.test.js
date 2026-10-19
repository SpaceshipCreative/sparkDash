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
