// Viewport emulation presets — names map to (width, height, dpr, mobile, ua).
//
// Why these specific devices: iPhone-14 and Pixel-7 cover the two biggest
// modern mobile fingerprints. iPad-mini covers the "tablet" case people forget
// about. Desktop presets are the two windows widths that matter for SaaS
// dashboards (1280 = the "small laptop" floor, 1440 = MBA 14" common default,
// 1920 = 24" external).
//
// User agents are real strings from real devices in late 2024. Sites that
// content-negotiate on UA tend to look at the "iPhone" / "Android" substrings
// rather than the exact version, so these are robust to UA-string drift.
//
// Adding a preset: append a row here, no other change. The CLI's `viewport
// preset` subcommand and the extension handler both read from this table.

export type ViewportSpec = {
  width: number;
  height: number;
  dpr: number;       // deviceScaleFactor (1, 2, 3...)
  mobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
};

export const VIEWPORT_PRESETS: Record<string, ViewportSpec> = {
  // ---- mobile ----
  "iphone-14": {
    width: 390,
    height: 844,
    dpr: 3,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
  },
  "iphone-15-pro": {
    width: 393,
    height: 852,
    dpr: 3,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
  },
  "iphone-se": {
    width: 375,
    height: 667,
    dpr: 2,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
  },
  "pixel-7": {
    width: 412,
    height: 915,
    dpr: 2.625,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },
  "galaxy-s23": {
    width: 360,
    height: 780,
    dpr: 3,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"
  },

  // ---- tablet ----
  "ipad-mini": {
    width: 768,
    height: 1024,
    dpr: 2,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
  },
  "ipad-pro-11": {
    width: 834,
    height: 1194,
    dpr: 2,
    mobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"
  },

  // ---- desktop ----
  "desktop-1280": { width: 1280, height: 800, dpr: 2, mobile: false, hasTouch: false },
  "desktop-1440": { width: 1440, height: 900, dpr: 2, mobile: false, hasTouch: false },
  "desktop-1920": { width: 1920, height: 1080, dpr: 1, mobile: false, hasTouch: false }
};

export type PresetName = keyof typeof VIEWPORT_PRESETS;

export function isPresetName(name: string): name is PresetName {
  return Object.prototype.hasOwnProperty.call(VIEWPORT_PRESETS, name);
}

export function listPresets(): string[] {
  return Object.keys(VIEWPORT_PRESETS);
}
