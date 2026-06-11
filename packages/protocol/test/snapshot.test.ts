import { describe, expect, it } from "vitest";
import {
  formatRefToken,
  parseRefToken,
  renderSnapshot,
  type SnapshotData
} from "../src/index";

describe("parseRefToken", () => {
  it("accepts @eN and returns the bare id", () => {
    expect(parseRefToken("@e1")).toBe("e1");
    expect(parseRefToken("@e1042")).toBe("e1042");
    expect(parseRefToken("  @e3 ")).toBe("e3");
  });

  it("rejects everything that is not exactly @eN", () => {
    expect(parseRefToken("e3")).toBeNull(); // bare e3 is a valid CSS type selector
    expect(parseRefToken("@e")).toBeNull();
    expect(parseRefToken("@x3")).toBeNull();
    expect(parseRefToken("@e3x")).toBeNull();
    expect(parseRefToken("button")).toBeNull();
    expect(parseRefToken("")).toBeNull();
  });

  it("round-trips with formatRefToken", () => {
    expect(formatRefToken(parseRefToken("@e7")!)).toBe("@e7");
  });
});

describe("renderSnapshot", () => {
  // The golden test — this output IS the product surface agents pay tokens
  // on. Change it deliberately or not at all.
  it("renders the canonical format", () => {
    const data: SnapshotData = {
      title: "Example - Log in",
      url: "https://example.com/login",
      tabId: 42,
      nodeCount: 7,
      refs: {
        e1: { tabId: 42, backendNodeId: 11, role: "heading", name: "Log in" },
        e3: { tabId: 42, backendNodeId: 13, role: "textbox", name: "Email" },
        e4: { tabId: 42, backendNodeId: 14, role: "textbox", name: "Password" },
        e5: { tabId: 42, backendNodeId: 15, role: "button", name: "Continue" },
        e6: { tabId: 42, backendNodeId: 16, role: "link", name: "Forgot password?" },
        e7: { tabId: 42, backendNodeId: 17, role: "checkbox", name: "Remember me" }
      },
      nodes: [
        { role: "heading", name: "Log in", ref: "e1", attrs: { level: 1 } },
        {
          role: "form",
          children: [
            { role: "textbox", name: "Email", ref: "e3", value: "kushal@example.com" },
            { role: "textbox", name: "Password", ref: "e4", attrs: { required: true } },
            { role: "checkbox", name: "Remember me", ref: "e7", attrs: { checked: true } },
            { role: "button", name: "Continue", ref: "e5", attrs: { disabled: true } },
            { role: "link", name: "Forgot password?", ref: "e6", attrs: { url: "https://example.com/reset" } }
          ]
        }
      ]
    };

    expect(renderSnapshot(data)).toBe(
      [
        "Page: Example - Log in",
        "URL: https://example.com/login",
        "Tab: 42",
        "",
        '- heading "Log in" [level=1, ref=e1]',
        "- form",
        '  - textbox "Email" [ref=e3]: kushal@example.com',
        '  - textbox "Password" [required, ref=e4]',
        '  - checkbox "Remember me" [checked, ref=e7]',
        '  - button "Continue" [disabled, ref=e5]',
        '  - link "Forgot password?" [ref=e6, url=https://example.com/reset]'
      ].join("\n")
    );
  });

  it("renders explicit-false and mixed tristates, skips value === name", () => {
    const data: SnapshotData = {
      title: "t",
      url: "u",
      tabId: 1,
      nodeCount: 2,
      refs: {},
      nodes: [
        { role: "checkbox", name: "A", ref: "e1", attrs: { checked: false } },
        { role: "checkbox", name: "B", ref: "e2", attrs: { checked: "mixed" } },
        { role: "option", name: "same", ref: "e3", value: "same" }
      ]
    };
    const text = renderSnapshot(data);
    expect(text).toContain('- checkbox "A" [checked=false, ref=e1]');
    expect(text).toContain('- checkbox "B" [checked=mixed, ref=e2]');
    expect(text).toContain('- option "same" [ref=e3]');
    expect(text).not.toContain("same: same");
  });

  it("escapes quotes and newlines in names", () => {
    const data: SnapshotData = {
      title: "t", url: "u", tabId: 1, nodeCount: 1, refs: {},
      nodes: [{ role: "button", name: 'Say "hi"\nnow', ref: "e1" }]
    };
    expect(renderSnapshot(data)).toContain('- button "Say \\"hi\\"\\nnow" [ref=e1]');
  });

  it("marks an empty snapshot", () => {
    const data: SnapshotData = { title: "t", url: "u", tabId: 1, nodeCount: 0, refs: {}, nodes: [] };
    expect(renderSnapshot(data)).toContain("(empty snapshot");
  });
});
