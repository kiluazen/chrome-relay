// profile — multi-profile discovery + labeling.
//
// `profile list`  — the ping-verified registry: every connected profile
//                   (label, id prefix, versions, port). Present state only.
// `profile label` — bind an alias in the CLI-owned label registry. Aliases
//                   live CLI-side because that's the only place uniqueness
//                   is enforceable (extensions can't see each other).
//
// These are CLIENT commands over the registry — no tool call reaches an
// extension. Which is the point: routing must be decidable before any
// extension is contacted.

import type { Command } from "commander";
import { instancePrefix, RelayError } from "@chrome-relay/protocol";
import { discoverInstances, type VerifiedInstance } from "../client/route.js";
import { loadLabels, saveLabels } from "../registry.js";
import type { CommandContext } from "./shared.js";

// Same shape the workspace/group names enforce.
const LABEL_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

function fail(error: RelayError): never {
  process.stderr.write(error.message + "\n");
  process.stderr.write(JSON.stringify({ relayError: error.toBridgeError() }, null, 2) + "\n");
  process.exit(1);
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function describe(v: VerifiedInstance): Record<string, unknown> {
  return {
    instanceId: v.descriptor.instanceId,
    prefix: instancePrefix(v.descriptor.instanceId),
    label: v.label,
    extensionVersion: v.descriptor.extensionVersion,
    hostVersion: v.descriptor.hostVersion,
    port: v.descriptor.port,
    pid: v.descriptor.pid,
    fileSchemeAccess: v.fileSchemeAccess,
    startedAt: v.descriptor.startedAt
  };
}

/** Pick the label target: --profile when given, else the single connected
 *  profile — the same routing rule every command follows. */
function pickTarget(verified: VerifiedInstance[], profileArg: string | undefined): VerifiedInstance {
  if (verified.length === 0) {
    fail(
      new RelayError({
        code: "extension_not_connected",
        message:
          "No connected profiles in the registry. Is the (v2) extension running? Pre-v2 extensions don't register — run `chrome-relay doctor`.",
        phase: "resolve_profile",
        retryable: false
      })
    );
  }
  if (profileArg !== undefined) {
    const needle = profileArg.replace(/-/g, "").toLowerCase();
    const matches = verified.filter(
      (v) =>
        v.label === profileArg ||
        v.descriptor.instanceId.replace(/-/g, "").toLowerCase().startsWith(needle)
    );
    if (matches.length === 1) return matches[0];
    fail(
      new RelayError({
        code: matches.length === 0 ? "profile_not_found" : "profile_ambiguous",
        message:
          matches.length === 0
            ? `--profile ${profileArg} matches no connected profile.`
            : `--profile ${profileArg} matches ${matches.length} connected profiles.`,
        phase: "resolve_profile",
        details: { requested: profileArg, connected: verified.map(describe) },
        retryable: false
      })
    );
  }
  if (verified.length > 1) {
    fail(
      new RelayError({
        code: "profile_ambiguous",
        message: `${verified.length} profiles connected — pass --profile <label|idprefix> to say which one to label.`,
        phase: "resolve_profile",
        details: { candidates: verified.map(describe) },
        retryable: false
      })
    );
  }
  return verified[0];
}

export function registerProfile(ctx: CommandContext): void {
  const { program } = ctx;

  const profile = program
    .command("profile")
    .description("Discover and label connected Chrome profiles (multi-profile routing).")
    .addHelpText(
      "after",
      `

Examples:
  chrome-relay profile list
  chrome-relay profile label work                 # one profile connected
  chrome-relay --profile 3f2a profile label work  # several connected: pick by id prefix
  chrome-relay --profile work tabs                # route any command by label

Notes:
  Identity is minted, not discovered: each profile's extension mints a stable
  instanceId; refs print profile-qualified (@3f2a:e12) and route by prefix.
  Labels live in the CLI's own registry (~/.chrome-relay/labels.json) — they
  don't travel with the profile.
  With ONE profile connected no --profile is ever needed. With two+, unscoped
  commands fail with profile_ambiguous instead of guessing.
`
    );

  profile
    .command("list")
    .description("List connected profiles (ping-verified, present state only).")
    .action(async () => {
      const { verified, unresolved } = await discoverInstances();
      printJson({
        connected: verified.map(describe),
        ...(unresolved.length > 0
          ? {
              unreachable: unresolved.map((u) => ({
                instanceId: u.descriptor.instanceId,
                prefix: instancePrefix(u.descriptor.instanceId),
                label: u.label,
                pid: u.descriptor.pid
              }))
            }
          : {}),
        ...(verified.some((v) => v.label === null)
          ? { hint: "unlabeled profiles are addressable by id prefix; give them names with `profile label <name>`" }
          : {})
      });
    });

  profile
    .command("label <name>")
    .description("Bind a unique alias to a connected profile (CLI-owned registry).")
    .action(async (name: string) => {
      if (!LABEL_RE.test(name)) {
        fail(
          new RelayError({
            code: "invalid_arguments",
            message: `label must match ${LABEL_RE} (lowercase, digits, _.-, max 64 chars).`,
            phase: "parse_arguments",
            details: { received: name },
            retryable: false
          })
        );
      }
      const parentOpts = program.opts() as { profile?: string };
      const { verified } = await discoverInstances();
      const target = pickTarget(verified, parentOpts.profile);

      const labels = loadLabels();
      const holder = Object.entries(labels.instances).find(([, v]) => v.label === name);
      if (holder && holder[0] !== target.descriptor.instanceId) {
        fail(
          new RelayError({
            code: "label_conflict",
            message: `label "${name}" is already bound to instance ${instancePrefix(holder[0])}… — labels are unique. Pick another name, or relabel that instance first.`,
            phase: "save_label",
            details: { label: name, boundTo: holder[0] },
            retryable: false
          })
        );
      }
      labels.instances[target.descriptor.instanceId] = { label: name };
      saveLabels(labels);
      printJson({
        labeled: {
          instanceId: target.descriptor.instanceId,
          prefix: instancePrefix(target.descriptor.instanceId),
          label: name
        }
      });
    });
}
