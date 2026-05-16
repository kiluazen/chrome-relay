import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CHROME_WEB_STORE_EXTENSION_ID,
  DEFAULT_EXTENSION_IDS,
  DEFAULT_HTTP_PORT,
  LEGACY_DEV_EXTENSION_ID,
  LOCAL_UNPACKED_EXTENSION_ID,
  NATIVE_HOST_NAME
} from "@chrome-relay/protocol";

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

function getChromeManifestDir(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library/Application Support/Google/Chrome/NativeMessagingHosts"
    );
  }

  if (process.platform === "linux") {
    return path.join(os.homedir(), ".config/google-chrome/NativeMessagingHosts");
  }

  throw new Error(`Unsupported platform for install: ${process.platform}`);
}

function getDistDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

async function writeWrapperScript(hostPath: string): Promise<string> {
  await mkdir(APP_DIR, { recursive: true });
  const wrapperPath = path.join(APP_DIR, "run-host.sh");
  const content = `#!/bin/sh\nexec "${process.execPath}" "${hostPath}"\n`;
  await writeFile(wrapperPath, content, "utf8");
  await chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function writeManifest(wrapperPath: string): Promise<string> {
  const manifestDir = getChromeManifestDir();
  await mkdir(manifestDir, { recursive: true });

  const manifestPath = path.join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Native host for Chrome Relay",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: getDefaultAllowedOrigins()
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

export async function runInstall(): Promise<void> {
  const distDir = getDistDir();
  const hostPath = path.join(distDir, "native-host.js");
  const wrapperPath = await writeWrapperScript(hostPath);
  const manifestPath = await writeManifest(wrapperPath);

  console.log(`Installed Chrome Relay native host.`);
  console.log(`Wrapper: ${wrapperPath}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Local bridge port: ${DEFAULT_HTTP_PORT}`);
  console.log(`Allowed extension IDs: ${formatKnownExtensionIds()}`);
}

export async function runDoctor(): Promise<boolean> {
  try {
    const wrapperPath = path.join(APP_DIR, "run-host.sh");
    const manifestPath = path.join(getChromeManifestDir(), `${NATIVE_HOST_NAME}.json`);

    await stat(wrapperPath);
    await stat(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const allowedOrigins = Array.isArray(manifest.allowed_origins)
      ? manifest.allowed_origins
      : [];
    const missingOrigins = getDefaultAllowedOrigins().filter(
      (origin) => !allowedOrigins.includes(origin)
    );

    let serverReachable = false;
    try {
      const response = await fetch(`http://127.0.0.1:${DEFAULT_HTTP_PORT}/ping`);
      serverReachable = response.ok;
    } catch {
      serverReachable = false;
    }

    console.log(`Wrapper present: yes`);
    console.log(`Manifest present: yes`);
    console.log(`Allowed extension IDs: ${formatKnownExtensionIds()}`);
    console.log(`Allowed origins: ${(manifest.allowed_origins ?? ["missing"]).join(", ")}`);
    if (missingOrigins.length > 0) {
      console.log(`Manifest missing origins: ${missingOrigins.join(", ")}`);
      console.log(`Tip: run "chrome-relay install" to refresh the native host manifest.`);
    }
    console.log(`Local bridge reachable: ${serverReachable ? "yes" : "no"}`);
    if (!serverReachable) {
      console.log(`Tip: load the extension so it can launch the native host.`);
    }
    return true;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}
