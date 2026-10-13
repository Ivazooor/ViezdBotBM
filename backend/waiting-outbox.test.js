import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WaitingOutbox } from "./waiting-outbox.js";

test("Telegram result survives restart until the site acknowledges it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bm-wait-outbox-"));
  try {
    const file = path.join(directory, "receipts.json");
    const key = "a".repeat(24) + ":898159043";
    const receipt = { id: "a".repeat(24), chatId: "898159043",
      claimId: "b".repeat(24), delivered: true };
    const first = new WaitingOutbox(file);
    first.save(key, receipt);
    const restarted = new WaitingOutbox(file);
    assert.deepEqual(restarted.entries(), [[key, receipt]]);
    restarted.remove(key);
    assert.deepEqual(new WaitingOutbox(file).entries(), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an interrupted Telegram attempt survives restart as uncertain, without automatic resend", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bm-wait-intent-"));
  try {
    const file = path.join(directory, "receipts.json");
    const id = "a".repeat(24), chatId = "898159043", claimId = "b".repeat(24);
    const key = `${id}:${chatId}`;
    const intent = { id, chatId, claimId, stage: "intent", delivered: false,
      uncertain: true, error: "Проверьте чат перед повтором" };
    const first = new WaitingOutbox(file);
    first.save(key, intent);
    assert.deepEqual(new WaitingOutbox(file).entries(), [[key, intent]]);
    const delivered = { id, chatId, claimId, delivered: true };
    first.save(key, delivered);
    assert.deepEqual(new WaitingOutbox(file).entries(), [[key, delivered]]);
    assert.throws(() => first.save(key, { ...delivered, claimId: "c".repeat(24) }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
