import { BrowserWindow, Updater } from "electrobun/bun";

const DEV_SERVER_URL = "http://localhost:5173";

async function getMainViewUrl(): Promise<string> {
  if ((await Updater.localInfo.channel()) === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      return DEV_SERVER_URL;
    } catch {
      // Fall back to the bundled view when the optional Vite server is not running.
    }
  }

  return "views://mainview/index.html";
}

new BrowserWindow({
  title: "Kalamata",
  url: await getMainViewUrl(),
});
