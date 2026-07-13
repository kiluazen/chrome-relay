// Profile identity — minted, not discovered.
//
// An extension cannot read its own Chrome profile's name or directory, so
// each install mints a stable UUID in chrome.storage.local (per-profile by
// construction). The instanceId rides on bridge.ready so the native host can
// write its instance descriptor, and its 4-hex-char prefix qualifies every
// ref token (@3f2a:e12) so refs stay routable when several profiles are
// connected. See docs/multi-profile-and-upload.md Part 1.

import { instancePrefix } from "@chrome-relay/protocol";

const STORAGE_KEY = "chrome_relay_instance_id_v1";

let cached: Promise<string> | null = null;

export function getInstanceId(): Promise<string> {
  if (!cached) {
    cached = (async () => {
      try {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        const existing = stored?.[STORAGE_KEY];
        if (typeof existing === "string" && existing) return existing;
      } catch {
        /* storage unavailable (tests) — fall through to an ephemeral mint */
      }
      const minted = crypto.randomUUID();
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: minted });
      } catch {
        /* best effort — an unpersisted id still works for this SW lifetime */
      }
      return minted;
    })();
  }
  return cached;
}

/** First 4 hex chars of the instanceId — the ref/routing prefix. Derivation
 *  lives in the protocol package so CLI and extension can never disagree. */
export async function getRefPrefix(): Promise<string> {
  return instancePrefix(await getInstanceId());
}

/** Chrome's "Allow access to file URLs" toggle. Gates debugger file
 *  operations (chrome_upload). undefined = API unavailable, unknown. */
export function getFileSchemeAccess(): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.extension.isAllowedFileSchemeAccess((allowed) => resolve(allowed));
    } catch {
      resolve(undefined);
    }
  });
}

/** Pin a deterministic identity in tests (snapshot goldens depend on the
 *  ref prefix). Passing null resets to the normal mint path. */
export function __setInstanceIdForTests(id: string | null): void {
  cached = id === null ? null : Promise.resolve(id);
}
