import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createReportPanels, encodeReportPanel, reportWidgetHtml } from "../backend/report-panels.js";

const panel = {
  title: "Выберите выезд",
  details: ["Заключительный"],
  stage: 0,
  rows: [[{ text: "1. Выезд", callback_data: "pick_i0_0" }]],
  cards: {
    pick_i0_0: {
      title: "Проверка макета <script>",
      project: "ЖК «Речной квартал»",
      warning: "Нет предварительной фиксации",
    },
  },
};
const nonce = "0123456789abcdef";

function setup() {
  const calls = [];
  const classic = [];
  const panels = createReportPanels({
    async tg(method, params) {
      calls.push({ method, params });
      if (method === "sendWidget") return { message_id: 17, reply_markup: params.reply_markup };
      return true;
    },
    fallback(...args) { classic.push(args); },
    warn() {},
  });
  return { calls, classic, panels };
}

function query(session, index = 0, overrides = {}) {
  return {
    id: "q", from: { id: 13 }, chat: { id: 13, type: "private" },
    message_id: 17, type: { type: "data" },
    data: "bmreport:" + session.reportWidget.nonce + ":" + index,
    ...overrides,
  };
}

test("widget code stays fixed and receives safe text within Telegram limits", () => {
  const { chatData } = encodeReportPanel(panel, nonce);
  const [, , , , rows] = JSON.parse(chatData);
  assert.equal(rows[0][0][0], "Проверка макета <script>");
  assert.match(reportWidgetHtml, /element\.textContent = text/);
  assert.match(reportWidgetHtml, /chatDataChanged/);
  assert.doesNotMatch(reportWidgetHtml, /Проверка макета/);
  assert.ok(Buffer.byteLength(chatData) <= 1024);
  assert.ok(deflateSync(reportWidgetHtml, { level: 9 }).length <= 4096);
});

test("menu and next screen share one message, with no widget caption", async () => {
  const { calls, panels } = setup();
  const session = { step: "picktrip" };
  await panels.send(13, session, panel);
  const old = query(session);
  assert.equal(calls[0].method, "sendWidget");
  assert.ok(!("caption" in calls[0].params));
  assert.equal(calls[0].params.reply_markup.inline_keyboard[0][0].callback_data, "report_classic");
  assert.ok(await panels.receive(old, session, true));
  session.step = "checklist";
  await panels.send(13, session, { ...panel, title: "Перед началом работ" });
  const edit = calls.find(call => call.method === "editMessageWidgetData");
  assert.equal(edit.params.message_id, 17);
  assert.equal(JSON.parse(edit.params.chat_data)[2], "Перед началом работ");
  assert.equal(calls.filter(call => call.method === "sendWidget").length, 1);
  assert.equal(await panels.receive(old, session, true), null);
});

test("only a current private widget can consume an action", async () => {
  const { panels } = setup();
  const session = { step: "picktrip" };
  await panels.send(13, session, panel);
  const current = query(session);
  assert.equal(await panels.receive(current, session, false), null);
  assert.equal(await panels.receive({ ...current, chat: { id: -17, type: "group" } }, session, true), null);
  assert.equal(await panels.receive({ ...current, message_id: 16 }, session, true), null);
  assert.equal(await panels.receive(current, { ...session, step: "checklist" }, true), null);
  assert.equal((await panels.receive(current, session, true)).callback_data, "pick_i0_0");
  assert.equal(await panels.receive(current, session, true), null);
  assert.equal(session.reportWidget.messageId, 17);
});

test("long details page inside the same widget, preserving its actions", async () => {
  const { calls, panels } = setup();
  const session = { step: "confirm" };
  const long = { title: "Проверьте отчёт", stage: 3, rows: [[{ text: "Отправить", callback_data: "confirm_send" }]],
    details: ["Длинная задача ".repeat(75) + "Последняя строка."] };
  await panels.send(13, session, long);
  const initial = JSON.parse(calls[0].params.chat_data);
  assert.equal(initial[4][0][0][0], "Ещё текст →");
  await panels.receive(query(session), session, true);
  const edit = calls.find(call => call.method === "editMessageWidgetData");
  assert.equal(edit.params.message_id, 17);
  assert.ok(Buffer.byteLength(edit.params.chat_data) <= 1024);
  assert.ok(session.reportWidget.actions.some(action => action.callback_data === "confirm_send"));
});

test("classic recovery preserves the draft and attachments", async () => {
  const { classic, panels } = setup();
  const files = [{ messageId: 21 }];
  const session = { step: "confirm", data: { tripId: "test" }, media: files };
  await panels.send(13, session, panel);
  assert.equal(await panels.resumeClassic(13, session), true);
  assert.equal(session.classicReport, true);
  assert.equal(session.reportWidget, undefined);
  assert.equal(session.media, files);
  assert.equal(session.data.tripId, "test");
  assert.deepEqual(classic[0], [13, panel.title, panel.details, panel.rows]);
});

test("missing fallback keyboard falls back to a standard message", async () => {
  const native = [];
  const panels = createReportPanels({
    async tg() { return { message_id: 17 }; },
    fallback(...args) { native.push(args); },
    warn() {},
  });
  const session = { step: "picktrip" };
  await panels.send(13, session, panel);
  assert.equal(session.classicReport, true);
  assert.deepEqual(native[0][3], panel.rows);
});

test("a failed edit offers the current actions in the standard chat", async () => {
  const native = [];
  const panels = createReportPanels({
    async tg(method, params) {
      if (method === "sendWidget") return { message_id: 17, reply_markup: params.reply_markup };
      throw Error("message not found");
    },
    fallback(...args) { native.push(args); },
    warn() {},
  });
  const session = { step: "picktrip" };
  await panels.send(13, session, panel);
  await panels.send(13, session, { ...panel, title: "Следующий шаг" });
  assert.equal(session.classicReport, true);
  assert.deepEqual(native[0], [13, "Следующий шаг", panel.details, panel.rows]);
});
