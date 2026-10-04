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
  labelFor,
  loadLabels,
  readInstanceDescriptors,
  removeInstanceDescriptor
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
    browser: v.descriptor.browser ?? null,
    extensionVersion: v.descriptor.extensionVersion,
    // The exact flag that retries this command at this candidate — the
    // error IS the picker; an agent should never need a second lookup.
    retryWith: `--profile ${v.label ?? instancePrefix(v.descriptor.instanceId)}`
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

export interface DiscoveryResult {
  /** Ping-verified: the process on the port proved it is the descriptor's
   *  instance + generation. Routable. */
  verified: VerifiedInstance[];
  /** Live-but-unverified: the ping failed (or echoed a different identity)
   *  while the descriptor's pid is still alive — a transiently unreachable
   *  profile. NOT routable, but routing must not pretend it doesn't exist:
   *  treating "1 verified + 1 unresolved" as "only one profile" would
   *  silently convert an ambiguous command into a wrong-profile command. */
  unresolved: Array<{ descriptor: InstanceDescriptor; label: string | null }>;
}

/** Discover connected profiles: read descriptors, verify each with a /ping
 *  handshake (THE REGISTRY IS DISCOVERY; THE HANDSHAKE IS THE AUTHORITY),
 *  sweep the provably dead, and report the transiently unreachable
 *  separately.
 *
 *  Sweep rule: delete a descriptor only when the ping failed AND its pid is
 *  gone — and even then generation-guarded (re-read + compare before
 *  unlink), because a restarted host may have replaced the file between our
 *  read and the failed ping. Deleting the replacement would orphan a live
 *  host until its next restart. */
