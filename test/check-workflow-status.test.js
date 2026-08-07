const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("js-yaml");

// The logic under test lives in a github-script `script:` block, so read it out of
// the workflow and run it against a stubbed octokit.
const WORKFLOW = path.join(
  __dirname,
  "..",
  ".github",
  "workflows",
  "check-workflow-status.yml",
);
const script = yaml.load(fs.readFileSync(WORKFLOW, "utf8")).jobs[
  "wait-for-workflow"
].steps[0].with.script;

const NON_TERMINAL = [
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
];

/**
 * Run the script with the given inputs.
 * byStatus maps a run status to the total_count the API reports for it.
 */
async function run({ env = {}, byStatus = {}, throwStatus } = {}) {
  const calls = [];
  const failures = [];
  const logs = [];

  const github = {
    rest: {
      actions: {
        listWorkflowRuns: async (params) => {
          calls.push(params);
          if (throwStatus) {
            const error = new Error("request failed");
            error.status = throwStatus;
            throw error;
          }
          const total = byStatus[params.status] || 0;
          return {
            data: {
              total_count: total,
              // The API caps a page at per_page, while total_count spans every page.
              workflow_runs: Array.from(
                { length: Math.min(total, params.per_page || 100) },
                () => ({
                  name: "Merge to dev or hotfix",
                  status: params.status,
                  html_url: "https://github.test/run/1",
                }),
              ),
            },
          };
        },
        listWorkflowRunsForRepo: async () => {
          throw new Error(
            "the repo-level endpoint ignores workflow_id and must stay unused",
          );
        },
      },
    },
  };

  const context = { repo: { owner: "NexusMutual", repo: "demo" } };
  const core = { setFailed: (message) => failures.push(message) };

  const previousLog = console.log;
  console.log = (message) => logs.push(message);

  Object.assign(process.env, {
    WORKFLOW_NAME: "merge-to-dev-or-hotfix.yml",
    WORKFLOW_STATUS: "",
    CREATED_WITHIN_MINUTES: "0",
    FAIL_IF_EXISTS: "true",
    ERROR_MESSAGE: "Workflow is currently running.",
    ...env,
  });

  // The script body is the workflow file in this repo, and running it is the point of
  // the test. github, context and core arrive as arguments, the way github-script
  // supplies them.
  const fn = new Function(
    "github",
    "context",
    "core",
    `"use strict"; return (async () => {${script}})();`,
  );

  try {
    await fn(github, context, core);
  } finally {
    console.log = previousLog;
  }

  return { calls, failures, logs };
}

describe("check-workflow-status", () => {
  test("scopes the query to the named workflow", async () => {
    const { calls, failures } = await run({
      env: { WORKFLOW_STATUS: "in_progress" },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].workflow_id, "merge-to-dev-or-hotfix.yml");
    assert.equal(calls[0].status, "in_progress");
    assert.equal(failures.length, 0);
  });

  test("counts with total_count, which spans every page", async () => {
    const { failures } = await run({
      env: { WORKFLOW_STATUS: "in_progress" },
      byStatus: { in_progress: 250 },
    });
    assert.equal(failures.length, 1);
  });

  test("non-terminal asks for each unfinished status", async () => {
    const { calls, failures } = await run({
      env: { WORKFLOW_STATUS: "non-terminal" },
    });
    assert.deepEqual(
      calls.map((call) => call.status),
      NON_TERMINAL,
    );
    assert.equal(failures.length, 0);
  });

  for (const status of NON_TERMINAL) {
    test(`non-terminal catches a run that is ${status}`, async () => {
      const { failures } = await run({
        env: { WORKFLOW_STATUS: "non-terminal" },
        byStatus: { [status]: 1 },
      });
      assert.equal(failures.length, 1);
    });
  }

  test("non-terminal leaves finished runs alone", async () => {
    const { calls, failures } = await run({
      env: { WORKFLOW_STATUS: "non-terminal" },
      byStatus: { completed: 99 },
    });
    assert.ok(calls.every((call) => call.status !== "completed"));
    assert.equal(failures.length, 0);
  });

  test("an unrecognised status fails before any request", async () => {
    const { calls, failures } = await run({
      env: { WORKFLOW_STATUS: "in_progres" },
    });
    assert.match(failures[0], /Unknown workflow-status/);
    assert.equal(calls.length, 0);
  });

  test("created-within-minutes bounds every query", async () => {
    const { calls } = await run({
      env: { WORKFLOW_STATUS: "non-terminal", CREATED_WITHIN_MINUTES: "60" },
    });
    assert.ok(calls.every((call) => /^>=\d{4}-\d{2}-\d{2}T/.test(call.created)));
  });

  test("a window of zero sends no created filter", async () => {
    const { calls } = await run({ env: { WORKFLOW_STATUS: "non-terminal" } });
    assert.ok(calls.every((call) => call.created === undefined));
  });

  test("a missing workflow fails with a clear message", async () => {
    const { failures } = await run({
      env: { WORKFLOW_STATUS: "in_progress" },
      throwStatus: 404,
    });
    assert.match(failures[0], /not found/);
  });

  test("fail-if-exists false reports and continues", async () => {
    const { failures, logs } = await run({
      env: { WORKFLOW_STATUS: "in_progress", FAIL_IF_EXISTS: "false" },
      byStatus: { in_progress: 2 },
    });
    assert.equal(failures.length, 0);
    assert.match(logs.join("\n"), /Continuing as configured/);
  });

  test("error-message reaches the failure", async () => {
    const { failures } = await run({
      env: {
        WORKFLOW_STATUS: "in_progress",
        ERROR_MESSAGE: "Release blocked, retry later.",
      },
      byStatus: { in_progress: 1 },
    });
    assert.match(failures[0], /Release blocked, retry later\./);
  });
});
