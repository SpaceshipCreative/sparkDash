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
