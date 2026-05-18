// Code-quality-hardening PR 11: edge-case tests for `chrome-relay update`.
//
// The structured-metadata response (0.5.7) exists to surface "install
// said success but the active binary didn't change" as a typed warning.
// These tests verify each of the four branches we promise to handle:
//   - --dry-run (no install)
//   - install failed (non-zero exit)
//   - install succeeded but binary version unchanged → update_not_verified
//   - install succeeded but new binary's release-notes parse failed
//
// child_process.spawnSync is mocked so we don't actually run npm/which.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

let fetchSpy: ReturnType<typeof vi.fn>;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

// spawnSync mock — each test wires up a handler keyed by the binary name
// so we can simulate npm install + which + version + release-notes calls
// independently.
let spawnHandlers: Record<string, (args: string[]) => { status: number; stdout?: Buffer; stderr?: Buffer }>;

vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[]) => {
    const handler = spawnHandlers[cmd];
    if (!handler) return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    return handler(args);
  }
}));

beforeEach(() => {
  spawnHandlers = {};
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function runArgs(...args: string[]): Promise<void> {
  // Fresh program each test so the parser state is clean.
  vi.resetModules();
  const { buildProgram } = await import("../src/program");
  const program = buildProgram();
  await program.parseAsync(["node", "chrome-relay", ...args]);
}

function stdoutText(): string {
  return stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
}

function lastJsonOnStdout(): Record<string, unknown> {
  // Find the LAST top-level JSON object by walking back from end. The
  // simple `lastIndexOf("{")` finds the deepest nested brace, not the
  // top-level one, so we brace-match instead.
  const text = stdoutText().trim();
  let depth = 0;
  let end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === "}") {
      if (depth === 0) end = i + 1;
      depth++;
    } else if (text[i] === "{") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(i, end));
    }
  }
  throw new Error(`no JSON object on stdout. got: ${text.slice(0, 200)}...`);
}

describe("chrome-relay update — structured metadata", () => {
  it("--dry-run: install.attempted=false, release-notes from current_process", async () => {
    await runArgs("update", "--dry-run");
    const out = lastJsonOnStdout();
    expect(out.install).toEqual({ attempted: false });
    expect((out.binary as Record<string, unknown>).reexeced).toBe(false);
    expect((out.releaseNotes as Record<string, unknown>).source).toBe("current_process");
    expect(out.warnings).toEqual([]);
    // updatedFrom === updatedTo since we didn't install
    expect(out.updatedFrom).toBe(out.updatedTo);
  });

  it("install failure (non-zero exit): warning + exit 1", async () => {
    // Register handlers for all 3 package managers so whichever is detected
    // from process.argv[1] gets the failure.
    const fail = () => ({ status: 1, stdout: Buffer.from(""), stderr: Buffer.from("EACCES") });
    spawnHandlers.npm  = fail;
    spawnHandlers.pnpm = fail;
    spawnHandlers.bun  = fail;
    await runArgs("update");
    const out = lastJsonOnStdout();
    expect((out.install as Record<string, unknown>).attempted).toBe(true);
    expect((out.install as Record<string, unknown>).status).toBe(1);
    const warnings = out.warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "update_install_failed")).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("install succeeded but binary version unchanged → update_not_verified", async () => {
    const ok = () => ({ status: 0, stdout: Buffer.from("") });
    spawnHandlers.npm   = ok;
    spawnHandlers.pnpm  = ok;
    spawnHandlers.bun   = ok;
    spawnHandlers.which = () => ({ status: 0, stdout: Buffer.from("/usr/local/bin/chrome-relay") });
    // Import CHROME_RELAY_VERSION at test-time to get the same string the
    // running process will compare against.
    const { CHROME_RELAY_VERSION } = await import("../src/index");
    spawnHandlers["/usr/local/bin/chrome-relay"] = (args) => {
      if (args[0] === "--version") {
        return { status: 0, stdout: Buffer.from(CHROME_RELAY_VERSION) };
      }
      return { status: 0, stdout: Buffer.from("") };
    };

    await runArgs("update");
    const out = lastJsonOnStdout();
    expect((out.install as Record<string, unknown>).status).toBe(0);
    expect((out.binary as Record<string, unknown>).reexeced).toBe(false);
    const warnings = out.warnings as Array<{ code: string; message: string }>;
    expect(warnings.some((w) => w.code === "update_not_verified")).toBe(true);
    // releaseNotes falls back to current_process since re-exec wasn't verified.
    expect((out.releaseNotes as Record<string, unknown>).source).toBe("current_process");
  });

  it("install succeeded but `which` fails → update_not_verified", async () => {
    const ok = () => ({ status: 0, stdout: Buffer.from("") });
    spawnHandlers.npm   = ok;
    spawnHandlers.pnpm  = ok;
    spawnHandlers.bun   = ok;
    spawnHandlers.which = () => ({ status: 1, stdout: Buffer.from("") });

    await runArgs("update");
    const out = lastJsonOnStdout();
    expect((out.binary as Record<string, unknown>).reexeced).toBe(false);
    const warnings = out.warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "update_not_verified")).toBe(true);
  });

  it("install succeeded, new binary reports newer version, release-notes parse fails", async () => {
    const ok = () => ({ status: 0, stdout: Buffer.from("") });
    spawnHandlers.npm   = ok;
    spawnHandlers.pnpm  = ok;
    spawnHandlers.bun   = ok;
    spawnHandlers.which = () => ({ status: 0, stdout: Buffer.from("/usr/local/bin/chrome-relay") });
    spawnHandlers["/usr/local/bin/chrome-relay"] = (args) => {
      if (args[0] === "--version") {
        return { status: 0, stdout: Buffer.from("99.99.99") };
      }
      if (args[0] === "release-notes") {
        return { status: 0, stdout: Buffer.from("THIS IS NOT JSON") };
      }
      return { status: 0, stdout: Buffer.from("") };
    };

    await runArgs("update");
    const out = lastJsonOnStdout();
    expect((out.binary as Record<string, unknown>).reexeced).toBe(true);
    expect(out.updatedTo).toBe("99.99.99");
    const warnings = out.warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "release_notes_parse_failed")).toBe(true);
  });

  it("install succeeded, new binary returns valid release notes", async () => {
    const ok = () => ({ status: 0, stdout: Buffer.from("") });
    spawnHandlers.npm   = ok;
    spawnHandlers.pnpm  = ok;
    spawnHandlers.bun   = ok;
    spawnHandlers.which = () => ({ status: 0, stdout: Buffer.from("/usr/local/bin/chrome-relay") });
    spawnHandlers["/usr/local/bin/chrome-relay"] = (args) => {
      if (args[0] === "--version") {
        return { status: 0, stdout: Buffer.from("99.99.99") };
      }
      if (args[0] === "release-notes") {
        return {
          status: 0,
          stdout: Buffer.from(JSON.stringify({
            currentVersion: "99.99.99",
            since: "0.0.0",
            changes: [{ version: "99.99.99", bullets: ["fake change"] }]
          }))
        };
      }
      return { status: 0, stdout: Buffer.from("") };
    };

    await runArgs("update");
    const out = lastJsonOnStdout();
    expect((out.binary as Record<string, unknown>).reexeced).toBe(true);
    expect(out.updatedTo).toBe("99.99.99");
    expect((out.releaseNotes as Record<string, unknown>).source).toBe("updated_binary");
    const changes = (out.releaseNotes as Record<string, unknown>).changes as Array<{ version: string }>;
    expect(changes[0].version).toBe("99.99.99");
    expect(out.warnings).toEqual([]);
  });
});
