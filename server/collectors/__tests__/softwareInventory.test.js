/**
 * The software probe: one script of plain file reads and its parser. A missing file
 * is a null field, never a failed reading.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SOFTWARE_FILES, SOFTWARE_SECTIONS, buildSoftwareScript, parseSoftware } from "../softwareInventory.js";
import { SystemCollector, splitRemoteGpuSections } from "../SystemCollector.js";

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
