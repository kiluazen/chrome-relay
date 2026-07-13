// Instance registry — discovery for multi-profile routing.
//
// Each native host binds an EPHEMERAL port and writes a descriptor file to
// <app dir>/instances/<instanceId>.json. The CLI reads the directory to
// discover connected profiles, then verifies each candidate with a /ping
// handshake before trusting it: THE REGISTRY IS DISCOVERY; THE HANDSHAKE IS
// THE AUTHORITY. A descriptor gets the CLI to a port; the ping (echoing
// instanceId + generationId) proves the process on that port is the one the
// descriptor describes — PIDs get reused, ports get reused, files go stale.
//
// Races closed here:
//   - torn reads: descriptors are written to a temp file then rename()d.
//   - late-exit cleanup: a host deletes its descriptor ONLY while the
//     on-disk generationId is still its own — an old host exiting after a
//     newer replacement started must not delete the newer descriptor.
//   - PID reuse: pid is a hint for stale-sweeping; never proof of liveness.
//
// Labels (profile aliases) also live here — CLI-owned, in labels.json —
// because extension-stored labels can't see each other, which makes a
// uniqueness invariant unenforceable (disconnect → relabel → reconnect would
// mint undetectable duplicates). Live descriptors describe connections; the
// persistent label registry owns aliases.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InstanceDescriptor } from "@chrome-relay/protocol";

export function appDir(): string {
  // CHROME_RELAY_HOME: test/dev override so integration tests never touch
  // the real ~/.chrome-relay (which live hosts on this machine may own).
  return process.env.CHROME_RELAY_HOME || path.join(os.homedir(), ".chrome-relay");
}

export function instancesDir(): string {
  return path.join(appDir(), "instances");
}

export function labelsPath(): string {
  return path.join(appDir(), "labels.json");
}

// ---------------------------------------------------------------------------
// Descriptors (host side writes, client side reads)

export function writeInstanceDescriptor(desc: InstanceDescriptor): void {
  const dir = instancesDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${desc.instanceId}.json`);
  const tmp = path.join(dir, `.${desc.instanceId}.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(desc, null, 2), { mode: 0o600 });
  renameSync(tmp, target); // atomic on POSIX; readers never see a torn file
}

/** Generation-guarded cleanup: delete only if the on-disk descriptor still
 *  belongs to THIS process generation. */
export function removeInstanceDescriptor(instanceId: string, generationId: string): void {
  const target = path.join(instancesDir(), `${instanceId}.json`);
  try {
    const onDisk = JSON.parse(readFileSync(target, "utf8")) as Partial<InstanceDescriptor>;
    if (onDisk.generationId !== generationId) return; // a newer host owns this file
    rmSync(target, { force: true });
  } catch {
    /* already gone or unreadable — nothing to clean */
  }
}

function isDescriptor(v: unknown): v is InstanceDescriptor {
  const d = v as Partial<InstanceDescriptor> | null;
  return (
    !!d &&
    d.schemaVersion === 1 &&
    typeof d.instanceId === "string" &&
    typeof d.generationId === "string" &&
    typeof d.port === "number" &&
    typeof d.token === "string" &&
    typeof d.pid === "number"
  );
}

/** Read every parseable descriptor. Unparseable files are skipped, not
 *  deleted — deletion decisions belong to the ping-verified sweep. */
export function readInstanceDescriptors(): InstanceDescriptor[] {
  let names: string[];
  try {
    names = readdirSync(instancesDir());
  } catch {
    return []; // no dir yet — no v2 hosts have ever run
  }
  const out: InstanceDescriptor[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(readFileSync(path.join(instancesDir(), name), "utf8"));
      if (isDescriptor(parsed)) out.push(parsed);
    } catch {
      /* torn/garbage file — skip */
    }
  }
  return out;
}

/** Unconditional descriptor delete — used by the CLIENT after a failed
 *  ping-verify (dead pid AND no answer, or the ping echoed a different
 *  instance). The host's own cleanup path stays generation-guarded. */
export function deleteInstanceDescriptor(instanceId: string): void {
  rmSync(path.join(instancesDir(), `${instanceId}.json`), { force: true });
}

// ---------------------------------------------------------------------------
// Labels (CLI-owned alias registry)

export interface LabelsFile {
  instances: Record<string, { label: string }>;
}

export function loadLabels(): LabelsFile {
  try {
    const parsed = JSON.parse(readFileSync(labelsPath(), "utf8")) as Partial<LabelsFile>;
    if (parsed && typeof parsed.instances === "object" && parsed.instances) {
      return { instances: parsed.instances as LabelsFile["instances"] };
    }
  } catch {
    /* missing or unreadable — start empty */
  }
  return { instances: {} };
}

export function saveLabels(labels: LabelsFile): void {
  mkdirSync(appDir(), { recursive: true, mode: 0o700 });
  const tmp = labelsPath() + `.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(labels, null, 2), { mode: 0o600 });
  renameSync(tmp, labelsPath());
}

export function labelFor(instanceId: string, labels = loadLabels()): string | null {
  return labels.instances[instanceId]?.label ?? null;
}
