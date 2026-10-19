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
  const s = typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").trim() : "";
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
  return m ? cap(m[1]) : null;
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
    dgxOs: cap(dgx.DGX_OTA_VERSION || dgx.DGX_SWBUILD_VERSION),
  };
  if (Object.values(result).every((v) => v == null)) return null;
  return { ...result, collectedAt: now };
}
