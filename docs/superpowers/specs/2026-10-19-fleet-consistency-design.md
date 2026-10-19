# Fleet consistency checks: design and implementation checklists

Date: 2026-10-19 · Status: draft for review

Two independent features for clustered DGX Sparks (a head plus its workers over the CX7 link):

- **A. Software version drift.** Every Linux unit reports its driver, CUDA, kernel and DGX OS versions. A worker whose versions differ from its head is flagged on the Overview strip and can notify.
- **B. Interconnect bandwidth test.** An on-demand benchmark that runs `ib_write_bw` between two units over RoCE and compares the result with the link rate.

They share no code. Each gets its own implementation plan and PR. A goes first because it is smaller and has fewer hardware unknowns.

---

## A. Software version drift

### What exists today

- `hardware.cudaDriver` is the **driver** version (from `nvidia-smi --query-gpu=name,driver_version`, `server/collectors/SystemCollector.js:3040-3057`), not the CUDA version.
- That field is detected only for `kind: "host"` units, once, in the `SparkMonitor` constructor (`server/sparks/SparkMonitor.js:221-233`), with no retry. Spark units use a static summary with `cudaDriver: null`.
- Kernel, OS release and CUDA toolkit versions are not read anywhere.
- Alerts look at one unit at a time: `collectConditions(unit)` (`server/alerts/conditions.js:89`) is called per unit from `AlertEngine.evaluate` (`server/alerts/engine.js:156`). The Overview strip works the same way (`deriveAlerts`, `src/components/OverviewPage/FleetAlertStrip.tsx:21`).

### Decisions (correct any of these)

1. **New snapshot field `software`; `hardware` stays as it is.** Shape:
   `{ driver, cuda, kernel, os, dgxOs, collectedAt } | null`. Every value is a string or null, and `collectedAt` is epoch ms. `null` means not collected: a Windows or macOS unit, or a Linux unit not yet read.
2. **Sources are plain file reads, the same on local and remote units:**

   | Field | File | Parse |
   |---|---|---|
   | `driver` | `/proc/driver/nvidia/version` | the first `\d+\.\d+(\.\d+)?` after `Kernel Module` |
   | `cuda` | `/usr/local/cuda/version.json` | `.cuda.version` |
   | `kernel` | `/proc/sys/kernel/osrelease` | trimmed |
   | `os` | `/etc/os-release` | `PRETTY_NAME` |
   | `dgxOs` | `/etc/dgx-release` | `DGX_SWBUILD_VERSION` (key to be confirmed on hardware) |

   - One script, `printf '\n__NAME__\n'; cat <file> 2>/dev/null` per field, runs on every unit.
     - Remote units run it over one SSH call.
     - Local units run it through `_execOnHost(script, { allowContainerFallback: false })`, the same path `collectRoce` uses. `_readHostFile` is not used because it falls back to the container's own `/etc`, which describes the image, not the host.
3. **Cadence:** a new `software` poll domain.
   - It runs every `POLL_INTERVAL_SOFTWARE` (env, default 600000 ms = 10 min), next to `POLL_INTERVAL_HERMES` in `server/config.js:78`.
   - It also runs once at start and again when a unit comes back online (`_noteOnline(true)`, `SparkMonitor.js:739`). A reboot is the usual moment versions change.
   - It runs on Linux units only. While a unit is offline it keeps its last reading; existing SSH-backed polls already pause then (`SparkMonitor.js:1002`).
4. **What counts as drift:** a **worker** whose versions differ from its **head**, measured by four fields: `driver`, `cuda`, `kernel` and `dgxOs`.
   - A field is compared only when both sides have a value. A plain Linux GPU host under a Spark head has no `dgxOs`, so that field is skipped instead of drifting forever.
   - `os` is shown but not compared. DGX OS and Ubuntu point releases share a pretty name format that differs for harmless reasons.
   - Standalone units and heads with no workers are never flagged.
   - An offline **worker** gets no condition, because being offline raises its own alert and `judged()` keeps any firing drift alert as it is.
   - An offline **head** is still compared, using its last-known `software`. Otherwise a head reboot would resolve every worker's drift alert after 30 minutes and fire it again 30 minutes after the head returns.