export async function discoverInstances(): Promise<DiscoveryResult> {
  const descriptors = readInstanceDescriptors();
  const result: DiscoveryResult = { verified: [], unresolved: [] };
  if (descriptors.length === 0) return result;
  const labels = loadLabels();
  await Promise.all(
    descriptors.map(async (desc): Promise<void> => {
      const ping = await pingDescriptor(desc);
      const ok =
        ping !== null &&
        ping.instanceId === desc.instanceId &&
        ping.generationId === desc.generationId;
      if (ok) {
        result.verified.push({
          descriptor: desc,
          label: labelFor(desc.instanceId, labels),
          fileSchemeAccess: ping.fileSchemeAccess ?? null
        });
        return;
      }
      if (pidAlive(desc.pid)) {
        result.unresolved.push({ descriptor: desc, label: labelFor(desc.instanceId, labels) });
        return;
      }
      // Provably dead. Generation-guarded delete: only remove the exact
      // generation that failed verification, never a newer replacement.
      removeInstanceDescriptor(desc.instanceId, desc.generationId);
    })
  );
  return result;
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

function unresolvedList(unresolved: DiscoveryResult["unresolved"]): Array<Record<string, unknown>> {
  return unresolved.map((u) => ({
    instanceId: u.descriptor.instanceId,
    prefix: instancePrefix(u.descriptor.instanceId),
    label: u.label,
    browser: u.descriptor.browser ?? null,
    unreachable: true,
    retryWith: `--profile ${u.label ?? instancePrefix(u.descriptor.instanceId)}`
  }));
}

// One runnable line per candidate: the exact --profile flag, the label, the
// id prefix, the browser. EVERY profile error ends with this menu so the
// agent never sees a bare "disambiguate" with nothing to disambiguate
// between — it always gets "here's what's connected, rerun with one of
// these." That uniformity is the design: a profile error is a picker.
function menuLine(label: string | null, prefix: string, browser: string | null | undefined, unreachable: boolean): string {
  const name = label ?? "(unlabeled)";
  const flag = label ?? prefix;
  const b = browser ? `, ${browser}` : "";
  return `  --profile ${flag}   → ${name} [${prefix}]${b}${unreachable ? " (UNREACHABLE right now)" : ""}`;
}

function profileMenu(verified: VerifiedInstance[], unresolved: DiscoveryResult["unresolved"] = []): string {
  return [
    ...verified.map((v) => menuLine(v.label, instancePrefix(v.descriptor.instanceId), v.descriptor.browser, false)),
    ...unresolved.map((u) => menuLine(u.label, instancePrefix(u.descriptor.instanceId), u.descriptor.browser, true))
  ].join("\n");
}

// "<what went wrong> — rerun this exact command with one of:\n<menu>"
function withMenu(head: string, verified: VerifiedInstance[], unresolved: DiscoveryResult["unresolved"] = []): string {
  const menu = profileMenu(verified, unresolved);
  if (!menu) return `${head} — but nothing is connected. Is the extension running? \`chrome-relay profile list\` to check.`;
  return `${head} — rerun this exact command with one of:\n${menu}`;
}

function unreachableError(what: string, verified: VerifiedInstance[], unresolved: DiscoveryResult["unresolved"]): RelayError {
  const reachable = verified.length
    ? ` Reachable right now:\n${profileMenu(verified)}`
    : "";
  return new RelayError({
    code: "extension_not_connected",
    message: `${what} is registered but its host didn't answer the handshake — transient (mid-restart, hiccup) or that browser profile is wedged. Retry; if it persists, restart that browser profile.${reachable}`,
    phase: "resolve_profile",
    details: { unresolved: unresolvedList(unresolved), reachable: candidateList(verified) },
    retryable: true
  });
}

/** How many instances (verified + unresolved) a ref prefix could belong to.
 *  More than one = the token itself is ambiguous and CANNOT be
 *  disambiguated by --profile: routing would pick a host, but the receiving
 *  extension shares the prefix and would happily resolve its own unrelated
 *  eN — a silent wrong-profile action, the worst failure class. Strict
 *  fail; the recovery is a fresh snapshot in the intended profile. */
function prefixSpan(
  prefix: string,
  verified: VerifiedInstance[],
  unresolved: DiscoveryResult["unresolved"]
): { verified: VerifiedInstance[]; total: number } {
  const v = verified.filter((x) => normalizeId(x.descriptor.instanceId).startsWith(prefix));
  const u = unresolved.filter((x) => normalizeId(x.descriptor.instanceId).startsWith(prefix));
  return { verified: v, total: v.length + u.length };
}

export async function resolveRoute(
  profileArg: string | undefined,
  args: Record<string, unknown>
): Promise<ResolvedRoute> {
  const refPrefixes = [...collectRefPrefixes(args)];

  const { verified, unresolved } = await discoverInstances();

  if (refPrefixes.length > 1) {
    throw new RelayError({
      code: "target_conflict",
      message: withMenu(
        `this call carries refs minted by ${refPrefixes.length} different profiles (${refPrefixes.join(", ")}) — one command routes to exactly one profile. Use refs from a single profile's snapshot, or scope explicitly`,
        verified,
        unresolved
      ),
      phase: "resolve_profile",
      details: { refPrefixes, candidates: [...candidateList(verified), ...unresolvedList(unresolved)] },
      retryable: false
    });
  }

  const refPrefixGuard = (selected?: VerifiedInstance): void => {
    for (const prefix of refPrefixes) {
      const span = prefixSpan(prefix, verified, unresolved);
      if (span.total > 1) {
        throw new RelayError({
          code: "profile_ambiguous",
          message: `ref prefix ${prefix} matches ${span.total} registered instances (id-prefix collision) — the token cannot say which profile minted it, and routing will not guess. Re-run snapshot in the intended profile and use the fresh ref.`,
          phase: "resolve_profile",
          details: {
            refPrefix: prefix,
            candidates: [...candidateList(span.verified), ...unresolvedList(unresolved.filter((x) => normalizeId(x.descriptor.instanceId).startsWith(prefix)))]
          },
          retryable: false
        });
      }
      if (selected && !normalizeId(selected.descriptor.instanceId).startsWith(prefix)) {
        const owner = verified.find((v) => normalizeId(v.descriptor.instanceId).startsWith(prefix));
        const ownerName = owner ? (owner.label ?? instancePrefix(owner.descriptor.instanceId)) : prefix;
        throw new RelayError({
          code: "target_conflict",
          message:
            `--profile ${profileArg} points at ${selected.label ?? instancePrefix(selected.descriptor.instanceId)}, but the ref was minted by profile ${prefix}. Either drop --profile (the ref routes itself), or rerun with --profile ${ownerName} to act in that profile.`,
          phase: "resolve_profile",
          details: { profile: profileArg, refPrefix: prefix, selected: candidateList([selected])[0], refOwner: owner ? candidateList([owner])[0] : null },
          retryable: false
        });
      }
    }
  };

  // Explicit --profile.
  if (profileArg !== undefined) {
    const matches = matchByProfileArg(verified, profileArg);
    if (matches.length === 0) {
      const needle = normalizeId(profileArg);
      const unresolvedHit = unresolved.some(
        (u) => u.label === profileArg || (/^[0-9a-f]+$/.test(needle) && normalizeId(u.descriptor.instanceId).startsWith(needle))
      );
      if (unresolvedHit) throw unreachableError(`--profile ${profileArg}`, verified, unresolved);
      throw new RelayError({
        code: "profile_not_found",
        message: withMenu(`--profile ${profileArg} matches no connected profile`, verified, unresolved),
        phase: "resolve_profile",
        details: { requested: profileArg, connected: candidateList(verified), unresolved: unresolvedList(unresolved) },
        retryable: false
      });
    }
    if (matches.length > 1) {
      throw new RelayError({
        code: "profile_ambiguous",
        message: withMenu(`--profile ${profileArg} matches ${matches.length} connected profiles — narrow it`, matches),
        phase: "resolve_profile",
        details: { requested: profileArg, candidates: candidateList(matches) },
        retryable: false
      });
    }
    const selected = matches[0];
    refPrefixGuard(selected);
    return toRoute(selected);
  }

  // Qualified ref prefix routes on its own.
  if (refPrefixes.length === 1) {
    const prefix = refPrefixes[0];
    refPrefixGuard(); // collision check across verified + unresolved
    const span = prefixSpan(prefix, verified, unresolved);
    if (span.verified.length === 1) return toRoute(span.verified[0]);
    if (span.total === 1) throw unreachableError(`the profile that minted ref prefix ${prefix}`, verified, unresolved);
    throw new RelayError({
      code: "profile_not_found",
      message: withMenu(
        `ref prefix ${prefix} matches no connected profile — the profile that minted this ref isn't here. Re-run \`snapshot\` in the profile you mean, or scope`,
        verified,
        unresolved
      ),
      phase: "resolve_profile",
      details: { refPrefix: prefix, connected: candidateList(verified), unresolved: unresolvedList(unresolved) },
      retryable: false
    });
  }

  // Unscoped. Strictness spans BOTH pools: an unreachable profile still
  // counts toward ambiguity — a transient ping failure must never convert
  // an ambiguous command into a single-profile command.
  const total = verified.length + unresolved.length;
  if (verified.length === 1 && unresolved.length === 0) return toRoute(verified[0]);
  if (total > 1) {
    // The error IS the picker: one line per candidate with label, browser,
    // prefix, and the exact retry flag — the agent chooses and continues
    // in a single round trip, no `profile list` needed first.
    throw new RelayError({
      code: "profile_ambiguous",
      message: withMenu(`${total} profiles connected (${verified.length} reachable) — pick which browser/profile to act in`, verified, unresolved),
      phase: "resolve_profile",
      details: { candidates: [...candidateList(verified), ...unresolvedList(unresolved)] },
      retryable: false
    });
  }
  if (unresolved.length === 1) {
    // v2 evidence exists but the host didn't answer. Falling back to the
    // legacy fixed port here could reach a DIFFERENT profile's host —
    // silent misroute. Fail loud and retryable instead.
    throw unreachableError("the only registered profile", verified, unresolved);
  }
  // Zero v2 evidence of any kind: legacy fixed-port fallback. Pre-v2
  // behavior and pre-v2 errors (extension_not_connected) apply from here.
  return { baseUrl: `http://127.0.0.1:${DEFAULT_HTTP_PORT}` };
}
