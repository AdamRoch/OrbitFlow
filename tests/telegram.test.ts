import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate, pool, query } from "../src/server/db.js";
import { enqueue, getRun, approve, cancel } from "../src/server/engine.js";
import { defaultAgent } from "../src/server/seed.js";
import { startIntegrations } from "../src/server/integrations.js";
import { createTelegramMenu } from "../src/server/telegram-menu.js";
import {
  parseTelegramCommand,
  type TelegramMarkup,
} from "../src/server/telegram-ui.js";
import type { Run, RunDetail, Workflow } from "../src/shared/types.js";

const target = new URL(
  process.env.DATABASE_URL ?? "http://unconfigured.invalid",
);
if (
  !["postgres:", "postgresql:"].includes(target.protocol) ||
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.port !== "54329" ||
  target.username !== "orbitflow" ||
  target.pathname !== "/orbitflow"
)
  throw Error(
    "Telegram database tests require the isolated orbitflow verification database; use npm test",
  );

type Reply = { text: string; markup?: TelegramMarkup };
async function fixture() {
  const prefix = `telegram-test-${randomUUID()}`;
  const chatId = String(Math.floor(Math.random() * 1e9));
  const agents = [
    defaultAgent(`${prefix}-builder`, "Builder", "Builder", "Build an app."),
    defaultAgent(`${prefix}-guide`, "Guide", "Guide", "Talk to Adam."),
  ];
  agents[1].telegram = true;
  const workflow: Workflow = {
    id: `${prefix}-build`,
    name: "Build an application",
    description: "A browser app with review",
    entryNode: "build",
    nodes: [
      {
        id: "build",
        agentId: agents[0].id,
        label: "Build",
        x: 0,
        y: 0,
        terminalOutcomes: ["done"],
      },
    ],
    edges: [],
  };
  const improve = {
    ...workflow,
    id: `${prefix}-improve`,
    name: "Improve an application",
    requiresSource: true,
  };
  const workflowIds = [workflow.id, improve.id];
  const runIds: string[] = [],
    keys = new Set<string>();
  const replies = new Map<string, Reply>();
  const submitted: Parameters<typeof enqueue>[0][] = [];
  let sequence = 0;
  for (const agent of agents)
    await query("INSERT INTO agents(id,data) VALUES($1,$2)", [agent.id, agent]);
  for (const value of [workflow, improve])
    await query("INSERT INTO workflows(id,data) VALUES($1,$2)", [
      value.id,
      value,
    ]);
  const trackedQuery = async <T>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> => {
    if (sql.startsWith("INSERT INTO integration_state"))
      keys.add(String(values[0]));
    return query<T>(sql, values);
  };
  const getState = async <T>(key: string): Promise<T | null> =>
    (
      await query<{ value: T }>(
        "SELECT value FROM integration_state WHERE key=$1",
        [key],
      )
    )[0]?.value ?? null;
  const setState = async (key: string, value: unknown) => {
    await trackedQuery(
      "INSERT INTO integration_state(key,value) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [key, JSON.stringify(value)],
    );
  };
  const dependencies = {
    query: trackedQuery,
    listAgents: async () => structuredClone(agents),
    enqueue: async (input: Parameters<typeof enqueue>[0]) => {
      submitted.push(input);
      const run = await enqueue(input);
      if (!runIds.includes(run.id)) runIds.push(run.id);
      return run;
    },
    approve,
    cancel,
    getRun,
    log: async () => {},
  };
  const menuDeps = {
    ...dependencies,
    getState,
    setState,
    deleteState: async (key: string) => {
      await query("DELETE FROM integration_state WHERE key=$1", [key]);
    },
    queueOutbound: async (
      key: string,
      _chatId: string,
      text: string,
      markup?: TelegramMarkup,
    ) => {
      if (!replies.has(key)) replies.set(key, { text, markup });
    },
    rememberRun: async (chat: string, run: Run) => {
      await setState(`telegram.run:${run.id}`, {
        chatId: chat,
        lastNotice: null,
      });
    },
    publicOrigin: "https://orbitflow.example.com",
  };
  let menu = createTelegramMenu(menuDeps);
  const latest = () => [...replies.values()].at(-1)!;
  const command = (text: string, id = ++sequence) =>
    menu.command(chatId, id, parseTelegramCommand(text));
  const data = (label: string) => {
    const button = latest()
      .markup?.inline_keyboard.flat()
      .find((b) => b.text === label);
    assert.ok(
      button && "callback_data" in button,
      `Missing button ${label}: ${JSON.stringify(latest())}`,
    );
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
    return button.callback_data;
  };
  const click = async (label: string) =>
    menu.callback(chatId, ++sequence, data(label));
  async function readyPrompt(name = workflow.name) {
    await command("/workflows");
    await click(name);
    await click("Start workflow");
  }
  async function run(owned = true) {
    const value = await dependencies.enqueue({
      workflowId: workflow.id,
      prompt: `Fixture ${runIds.length}`,
    });
    if (owned)
      await setState(`telegram.run:${value.id}`, { chatId, lastNotice: null });
    return value;
  }
  async function approval(approved = false) {
    const value = await run();
    const revisionId = randomUUID(),
      approvalToken = randomUUID();
    await query(
      "INSERT INTO revisions(id,run_id,files,approved) VALUES($1,$2,$3,$4)",
      [
        revisionId,
        value.id,
        { "index.html": "<h1>Retained source</h1>" },
        approved,
      ],
    );
    await query(
      "UPDATE runs SET data=data||$2::jsonb,snapshot=snapshot||$3::jsonb WHERE id=$1",
      [
        value.id,
        JSON.stringify({
          status: approved ? "completed" : "awaiting_approval",
          revisionId,
        }),
        JSON.stringify({ approvalKind: "release", approvalToken }),
      ],
    );
    return (await getRun(value.id))!;
  }
  return {
    chatId,
    agents,
    workflow,
    improve,
    workflowIds,
    runIds,
    keys,
    submitted,
    replies,
    latest,
    command,
    data,
    click,
    readyPrompt,
    run,
    approval,
    dependencies,
    getState,
    setState,
    restart: () => {
      menu = createTelegramMenu(menuDeps);
    },
    callback: (data: string, otherChat = chatId) =>
      menu.callback(otherChat, ++sequence, data),
    card: async (detail: RunDetail) =>
      menu.runCard(`card:${++sequence}`, chatId, detail),
    cleanup: async () => {
      await query("DELETE FROM integration_state WHERE key=ANY($1::text[])", [
        [...keys],
      ]);
      await query("DELETE FROM events WHERE run_id=ANY($1::text[])", [runIds]);
      await query("DELETE FROM messages WHERE run_id=ANY($1::text[])", [
        runIds,
      ]);
      await query("DELETE FROM revisions WHERE run_id=ANY($1::text[])", [
        runIds,
      ]);
      await query("DELETE FROM runs WHERE id=ANY($1::text[])", [runIds]);
      await query("DELETE FROM workflows WHERE id=ANY($1::text[])", [
        workflowIds,
      ]);
      await query("DELETE FROM agents WHERE id=ANY($1::text[])", [
        agents.map((a) => a.id),
      ]);
    },
  };
}

