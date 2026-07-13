// Profile routing — decides WHICH host serves a call, before any extension
// is contacted. docs/multi-profile-and-upload.md Part 1, "Routing strictness":
//
//   0 connected → legacy fixed-port fallback (pre-v2 behavior + its errors)
//   1 connected → routes implicitly (uniform, obviously-right default)
//   2+ connected, unscoped → profile_ambiguous, candidates enumerated.
//     NEVER pick one.
//
// Scope arrives two ways, which must AGREE:
//   --profile <label|idprefix>   explicit flag
//   @3f2a:e12                    qualified ref prefixes inside the args
// Disagreement (flag resolves to A, ref minted by B) is target_conflict.
// Strictness is on PRESENT state only: what the ping-verified registry shows
// now, not what was connected an hour ago.

import {
  DEFAULT_HTTP_PORT,
  RelayError,
  collectRefPrefixes,
  instancePrefix,
  type InstanceDescriptor,
  type PingResponse
} from "@chrome-relay/protocol";
import {
  deleteInstanceDescriptor,
  labelFor,
  loadLabels,
  readInstanceDescriptors
} from "../registry.js";

const PING_TIMEOUT_MS = 1_000;

export interface VerifiedInstance {
  descriptor: InstanceDescriptor;
  label: string | null;
  fileSchemeAccess: boolean | null;
}

export interface ResolvedRoute {
  baseUrl: string;
  token?: string;
  /** Absent on the legacy fixed-port fallback (no v2 host discovered). */
  instanceId?: string;
  label?: string | null;
}

function normalizeId(instanceId: string): string {
  return instanceId.replace(/-/g, "").toLowerCase();
}

function candidateList(verified: VerifiedInstance[]): Array<Record<string, unknown>> {
  return verified.map((v) => ({
    instanceId: v.descriptor.instanceId,
    prefix: instancePrefix(v.descriptor.instanceId),
    label: v.label,
    extensionVersion: v.descriptor.extensionVersion
  }));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pingDescriptor(desc: InstanceDescriptor): Promise<PingResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${desc.port}/ping`, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as PingResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Discover connected profiles: read descriptors, verify each with a /ping
 *  handshake (THE REGISTRY IS DISCOVERY; THE HANDSHAKE IS THE AUTHORITY),
 *  sweep the provably dead.
 *
 *  Sweep rule: delete a descriptor only when the ping failed AND its pid is
 *  gone. A live pid with a failed ping (transient hiccup, mid-start) is
 *  excluded from this call's routing but its file is left alone — deleting
 *  a live host's descriptor would orphan it until Chrome restarts it. */
export async function discoverInstances(): Promise<VerifiedInstance[]> {
  const descriptors = readInstanceDescriptors();
  if (descriptors.length === 0) return [];
  const labels = loadLabels();
  const results = await Promise.all(
    descriptors.map(async (desc): Promise<VerifiedInstance | null> => {
      const ping = await pingDescriptor(desc);
      const verified =
        ping !== null &&
        ping.instanceId === desc.instanceId &&
        ping.generationId === desc.generationId;
      if (!verified) {
        if (!pidAlive(desc.pid)) deleteInstanceDescriptor(desc.instanceId);
        return null;
      }
      return {
        descriptor: desc,
        label: labelFor(desc.instanceId, labels),
        fileSchemeAccess: ping.fileSchemeAccess ?? null
      };
    })
  );
  return results.filter((r): r is VerifiedInstance => r !== null);
}

function matchByProfileArg(verified: VerifiedInstance[], profileArg: string): VerifiedInstance[] {
  const byLabel = verified.filter((v) => v.label === profileArg);
  if (byLabel.length > 0) return byLabel;
  const needle = normalizeId(profileArg);
  if (!/^[0-9a-f]+$/.test(needle)) return [];
  return verified.filter((v) => normalizeId(v.descriptor.instanceId).startsWith(needle));
}

function toRoute(v: VerifiedInstance): ResolvedRoute {
  return {
    baseUrl: `http://127.0.0.1:${v.descriptor.port}`,
    token: v.descriptor.token,
    instanceId: v.descriptor.instanceId,
    label: v.label
  };
}

