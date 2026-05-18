// Tool-arg parsers — protocol-owned single source of truth.
//
// Code-quality-hardening PR 12: addresses doc Risk 1 "protocol drift."
// Each tool gets a parser here that returns a typed args object. CLI
// and extension both consume the same parser, so silent shape drift
// can't happen between them.
//
// Current coverage: chrome_navigate, chrome_hover, chrome_network. The
// pattern is established; remaining tools are mechanical follow-up
// (each one is ~20 lines + a few tests).

export * from "./shared";
export * from "./navigate";
export * from "./hover";
export * from "./network";
export * from "./simple";
export * from "./multi";