5. **Head resolution** works like `makeHeadResolver` (`src/shared/sparkHead.ts`). A worker's head is its `workerHeadId` when that unit exists. Otherwise it is the fleet's only head, if there is exactly one. Otherwise the worker has no head and nothing is compared. The resolver is written in plain JS in `src/shared/` because the server cannot import `.ts`.
6. **One shared module computes drift for both the server and the browser:** `src/shared/softwareDrift.js` with a `.d.ts`, the same pattern as `fleetExceptions.js`.
   - The alert engine calls it once per `evaluate(units)` and passes each unit's result into `collectConditions`.
   - `deriveAlerts` calls it once over the fleet.
7. **Alert rule** `drift`: name "Software differs from head", `source: "strip"`, `severity: "warning"` (never critical), defaults `{ enabled: true, forSec: 1800 }`.
   - Why 30 minutes: during a rolling upgrade the head and worker legitimately differ until the second one has rebooted. Half an hour covers that without hiding a real, forgotten mismatch for long.
8. **Activity event** `software.changed` when a unit's compared fields change between two readings. Example: "spark-2: driver 580.82 → 580.95".
   - It is not emitted on the first reading after a restart, because that is a baseline. This follows the Health findings rule.
   - It records when a drift started, which the strip alone cannot show.
9. **Prometheus:** a new info metric, `sparkdash_software_info{driver,cuda,kernel,os,dgx_os} 1`, for online units with `software` set. This lets Grafana users build their own version matrix.

### Implementation checklist

**Collector (server)**

- [ ] `server/collectors/SystemCollector.js:191-210`: give `splitRemoteGpuSections(output, allowed = REMOTE_GPU_SECTIONS)` an optional allowed-set parameter, so the software probe reuses the same parser. Existing callers stay unchanged.
- [ ] New `server/collectors/softwareInventory.js`, with these exports:
  - `SOFTWARE_SECTIONS` (`DRIVER`, `CUDA`, `KERNEL`, `OSREL`, `DGXREL`).
  - `SOFTWARE_FILES`: section → path.
  - `buildSoftwareScript()`: the remote `printf`/`cat` script.
  - `parseSoftware(sections, now)`: returns the `software` object, with null for each missing or unparseable field.
  - It is pure; no I/O in this file.
- [ ] `SystemCollector`: add `collectSoftware()`.
  - Local units: `_readHostFile` for each path in `SOFTWARE_FILES`, with a missing file giving null.
  - Remote units: one `sshExec(buildSoftwareScript())`, then `splitRemoteGpuSections(out, SOFTWARE_SECTIONS)`.
  - Windows or macOS units return `null` without running anything.
  - Errors are caught and return `null`, following the collectors' rule to degrade, not throw.
- [ ] Check that `_readHostFile` accepts paths outside `/proc` (`/etc/...`, `/usr/local/...`) inside the Docker container. If it does not, read those three files through the same nsenter path `_nvidiaSmi` uses (`SystemCollector.js:2953`).

**Monitor (server)**

- [ ] `server/config.js`: add `POLL_INTERVAL_SOFTWARE`, from env with default 600000, and export it like `POLL_INTERVAL_HERMES`.
- [ ] `server/sparks/SparkMonitor.js`:
  - Add a `software` case in `_pollDomain`, both the collect switch (~:1069) and the store switch (~:1138). It writes `this._software`.
  - Register the interval with the other slow timers (~:606), only when `spark.platform` is Linux.
  - Trigger one `void this._pollDomain("software")` from `_noteOnline` whenever the unit becomes online, including the first liveness result. `start()` needs no trigger of its own, because its first `_poll()` runs `_checkOnline`.
    - Triggering from `_noteOnline` is safe: `_checkOnline` sets `this.online = true` before calling it, so the offline early return in `_pollDomain` (:1002) does not swallow the poll.
    - Keep that order; a test covers it.
