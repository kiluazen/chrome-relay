// install / doctor / update / release-notes — the lifecycle and
// versioning commands. None of these targets a tab.

import type { Command } from "commander";
import { CHROME_RELAY_VERSION } from "../index.js";
import { runDoctor, runInstall } from "../install/install.js";
import { listReleaseNotesSince } from "../release-notes.js";

export function registerInstallUpdate(program: Command): void {
  program
    .command("install")
    .description("Install and register the local Chrome Relay host.")
    .action(async () => {
      await runInstall();
    });

  program
    .command("doctor")
    .description("Validate the local Chrome Relay installation.")
    .action(async () => {
      const ok = await runDoctor();
      process.exit(ok ? 0 : 1);
    });

  // ---------- update + release-notes ----------
  // Agent-native versioning loop. `update` installs the latest CLI and then
  // re-execs the new binary with --since <oldVersion> so the printed bullets
  // come from the just-installed release-notes (single source of truth on
  // disk). `release-notes` is the queryable form — same data, no install.
  program
    .command("update")
    .description("Update chrome-relay CLI to the latest version and print what changed (agent-readable JSON).")
    .option("--dry-run", "skip the install; just show what changed since the current version")
    .action(async (opts: { dryRun?: boolean }) => {
      const fromVersion = CHROME_RELAY_VERSION;
      const { spawnSync } = await import("node:child_process");

      // Code-quality-hardening PR 5: return structured update metadata so
      // the agent can branch on whether the install was attempted, whether
      // it succeeded, and whether the re-exec proved the active binary
      // changed.
      const out: {
        updatedFrom: string;
        updatedTo: string;
        install: {
          attempted: boolean;
          packageManager?: "pnpm" | "bun" | "npm";
          status?: number | null;
          command?: string;
        };
        binary: {
          path: string;
          reexeced: boolean;
        };
        releaseNotes: {
          source: "current_process" | "updated_binary";
          changes: ReturnType<typeof listReleaseNotesSince>;
        };
        warnings: Array<{ code: string; message: string }>;
      } = {
        updatedFrom: fromVersion,
        updatedTo: fromVersion,
        install: { attempted: false },
        binary: { path: process.argv[1] ?? "", reexeced: false },
        releaseNotes: { source: "current_process", changes: [] },
        warnings: []
      };

      if (!opts.dryRun) {
        const argv0 = process.argv[1] ?? "";
        const pm: "pnpm" | "bun" | "npm" =
          /[\\/](pnpm|\.pnpm)[\\/]/.test(argv0) ? "pnpm" :
          /[\\/]bun[\\/]/.test(argv0)            ? "bun" :
          "npm";
        const cmd: [string, string[]] =
          pm === "pnpm" ? ["pnpm", ["add", "-g", "chrome-relay@latest"]] :
          pm === "bun"  ? ["bun",  ["add", "-g", "chrome-relay@latest"]] :
                          ["npm",  ["install", "-g", "chrome-relay@latest"]];
        out.install = {
          attempted: true,
          packageManager: pm,
          command: `${cmd[0]} ${cmd[1].join(" ")}`
        };
        process.stderr.write(`[chrome-relay] updating from ${fromVersion} via ${pm}...\n`);
        const install = spawnSync(cmd[0], cmd[1], { stdio: "inherit" });
        out.install.status = install.status;
        if (install.status !== 0) {
          process.stderr.write(`[chrome-relay] install failed (${pm} exited ${install.status}). Try manually: ${cmd[0]} ${cmd[1].join(" ")}\n`);
          out.warnings.push({
            code: "update_install_failed",
            message: `Package-manager exit ${install.status}. Active binary unchanged.`
          });
          process.stdout.write(JSON.stringify(out, null, 2) + "\n");
          process.exit(1);
        }

        const which = spawnSync("which", ["chrome-relay"]);
        const newBin = which.stdout?.toString().trim();
        if (which.status === 0 && newBin) {
          const versionOut = spawnSync(newBin, ["--version"]);
          const newVersion = (versionOut.stdout?.toString() ?? "").trim();
          out.binary.path = newBin;
          if (newVersion && newVersion !== fromVersion) {
            out.updatedTo = newVersion;

            // Re-run install from the freshly-installed binary so the
            // native-messaging manifest points at the new dist AND any
            // stale native-host process gets SIGTERM'd. Without this,
            // `chrome-relay update` left Chrome talking to the previous
            // version — which then kept firing the cli-outdated nudge
            // telling the user to run the very command they just ran.
            const install = spawnSync(newBin, ["install"], { stdio: "inherit" });
            if (install.status !== 0) {
              out.warnings.push({
                code: "install_refresh_failed",
                message: `Update installed the new package but \`${newBin} install\` exited ${install.status}. Run it manually to refresh the native host manifest.`
              });
            }

            const rn = spawnSync(newBin, ["release-notes", "--since", fromVersion]);
            try {
              const parsed = JSON.parse(rn.stdout?.toString() ?? "");
              if (Array.isArray(parsed.changes)) {
                out.releaseNotes = { source: "updated_binary", changes: parsed.changes };
              }
            } catch {
              out.warnings.push({
                code: "release_notes_parse_failed",
                message: `Could not parse output of "${newBin} release-notes --since ${fromVersion}".`
              });
            }
            out.binary.reexeced = true;
          } else {
            out.warnings.push({
              code: "update_not_verified",
              message: `Install completed but \`${newBin} --version\` still reports ${newVersion || "unknown"}. The active binary may not have changed — check your PATH or run "${cmd[0]} ${cmd[1].join(" ")}" manually and verify.`
            });
          }
        } else {
          out.warnings.push({
            code: "update_not_verified",
            message: `Install completed but \`which chrome-relay\` did not return a path. Could not verify the active binary changed.`
          });
        }
      }

      if (out.releaseNotes.source === "current_process") {
        out.releaseNotes.changes = listReleaseNotesSince(fromVersion);
      }
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    });

  program
    .command("release-notes")
    .description("Print release notes since a version (no install). JSON output for agents.")
    .option("--since <version>", "show release notes for versions newer than this", "0.0.0")
    .action((opts: { since: string }) => {
      const changes = listReleaseNotesSince(opts.since);
      process.stdout.write(JSON.stringify({
        currentVersion: CHROME_RELAY_VERSION,
        since: opts.since,
        changes
      }, null, 2) + "\n");
    });
}
