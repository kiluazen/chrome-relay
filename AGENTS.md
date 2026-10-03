# Background operation

Chrome Relay work must preserve the user's desktop focus. Run browser tests and benchmarks only with headless Chromium; never launch a visible browser or Playwright UI, activate a tab, raise a window, or move the system pointer as part of testing or automation. Use isolated temporary profiles for tests.

Target browser tabs explicitly instead of switching to them. Do not work around a failed background operation by bringing it to the foreground. Fix the background path or report its limitation. Recordings sample background screenshots; they do not promise every compositor frame.
