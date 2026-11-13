import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type NotificationOptions = { sound?: "Glass" };

async function notifyHerdr(title: string, body: string, options: NotificationOptions): Promise<boolean> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_ENV !== "1" || !socketPath || !process.env.HERDR_PANE_ID) {
    return false;
  }

  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  return new Promise((resolve) => {
    const socket = net.createConnection(endpoint);
    let response = "";
    const timeout = setTimeout(() => finish(false), 1500);
    timeout.unref?.();

    function finish(shown: boolean) {
      clearTimeout(timeout);
      socket.destroy();
      resolve(shown);
    }

    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: `pi-notification:${Date.now()}`,
          method: "notification.show",
          params: {
            title,
            body,
            sound: options.sound === "Glass" ? "request" : undefined,
          },
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(JSON.parse(response.slice(0, newline)).result?.shown === true);
      } catch {
        finish(false);
      }
    });
  });
}

async function notifyMacOS(title: string, body: string, options: NotificationOptions): Promise<boolean> {
  try {
    await execFileAsync(
      "terminal-notifier",
      ["-title", title, "-message", body, ...(options.sound ? ["-sound", options.sound] : [])],
      { timeout: 5000 },
    );
    return true;
  } catch {
    try {
      await execFileAsync(
        "osascript",
        [
          "-e",
          "on run argv",
          "-e",
          options.sound
            ? "display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)"
            : "display notification (item 2 of argv) with title (item 1 of argv)",
          "-e",
          "end run",
          title,
          body,
          ...(options.sound ? [options.sound] : []),
        ],
        { timeout: 5000 },
      );
      return true;
    } catch {
      return false;
    }
  }
}

async function notifyLinux(title: string, body: string): Promise<boolean> {
  try {
    await execFileAsync("notify-send", [title, body], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Best-effort OS notification; Herdr handles pane isolation before platform delivery. */
export async function notifySystem(
  title: string,
  body: string,
  options: NotificationOptions = {},
): Promise<void> {
  if (await notifyHerdr(title, body, options)) return;

  if (process.platform === "darwin") {
    if (await notifyMacOS(title, body, options)) return;
  } else if (process.platform === "linux") {
    if (await notifyLinux(title, body)) return;
  }

  // OSC is only a terminal-specific fallback, never the primary system channel.
  if (process.platform === "win32" && process.env.WT_SESSION) {
    const { execFile: exec } = await import("node:child_process");
    const quote = (value: string) => value.replaceAll("'", "''");
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText01)",
      `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${quote(`${title}: ${body}`)}')) > $null`,
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Windows Terminal').Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
    ].join("; ");
    try {
      await promisify(exec)("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 5000 });
      return;
    } catch {
      // Fall through to the terminal notification protocol.
    }
  }

  if (process.stdout.writable) {
    const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f;]/g, " ");
    process.stdout.write(`\x1b]777;notify;${clean(title)};${clean(body)}\x07`);
  }
}
