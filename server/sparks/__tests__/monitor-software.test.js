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
