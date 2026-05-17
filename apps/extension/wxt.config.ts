import { defineConfig } from "wxt";

const DEV_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwjeom6wFAdp6NvNnKNxKiFnhAj4P8EH8zcbhObhsub2z2cNaOIk6xKcutJBUGwHS4GoEEoyTAiU0HzMwXzhcHOvqJYrFSLPwwounnZz1D0c+kdHSWbGztX2ykECewFHkabKi/6NsmgHnHQ1Of7fZj0LICNcD0nm8fNaq+3g4SF8pQRIojy222HGtSN2FfgvkHO9kr1L9eL0Tx+7YIJx8XQgx4mm/FsEK15+upox8LXm0Fbyb5ZermhRwZriMrYC2zkPMmhGmXgIUGs4AblTNwuLUsdNWvaticCs1i43ezNwNvbHXWO1T6jeng2IHb0nVacBueAf0oztBaNz9G9sDeQIDAQAB";

const isDev = process.env.NODE_ENV !== "production";

export default defineConfig({
  manifestVersion: 3,
  outDir: "build",
  manifest: {
    ...(isDev ? { key: DEV_KEY } : {}),
    name: "Chrome Relay",
    short_name: "Relay",
    description: "Connect your local browser to coding agents through a local bridge.",
    permissions: ["nativeMessaging", "debugger", "tabs", "tabGroups", "storage"],
    host_permissions: ["<all_urls>"],
    icons: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    },
    action: {
      default_title: "Chrome Relay",
      default_popup: "popup.html",
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png"
      }
    }
  }
});
