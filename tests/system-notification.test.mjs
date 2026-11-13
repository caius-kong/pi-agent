import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const extensionUrl = new URL("../agent/extensions/notify/index.ts", import.meta.url);
const helperUrl = new URL("../agent/extensions/lib/system-notification.ts", import.meta.url);

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-notify-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fakeCommand(dir, name, body) {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

async function withEnv(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("macOS delivery uses terminal-notifier and falls back to osascript", async () => {
  const { notifySystem } = await import(helperUrl);
  await withTempDir(async (dir) => {
    const log = path.join(dir, "args");
    const fallback = path.join(dir, "fallback");
    await fakeCommand(dir, "terminal-notifier", 'printf "%s\\n" "$@" > "$NOTIFY_LOG"');
    await fakeCommand(dir, "osascript", 'echo called >> "$OSASCRIPT_LOG"');
    await withEnv({
      PATH: `${dir}:${process.env.PATH}`,
      NOTIFY_LOG: log,
      OSASCRIPT_LOG: fallback,
      HERDR_ENV: undefined,
      HERDR_SOCKET_PATH: undefined,
      HERDR_PANE_ID: undefined,
    }, async () => {
      await notifySystem("Pi done", "Ready for input");
      const args = await readFile(log, "utf8");
      assert.match(args, /-title\nPi done/);
      assert.match(args, /-message\nReady for input/);
      assert.equal(await readFile(fallback, "utf8").catch(() => ""), "");

      await fakeCommand(dir, "terminal-notifier", "exit 1");
      await notifySystem("Fallback", "Visible");
      assert.equal(await readFile(fallback, "utf8"), "called\n");
    });
  });
});

test("Herdr delivery uses notification.show without writing terminal escape sequences", async () => {
  const { notifySystem } = await import(helperUrl);
  await withTempDir(async (dir) => {
    const socketPath = path.join(dir, "herdr.sock");
    const server = net.createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk;
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.trim());
        assert.equal(request.method, "notification.show");
        assert.equal(request.params.title, "Pi done");
        assert.equal(request.params.body, "Ready for input");
        socket.end(`${JSON.stringify({ id: request.id, result: { shown: true } })}\n`);
      });
    });
    server.listen(socketPath);
    await once(server, "listening");
    try {
      await withEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "w1:p1" }, () =>
        notifySystem("Pi done", "Ready for input"),
      );
    } finally {
      server.close();
    }
  });
});

test("Pi completion is announced once at final settlement, never at agent_end", async () => {
  const { registerCompletionNotifier } = await import(extensionUrl);
  const handlers = {};
  const notifications = [];
  registerCompletionNotifier(
    {
      on: (name, handler) => (handlers[name] = handler),
      events: { on: () => () => {} },
    },
    {
      graceMs: 0,
      notify: async (title, body) => notifications.push({ title, body }),
      resolveContext: async () => ({ title: "Pi", body: "Run finished; ready for input" }),
    },
  );
  assert.equal(typeof handlers.agent_settled, "function");
  assert.equal(handlers.agent_end, undefined);

  await handlers.agent_settled(
    { type: "agent_settled", aborted: false },
    { mode: "tui", isIdle: () => true, hasPendingMessages: () => false },
  );
  assert.equal(notifications.length, 0, "the notification waits out the settle boundary");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(notifications, [{ title: "Pi", body: "Run finished; ready for input" }]);
});
