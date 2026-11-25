import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../backend/server.js", import.meta.url), "utf8");
const entry = source.slice(source.indexOf("async function startReport("), source.indexOf("// Показ чек-листа"));
const callbacks = source.slice(source.indexOf("async function handleCallback("), source.indexOf("\nasync function handleUpdate("));
const user = { id: 900001 };
const chat = { id: user.id, type: "private" };

function fixture({ profile = { fio: "Сотрудник Стенда" }, failAck = false } = {}) {
  const next = [];
  const sent = [];
  const telegram = [];
  let session = { step: "idle", data: {}, media: [] };
  const context = vm.createContext({
    BOT_USERNAME: "fixturebot", TARGET_CHAT_ID: "-1000000000011", tripCards: null,
    reportOutbox: { seriesDraft: () => null },
    bmEnabled: () => true, bmGetProfile: async () => profile, isAllowed: id => id === user.id,
    getSession: () => session, resetSession: () => (session = { step: "idle", data: {}, media: [] }),
    sendTypeMenu: async () => next.push("menu"),
    sendMessage: async (chatId, text) => sent.push({ chatId, text }),
    offerTripChoice: async (chatId, draft) => {
      next.push({ chatId, type: draft.data.reportType, classic: draft.classicReport });
      draft.step = "picktrip";
    },
    taskCallback: /^task:/,
    tg: async (method, payload) => {
      telegram.push({ method, payload });
      if (failAck) throw Error("query is too old");
    },
    logEvent() {},
  });
  vm.runInContext(entry + "\n" + callbacks, context);
  return { next, sent, telegram, session: () => session, context };
}

function press(fixture, data, sourceChat = chat) {
  return fixture.context.handleCallback({ id: "old", from: user, data,
    message: { message_id: 42, chat: sourceChat } });
}

test("preliminary opens the list after a restart even if Telegram refuses the acknowledgement", async () => {
  const f = fixture({ failAck: true });
  await press(f, "type_pre");
  assert.deepEqual(f.next, [{ chatId: chat.id, type: "pre", classic: true }]);
  assert.equal(f.session().profileFio, "Сотрудник Стенда");
});

test("pressing an old report button leaves an active report and its media intact", async () => {
  const f = fixture();
  const existing = f.session();
  existing.step = "media";
  existing.data.reportType = "final";
  existing.media.push({ messageId: 73 });
  await press(f, "type_pre");
  assert.equal(f.session(), existing);
  assert.equal(existing.data.reportType, "final");
  assert.equal(existing.media[0].messageId, 73);
  assert.deepEqual(f.next, []);
  assert.match(f.sent[0].text, /Отчёт уже открыт/);
});

test("after a restart report selection survives the first-time profile prompt", async () => {
  const f = fixture({ profile: null });
  await press(f, "type_pre");
  assert.equal(f.session().step, "register_fio");
  assert.equal(f.session().pendingReportType, "pre");
  assert.match(f.sent[0].text, /ФИО/);
});

test("an old classic-menu button reopens the private menu", async () => {
  const f = fixture();
  await press(f, "report_classic");
  assert.deepEqual(f.next, ["menu"]);
  assert.equal(f.session().classicReport, true);
});

test("a report button in the work group opens the private report through a Telegram start link", async () => {
  const f = fixture();
  await press(f, "type_pre", { id: -1000000000011, type: "supergroup" });
  assert.equal(f.telegram[0].payload.url, "https://t.me/fixturebot?start=report_pre");
  assert.deepEqual(f.next, []);
  assert.deepEqual(f.sent, []);
});
