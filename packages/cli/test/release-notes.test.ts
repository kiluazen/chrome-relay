import { describe, it, expect } from "vitest";
import { compareSemver, listReleaseNotesSince, RELEASE_NOTES } from "../src/release-notes";

describe("compareSemver", () => {
  it("orders patch versions", () => {
    expect(compareSemver("0.5.0", "0.5.1")).toBe(-1);
    expect(compareSemver("0.5.1", "0.5.0")).toBe(1);
    expect(compareSemver("0.5.0", "0.5.0")).toBe(0);
  });

  it("orders minor versions ahead of patch", () => {
    expect(compareSemver("0.5.9", "0.6.0")).toBe(-1);
    expect(compareSemver("0.6.0", "0.5.9")).toBe(1);
  });

  it("orders major versions ahead of minor", () => {
    expect(compareSemver("0.9.9", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
  });

  it("handles missing parts as 0", () => {
    expect(compareSemver("0.5", "0.5.0")).toBe(0);
    expect(compareSemver("0.5", "0.5.1")).toBe(-1);
  });
});

describe("listReleaseNotesSince", () => {
  it("returns versions strictly greater than `since`, sorted ascending", () => {
    const out = listReleaseNotesSince("0.4.0");
    const versions = out.map((c) => c.version);
    // 0.4.0 is in the file but must be excluded (strict >).
    expect(versions).not.toContain("0.4.0");
    // 0.5.0 and 0.5.1 must be included.
    expect(versions).toContain("0.5.0");
    expect(versions).toContain("0.5.1");
    // Ascending order: 0.5.0 before 0.5.1.
    expect(versions.indexOf("0.5.0")).toBeLessThan(versions.indexOf("0.5.1"));
  });

  it("returns the full backlog when since is 0.0.0", () => {
    const out = listReleaseNotesSince("0.0.0");
    expect(out.map((c) => c.version)).toEqual(
      Object.keys(RELEASE_NOTES).sort((a, b) => compareSemver(a, b))
    );
  });

  it("returns an empty list when caller is at or above the latest", () => {
    const latest = Object.keys(RELEASE_NOTES).sort((a, b) => compareSemver(b, a))[0];
    expect(listReleaseNotesSince(latest)).toEqual([]);
  });

  it("each entry has a non-empty bullets array", () => {
    for (const change of listReleaseNotesSince("0.0.0")) {
      expect(change.bullets.length).toBeGreaterThan(0);
      for (const bullet of change.bullets) {
        expect(typeof bullet).toBe("string");
        expect(bullet.length).toBeGreaterThan(0);
      }
    }
  });
});
