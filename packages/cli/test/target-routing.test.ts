// Code-quality-hardening PR 2: target routing matrix.
//
// Every CLI command that targets a tab MUST forward --tab / --workspace /
// --group consistently through baseArgs(). The doc named viewport set and
// console as the two drift sites; PR 2 fixed both. This file proves it
// stays fixed and proves the new strict-conflict rules.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { buildProgram } from "../src/program";

type FetchSpy = ReturnType<typeof vi.fn>;

let fetchSpy: FetchSpy;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: {} })
  }));
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function runArgs(...args: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(["node", "chrome-relay", ...args]);
}

function lastBody(): { name: string; args: Record<string, unknown> } {
  const calls = fetchSpy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const body = calls.at(-1)?.[1]?.body;
  return JSON.parse(body as string);
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
}

// Every command in this matrix must accept --tab, --workspace, --group
// (alone, not combined) and forward exactly that field to the bridge.
// If you add a new targetable subcommand to chrome-relay, add it here.
const TARGETABLE_COMMANDS: Array<{ name: string; argv: string[]; tool: string }> = [
  { name: "screenshot",      argv: ["screenshot"],                         tool: "chrome_screenshot" },
  { name: "read",            argv: ["read"],                               tool: "chrome_read_page" },
  { name: "click",           argv: ["click", "button"],                    tool: "chrome_click_element" },
  { name: "fill",            argv: ["fill", "input", "hi"],                tool: "chrome_fill_or_select" },
  { name: "type",            argv: ["type", "hello"],                      tool: "chrome_type" },
  { name: "keys",            argv: ["keys", "Enter"],                      tool: "chrome_keyboard" },
  { name: "js",              argv: ["js", "return 1"],                     tool: "chrome_evaluate" },
  { name: "viewport set",    argv: ["viewport", "set", "--width", "800", "--height", "600"], tool: "chrome_viewport" },
  { name: "viewport preset", argv: ["viewport", "preset", "iphone-14"],    tool: "chrome_viewport" },
  { name: "viewport clear",  argv: ["viewport", "clear"],                  tool: "chrome_viewport" },
  { name: "console",         argv: ["console"],                            tool: "chrome_console" },
  { name: "network",         argv: ["network"],                            tool: "chrome_network" },
  { name: "ax",              argv: ["ax"],                                 tool: "chrome_ax" },
  { name: "hover",           argv: ["hover", "--x", "10", "--y", "10"],    tool: "chrome_hover" }
];

describe("baseArgs forwarding matrix", () => {
  for (const cmd of TARGETABLE_COMMANDS) {
    describe(cmd.name, () => {
      it("forwards --tab as tabId", async () => {
        await runArgs(...cmd.argv, "--tab", "42");
        const body = lastBody();
        expect(body.name).toBe(cmd.tool);
        expect(body.args.tabId).toBe(42);
        expect(body.args.workspaceName).toBeUndefined();
        expect(body.args.groupName).toBeUndefined();
      });

      it("forwards --workspace as workspaceName", async () => {
        await runArgs(...cmd.argv, "--workspace", "research");
        const body = lastBody();
        expect(body.args.workspaceName).toBe("research");
        expect(body.args.tabId).toBeUndefined();
        expect(body.args.groupName).toBeUndefined();
      });

      it("forwards --group as groupName", async () => {
        await runArgs(...cmd.argv, "--group", "deepdive");
        const body = lastBody();
        expect(body.args.groupName).toBe("deepdive");
        expect(body.args.tabId).toBeUndefined();
        expect(body.args.workspaceName).toBeUndefined();
      });
    });
  }
});

describe("Strict intra-scope conflict rules", () => {
  it("rejects --tab + --workspace on the same subcommand", async () => {
    await runArgs("screenshot", "--tab", "42", "--workspace", "research");
    expect(stderrText()).toMatch(/target_conflict.*subcommand.*--tab.*--workspace/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("rejects --workspace + --group on the same subcommand", async () => {
    await runArgs("screenshot", "--workspace", "research", "--group", "deepdive");
    expect(stderrText()).toMatch(/target_conflict.*subcommand.*--workspace.*--group/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("rejects --workspace + --group at the program-level too", async () => {
    await runArgs("--workspace", "research", "--group", "deepdive", "screenshot");
    expect(stderrText()).toMatch(/target_conflict.*program-level.*--workspace.*--group/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("rejects all three targets on the same subcommand", async () => {
    await runArgs("screenshot", "--tab", "1", "--workspace", "x", "--group", "y");
    expect(stderrText()).toMatch(/target_conflict.*subcommand/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

describe("Cross-scope override notice", () => {
  it("subcommand --workspace overrides program-level --workspace and emits target_overridden", async () => {
    await runArgs("--workspace", "default", "screenshot", "--workspace", "override");
    expect(stderrText()).toMatch(/target_overridden: workspace default → override/);
    const body = lastBody();
    expect(body.args.workspaceName).toBe("override");
  });

  it("subcommand --tab overrides program-level --workspace with a notice", async () => {
    await runArgs("--workspace", "default", "screenshot", "--tab", "99");
    expect(stderrText()).toMatch(/target_overridden: tab workspace=default → 99/);
    const body = lastBody();
    expect(body.args.tabId).toBe(99);
    expect(body.args.workspaceName).toBeUndefined();
  });

  it("subcommand --tab overrides program-level --group with a notice", async () => {
    await runArgs("--group", "dive", "screenshot", "--tab", "5");
    expect(stderrText()).toMatch(/target_overridden: tab group=dive → 5/);
    const body = lastBody();
    expect(body.args.tabId).toBe(5);
  });

  it("subcommand --group same value as program-level --group does NOT emit notice", async () => {
    await runArgs("--group", "dive", "screenshot", "--group", "dive");
    expect(stderrText()).not.toMatch(/target_overridden/);
    const body = lastBody();
    expect(body.args.groupName).toBe("dive");
  });

  it("program-level --workspace alone works with no notice", async () => {
    await runArgs("--workspace", "alone", "screenshot");
    expect(stderrText()).not.toMatch(/target_overridden|target_conflict/);
    const body = lastBody();
    expect(body.args.workspaceName).toBe("alone");
  });
});

describe("Regression: viewport set + console do NOT silently drop workspace/group", () => {
  it("viewport set forwards --workspace (was dropped pre-0.5.4)", async () => {
    await runArgs("viewport", "set", "--width", "800", "--height", "600", "--workspace", "ws");
    expect(lastBody().args.workspaceName).toBe("ws");
  });

  it("viewport set forwards program-level --group (was dropped pre-0.5.4)", async () => {
    await runArgs("--group", "g", "viewport", "set", "--width", "800", "--height", "600");
    expect(lastBody().args.groupName).toBe("g");
  });

  it("console forwards --workspace (was dropped pre-0.5.4)", async () => {
    await runArgs("console", "--workspace", "ws");
    expect(lastBody().args.workspaceName).toBe("ws");
  });

  it("console forwards program-level --group (was dropped pre-0.5.4)", async () => {
    await runArgs("--group", "g", "console");
    expect(lastBody().args.groupName).toBe("g");
  });
});
