# Chrome Relay Privacy Policy Draft

Last updated: 2026-04-23

Chrome Relay connects your local browser to coding agents that you configure. The extension works with the `chrome-relay` native host running on your own machine.

## What Data Chrome Relay Can Access

When you or your local agent use Chrome Relay, the extension can access:

- Currently open tab titles and URLs.
- Visible page text and interactive element metadata.
- Screenshots of the visible tab.
- Form fields and buttons on pages you ask the agent to operate.

Chrome Relay uses this access only to perform local browser-control actions requested through the local Chrome Relay bridge.

## What Chrome Relay Stores

Chrome Relay stores the last three tool execution summaries in Chrome extension local storage so the popup can show recent activity. These summaries include the tool name, time, success/error state, and a short non-secret description. Fill values are not stored; only the value length is shown.

## What Chrome Relay Sends

Chrome Relay does not send browsing data to a Chrome Relay cloud service.

Tool calls and tool results move between:

- The Chrome Relay extension.
- The locally installed native messaging host.
- The local CLI or coding agent configured by the user.

If you connect Chrome Relay to a third-party local agent, that agent's own privacy practices apply to what it does with the data you ask it to read.

## Remote Code

Chrome Relay does not load or execute remotely hosted extension code. Its browser actions are implemented by code included in the extension package.

## Contact

For questions, contact the publisher listed in the Chrome Web Store listing or open an issue in the project repository.
