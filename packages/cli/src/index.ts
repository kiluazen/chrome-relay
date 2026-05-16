// At build time, tsup's `define` config replaces `__CHROME_RELAY_VERSION__`
// with the package.json version string. At dev time / under vitest the
// fallback after `||` keeps the type stable.
declare const __CHROME_RELAY_VERSION__: string;
export const CHROME_RELAY_VERSION: string =
  typeof __CHROME_RELAY_VERSION__ !== "undefined" ? __CHROME_RELAY_VERSION__ : "0.0.0-dev";
