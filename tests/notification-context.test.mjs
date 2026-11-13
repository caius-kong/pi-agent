import assert from "node:assert/strict";
import test from "node:test";

const extensionUrl = new URL("../agent/extensions/notify/index.ts", import.meta.url);

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

test("Herdr completion notifications identify the workspace, tab, and pane", async () => {
  const { resolveNotificationContext } = await import(extensionUrl);
  const calls = [];
  const run = async (_command, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify(
        args[0] === "workspace"
          ? { result: { workspace: { label: "payments-api" } } }
          : { result: { tab: { label: "tests" } } },
      ),
    };
  };
  assert.deepEqual(
    await resolveNotificationContext(
      { cwd: "/repo" },
      {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "w1",
        HERDR_TAB_ID: "w1:t2",
        HERDR_PANE_ID: "w1:p3",
      },
      run,
    ),
    {
      title: "Pi · payments-api / tests",
      body: "Run finished; ready for input · w1:p3",
    },
  );
  assert.deepEqual(calls.sort((a, b) => a[0].localeCompare(b[0])), [
    ["tab", "get", "w1:t2"],
    ["workspace", "get", "w1"],
  ]);
});

test("Herdr context falls back to stable ids if labels cannot be read", async () => {
  const { resolveNotificationContext } = await import(extensionUrl);
  assert.deepEqual(
    await resolveNotificationContext(
      { cwd: "/repo" },
      {
        HERDR_ENV: "1",
        HERDR_BIN_PATH: "/missing/herdr",
        HERDR_WORKSPACE_ID: "w4",
        HERDR_TAB_ID: "w4:t1",
        HERDR_PANE_ID: "w4:p2",
      },
      async () => { throw new Error("unavailable"); },
    ),
    {
      title: "Pi · w4 / w4:t1",
      body: "Run finished; ready for input · w4:p2",
    },
  );
});

test("non-Herdr completion notifications identify the project directory", async () => {
  const { resolveNotificationContext } = await import(extensionUrl);
  assert.deepEqual(
    await resolveNotificationContext(
      { cwd: "/work/payments-api" },
      {},
    ),
    {
      title: "Pi · payments-api",
      body: "Run finished; ready for input",
    },
  );
});