- [ ] Same file: emit the `software.changed` event when a compared field differs from the previous non-null reading. Use `this._emit` with `severity: "info"` and the message format from decision 8.
- [ ] Snapshot (~:688): add `software: this._software ?? null`.
- [ ] Leave `software` out of the `/metrics` collector-freshness series. A 10-minute file read is not worth a staleness alert. Check that `_domainSucceeded` does not choke on the new domain name.

**Shared drift logic**

- [ ] New `src/shared/softwareDrift.js`:
  - `COMPARED_FIELDS` (`driver`, `cuda`, `kernel`, `dgxOs` with display labels).
  - `headIdFor(unit, units)`, following decision 5.
  - `softwareDrift(units)`: returns a `Map<unitId, { headId, headName, diffs: [{ field, label, value, headValue }] }>` that contains only drifting workers.
- [ ] New `src/shared/softwareDrift.d.ts` with the matching types.
- [ ] `src/api/types.ts`: add a `SoftwareInfo` interface and an optional `software?: SoftwareInfo | null` on `SparkSnapshot` (near :702). Because it is optional, a dashboard talking to an older server still type-checks, and the default snapshots need no edits.

**Alerts**

- [ ] `server/alerts/conditions.js`: add a `RULES` entry for `drift` (decision 7). Without it, `store.js:99-130` rejects the rule id on save.
- [ ] Same file: change `collectConditions(unit, { drift } = {})` so that a given `drift` pushes a condition: `ruleId: "drift"`, `label: "Software differs from head"`, and summary `"driver 580.95 vs 580.82 on spark-1"`, joined by `; ` for several fields and capped by `capText`.
  - Only when `unit.online`.
  - `judged()` stays as it is, so a fixed worker resolves the alert after `forSec` and an offline worker keeps it.
- [ ] `server/alerts/engine.js:156`: compute `const drift = softwareDrift(list)` once before the loop and call `collectConditions(unit, { drift: drift.get(unit.id) })`.
- [ ] Check that `AlertsDialog.tsx` lists the new rule from `RULES` with no extra UI code. If it groups by `source`, `"strip"` puts it with the other strip rules.

**Overview strip and unit page (frontend)**

- [ ] `src/components/OverviewPage/FleetAlertStrip.tsx` `deriveAlerts`: after the per-unit loop, add one `FleetAlert` per entry of `softwareDrift(sparks)` with `key: "<id>:drift"` and the same label and detail as the server.
- [ ] Same file: check that `serverAlertRows` shows a `drift` server alert with the server's words. Its live-snapshot lookup is built for `fleetExceptions` ids, so a rule id outside that set must fall back to the server text.
- [ ] `src/components/SparkPage/SparkHeader.tsx:46-49`: add a second, muted line when `software` is set: `Driver 580.95 · CUDA 13.0 · Kernel 6.11.0-1016-nvidia · DGX OS 7.2.3`, skipping null fields.
  - When this unit drifts, the differing values use the warning colour and a `title` tooltip: "Head spark-1 has 580.82".
  - Mobile header: same line, allowed to wrap.

**Prometheus**

- [ ] `server/prometheus.js`: add `sparkdash_software_info` to `METRIC_FAMILIES` (near :46). Without it, `SampleSet.add` throws (:213).
- [ ] Same file: emit the metric next to `sparkdash_gpu_info` (~:276) for online units with `software`. Labels are `driver`, `cuda`, `kernel`, `os`, `dgx_os`; `formatLabels` drops nulls.
- [ ] Update the Prometheus metric list in `README.md`.

**Docs**

- [ ] `README.md`: add a "Software versions" row to the Features table, a line in the Alert notifications "What notifies" list, and `POLL_INTERVAL_SOFTWARE` under Configuration.
- [ ] Add a `CHANGELOG.md` entry.

### Tests

- [ ] `server/collectors/__tests__/softwareInventory.test.js` (`node:test`), with fixtures for each file:
  - `/proc/driver/nvidia/version` for both the open and the proprietary module text.
  - `version.json`.
  - `os-release` with quoted values.
  - `dgx-release`.
  - Missing sections give null fields.
  - Garbage gives null, never a throw.
  - The script only `cat`s fixed paths.