export async function resolveRoute(
  profileArg: string | undefined,
  args: Record<string, unknown>
): Promise<ResolvedRoute> {
  const refPrefixes = [...collectRefPrefixes(args)];
  if (refPrefixes.length > 1) {
    throw new RelayError({
      code: "target_conflict",
      message: `refs from ${refPrefixes.length} different profiles in one call (${refPrefixes.join(", ")}) — a call routes to exactly one profile.`,
      phase: "resolve_profile",
      details: { refPrefixes },
      retryable: false
    });
  }

  const verified = await discoverInstances();

  // Explicit --profile.
  if (profileArg !== undefined) {
    const matches = matchByProfileArg(verified, profileArg);
    if (matches.length === 0) {
      throw new RelayError({
        code: "profile_not_found",
        message: `--profile ${profileArg} matches no connected profile. Connected: ${verified.length ? verified.map((v) => v.label ?? instancePrefix(v.descriptor.instanceId)).join(", ") : "(none — is the extension running?)"}.`,
        phase: "resolve_profile",
        details: { requested: profileArg, connected: candidateList(verified) },
        retryable: false
      });
    }
    if (matches.length > 1) {
      throw new RelayError({
        code: "profile_ambiguous",
        message: `--profile ${profileArg} matches ${matches.length} connected profiles — use a longer id prefix or a label.`,
        phase: "resolve_profile",
        details: { requested: profileArg, candidates: candidateList(matches) },
        retryable: false
      });
    }
    const selected = matches[0];
    // A qualified ref must AGREE with the explicit profile.
    for (const prefix of refPrefixes) {
      if (!normalizeId(selected.descriptor.instanceId).startsWith(prefix)) {
        throw new RelayError({
          code: "target_conflict",
          message: `--profile ${profileArg} resolves to ${selected.label ?? instancePrefix(selected.descriptor.instanceId)}, but the call carries a ref minted by profile ${prefix}. Drop --profile or use a ref from the right profile's snapshot.`,
          phase: "resolve_profile",
          details: { profile: profileArg, refPrefix: prefix, selected: candidateList([selected])[0] },
          retryable: false
        });
      }
    }
    return toRoute(selected);
  }

  // Qualified ref prefix routes on its own.
  if (refPrefixes.length === 1) {
    const prefix = refPrefixes[0];
    const matches = verified.filter((v) => normalizeId(v.descriptor.instanceId).startsWith(prefix));
    if (matches.length === 0) {
      throw new RelayError({
        code: "profile_not_found",
        message: `ref prefix ${prefix} matches no connected profile — the profile that minted this ref isn't reachable. Connected: ${verified.length ? verified.map((v) => v.label ?? instancePrefix(v.descriptor.instanceId)).join(", ") : "(none)"}.`,
        phase: "resolve_profile",
        details: { refPrefix: prefix, connected: candidateList(verified) },
        retryable: false
      });
    }
    if (matches.length > 1) {
      // 4-hex-char prefix collision between instanceIds — astronomically
      // rare, but specified: strict fail, disambiguate with an agreeing
      // --profile <longer-prefix>.
      throw new RelayError({
        code: "profile_ambiguous",
        message: `ref prefix ${prefix} matches ${matches.length} connected profiles (id-prefix collision). Add --profile <longer-id-prefix> to disambiguate.`,
        phase: "resolve_profile",
        details: { refPrefix: prefix, candidates: candidateList(matches) },
        retryable: false
      });
    }
    return toRoute(matches[0]);
  }

  // Unscoped.
  if (verified.length === 1) return toRoute(verified[0]);
  if (verified.length > 1) {
    throw new RelayError({
      code: "profile_ambiguous",
      message: `${verified.length} profiles connected — pass --profile <label|idprefix>. Connected: ${verified.map((v) => `${v.label ?? "(unlabeled)"} [${instancePrefix(v.descriptor.instanceId)}]`).join(", ")}.`,
      phase: "resolve_profile",
      details: { candidates: candidateList(verified) },
      retryable: false
    });
  }
  // Zero v2 hosts discovered: legacy fixed-port fallback. Pre-v2 behavior
  // and pre-v2 errors (extension_not_connected) apply beyond this point.
  return { baseUrl: `http://127.0.0.1:${DEFAULT_HTTP_PORT}` };
}
