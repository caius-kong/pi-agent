import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const extensionUrl = new URL("../agent/extensions/permission-gate/index.ts", import.meta.url);

async function loadExtension() {
  const url = new URL(extensionUrl);
  url.searchParams.set("test", randomUUID());
  return import(url);
}

function fakePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
}

function context({ cwd = "~", choice = "YOLO - this session", hasUI = true } = {}) {
  const notices = [];
  let selectCount = 0;
  return {
    notices,
    get selectCount() { return selectCount; },
    cwd,
    hasUI,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      select: async () => {
        selectCount++;
        return choice;
      },
    },
  };
}

/** Write ~/.pi/agent/settings.json into the isolated home. */
async function writeSettings(home, settings) {
  const dir = path.join(home, ".pi", "agent");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "settings.json"), JSON.stringify(settings));
}

/**
 * Notification socket stub + isolated HOME, so the extension reads a test
 * settings.json instead of this machine's (which may set permission-gate.yolo).
 */
async function withHarness(run) {
  const binDir = await mkdtemp(path.join(os.tmpdir(), "permission-gate-test-"));
  const home = path.join(binDir, "home");
  await mkdir(home, { recursive: true });
  const socketPath = path.join(binDir, "notify.sock");
  const notifications = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      notifications.push(JSON.parse(chunk.toString()));
      socket.end('{"result":{"shown":true}}\n');
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const env = {
    HOME: process.env.HOME,
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
  process.env.HOME = home;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = socketPath;
  process.env.HERDR_PANE_ID = "test-pane";
  try {
    await run(notifications, home);
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise((resolve) => server.close(resolve));
    await rm(binDir, { recursive: true, force: true });
  }
}

test("choosing YOLO in the approval dialog confirms it and arms subsequent dangerous commands", async () => {
  await withHarness(async (notifications) => {
    const { default: register } = await loadExtension();
    const pi = fakePi();
    register(pi);
    const ctx = context();

    const first = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "rm -rf /tmp/permission-gate-test" } },
      ctx,
    );

    assert.equal(first, undefined);
    assert.deepEqual(ctx.notices, [{
      message: "YOLO armed for this session (cwd: ~). Dangerous commands auto-approve; hard-deny still enforced.",
      level: "info",
    }]);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].params.body, /rm -rf \/tmp\/permission-gate-test/);

    const second = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "sudo ls /tmp" } },
      ctx,
    );

    assert.equal(second, undefined);
    assert.equal(ctx.selectCount, 1, "later dangerous commands in the armed cwd should not prompt again");

    const hardDenied = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "rm -rf /" } },
      ctx,
    );
    assert.equal(hardDenied?.block, true, "YOLO must not bypass the hard-deny floor");
    assert.equal(ctx.selectCount, 1, "hard-denied commands must not show an approval dialog");
  });
});

test("does not notify when a command is blocked without waiting for approval", async () => {
  await withHarness(async (notifications) => {
    const { default: register } = await loadExtension();
    const pi = fakePi();
    register(pi);
    const ctx = context({ hasUI: false });

    const result = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "rm -rf /tmp/permission-gate-test" } },
      ctx,
    );

    assert.equal(result?.block, true);
    const hardDenied = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "rm -rf /" } },
      ctx,
    );
    assert.equal(hardDenied?.block, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(notifications.length, 0);
  });
});

test("the /yolo command and dialog choice show the same armed message", async () => {
  await withHarness(async () => {
    const { default: register } = await loadExtension();
    const pi = fakePi();
    register(pi);
    const ctx = context();

    await pi.commands.get("yolo").handler("", ctx);
    const commandNotice = ctx.notices.at(-1);

    await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "rm -rf /tmp/permission-gate-test" } },
      ctx,
    );
    const dialogNotice = ctx.notices.at(-1);

    assert.equal(dialogNotice.message, commandNotice.message);
    assert.equal(dialogNotice.level, commandNotice.level);
  });
});

test("YOLO chosen in the dialog remains scoped to the armed cwd", async () => {
  await withHarness(async () => {
    const { default: register } = await loadExtension();
    const pi = fakePi();
    register(pi);
    const ctx = context({ choice: "No — block it" });

    await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "rm -rf /tmp/permission-gate-test" } },
      ctx,
    );
    ctx.cwd = "/tmp";
    const outsideScope = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "sudo ls /tmp" } },
      ctx,
    );

    assert.equal(outsideScope?.block, true, "a command outside the armed cwd still requires approval");
    assert.equal(ctx.selectCount, 2, "the command outside the armed cwd should show a fresh approval dialog");
  });
});

test("permission-gate.yolo=true in settings.json auto-approves without a dialog, for any cwd", async () => {
  await withHarness(async (notifications, home) => {
    await writeSettings(home, { "permission-gate": { yolo: true } });
    const { default: register } = await loadExtension();
    const pi = fakePi();
    register(pi);
    const ctx = context({ cwd: "/tmp" });

    const armed = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "sudo ls /tmp" } },
      ctx,
    );
    assert.equal(armed, undefined, "settings YOLO is machine-wide, not cwd-scoped");
    assert.equal(ctx.selectCount, 0, "settings YOLO must not prompt");

    await pi.commands.get("yolo").handler("status", ctx);
    assert.match(ctx.notices.at(-1).message, /settings\.json permission-gate\.yolo/);

    const hardDenied = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "rm -rf /" } },
      ctx,
    );
    assert.equal(hardDenied?.block, true, "settings YOLO must not bypass the hard-deny floor");

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(notifications.length, 0);
  });
});

test("/yolo off overrides permission-gate.yolo=true for the rest of the session", async () => {
  await withHarness(async (_notifications, home) => {
    await writeSettings(home, { "permission-gate": { yolo: true } });
    const { default: register } = await loadExtension();
    const pi = fakePi();
    register(pi);
    const ctx = context({ choice: "No — block it" });

    await pi.commands.get("yolo").handler("off", ctx);

    const result = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "rm -rf /tmp/permission-gate-test" } },
      ctx,
    );
    assert.equal(result?.block, true, "a disarmed session must ask again");
    assert.equal(ctx.selectCount, 1);
  });
});

test("permission-gate.yolo=false leaves the gate armed", async () => {
  await withHarness(async (_notifications, home) => {
    await writeSettings(home, { "permission-gate": { yolo: false } });
    const { default: register } = await loadExtension();
    const pi = fakePi();
    register(pi);
    const ctx = context({ choice: "No — block it" });

    const result = await pi.handlers.get("tool_call")(
      { toolName: "bash", input: { command: "sudo ls /tmp" } },
      ctx,
    );
    assert.equal(result?.block, true);
    assert.equal(ctx.selectCount, 1, "yolo:false must still prompt");
  });
});
