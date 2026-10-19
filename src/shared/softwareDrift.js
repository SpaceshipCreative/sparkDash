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