- [ ] `server/collectors/__tests__/SystemCollector.*.test.js`: `splitRemoteGpuSections` with a custom allowed set ignores GPU markers and the reverse, so existing behaviour is unchanged.
- [ ] `server/alerts/__tests__/softwareDrift.test.js` (`node:test`, importing `src/shared/softwareDrift.js` as `conditions.js` imports `fleetExceptions.js`). Cases:
  - A worker matching its head gives no entry.
  - A driver mismatch names the field and both values.
  - A null on either side is skipped.
  - A Linux host worker without `dgxOs` under a Spark head is not flagged on `dgxOs`.
  - The sole-head fallback picks the head.
  - Two heads without `workerHeadId` mean no comparison.
  - An offline worker gets no entry.
  - An offline head with known `software` keeps the comparison.
  - A standalone unit is never flagged.
- [ ] `server/alerts/__tests__/conditions.test.js`: the `drift` condition appears only when online and is shaped as specified.
- [ ] `server/alerts/__tests__/engine.test.js`:
  - A drifting worker fires only after `forSec`.
  - Fixing the version resolves the alert after `forSec`.
  - Turning the rule off ends it.
- [ ] `server/__tests__/prometheus.test.js`: `sparkdash_software_info` has its labels, and offline units do not export it.
- [ ] `server/sparks/__tests__/`:
  - A `software.changed` event on a version change.
  - No event on the first reading.
  - A re-collect on the offline→online transition, with an injected collector.
- [ ] `src/components/OverviewPage/FleetAlertStrip.test.tsx`: drift rows from snapshots, and server-alert rows for `drift`.
- [ ] `SparkHeader` vitest: the version line renders, null fields are skipped, and drifting values are marked.

### Verify on hardware (this machine is x86 Ubuntu, not a Spark)

- `/etc/dgx-release` exists on Spark DGX OS. Which key holds the build version?
- Is `/usr/local/cuda/version.json` present on a stock Spark, and is it the toolkit the user actually runs?
- What is the `/proc/driver/nvidia/version` wording on GB10 (open kernel module)?
- `_readHostFile` reaches `/etc` and `/usr/local` of the host from the container.

### Not included

- A fleet version matrix page. Prometheus covers that for now; add a page if people ask for it.
- Container-level versions (vLLM, NCCL and CUDA inside images).
- CX7 firmware.
- Windows and macOS versions.
- Drift between standalone units.

---

## B. Interconnect bandwidth test

### What exists today

- **RoCE data.** The RoCE collector (`server/collectors/roce.js`) gives, per RDMA device: name, active state, link rate (Gb/s) and netdev. It does not give GID indexes or IPs.
- **IP data.** The IP of each netdev is in `metrics.network.interfaces[].ip`, from `ip -4 addr` at `SystemCollector.js:2475`. Joining `roce.devices[].netdev` with `network.interfaces[].name` gives a device's RoCE IP.
- **Bench managers.** The decode, prefill and quality managers are singletons with these traits:
  - one job per Spark (`activeBySpark`);
  - a history file written with `atomicWrite(…, 0o600)`;
  - polling routes (`index.js:1426-1873`);
  - an event sink;
  - the fleet cap `MAX_ACTIVE_BENCH_JOBS` (`activeBenchJobCount`, `index.js:261`; `consumeBenchStartQuota`, :270).
- **Remote commands.** `sshExec` rejects on any non-zero exit and returns no exit code (`ssh.js:295`). Long and streamed remote commands use `defaultSpawn` (`server/llmlaunch/LauncherManager.js:103`) and `ToolEvalManager.runOnce` (`server/tooleval/ToolEvalManager.js:172`), which returns `{ ok, code, output }`. Scripts travel base64-wrapped (`server/vulnhunt/commands.js:55`).
- **Nothing runs one job across two units today.**

### Decisions (correct any of these)

1. **Tool:** `ib_write_bw` from **perftest**, RDMA write bandwidth.
   - sparkDash does not install it. When it is missing, the job fails at once with "ib_write_bw is not installed on spark-2 (sudo apt install perftest)".
   - NCCL all-reduce is the next step; it is not in this spec.
