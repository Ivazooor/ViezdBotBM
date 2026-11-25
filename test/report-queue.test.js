import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReportOutbox } from "../backend/report-outbox.js";
import { normalizeMessageIds, copyReportMessages } from "../backend/report-delivery.js";

function withOutbox(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visit-outbox-test-"));
  const file = path.join(dir, "outbox.json");
  try { return run(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("запрос CRM сохраняется до отправки и переживает перезапуск", () => withOutbox((file) => {
  const first = new ReportOutbox(file);
  const payload = { op: "attach_report", tripId: "trip1", report: { id: "m42" } };
  first.queueReport("m42", payload);
  const restarted = new ReportOutbox(file);
  assert.deepEqual(restarted.reportEntries()[0][1].payload, payload);
  restarted.removeReport("m42");
  assert.equal(new ReportOutbox(file).reportEntries().length, 0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}));

test("сбой при создании PDF не теряет уже скопированные медиа", () => withOutbox((file) => {
  const box = new ReportOutbox(file);
  const withoutPdf = { op: "create", report: { id: "m42", mediaMessageIds: [43], pdfMessageId: null } };
  box.queueReport("m42", withoutPdf, true);
  assert.equal(box.reportEntries()[0][1].staged, true);
  const restarted = new ReportOutbox(file);
  assert.equal(restarted.reportEntries()[0][1].staged, false);
  assert.deepEqual(restarted.reportEntries()[0][1].payload, withoutPdf);
}));

test("ID PDF сохраняется сразу после отправки в рабочий чат", () => withOutbox((file) => {
  const box = new ReportOutbox(file);
  box.queueReport("m42", { op: "attach_report", report: { id: "m42", pdfMessageId: null } }, true);
  box.queueReport("m42", { op: "attach_report", report: { id: "m42", pdfMessageId: 44 } }, true);
  const restarted = new ReportOutbox(file);
  assert.equal(restarted.reportEntries()[0][1].payload.report.pdfMessageId, 44);
  assert.equal(restarted.reportEntries()[0][1].staged, false);
}));

test("готовый PDF заменяет подготовленную запись до синхронизации", () => withOutbox((file) => {
  const box = new ReportOutbox(file);
  box.queueReport("m42", { op: "create", report: { id: "m42", pdfMessageId: null } }, true);
  box.queueReport("m42", { op: "create", report: { id: "m42", pdfMessageId: 44 } });
  assert.equal(new ReportOutbox(file).reportEntries()[0][1].payload.report.pdfMessageId, 44);
}));

test("потерянный ответ claim повторяется с тем же ID после перезапуска", () => withOutbox((file) => {
  const claimId = "a".repeat(24);
  const job = { id: "b".repeat(24), tgId: "123456", messageIds: [2, 3] };
  new ReportOutbox(file).setClaim(claimId);
  const restarted = new ReportOutbox(file);
  assert.equal(restarted.pendingClaimId(), claimId);
  restarted.saveClaimedJobs(claimId, [job]);
  assert.equal(new ReportOutbox(file).pendingClaimId(), null);
  assert.equal(new ReportOutbox(file).deliveryEntries()[0][1].started, false);
}));

test("состояние начала выдачи и ACK сохраняются до подтверждения CRM", () => withOutbox((file) => {
  const id = "b".repeat(24);
  const claimId = "a".repeat(24);
  const box = new ReportOutbox(file);
  box.setClaim(claimId);
  box.saveClaimedJobs(claimId, [{ id }]);
  box.markStarted(id);
  assert.equal(new ReportOutbox(file).deliveryEntries()[0][1].started, true);
  box.finishDelivery(id, { claimId, status: "unknown" });
  const restarted = new ReportOutbox(file);
  assert.equal(restarted.deliveryEntries().length, 0);
  assert.deepEqual(restarted.ackEntries()[0][1], { claimId, status: "unknown" });
  restarted.removeAck(id);
  assert.equal(new ReportOutbox(file).ackEntries().length, 0);
}));

test("повреждённую очередь нельзя незаметно заменить пустой", () => withOutbox((file) => {
  fs.writeFileSync(file, "{broken", { mode: 0o600 });
  assert.throws(() => new ReportOutbox(file));
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
}));

test("после пропуска файла в первой пачке доставляются следующие пачки", async () => {
  const ids = normalizeMessageIds(Array.from({ length: 201 }, (_, i) => 201 - i));
  const chunks = [];
  const result = await copyReportMessages(ids, async (chunk) => {
    chunks.push(chunk);
    return chunk[0] === 1 ? chunk.slice(1).map((message_id) => ({ message_id }))
      : chunk.map((message_id) => ({ message_id }));
  });
  assert.deepEqual(chunks.map((chunk) => chunk.length), [100, 100, 1]);
  assert.deepEqual(chunks.map((chunk) => chunk[0]), [1, 101, 201]);
  assert.deepEqual(result, { copiedCount: 200, totalCount: 201 });
});

test("после сбоя поздней пачки сохранён счётчик уже доставленных файлов", async () => {
  let copied = 0;
  await assert.rejects(copyReportMessages(
    Array.from({ length: 101 }, (_, i) => i + 1),
    async (chunk) => { if (chunk[0] === 101) throw new Error("сеть"); return chunk; },
    (count) => { copied = count; }
  ));
  assert.equal(copied, 100);
});

test("повторяющиеся или небезопасные message ID не отправляются", () => {
  assert.throws(() => normalizeMessageIds([7, 7]));
  assert.throws(() => normalizeMessageIds([0]));
  assert.throws(() => normalizeMessageIds([Number.MAX_SAFE_INTEGER + 1]));
});

test("ошибки ACK откладываются и не блокируют весь опрос очереди", () => withOutbox((file) => {
  const id = "b".repeat(24);
  const claimId = "a".repeat(24);
  const box = new ReportOutbox(file);
  box.setClaim(claimId);
  box.saveClaimedJobs(claimId, [{ id }]);
  box.finishDelivery(id, { claimId, status: "unknown" });
  box.deferAck(id);
  const ack = new ReportOutbox(file).ackEntries()[0][1];
  assert.equal(ack.status, "unknown");
  assert.equal(ack.attempts, 1);
  assert.ok(ack.retryAt > Date.now());
}));

test("полный отчёт и известный результат публикации переживают перезапуск", () => withOutbox((file) => {
  const id = "m42";
  const review = { reportId: id, tripId: null, tripName: "Макет" };
  const payload = { op: "create", kind: "final", workDone: "Установили блок", report: { id } };
  new ReportOutbox(file).queueReport(id, payload, true, review);

  const restarted = new ReportOutbox(file);
  assert.equal(restarted.reportEntry(id).staged, false);
  assert.deepEqual(restarted.reportEntry(id).payload, payload);
  restarted.recordFinalIndex(id, { id: "trip1" });
  restarted.setReviewDelivery(id, "sending");

  const afterLostResponse = new ReportOutbox(file).reportEntry(id);
  assert.equal(afterLostResponse.indexed, true);
  assert.equal(afterLostResponse.review.tripId, "trip1");
  assert.equal(afterLostResponse.reviewDelivery, "sending");
}));

test("более поздний отчёт не обгоняет незавершённую запись того же выезда", () => withOutbox((file) => {
  const outbox = new ReportOutbox(file);
  outbox.queueReport("m42", { op: "final_report", tripId: "trip1" }, true, { reportId: "m42" });
  assert.equal(outbox.hasEarlierFinalIndex("m43", "trip1"), true);
  assert.equal(outbox.hasEarlierFinalIndex("m43", "trip2"), false);
  assert.equal(outbox.hasEarlierFinalIndex("m42", "trip1"), false);
  outbox.recordFinalIndex("m42", {});
  assert.equal(new ReportOutbox(file).hasEarlierFinalIndex("m43", "trip1"), false);
}));

test("series delivery checkpoints survive restart and are handed to the CRM outbox atomically", () => withOutbox((file) => {
  const original = new ReportOutbox(file);
  const owner = "10001";
  const draft = { claimId: "a".repeat(32), header: 42, copied: [["10001:6", 43]], uncertain: true };
  original.saveSeriesDraft(owner, draft);
  draft.copied.length = 0;
  const restarted = new ReportOutbox(file);
  assert.deepEqual(restarted.seriesDraft(owner).copied, [["10001:6",43]]);
  assert.equal(restarted.seriesDraft(owner).uncertain, true);
  const payload = { op:"preliminary", uid: owner, seriesClaimId: draft.claimId, report:{id:"m42"} };
  restarted.queueReport("m42", payload, false, null, owner);
  const recovered = new ReportOutbox(file);
  assert.equal(recovered.seriesDraft(owner), undefined);
  assert.deepEqual(recovered.reportEntry("m42").payload, payload);
}));

test("a released series claim keeps evidence and does not block a newer final report", () => withOutbox(file => {
  const box = new ReportOutbox(file);
  box.queueReport("m42", { op:"final_report", tripId:"trip1" }, false, { reportId:"m42" });
  assert.equal(box.hasEarlierFinalIndex("m60", "trip1"), true);
  box.blockReport("m42", "trip_series_claim_required");
  assert.equal(new ReportOutbox(file).hasEarlierFinalIndex("m60", "trip1"), false);
  assert.equal(box.reportEntry("m42").blocked, "trip_series_claim_required");
}));
