import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { createReportPanels, renderReportWidget } from "../backend/report-panels.js";

const panel = {
  title: "Выберите выезд",
  details: ["Заключительный"],
  stage: 0,
  rows: [[{ text: "1. Выезд", callback_data: "pick_i0_0" }]],
  cards: {
    pick_i0_0: {
      title: 'Проверка макета <script>',
      project: "ЖК «Речной квартал»",
      warning: "Нет предварительной фиксации",
    },
  },
};
const nonce = "0123456789abcdef";

test("widget escapes trip data and fits Telegram limits", () => {
  const { html } = renderReportWidget(panel, nonce);
  assert.match(html, /Проверка макета &lt;script&gt;/);
  assert.match(html, /Проект · ЖК «Речной квартал»/);
  assert.match(html, /Нет предварительной фиксации/);
  assert.match(html, /answer\.result/);
  assert.ok(Buffer.byteLength(html) < 32768);
  assert.ok(deflateSync(html, { level: 9 }).length < 4096);
});

test("one current private widget can consume an action only once", async () => {
  const session = { step: "picktrip", data: {}, media: [] };
  const responses = [];
  const panels = createReportPanels({
    async tg(method, params) {
      if (method === "sendWidget") return { message_id: 17 };
      responses.push(params.data);
    },
    fallback() { assert.fail("unexpected fallback"); },
    warn() { assert.fail("unexpected warning"); },
  });
  await panels.send(13, session, panel);
  const query = {
    id: "q", from: { id: 13 }, chat: { id: 13, type: "private" },
    message_id: 17, type: { type: "data" },
    data: "bmreport:" + session.reportWidget.nonce + ":0",
  };
  assert.equal(await panels.receive(query, session, false), null);
  assert.equal(await panels.receive({ ...query, chat: { id: -17, type: "group" } }, session, true), null);
  assert.equal(await panels.receive({ ...query, message_id: 16 }, session, true), null);
  assert.equal(await panels.receive(query, { ...session, step: "checklist" }, true), null);
  assert.equal((await panels.receive(query, session, true)).callback_data, "pick_i0_0");
  assert.equal(await panels.receive(query, session, true), null);
  assert.equal(responses[0], "Откройте последнее сообщение бота.");
});

test("classic recovery preserves the active draft and attachment list", async () => {
  const files = [{ messageId: 21 }];
  const session = { step: "confirm", data: { tripId: "test" }, media: files };
  const calls = [];
  const panels = createReportPanels({
    async tg() { return { message_id: 17 }; },
    fallback(...args) { calls.push(args); },
    warn() {},
  });
  await panels.send(13, session, panel);
  assert.equal(await panels.resumeClassic(13, session), true);
  assert.equal(session.classicReport, true);
  assert.equal(session.reportWidget, undefined);
  assert.equal(session.media, files);
  assert.equal(session.data.tripId, "test");
  assert.deepEqual(calls[0], [13, panel.title, panel.details, panel.rows]);
});

test("unavailable widgets and very long panels keep the native actions", async () => {
  const native = [];
  const panels = createReportPanels({
    async tg() { throw Error("unsupported method"); },
    fallback(...args) { native.push(args); },
    warn() {},
  });
  const session = { step: "picktrip" };
  await panels.send(13, session, panel);
  await panels.send(13, session, { ...panel, details: ["Длинная задача ".repeat(350)] });
  assert.deepEqual(native.map(call => call[3]), [panel.rows, panel.rows]);
  assert.equal(session.reportWidget, undefined);
});
