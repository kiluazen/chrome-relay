import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CHROME_WEB_STORE_EXTENSION_ID,
  DEFAULT_EXTENSION_IDS,
  DEFAULT_HTTP_PORT,
  instancePrefix,
  LEGACY_DEV_EXTENSION_ID,
  LOCAL_UNPACKED_EXTENSION_ID,
  NATIVE_HOST_NAME
} from "@chrome-relay/protocol";
import { discoverInstances } from "../client/route.js";

const APP_DIR = path.join(os.homedir(), ".chrome-relay");

const KNOWN_EXTENSION_IDS = [
  ["Chrome Web Store", CHROME_WEB_STORE_EXTENSION_ID],
  ["legacy dev", LEGACY_DEV_EXTENSION_ID],
  ["local unpacked", LOCAL_UNPACKED_EXTENSION_ID]
] as const;

function allowedOrigin(extensionId: string): string {
  return `chrome-extension://${extensionId}/`;
}

function getDefaultAllowedOrigins(): string[] {
  return DEFAULT_EXTENSION_IDS.map(allowedOrigin);
}

function formatKnownExtensionIds(): string {
  return KNOWN_EXTENSION_IDS.map(([label, id]) => `${label}: ${id}`).join(", ");
}

// Every Chromium-fork browser maintains its own NativeMessagingHosts
// directory. Chrome was the first target so the codebase grew up assuming
// only Chrome's path, but the extension installs unchanged in Arc, Brave,
// Edge, Vivaldi, Chromium, Opera, etc — so the native-host manifest needs
// to land in each browser's dir, otherwise the extension loads but the
// bridge fails to connect from that browser.
//
// We list ALL candidate dirs, then write to the ones whose PARENT directory
// already exists on disk. Parent-exists is the "is this browser installed"
// signal — we never create the browser's profile dir, only the
// NativeMessagingHosts subdir inside it.
interface BrowserTarget {
  label: string;
  manifestDir: string;
  // The dir we check to decide whether this browser is installed. Usually
  // the parent of manifestDir (the profile dir itself).
  installRoot: string;
  registryKey?: string;
}