test("Telegram navigation and actions with PostgreSQL; no model or Telegram calls", async (t) => {
  const schema = `telegram_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  try {
    await migrate();
    await t.test(
      "browse current workflows and agent models without starting or reconfiguring anything",
      async () => {
        const f = await fixture();
        try {
          await f.command("/start");
          assert.match(f.latest().text, /Default chat: Guide/);
          await f.click("Workflows");
          await f.click(f.workflow.name);
          assert.match(f.latest().text, /Start → Build: Builder/);
          assert.ok(f.latest().text.includes(f.agents[0].model));
          await f.click("Agents");
          await f.click("Builder");
          assert.match(f.latest().text, /Direct Telegram chat is not enabled/);
          assert.deepEqual(
            (
              await query<{ data: unknown }>(
                "SELECT data FROM agents WHERE id=$1",
                [f.agents[1].id],
              )
            )[0].data,
            f.agents[1],
          );
          assert.equal(f.submitted.length, 0);
        } finally {
          await f.cleanup();
        }
      },
    );
    await t.test(
      "guided workflow persists across restart and duplicate delivery enqueues once",
      async () => {
        const f = await fixture();
        try {
          await f.readyPrompt();
          assert.match(f.latest().text, /Waiting for: Build an application/);
          f.restart();
          assert.equal(await f.command("Create a checklist", 900), true);
          assert.equal(await f.command("Create a checklist", 900), true);
          assert.equal(f.submitted.length, 1);
          const detail = (await getRun(f.runIds[0]))!;
          assert.equal(detail.executionSnapshot.workflow?.id, f.workflow.id);
          assert.equal(detail.messages[0].from, "telegram");
          await f.command("/runs");
          await f.click("queued · Create a checklist");
          assert.doesNotMatch(f.latest().text, /Waiting for/);
          assert.ok(
            f
              .latest()
              .markup?.inline_keyboard.flat()
              .some(
                (b) => "url" in b && b.url.endsWith(`/?run=${detail.run.id}`),
              ),
          );
          assert.equal(await f.command("ordinary conversation", 901), false);
        } finally {
          await f.cleanup();
        }
      },
    );
    await t.test(
      "workflow and model changes invalidate both old start buttons and pending prompts",
      async () => {
        const f = await fixture();
        try {
          await f.command("/workflows");
          await f.click(f.workflow.name);
          const start = f.data("Start workflow");
          f.agents[0].model = "openrouter/changed-model";
          await f.callback(start);
          assert.ok(
            [...f.replies.values()].some((r) => /agents changed/.test(r.text)),
          );
          assert.equal(await f.command("still ordinary chat"), false);
          await f.click("Start workflow");
          f.agents[0].model = "openrouter/another-model";
          assert.equal(await f.command("Build it"), true);
          assert.match(f.latest().text, /request was not started/);
          assert.equal(f.submitted.length, 0);
          await f.readyPrompt();
          const pending = await f.getState<Record<string, unknown>>(
            `telegram.pending:${f.chatId}`,
          );
          await f.setState(`telegram.pending:${f.chatId}`, {
            ...pending,
            expiresAt: "2000-01-01T00:00:00Z",
          });
          assert.equal(await f.command("Expired request"), true);
          assert.match(f.latest().text, /not sent to an agent/);
        } finally {
          await f.cleanup();
        }
      },
    );
    await t.test(
      "improve lets you choose an approved source and retains its files",
      async () => {
        const f = await fixture();
        try {
          const source = await f.approval(true);
          await f.approval(false);
          await f.command("/improve");
          await f.click(`${f.improve.name} · Improve`);
          await f.click("Choose approved application");
          const options = f
            .latest()
            .markup!.inline_keyboard.flat()
            .filter((b) => b.text.includes("Fixture"));
          assert.equal(options.length, 1);
          await f.click(options[0].text);
          assert.match(f.latest().text, /Selected application: Fixture 0/);
          await f.command("Add a search field");
          const input = f.submitted.at(-1)!;
          assert.equal(input.parentRunId, source.run.id);
          assert.equal(input.workflowId, f.improve.id);
          const snapshot = (
            await query<{ snapshot: { files: Record<string, string> } }>(
              "SELECT snapshot FROM runs WHERE id=$1",
              [f.runIds.at(-1)],
            )
          )[0].snapshot;
          assert.equal(
            snapshot.files["index.html"],
            "<h1>Retained source</h1>",
          );
        } finally {
          await f.cleanup();
        }
      },
    );
    await t.test(
      "outdated approvals and feedback never approve a different revision",
      async () => {
        const f = await fixture();
        try {
          const detail = await f.approval();
          await f.card(detail);
          const oldApproval = f.data("Approve revision");
          await f.click("Request changes");
          await query(
            "UPDATE runs SET snapshot=snapshot||$2::jsonb WHERE id=$1",
            [detail.run.id, JSON.stringify({ approvalToken: randomUUID() })],
          );
          await f.command("Fix keyboard navigation");
          assert.match(f.latest().text, /feedback was not submitted/);
          await f.callback(oldApproval);
          assert.match(f.latest().text, /approval button is outdated/);
          assert.equal(
            (await getRun(detail.run.id))!.run.status,
            "awaiting_approval",
          );
          await f.click("Request changes");
          await f.command("Fix keyboard navigation", 950);
          await f.command("Fix keyboard navigation", 950);
          const updated = (await getRun(detail.run.id))!;
          assert.equal(updated.run.status, "queued");
          assert.equal(
            updated.messages.filter((m) => m.kind === "approval").length,
            1,
          );
        } finally {
          await f.cleanup();
        }
      },
    );
    await t.test(
      "approval is single-use; cancelling a draft and stopping a run are distinct",
      async () => {
        const f = await fixture();
        try {
          const detail = await f.approval();
          await f.card(detail);
          const approval = f.data("Approve revision");
          await f.callback(approval);
          await f.callback(approval);
          assert.equal((await getRun(detail.run.id))!.run.status, "completed");
          assert.equal(
            (await getRun(detail.run.id))!.messages.filter(
              (m) => m.kind === "approval",
            ).length,
            1,
          );
          const running = await f.run();
          await f.readyPrompt();
          await f.command("/cancel");
          assert.equal((await getRun(running.id))!.run.status, "queued");
          assert.equal(await f.command("Normal chat again"), false);
          await f.card((await getRun(running.id))!);
          await f.click("Stop run");
          assert.equal((await getRun(running.id))!.run.status, "queued");
          await f.click("Yes, stop run");
          assert.equal((await getRun(running.id))!.run.status, "cancelled");
        } finally {
          await f.cleanup();
        }
      },
    );
    await t.test(
      "chat-bound buttons, expired callbacks, and run ownership are enforced",
      async () => {
        const f = await fixture();
        try {
          const owned = await f.run(),
            other = await f.run(false);
          await f.command(`/status ${other.id}`);
          assert.match(f.latest().text, /does not belong/);
          await f.card((await getRun(owned.id))!);
          const stop = f.data("Stop run");
          await f.callback(stop, "different-chat");
          assert.match(f.latest().text, /expired or is unavailable/);
          const stateKey = `telegram.button:${stop.slice(3)}`;
          const saved = await f.getState<Record<string, unknown>>(stateKey);
          await f.setState(stateKey, {
            ...saved,
            expiresAt: "2000-01-01T00:00:00Z",
          });
          await f.callback(stop);
          assert.match(f.latest().text, /expired or is unavailable/);
          await f.command("/runs");
          assert.equal(
            f
              .latest()
              .markup!.inline_keyboard.flat()
              .filter((b) => b.text.includes("Fixture")).length,
            1,
          );
          assert.equal((await getRun(owned.id))!.run.status, "queued");
        } finally {
          await f.cleanup();
        }
      },
    );
    await t.test(
      "menus paginate without losing agent or workflow identities",
      async () => {
        const f = await fixture();
        try {
          for (let i = 0; i < 7; i++) {
            const w = {
              ...f.workflow,
              id: `${f.workflow.id}-${i}`,
              name: `Extra ${i}`,
            };
            f.workflowIds.push(w.id);
            await query("INSERT INTO workflows(id,data) VALUES($1,$2)", [
              w.id,
              w,
            ]);
          }
          await f.command("/workflows");
          await f.click("Next");
          assert.match(f.latest().text, /page 2/);
          await f.click("Extra 6");
          assert.match(f.latest().text, /^Extra 6/);
          await f.click("Start workflow");
          await f.command("Only this workflow");
          assert.equal(f.submitted[0].workflowId, `${f.workflow.id}-6`);
        } finally {
          await f.cleanup();
        }
      },
    );
    await t.test(
      "transport stub: registers menu, acknowledges callbacks, retains markup, ignores foreign chats and duplicates",
      async () => {
        const f = await fixture();
        const originalFetch = globalThis.fetch;
        const prior = {
          token: process.env.TELEGRAM_BOT_TOKEN,
          chat: process.env.TELEGRAM_CHAT_ID,
        };
        let service: ReturnType<typeof startIntegrations> | undefined;
        const requests: { method: string; body: any }[] = [];
        try {
          await f.command("/workflows");
          const selected = f.data(f.workflow.name);
          process.env.TELEGRAM_BOT_TOKEN = "fixture-token";
          process.env.TELEGRAM_CHAT_ID = f.chatId;
          let first = true;
          globalThis.fetch = async (input, init) => {
            const url = String(input);
            assert.ok(
              url.startsWith("https://api.telegram.org/botfixture-token/"),
            );
            const method = url.split("/").at(-1)!;
            const body = JSON.parse(String(init?.body));
            requests.push({ method, body });
            let result: unknown = true;
            if (method === "getUpdates") {
              result = first
                ? [
                    {
                      update_id: 1,
                      message: {
                        chat: { id: "foreign" },
                        text: `/build ${f.workflow.id} forbidden`,
                      },
                    },
                    {
                      update_id: 2,
                      message: { chat: { id: f.chatId }, text: "/start" },
                    },
                    {
                      update_id: 3,
                      callback_query: {
                        id: "foreign-callback",
                        data: selected,
                        message: { chat: { id: "foreign" } },
                      },
                    },
                    {
                      update_id: 4,
                      callback_query: {
                        id: "valid-callback",
                        data: selected,
                        message: { chat: { id: f.chatId } },
                      },
                    },
                    {
                      update_id: 4,
                      callback_query: {
                        id: "duplicate",
                        data: selected,
                        message: { chat: { id: f.chatId } },
                      },
                    },
                  ]
                : [];
              first = false;
            }
            return new Response(JSON.stringify({ ok: true, result }), {
              status: 200,
            });
          };
          service = startIntegrations(f.dependencies);
          for (
            let i = 0;
            i < 100 &&
            requests.filter((r) => r.method === "sendMessage").length < 2;
            i++
          )
            await new Promise((resolve) => setTimeout(resolve, 20));
          await service.stop();
          service = undefined;
          assert.ok(
            requests.some(
              (r) =>
                r.method === "setMyCommands" &&
                r.body.scope.chat_id === f.chatId &&
                r.body.commands.some((c: any) => c.command === "workflows"),
            ),
          );
          assert.deepEqual(
            requests
              .filter((r) => r.method === "answerCallbackQuery")
              .map((r) => r.body.callback_query_id),
            ["foreign-callback", "valid-callback"],
          );
          const sends = requests.filter((r) => r.method === "sendMessage");
          assert.equal(sends.length, 2);
          assert.ok(
            sends.every(
              (r) =>
                r.body.chat_id === f.chatId &&
                r.body.reply_markup.inline_keyboard.length,
            ),
          );
          assert.equal(f.submitted.length, 0);
          const outbound = await query<{
            value: { sent: boolean; markup: unknown };
          }>("SELECT value FROM integration_state WHERE key LIKE $1", [
            `telegram.outbound:${f.chatId}%`,
          ]);
          assert.ok(outbound.every((r) => r.value.sent && r.value.markup));
          f.keys.add("telegram.offset");
        } finally {
          await service?.stop();
          globalThis.fetch = originalFetch;
          if (prior.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
          else process.env.TELEGRAM_BOT_TOKEN = prior.token;
          if (prior.chat === undefined) delete process.env.TELEGRAM_CHAT_ID;
          else process.env.TELEGRAM_CHAT_ID = prior.chat;
          await f.cleanup();
        }
      },
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