2. **One device pair per run.** The user picks a server unit, a client unit and one RDMA device on each. The default is the first device pair whose IPv4s share a /24. Dual-link setups usually put each port on its own subnet. If no pair shares a /24, the default is the first active device with an IPv4 on each side.
   - The result is compared with that device's `rate`, as already reported in `metrics.roce.devices[]`, never a hard-coded 200 Gb/s.
   - The Spark's CX7 may expose each physical port as more than one RDMA device. Running several pairs at once to measure the aggregate is a follow-up.
3. **Run shape:**
   - **Server side:** `timeout <D+30> ib_write_bw -d <dev> -x <gid> -F --report_gbits -D <D> -p 18515 [-b]`.
     - Spawned through `defaultSpawn`.
     - Bounded by `timeout`, so a dropped SSH session cannot leave a listener on the Spark.
   - **Client side:** the same command plus the server's RoCE IP. It runs through a `runOnce`-style call and is retried up to 3 times, 1 s apart, while the server is still starting to listen.
   - Defaults: duration `D` = 10 s, allowed range 5–30 s. Bidirectional (`-b`) is optional.
4. **GID index** is resolved inside each host's script at run time. The script picks the index under `/sys/class/infiniband/<dev>/ports/1/gids/*` whose `gid_attrs/types` is `RoCE v2`, whose `gid_attrs/ndevs` is the device's netdev, and whose GID is IPv4-mapped. Nothing is added to `roce.js`.
5. **Input safety:**
   - The device name must match `^[A-Za-z0-9._-]{1,32}$` and be an active device in the unit's latest `metrics.roce.devices[]`.
   - The server IP comes from the server unit's own snapshot, never from the request, and is checked with `isValidIPv4`.
   - Duration is an integer in range. The two units must be different and both online on Linux.
   - Scripts are base64-wrapped.
6. **Busy rules:**
   - A run occupies both units: either one running any bench returns 409.
   - It counts as one job in `activeBenchJobCount()` and goes through `consumeBenchStartQuota`.
7. **No active checkpoint.**
   - A job lives in memory, and only finished runs are written to history: `config/interconnect-bench-history.json` (env `INTERCONNECT_BENCH_HISTORY_PATH`), flat and newest first, at most 30, mode `0600`.
   - A sparkDash restart mid-run loses that run, at most ~40 s of work. The remote `timeout` cleans up the listener.
8. **On demand only, never scheduled.** The test saturates the link NCCL traffic uses, so the page says so: "Runs at full link speed; running model traffic over this link will slow down for the test's duration."

### Implementation checklist

**Command building and parsing (server)**

- [ ] New `server/netbench/commands.js`, with these exports:
  - `DEVICE_RE`.
  - `buildGidScript(dev, netdev)`: prints `GID=<n>` or fails with a clear message.
  - `buildServerProgram({ dev, netdev, durationSec, bidirectional, port })` and `buildClientProgram({ …, serverIp })`.
    - Each checks `command -v ib_write_bw` first and exits 127 with the install hint.
    - Each resolves the GID with `buildGidScript`, then runs the tool.
    - Each is wrapped with `wrap()` from `server/vulnhunt/commands.js:55`. It is not exported today; add `export` and import it rather than copying it.
  - Every value is validated before it is placed in a script.
- [ ] New `server/netbench/parse.js`: `parseIbWriteBw(output)` returns `{ msgBytes, iterations, peakGbps, avgGbps, msgRateMpps }` from the result row under the `#bytes #iterations BW peak[Gb/sec] BW average[Gb/sec] MsgRate[Mpps]` header, or null.
  - It also maps known failure lines (`Couldn't connect`, `Failed to create QP`, `No IB devices found`, `Unable to find the Gid index`) to short reasons.

**Manager (server)**

