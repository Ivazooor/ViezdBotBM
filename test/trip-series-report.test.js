import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../backend/server.js", import.meta.url), "utf8");
const submit = source.slice(source.indexOf("async function submitReport("), source.indexOf("// ===== Обработка обычных сообщений"));
const user = { id: 900001, first_name: "Сотрудник" };

function fixture({ refuse, telegramUnknown, failFinalQueue } = {}) {
  const events = [];
  const drafts = new Map();
  const session = {
    data: { tripId: "trip_series_20270104", seriesRevision: "revision", tripName: "Тестовый выезд",
      reportType: failFinalQueue ? "final" : "prelim", visitDate: "2027-01-01", responsible: "Устаревшее имя", tripTasks: "Проверить свет" },
    media: [{ chatId: user.id, messageId: 11, kind: "photo" }],
  };
  const context = vm.createContext({
    getSession: () => session, bmEnabled: () => true, confirmKeyboard: {},
    reportOutbox: {
      seriesDraft: id => drafts.get(id),
      saveSeriesDraft: (id, draft) => drafts.set(id, structuredClone(draft)),
      removeSeriesDraft: id => drafts.delete(id),
      queueReport: () => { throw Error("ENOSPC"); },
    },
    randomBytes: () => Buffer.alloc(16, 18),
    bmApi: async (_method, body) => {
      events.push({ op: body.op, body });
      if (refuse) throw Object.assign(Error("Назначение изменилось"), { code: "trip_series_assignment_changed", permanent: true });
      return { date: "2027-01-04", responsible: "Текущий ответственный" };
    },
    offerTripChoice: () => events.push({ op: "refresh" }),
    showReportStep: (_chat, _session, title) => events.push({ op: "step", title }),
    reportTypeLabel: () => "Предварительный", detailsLines: () => "", senderName: () => user.first_name,
    TARGET_CHAT_ID: "-10012345",
    tg: async (method, params, _, retryNetwork) => {
      events.push({ op: method, params, retryNetwork });
      if (telegramUnknown) throw Object.assign(Error("timeout"), { uncertain: true });
      return { message_id: method === "sendMessage" ? 21 : 22 };
    },
    postReportWithOutbox: async (payload, fallback) => events.push({ op: "index", payload, fallback }),
    buildVisitPdf: async () => Buffer.from("%PDF-1.4"),
    sendDocument: async () => events.push({ op: "sendDocument" }),
    pdfFilename: () => "test.pdf", BRAND: {}, PDF_MAX_PHOTOS: 1, PDF_UPLOAD_LIMIT_BYTES: 10000,
    sendMessage: async () => {}, sleep: async () => {}, logEvent: () => {},
    resetSession: () => {},
  });
  vm.runInContext(submit, context);
  return { events, run: () => context.submitReport(user.id, user.id, user) };
}

test("a changed series assignment stops a report before Telegram publication", async () => {
  const f = fixture({ refuse: true });
  await f.run();
  assert.deepEqual(f.events.map(event => event.op), ["reserve_series_report", "refresh"]);
});

test("a series report uses the reserved date and queues its complete CRM operation", async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.events.map(event => event.op), ["reserve_series_report", "sendMessage", "copyMessage", "index"]);
  const [reserve, header, copy, index] = f.events;
  assert.equal(reserve.body.uid, String(user.id));
  assert.equal(header.retryNetwork, false);
  assert.equal(copy.retryNetwork, false);
  assert.match(header.params.text, /2027-01-04/);
  assert.match(header.params.text, /Текущий ответственный/);
  assert.equal(index.payload.report.visitDate, "2027-01-04");
  assert.equal(index.payload.seriesClaimId, reserve.body.seriesClaimId);
  assert.equal(index.payload.op, "preliminary");
  assert.equal(index.fallback, null);
});

test("an uncertain Telegram publication is not attempted a second time", async () => {
  const f = fixture({ telegramUnknown: true });
  await f.run();
  await f.run();
  assert.deepEqual(f.events.map(event => event.op), ["reserve_series_report", "sendMessage", "step", "step"]);
});

test("an unsaved final stage stops before PDF publication and preserves the checkpoint", async () => {
  const f = fixture({ failFinalQueue: true });
  await f.run();
  assert.deepEqual(f.events.map(event => event.op), ["reserve_series_report", "sendMessage", "copyMessage", "step"]);
  await f.run();
  assert.deepEqual(f.events.map(event => event.op), [
    "reserve_series_report", "sendMessage", "copyMessage", "step", "reserve_series_report", "step",
  ]);
});
