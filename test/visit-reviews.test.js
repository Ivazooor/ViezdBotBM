import assert from "node:assert/strict";
import test from "node:test";
import { createVisitReviews } from "../backend/visit-reviews.js";

const chatId = "-1003953057200";
const botId = "12345";
const reviewer = { ids: ["111111111"], name: "Проверяющий", username: "curator_fixture" };
const from = { id: 111111111, first_name: "Проверяющий" };
const base = "🔎 Проверка выезда\nВыезд: Макет";
const reportLink = "https://t.me/c/3953057200/500";
const qualityPrompt = "Ответьте на это сообщение и укажите замечания по качеству.";
const qualityYes = { answer: "yes", reason: "", by: "Проверяющий" };
const workYes = { answer: "yes", reason: "", by: "Проверяющий" };

function fixture(respond) {
  const telegram = [];
  const requests = [];
  const reviews = createVisitReviews({
    chatId, botId,
    async tg(method, input, timeout, retryNetwork) { telegram.push({ method, input, timeout, retryNetwork }); },
    async api(input) { requests.push(input); return respond(input); },
    senderName: user => user.first_name,
    htmlEscape: text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    warn: () => {},
  });
  return { reviews, telegram, requests };
}

function callback(action, sender = from) {
  return {
    id: "callback", data: "vr:m500:" + action, from: sender,
    message: { chat: { id: chatId }, message_id: 600, text: base },
  };
}

test("quality and work controls use a single message, with only the current step enabled", async () => {
  const { reviews, telegram, requests } = fixture(({ action }) => ({
    reviewer, linked: true,
    quality: action === "open" ? null : qualityYes,
    work: action === "work_yes" ? workYes : null,
  }));
  await reviews.deliver(await reviews.prepare({ reportId: "m500", tripId: "trip1", tripName: "Макет <А>" }));
  await reviews.handleCallback(callback("quality_yes"));
  await reviews.handleCallback(callback("work_yes"));
  assert.deepEqual(requests.map(({ action }) => action), ["open", "quality_yes", "work_yes"]);
  const [published] = telegram.filter(({ method }) => method === "sendMessage");
  const [quality, work] = telegram.filter(({ method }) => method === "editMessageText");
  assert.equal(published.retryNetwork, false);
  assert.match(published.input.text, /@curator_fixture/);
  assert.match(published.input.text, /Макет &lt;А&gt;/);
  assert.deepEqual(published.input.reply_markup.inline_keyboard.flat().map(row => row.callback_data),
    ["vr:m500:quality_yes", "vr:m500:quality_no"]);
  assert.deepEqual(quality.input.reply_markup.inline_keyboard.flat().map(row => row.callback_data),
    ["vr:m500:work_yes", "vr:m500:work_no"]);
  assert.equal(quality.input.message_id, 600);
  assert.equal(work.input.message_id, 600);
  assert.match(work.input.text, /Качество выезда: ✅ Качественно/);
  assert.match(work.input.text, /Выполнение работ: ✅ Выполнены/);
  assert.deepEqual(work.input.reply_markup.inline_keyboard, []);
});

test("replying to the real review carries its report and step across a bot restart", async () => {
  const { reviews, telegram, requests } = fixture(({ action, reason }) => {
    assert.equal(action, "quality_no");
    return { reviewer, linked: true, quality: { answer: "no", by: "Проверяющий", reason }, work: null };
  });
  const reply = {
    chat: { id: chatId }, message_id: 601, from, text: "Проверить <подсветку>",
    reply_to_message: {
      from: { id: botId }, message_id: 600,
      text: base + "\n\nОткрыть фотоотчёт\n\n" + qualityPrompt,
      entities: [{ type: "text_link", url: reportLink }],
    },
  };
  assert.equal(await reviews.handleReason({ ...reply, reply_to_message: { ...reply.reply_to_message, from } }), false);
  assert.equal(await reviews.handleReason(reply), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reportId, "m500");
  assert.equal(requests[0].telegramUser, "111111111");
  assert.match(telegram[0].input.text, /Проверить &lt;подсветку&gt;/);
  assert.equal(telegram[0].input.message_id, 600);
  assert.equal(telegram[0].input.reply_markup.inline_keyboard[0][0].callback_data, "vr:m500:work_yes");
});

test("a denied callback leaves the message and its buttons in place", async () => {
  const { reviews, telegram, requests } = fixture(() => {
    throw Object.assign(new Error("Только назначенный проверяющий"), { status: 403 });
  });
  await reviews.handleCallback(callback("quality_yes", { id: 222222222, first_name: "Другой участник" }));
  assert.equal(requests[0].telegramUser, "222222222");
  assert.equal(telegram.length, 1);
  assert.equal(telegram[0].method, "answerCallbackQuery");
  assert.equal(telegram[0].input.show_alert, true);
});

test("the fallback tag uses Taras's Telegram account without a public username", async () => {
  const { reviews, telegram } = fixture(() => ({
    reviewer: { ids: ["333333333"], name: "Резервный", username: "" },
    linked: false, quality: null, work: null,
  }));
  await reviews.deliver(await reviews.prepare({ reportId: "m500", tripName: "Выезд" }));
  assert.match(telegram[0].input.text, /href="tg:\/\/user\?id=333333333">@Резервный<\/a>/);
});
