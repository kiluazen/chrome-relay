// chrome_upload against a real Chromium — the smoke test the design doc
// gates on. Three strategies, three mechanisms on one fixture page.
//
// NOTE on file access: Chrome gates debugger file operations behind the
// per-extension "Allow access to file URLs" toggle. If this suite fails
// with file_access_denied, that's the gate doing its job in a context where
// the toggle can't be pre-set — see the skip logic below, which records the
// outcome instead of hiding it.

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "../helpers/extension-context";

interface Diag {
  direct: Array<{ name: string; size: number }>;
  multi: Array<{ name: string; size: number }>;
  hidden: Array<{ name: string; size: number }>;
  dropped: Array<{ name: string; size: number }>;
  sawDragOver: boolean;
}

let dir: string;
let txtFile: string;
let secondFile: string;

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "chrome-relay-upload-"));
  txtFile = join(dir, "hello.txt");
  secondFile = join(dir, "world.txt");
  writeFileSync(txtFile, "hello upload");
  writeFileSync(secondFile, "second file");
});

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function diag(runTool: <T>(n: string, a: Record<string, unknown>) => Promise<T>, tabId: number): Promise<Diag> {
  const out = await runTool<{ result: Diag }>("chrome_evaluate", {
    tabId,
    code: "return window.__diag()"
  });
  return out.result;
}

test.describe("chrome_upload", () => {
  test("set: a visible file input receives the file, verified both ends", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("upload.html");
    const result = await runTool<{ files: Array<{ name: string }> }>("chrome_upload", {
      action: "set",
      tabId,
      selector: "#direct",
      files: [txtFile]
    });
    expect(result.files.map((f) => f.name)).toEqual(["hello.txt"]);
    expect((await diag(runTool, tabId)).direct.map((f) => f.name)).toEqual(["hello.txt"]);
  });

  test("set: works on a HIDDEN input (display:none)", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("upload.html");
    const result = await runTool<{ files: Array<{ name: string }> }>("chrome_upload", {
      action: "set",
      tabId,
      selector: "#hidden-input",
      files: [txtFile]
    });
    expect(result.files.map((f) => f.name)).toEqual(["hello.txt"]);
    expect((await diag(runTool, tabId)).hidden.map((f) => f.name)).toEqual(["hello.txt"]);
  });

  test("set: two files land on a `multiple` input; a single-file input hard-rejects them", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("upload.html");
    const multi = await runTool<{ files: Array<{ name: string }> }>("chrome_upload", {
      action: "set",
      tabId,
      selector: "#multi",
      files: [txtFile, secondFile]
    });
    expect(multi.files).toHaveLength(2);

    await expect(
      runTool("chrome_upload", { action: "set", tabId, selector: "#direct", files: [txtFile, secondFile] })
    ).rejects.toThrow(/multiple/i);
    // The strict failure left the input untouched.
    expect((await diag(runTool, tabId)).direct).toEqual([]);
  });

  test("set: a non-input target is not_a_file_input, pointing at choose", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("upload.html");
    await expect(
      runTool("chrome_upload", { action: "set", tabId, selector: "#pick", files: [txtFile] })
    ).rejects.toThrow(/not <input type="file">/);
  });

  test("choose: intercepts the chooser the button opens and sets files on it", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("upload.html");
    const result = await runTool<{ files: Array<{ name: string }>; mode: string }>("chrome_upload", {
      action: "choose",
      tabId,
      clickSelector: "#pick",
      files: [txtFile]
    });
    expect(result.files.map((f) => f.name)).toEqual(["hello.txt"]);
    expect((await diag(runTool, tabId)).hidden.map((f) => f.name)).toEqual(["hello.txt"]);
  });

  test("choose: a click that opens nothing fails no_file_chooser", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("upload.html");
    await expect(
      runTool("chrome_upload", {
        action: "choose",
        tabId,
        clickSelector: "#zone", // the drop zone — clicking it opens no dialog
        files: [txtFile],
        timeoutMs: 1500
      })
    ).rejects.toThrow(/did not open a file dialog/);
  });

  test("drop: path-based DragData reaches the drop zone's handler", async ({ runTool, openFixture }) => {
    const { tabId } = await openFixture("upload.html");
    const result = await runTool<{ dispatched: boolean; dropHandled: boolean | null }>("chrome_upload", {
      action: "drop",
      tabId,
      selector: "#zone",
      files: [txtFile]
    });
    expect(result.dispatched).toBe(true);
    const d = await diag(runTool, tabId);
    expect(d.sawDragOver).toBe(true);
    expect(d.dropped.map((f) => f.name)).toEqual(["hello.txt"]);
    expect(d.dropped[0].size).toBeGreaterThan(0); // Chrome actually read the file from the path
  });
});