- [ ] New `server/netbench/InterconnectBenchManager.js`, a singleton `interconnectBenchManager`:
  - `start({ serverId, clientId, serverDevice, clientDevice, durationSec, bidirectional }, { registry, snapshots })`:
    - Validates per decision 5.
    - Resolves IPs and link rates from the snapshots.
    - Marks both units busy, then returns the public job.
    - `_runJob` then starts without being awaited.
    - Errors carry `.status`: 400 invalid, 404 unknown unit, 409 busy.
  - `_runJob`: spawn the server program → run the client with retries → parse → kill the server child if it is still running → finish.
    - Job states: `starting` → `running` → `completed` / `failed` / `cancelled`.
    - Results: `{ avgGbps, peakGbps, msgRateMpps, linkRateGbps, pctOfLink }`.
  - `cancel(benchId)` aborts both local children. The remote side relies on its own `timeout`.
  - Also: `getActive()`, `getHistory()`, `getLast()`, `getJob(id)`, `clearHistory()` (409 while running), `activeCount()`, `isBusy(sparkId)`, `setEventSink(fn)`, `interruptAll()`.
- [ ] Same folder: add a small `server/netbench/exec.js` helper, `runProgram(spark, program, { timeoutMs, signal, spawn })`, which returns `{ ok, code, output }`.
  - It spawns through `defaultSpawn`, collects the output and reads the exit code from a trailing marker line.
  - It is needed because `sshExec` rejects without an exit code, and `runOnce` belongs to `ToolEvalManager`, which allows one job per Spark. Both the server and client sides use this helper.
  - The spawn and exec functions are injectable for tests, as in `ToolEvalManager`.
- [ ] Add a cross-bench busy check as one helper in `server/index.js`, `unitBenchBusy(sparkId)`. It returns true when any of the four managers has an active job on that unit.
  - The decode, prefill and quality POST routes return 409 when `interconnectBenchManager.isBusy(id)`.
  - The interconnect manager receives `unitBenchBusy` as a `start()` option and refuses with 409 when either unit is busy.
  - The other managers stay untouched.

**Wiring (server)**

- [ ] `server/index.js`:
  - Add the manager to `activeBenchJobCount()` (:261).
  - Wire `setEventSink` (:338-344).
  - Call `interruptAll()` on shutdown (:2452-2458).
- [ ] `server/index.js` routes, behind the same auth as the other `/api` routes:
  - `POST /api/bench/interconnect` returns 202 with the job, after `consumeBenchStartQuota`.
  - `GET /api/bench/interconnect` returns `{ active, last, history, defaults: { durationSec: 10, port: 18515 } }`.
  - `DELETE /api/bench/interconnect/:benchId` cancels.
  - `DELETE /api/bench/interconnect` clears history.
- [ ] `server/events/eventFormat.js`: add `BENCH_LABEL.interconnect = "Interconnect test"`. In `benchEvent`, the detail for a finished run is `: 97.5 Gb/s (98 % of link) spark-1 → spark-2`.
- [ ] `server/config.js`: add the history path constant and env override, next to the other bench paths.
- [ ] `package.json` `test:server`: add `server/netbench/__tests__/*.test.js`. The script lists folders explicitly, so new tests would otherwise never run.

**Frontend**

- [ ] `src/api/types.ts`: add `InterconnectBenchJob` and `InterconnectBenchState`.
- [ ] `src/api/client.ts`: add `getInterconnectBench`, `startInterconnectBench`, `cancelInterconnectBench` and `clearInterconnectBench`, next to the prefill client (:328-363).
- [ ] New `src/components/bench/interconnect/eligible.ts` (pure):
  - `eligibleUnits(sparks)`: online Linux units with at least one active RoCE device that has an IPv4.
    - The IP comes from joining `roce.devices[].netdev` with `network.interfaces[].name`.
    - Interfaces hidden by `disabledInterfaces` are still returned, only marked (`SystemCollector.js:1745`), so do not filter on that mark.
  - `devicesFor(spark)`: `{ name, netdev, ip, rateGbps }[]`.
  - `defaultPair(sparks)`: the head and its first worker, otherwise the first two eligible units. Devices are chosen by the shared /24 rule in decision 2.