function getChromiumBrowserTargets(): BrowserTarget[] {
  const home = os.homedir();

  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library/Application Support");
    return [
      { label: "Google Chrome",          installRoot: path.join(appSupport, "Google/Chrome"),                  manifestDir: path.join(appSupport, "Google/Chrome/NativeMessagingHosts") },
      { label: "Google Chrome Canary",   installRoot: path.join(appSupport, "Google/Chrome Canary"),           manifestDir: path.join(appSupport, "Google/Chrome Canary/NativeMessagingHosts") },
      { label: "Chromium",               installRoot: path.join(appSupport, "Chromium"),                       manifestDir: path.join(appSupport, "Chromium/NativeMessagingHosts") },
      { label: "Microsoft Edge",         installRoot: path.join(appSupport, "Microsoft Edge"),                 manifestDir: path.join(appSupport, "Microsoft Edge/NativeMessagingHosts") },
      { label: "Brave",                  installRoot: path.join(appSupport, "BraveSoftware/Brave-Browser"),    manifestDir: path.join(appSupport, "BraveSoftware/Brave-Browser/NativeMessagingHosts") },
      { label: "Vivaldi",                installRoot: path.join(appSupport, "Vivaldi"),                        manifestDir: path.join(appSupport, "Vivaldi/NativeMessagingHosts") },
      { label: "Arc",                    installRoot: path.join(appSupport, "Arc/User Data"),                  manifestDir: path.join(appSupport, "Arc/User Data/NativeMessagingHosts") },
      { label: "Opera",                  installRoot: path.join(appSupport, "com.operasoftware.Opera"),        manifestDir: path.join(appSupport, "com.operasoftware.Opera/NativeMessagingHosts") }
    ];
  }

  if (process.platform === "linux") {
    const config = path.join(home, ".config");
    return [
      { label: "Google Chrome",   installRoot: path.join(config, "google-chrome"),                  manifestDir: path.join(config, "google-chrome/NativeMessagingHosts") },
      { label: "Chromium",        installRoot: path.join(config, "chromium"),                       manifestDir: path.join(config, "chromium/NativeMessagingHosts") },
      { label: "Microsoft Edge",  installRoot: path.join(config, "microsoft-edge"),                 manifestDir: path.join(config, "microsoft-edge/NativeMessagingHosts") },
      { label: "Brave",           installRoot: path.join(config, "BraveSoftware/Brave-Browser"),    manifestDir: path.join(config, "BraveSoftware/Brave-Browser/NativeMessagingHosts") },
      { label: "Vivaldi",         installRoot: path.join(config, "vivaldi"),                        manifestDir: path.join(config, "vivaldi/NativeMessagingHosts") },
      { label: "Opera",           installRoot: path.join(config, "opera"),                          manifestDir: path.join(config, "opera/NativeMessagingHosts") }
    ];
  }

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const manifestBase = path.join(APP_DIR, "NativeMessagingHosts");
    return [
      {
        label: "Google Chrome",
        installRoot: path.join(local, "Google", "Chrome", "User Data"),
        manifestDir: path.join(manifestBase, "Google Chrome"),
        registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      },
      {
        label: "Google Chrome Canary",
        installRoot: path.join(local, "Google", "Chrome SxS", "User Data"),
        manifestDir: path.join(manifestBase, "Google Chrome Canary"),
        registryKey: `HKCU\\Software\\Google\\Chrome SxS\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      },
      {
        label: "Chromium",
        installRoot: path.join(local, "Chromium", "User Data"),
        manifestDir: path.join(manifestBase, "Chromium"),
        registryKey: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      },
      {
        label: "Microsoft Edge",
        installRoot: path.join(local, "Microsoft", "Edge", "User Data"),
        manifestDir: path.join(manifestBase, "Microsoft Edge"),
        registryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      },
      {
        label: "Brave",
        installRoot: path.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
        manifestDir: path.join(manifestBase, "Brave"),
        registryKey: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      },
      {
        label: "Vivaldi",
        installRoot: path.join(local, "Vivaldi", "User Data"),
        manifestDir: path.join(manifestBase, "Vivaldi"),
        registryKey: `HKCU\\Software\\Vivaldi\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      },
      {
        label: "Opera",
        installRoot: path.join(roaming, "Opera Software", "Opera Stable"),
        manifestDir: path.join(manifestBase, "Opera"),
        registryKey: `HKCU\\Software\\Opera Software\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      }
    ];
  }

  throw new Error(`Unsupported platform for install: ${process.platform}`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Filter to targets whose installRoot actually exists — meaning the browser
// is installed locally. We don't speculatively create profile dirs.
async function getInstalledBrowsers(): Promise<BrowserTarget[]> {
  const all = getChromiumBrowserTargets();
  const installed: BrowserTarget[] = [];
  for (const target of all) {
    if (await pathExists(target.installRoot)) {
      installed.push(target);
    }
  }
  return installed;
}

function getDistDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

async function writeWrapperScript(hostPath: string): Promise<string> {
  await mkdir(APP_DIR, { recursive: true });
  if (process.platform === "win32") {
    const wrapperPath = path.join(APP_DIR, "run-host.cmd");
    const content = `@echo off\r\n"${process.execPath}" "${hostPath}"\r\n`;
    await writeFile(wrapperPath, content, "utf8");
    return wrapperPath;
  }
  const wrapperPath = path.join(APP_DIR, "run-host.sh");
  const content = `#!/bin/sh\nexec "${process.execPath}" "${hostPath}"\n`;
  await writeFile(wrapperPath, content, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

interface WrittenManifest {
  browser: string;
  manifestPath: string;
  registryKey?: string;
}

function registerWindowsNativeHost(registryKey: string, manifestPath: string): void {
  const res = spawnSync("reg.exe", [
    "ADD",
    registryKey,
    "/ve",
    "/t",
    "REG_SZ",
    "/d",
    manifestPath,
    "/f"
  ], { encoding: "utf8" });
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(`failed to register ${registryKey}${detail ? `: ${detail}` : ""}`);
  }
}

function readWindowsNativeHostRegistry(registryKey: string): string | null {
  const res = spawnSync("reg.exe", ["QUERY", registryKey, "/ve"], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) return null;
  for (const line of res.stdout.split("\n")) {
    const match = line.match(/REG_SZ\s+(.+?)\s*$/);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

async function writeManifestsForBrowsers(
  wrapperPath: string,
  browsers: BrowserTarget[]
): Promise<WrittenManifest[]> {
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Native host for Chrome Relay",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: getDefaultAllowedOrigins()
  };
  const body = `${JSON.stringify(manifest, null, 2)}\n`;

  const written: WrittenManifest[] = [];
  for (const target of browsers) {
    await mkdir(target.manifestDir, { recursive: true });
    const manifestPath = path.join(target.manifestDir, `${NATIVE_HOST_NAME}.json`);
    await writeFile(manifestPath, body, "utf8");
    if (process.platform === "win32") {
      if (!target.registryKey) throw new Error(`missing registry key for ${target.label}`);
      registerWindowsNativeHost(target.registryKey, manifestPath);
    }
    written.push({ browser: target.label, manifestPath, registryKey: target.registryKey });
  }
  return written;
}

// Find and SIGTERM any running native-host.js processes. Chrome's native
// messaging keeps the host alive for the session, so without this `update`
// would refresh the on-disk binary while Chrome kept talking to the old one
// — that's exactly how the cli-outdated nudge ended up firing on a CLI that
// was already at-or-newer than the extension. Best-effort: silently no-op
// on unsupported platforms and on individual kill failures (already gone,
// no permission). Returns the count of processes we actually terminated.
function killStaleNativeHosts(): { killed: number } {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return { killed: 0 };
  }

  const ps = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" });
  if (ps.status !== 0 || !ps.stdout) return { killed: 0 };

  let killed = 0;
  for (const raw of ps.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.includes("chrome-relay") || !line.includes("native-host.js")) continue;
    const m = line.match(/^(\d+)\s/);
    if (!m) continue;
    const pid = Number.parseInt(m[1], 10);
    if (pid === process.pid) continue; // never SIGTERM ourselves
    try {
      process.kill(pid, "SIGTERM");
      killed++;
    } catch {
      // already gone, no permission — ignore
    }
  }
  return { killed };
}

export async function runInstall(): Promise<void> {
  const distDir = getDistDir();
  const hostPath = path.join(distDir, "native-host.js");
  const wrapperPath = await writeWrapperScript(hostPath);

  const installed = await getInstalledBrowsers();
  if (installed.length === 0) {
    // Fall back to Chrome's path so the install at least lands somewhere
    // — matches pre-0.5.22 behavior when no Chromium browser is detected.
    const all = getChromiumBrowserTargets();
    const fallback = all.find((t) => t.label === "Google Chrome");
    if (fallback) installed.push(fallback);
  }
  const writtenManifests = await writeManifestsForBrowsers(wrapperPath, installed);

  // Reaping happens after the manifest is in place, so each browser's next
  // native-messaging request respawns the host pointing at the freshly
  // written wrapper.
  const { killed } = killStaleNativeHosts();

  console.log(`Installed Chrome Relay native host.`);
  console.log(`Wrapper: ${wrapperPath}`);
  console.log(`Manifests written:`);
  for (const m of writtenManifests) {
    console.log(`  • ${m.browser}: ${m.manifestPath}`);
    if (m.registryKey) {
      console.log(`    registry: ${m.registryKey}`);
    }
  }
  console.log(`Local bridge port: ${DEFAULT_HTTP_PORT}`);
  console.log(`Allowed extension IDs: ${formatKnownExtensionIds()}`);
  if (killed > 0) {
    console.log(`Reaped ${killed} stale native-host process${killed === 1 ? "" : "es"}; browsers will respawn from the new manifest.`);
  }
}

export async function runDoctor(): Promise<boolean> {
  try {
    const wrapperPath = path.join(APP_DIR, process.platform === "win32" ? "run-host.cmd" : "run-host.sh");
    await stat(wrapperPath);
    console.log(`Wrapper present: yes`);

    const installed = await getInstalledBrowsers();
    if (installed.length === 0) {
      console.log(`No Chromium-based browsers detected.`);
      console.log(`Tip: install Chrome / Arc / Brave / Edge / Chromium / Vivaldi / Opera then re-run "chrome-relay install".`);
      return false;
    }

    const required = getDefaultAllowedOrigins();
    let allHealthy = true;
    console.log(`Detected browsers (${installed.length}):`);
    for (const target of installed) {
      const manifestPath = path.join(target.manifestDir, `${NATIVE_HOST_NAME}.json`);
      const exists = await pathExists(manifestPath);
      if (!exists) {
        allHealthy = false;
        console.log(`  • ${target.label}: manifest MISSING (${manifestPath})`);
        continue;
      }
      if (process.platform === "win32" && target.registryKey) {
        const registered = readWindowsNativeHostRegistry(target.registryKey);
        if (path.normalize(registered || "") !== path.normalize(manifestPath)) {
          allHealthy = false;
          console.log(`  • ${target.label}: registry MISSING/STALE (${target.registryKey})`);
          continue;
        }
      }
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const allowedOrigins: string[] = Array.isArray(manifest.allowed_origins) ? manifest.allowed_origins : [];
        const missingOrigins = required.filter((o) => !allowedOrigins.includes(o));
        if (missingOrigins.length > 0) {
          allHealthy = false;
          console.log(`  • ${target.label}: manifest present but missing origins: ${missingOrigins.join(", ")}`);
        } else {
          console.log(`  • ${target.label}: ok`);
        }
      } catch (e) {
        allHealthy = false;
        console.log(`  • ${target.label}: manifest unreadable (${e instanceof Error ? e.message : String(e)})`);
      }
    }

    if (!allHealthy) {
      console.log(`Tip: run "chrome-relay install" to refresh manifests for every detected browser.`);
    }

    let serverReachable = false;
    let connected: { extensionId?: string | null; extensionVersion?: string | null } = {};
    try {
      const response = await fetch(`http://127.0.0.1:${DEFAULT_HTTP_PORT}/ping`);
      serverReachable = response.ok;
      if (response.ok) connected = (await response.json()) as typeof connected;
    } catch {
      serverReachable = false;
    }
    console.log(`Allowed extension IDs: ${formatKnownExtensionIds()}`);
    console.log(`Local bridge reachable: ${serverReachable ? "yes" : "no"}`);
    if (serverReachable) {
      // WHICH extension owns the bridge matters: when both the store build
      // and an unpacked dev build are loaded, they race for the port, and
      // "new commands return unsupported_tool" is the confusing symptom.
      const flavor =
        connected.extensionId === CHROME_WEB_STORE_EXTENSION_ID ? "Chrome Web Store" :
        connected.extensionId === LOCAL_UNPACKED_EXTENSION_ID ? "local unpacked (dev)" :
        connected.extensionId === LEGACY_DEV_EXTENSION_ID ? "legacy dev" :
        connected.extensionId ? "unknown id" : "id not reported (pre-0.8 host still running — restart Chrome or run chrome-relay update)";
      console.log(`Connected extension: ${connected.extensionVersion ?? "?"} — ${flavor}${connected.extensionId ? ` (${connected.extensionId})` : ""}`);
    } else {
      console.log(`Tip: load the extension in one of the detected browsers so it can launch the native host.`);
    }

    // v2 instance registry: one line per ping-verified profile. This is
    // the multi-profile view — the legacy fixed-port check above only ever
    // sees whichever host won the 12122 race.
    const { verified: instances, unresolved } = await discoverInstances();
    console.log(`Registered profiles (v2): ${instances.length === 0 && unresolved.length === 0 ? "none (pre-v2 extension, or none connected)" : ""}`);
    for (const u of unresolved) {
      console.log(`  ${u.label ?? "(unlabeled)"} [${instancePrefix(u.descriptor.instanceId)}] — UNREACHABLE (registered, host not answering; pid ${u.descriptor.pid})`);
    }
    for (const inst of instances) {
      const prefix = instancePrefix(inst.descriptor.instanceId);
      const fileAccess =
        inst.fileSchemeAccess === true ? "yes" :
        inst.fileSchemeAccess === false ? "NO — uploads will fail with file_access_denied; fix: chrome://extensions → Chrome Relay → Allow access to file URLs" :
        "unknown";
      console.log(
        `  ${inst.label ?? "(unlabeled)"} [${prefix}] — ext ${inst.descriptor.extensionVersion}, host ${inst.descriptor.hostVersion}, port ${inst.descriptor.port}, file-URL access: ${fileAccess}`
      );
    }
    return allHealthy;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}