- [ ] New `src/components/bench/interconnect/InterconnectBenchPage.tsx`, using `BenchPageShell` with `picker={false}`:
  - Server and client unit selects, each with a device select showing name, netdev, IP and rate.
  - Duration (5–30 s) and bidirectional toggle.
  - The decision 8 warning line.
  - Run and Cancel.
  - Live status, polled every 1 s while a job is active, following `PrefillBenchDialog.tsx:265-290`.
  - Result card: average Gb/s, % of link rate, peak, Mpps.
  - History table: date, pair, devices, Gb/s, % of link, status, plus Clear history.
  - Empty state when fewer than two units are eligible, saying why: no RoCE device, no IP, or offline.
- [ ] `src/components/bench/benchCatalog.ts`:
  - Add `"interconnect"` to the `BenchEngine` union and `"Fleet"` to the `family` union.
  - Add the entry `{ id: "interconnect", label: "Interconnect", blurb: "RDMA write bandwidth between two units over RoCE, against the link rate.", engine: "interconnect", family: "Fleet" }`.
  - The sidebar, mobile tab, palette and `/bench/interconnect` route follow from this entry.
- [ ] `src/components/bench/BenchPage.tsx` (:22-27): add the switch case. Set `picker` false for this engine (:29).
- [ ] `src/components/bench/BenchIcon.tsx`: add an `ICONS` entry.
- [ ] `src/components/shell/shell.test.tsx` (~:290): update the sidebar layout assertion.

**Docs**

- [ ] `README.md`:
  - Add an "Interconnect test" row to Features.
  - Add an "Interconnect bandwidth test" section covering perftest install, the port (18515/TCP must be open between the units for the out-of-band exchange), what the % of link means, and the "saturates the link" warning.
  - Add the four routes to the REST API list.
- [ ] Add a `CHANGELOG.md` entry.

### Tests

- [ ] `server/netbench/__tests__/commands.test.js`:
  - Bad device names, IPs and durations are refused.
  - Scripts contain only validated values.
  - The install hint is present.
  - `timeout` bounds the server and is greater than the duration.
- [ ] `server/netbench/__tests__/parse.test.js`, with captured `ib_write_bw` outputs:
  - Unidirectional and bidirectional results.
  - The `-D` duration mode, where peak can print `0.00`.
  - Each known failure line.
  - Empty output gives null.
- [ ] `server/netbench/__tests__/manager.test.js`, with fake spawn and exec through a fake `ib_write_bw` bash script, as in `vulnhunt/__tests__/fakeVulnHunt.js`:
  - A completed run lands in history with `pctOfLink`.
  - The client retries until the server listens.
  - Missing tool on either side fails with the hint.
  - Cancel ends both children.
  - Both units are busy while running, and another bench on either unit gets a 409.
  - A same-unit pair, an offline unit, a non-RoCE device and a device absent from the snapshot are refused.
  - History is capped at 30 and the file has mode 0600.
- [ ] `server/__tests__/bench-cap-config.test.js`: the interconnect job counts toward `MAX_ACTIVE_BENCH_JOBS`.
- [ ] `server/__tests__/api.test.js`: the routes return 400, 404, 409 and 202 as specified, and auth gating matches the other bench routes.
- [ ] `src/components/bench/interconnect/eligible.test.ts`: eligibility, device lists and the default pair.
- [ ] `InterconnectBenchPage.test.tsx`: the empty state, a run → result flow with a mocked client, and the warning line present.

### Verify on hardware

- Is perftest installed on stock Spark DGX OS? If not, the install hint is the whole story.
- How does the Spark CX7 appear under `/sys/class/infiniband`: how many devices per physical port, and what `rate` each reports? This decides whether "% of link" reads sensibly or needs per-port aggregation.
- The `gid_attrs/types` text is `RoCE v2` on this driver.
- Is anything (ufw) blocking 18515/TCP between two Sparks by default?
- A measured run on the user's real head/worker pair, recorded in the README as a reference number.

### Not included

- NCCL `all_reduce_perf`.
- Several device pairs at once (aggregate bandwidth).
- Latency tests (`ib_write_lat`).
- Scheduled runs and regression alerts.
- Showing the last result on the RoCE panel.
- Switch-side telemetry.
