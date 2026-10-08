import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { ReportOutbox } from "./report-outbox.js";
import { normalizeMessageIds, copyReportMessages } from "./report-delivery.js";
import { buildVisitPdf } from "./pdf.js";

dotenv.config();

// ===== Конфигурация =====
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
// Целевой чат/группа, куда бот пересылает готовые отчёты.
const TARGET_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
function parseIds(raw) {
  return (raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
// Дополнительные сотрудники с доступом к боту (зашиты в коде, помимо .env ALLOWED_USER_IDS).
const EXTRA_ALLOWED_IDS =
  "983796960,369094962,1416285563,475858355,1090755229,2003024692,1788196095,420290843,1504488231,709747902,5244003524,508570326,475386963,486635892,6341486734,1305025641,1175709298,862747793,1136597026,1119946044,5167474121,1186366279,916525382,663431978,455678231,5004731399,898159043,993245287,1088733519,6072230929,1432669716,636914019,8136543551,989537568,2108433058,568778122";
// Список Telegram ID сотрудников, которым разрешено отправлять отчёты.
// Объединяем .env и зашитые ID; Set убирает дубликаты.
const ALLOWED_USER_IDS = [
  ...new Set([...parseIds(process.env.ALLOWED_USER_IDS), ...parseIds(EXTRA_ALLOWED_IDS)]),
];
// Кто может оценивать качество выезда кнопками в рабочем чате.
// Базовый список можно переопределить через .env; передачу прав ниже сохраняем обязательно.
const DEFAULT_REVIEWER_IDS =
  "814705792,165912761,163743492,1090755229,1504488231,898159043,466665113,758274157,97782197,369094962";
// Передача права оценки действует и при старом списке QUALITY_REVIEWER_IDS на сервере.
const QUALITY_REVIEWER_IDS = [
  ...new Set([...parseIds(process.env.QUALITY_REVIEWER_IDS || DEFAULT_REVIEWER_IDS), "898159043"]),
].filter((id) => id !== "508570326");
const PORT = Number(process.env.PORT) || 3000;

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;

// Реквизиты для фирменного PDF-отчёта (подвал документа). Закреплены, переопределяются через .env.
const BRAND = {
  site: (process.env.PDF_SITE || "бизнес-макет.рф").trim(),
  managerName: (process.env.PDF_MANAGER_NAME || "Вербицкий Матвей Михайлович").trim(),
  managerPhone: (process.env.PDF_MANAGER_PHONE || "+7 985 433-75-90").trim(),
};
// Максимум фото, попадающих в PDF (защита от тяжёлого файла).
const PDF_MAX_PHOTOS = Number(process.env.PDF_MAX_PHOTOS) || 20;
// Обычный Bot API принимает загружаемый документ до 50 МБ. Фото в рабочем чате
// остаются полными; для PDF ограничиваем общий размер скачанных исходников.
const PDF_INPUT_BUDGET_BYTES = 35 * 1024 * 1024;
const PDF_UPLOAD_LIMIT_BYTES = 49 * 1024 * 1024;

// Интеграция с KPI-приложением (отдел «Выезды»): выбор карточки выезда + запись результата.
// Токен ТОЛЬКО из .env (репозиторий публичный — не хардкодить!). Пусто → интеграция отключена.
const BM_API_URL = (process.env.BM_API_URL || "https://xn----8sbbqciguqh9br.xn--p1ai/api/bot.php").trim();
const BM_API_TOKEN = (process.env.BM_API_TOKEN || "").trim();
const REPORT_OUTBOX_PATH = (process.env.REPORT_OUTBOX_PATH || fileURLToPath(new URL("../data/report-outbox.json", import.meta.url))).trim();
const reportOutbox = new ReportOutbox(REPORT_OUTBOX_PATH);
// [MINIAPP] Мини-приложение «Приложение по выездам» — информационное окно внутри Telegram:
// свои выезды (задачи, фото задачи, контакт заказчика) и итоги по качеству. Отчёты по-прежнему
// оформляются здесь, в боте. Требование Telegram: только https-адрес.
const MINIAPP_URL = (process.env.MINIAPP_URL || "https://xn----8sbbqciguqh9br.xn--p1ai/viezd/").trim();
// Логин бота — нужен для запасной кнопки в групповом чате (там web_app-кнопки Telegram запрещает).
const BOT_USERNAME = (process.env.BOT_USERNAME || "bmhpolabot").trim().replace(/^@/, "");
// Адрес мини-приложения должен быть https и БЕЗ якоря: Telegram сам дописывает в адрес свой
// #tgWebAppData (из него приложение читает подпись). Кривой адрес Telegram не принимает и отвергает
// СООБЩЕНИЕ ЦЕЛИКОМ — тогда /start молчал бы у всех. Поэтому при плохом адресе кнопку web_app
// не ставим вовсе: меню уходит с обычной ссылкой, бот остаётся рабочим.
const MINIAPP_OK = /^https:\/\/\S+$/i.test(MINIAPP_URL) && !MINIAPP_URL.includes("#");
// Кого упоминать в вопросе «выезд выполнен?» (ответственный за финальный статус).
const STATUS_MENTION = (process.env.STATUS_MENTION || "@matiyver").trim();
// Кого тегать отдельным сообщением при заключительном отчёте (для уведомления).
// Руководителя упоминаем по ID, второго адресата — по его актуальному username.
const NOTIFY_FINAL = [
  { id: "1504488231", name: "Руководитель" },
  { username: "murraserebra" },
];

// ===== Тексты чек-листов (как в прежнем приложении) =====
const CHECKLISTS = {
  pre: [
    "Сделана фото-фиксация до начала работ.",
    "Объект снят со всех сторон.",
    "Макет видно полностью (4–5 фото).",
    "Детализированы объекты, с которыми и вокруг которых будет идти работа.",
    "Сделана видео-фиксация до начала работ.",
    "Сделан видео-облёт: горизонтальное видео, плавно, видно состояние объекта; с демонстрацией интерактива, если он есть.",
  ],
  final: [
    "Убран за собой мусор.",
    "Итоговый фото-отчёт: объект со всех сторон, макет полностью (4–5 фото), детализированы объекты, с которыми велась работа.",
    "Итоговый видео-отчёт: горизонтальное видео, плавный облёт, видно итоговое состояние; с демонстрацией интерактива, если он есть.",
  ],
};

// ===== Состояние диалогов (FSM) в памяти, по Telegram ID =====
const sessions = new Map();

// [BAD-REASON] Ожидание причины «не качественный» в рабочем чате: оценщик нажал «⚠️ Не качественный»
// (или «⚠️ Не выполнен») → бот просит причину; принимаем Reply на ЕГО запрос ИЛИ следующее текстовое
// сообщение ТОГО ЖЕ оценщика. Структура: Map chatId → Map reviewerId → pending — у КАЖДОГО оценщика
// свой независимый слот (двое могут параллельно оценивать разные выезды, не затирая друг друга).
// Хранится в памяти: рестарт бота сбрасывает ожидание — кнопки оценки остаются, можно нажать заново.
const pendingBadReasons = new Map();
const BAD_REASON_TTL_MS = 15 * 60 * 1000; // 15 минут на ввод причины
function badReasonChatMap(chatId) {
  const key = String(chatId);
  if (!pendingBadReasons.has(key)) pendingBadReasons.set(key, new Map());
  return pendingBadReasons.get(key);
}
// Снять ожидание причины конкретного оценщика по конкретному выезду (после успешной «хорошей» оценки).
function clearBadReasonPending(chatId, reviewerId, tripId) {
  const m = badReasonChatMap(chatId);
  const p = m.get(reviewerId);
  if (p && (!tripId || p.tripId === tripId)) m.delete(reviewerId);
}

function resetSession(userId) {
  sessions.set(userId, { step: "idle", data: {}, media: [], mediaHintShown: false, submitting: false });
  return sessions.get(userId);
}

function getSession(userId) {
  return sessions.get(userId) || resetSession(userId);
}

function isAllowed(userId) {
  const id = String(userId);
  // Оценщикам качества доступ к боту открыт автоматически.
  return ALLOWED_USER_IDS.includes(id) || QUALITY_REVIEWER_IDS.includes(id);
}

function isReviewer(userId) {
  return QUALITY_REVIEWER_IDS.includes(String(userId));
}

function senderName(from) {
  const parts = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const uname = from.username ? ` (@${from.username})` : "";
  return `${parts || "Без имени"}${uname}`;
}

// ===== Вызов Telegram API (с автоповтором при 429 и сетевых сбоях) =====
async function tg(method, params = {}, timeoutMs = 65000, retryNetwork = true, floodBudget = null) {
  let lastErr;
  for (let attempt = 0; attempt <= 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${API}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const data = await response.json();
      if (data.ok) return data.result;
      // 429 Too Many Requests — Telegram просит подождать retry_after секунд и повторить.
      const retryAfter = data.parameters && data.parameters.retry_after;
      if (response.status === 429 && retryAfter) {
        const delayMs = (retryAfter + 1) * 1000;
        if (floodBudget && delayMs > floodBudget.remainingMs) {
          throw new Error(`${method}: лимит Telegram 429 превысил ожидание 60 секунд`);
        }
        if (floodBudget) floodBudget.remainingMs -= delayMs;
        logEvent("warn", `${method}: лимит 429, пауза ${retryAfter}s (попытка ${attempt + 1})`);
        await sleep(delayMs);
        continue;
      }
      // Прочие ошибки API (400/403 и т.п.) — повторять бессмысленно.
      throw new Error(`${method}: ${data.description || response.status}`);
    } catch (error) {
      lastErr = error;
      // Ошибка API (а не сети) — пробрасываем сразу.
      if (error.message && error.message.indexOf(`${method}:`) === 0) throw error;
      // При выдаче найденного отчёта повтор после неизвестного исхода сети мог бы
      // прислать сотруднику те же сообщения ещё раз. Обычный поток отчёта не меняем.
      if (!retryNetwork) {
        // Ответ Telegram не получен: сообщение могло быть доставлено.
        error.uncertain = true;
        throw error;
      }
      // Сетевой сбой/таймаут — короткий backoff и повтор.
      if (attempt < 4) {
        logEvent("warn", `${method}: сеть (${error.message}), повтор ${attempt + 1}`);
        await sleep(800 * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`${method}: не удалось`);
}

function sendMessage(chatId, text, replyMarkup) {
  const params = { chat_id: chatId, text };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return tg("sendMessage", params);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== Внутренний журнал (кольцевой буфер) для удалённого чтения логов =====
const LOG_BUFFER = [];
const LOG_MAX = 400;
function logEvent(level, ...parts) {
  let stamp = "";
  try {
    stamp = nowMoscow();
  } catch (_) {}
  const msg = parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ");
  const line = `${stamp} [${level}] ${msg}`;
  LOG_BUFFER.push(line);
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
  (level === "error" ? console.error : console.log)(line);
}

// Скачать файл из Telegram по file_id (download-лимит Bot API — 20 МБ; для фото достаточно).
async function downloadFile(fileId) {
  const file = await tg("getFile", { file_id: fileId });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(`${FILE_API}/${file.file_path}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`download ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// Отправить документ (PDF) в чат через multipart (нативные fetch/FormData/Blob Node 18+).
async function sendDocument(chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([buffer], { type: "application/pdf" }), filename);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await globalThis.fetch(`${API}/sendDocument`, { method: "POST", body: form, signal: controller.signal });
    const data = await response.json();
    if (!data.ok) throw new Error(`sendDocument: ${data.description || response.status}`);
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

// Имя PDF-файла вида «Отчет о выезде: <Проект> <Дата>.pdf».
function pdfFilename(d) {
  const clean = (s) => String(s || "").replace(/[\\/\n\r\t]+/g, " ").trim();
  const project = clean(d.tripName || d.projectName) || "выезд";
  const date = clean(d.visitDate);
  const name = `Отчет о выезде: ${project} ${date}`.trim().slice(0, 120);
  return `${name}.pdf`;
}

// ===== Интеграция с KPI-приложением (api/bot.php) =====
function bmEnabled() {
  return Boolean(BM_API_TOKEN);
}

async function bmApi(method, payload = {}) {
  if (!BM_API_TOKEN) throw new Error("BM_API_TOKEN не задан");
  const opts = { method, headers: { "X-Bot-Token": BM_API_TOKEN } };
  let url = BM_API_URL;
  if (method === "GET") {
    const qs = Object.keys(payload)
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(payload[k]))
      .join("&");
    url += (url.includes("?") ? "&" : "?") + (qs || "op=trips");
  } else {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(payload);
  }
  // Срок каждого обращения ограничен: зависший сайт не должен останавливать выдачу.
  // Для report_jobs тело с тем же claimId повторяется после любой сетевой неопределённости.
  let lastErr;
  for (let attempt = 0; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(url, { ...opts, signal: controller.signal });
      if (response.status >= 500) throw new Error("api " + response.status);
      const data = await response.json();
      if (!data.ok) { const e = new Error(data.error || `api ${response.status}`); if (data.code) e.code = data.code; e.permanent = response.status < 500; throw e; }
      return data;
    } catch (error) {
      lastErr = error;
      if (error.permanent) throw error;
      // Прочие POST-операции с неоднозначным ответом уже обязаны быть идемпотентны.
      if (attempt < 2) {
        logEvent("warn", "bmApi", payload.op || method, "сеть/ответ, повтор " + (attempt + 1));
        await sleep(1000 * (attempt + 1));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("bmApi: не удалось");
}

// Список незавершённых выездов для выбора в боте.
async function bmGetTrips() {
  const data = await bmApi("GET", { op: "trips" });
  return Array.isArray(data.trips) ? data.trips : [];
}

async function assertReportApiCompatible() {
  const caps = await bmApi("GET", { op: "capabilities" });
  if (caps.visitReportsVersion !== 2 || caps.reportJobsProtocol !== "claim-v1" || caps.attachReport !== true
      || String(caps.sourceChatId || "") !== TARGET_CHAT_ID) {
    throw new Error("несовместимая версия API отчётов");
  }
}

// Профиль сотрудника (ФИО) по Telegram ID.
async function bmGetProfile(userId) {
  const data = await bmApi("GET", { op: "profile", uid: String(userId) });
  return data.profile || null;
}
async function bmSaveProfile(userId, fio) {
  return bmApi("POST", { op: "save_profile", uid: String(userId), fio });
}

// Выдача найденного в мини-приложении отчёта в личный чат сотрудника.
// До каждого внешнего Telegram-вызова состояние пишется на диск. После сбоя
// процесса незавершённую отправку НЕ повторяем: Telegram не поддерживает
// идемпотентный ключ, поэтому её исход может быть неизвестен.
const REPORT_JOBS_POLL_MS = 5000;
let reportJobsPolling = false;

async function flushReportAck(id, ack) {
  try {
    const { attempts: _attempts, retryAt: _retryAt, ...payload } = ack;
    await bmApi("POST", { op: "report_job_done", id, ...payload });
    reportOutbox.removeAck(id);
  } catch (error) {
    reportOutbox.deferAck(id);
    logEvent("error", `report_job_done ${id}: ${error.message}`);
  }
}

async function deliverReportJob(id, entry) {
  const { job, claimId } = entry;
  if (entry.started) {
    // После рестарта неизвестно, успел ли Telegram отправить что-либо.
    const ack = { claimId, status: "unknown", error: "Бот перезапустился во время выдачи отчёта; проверьте личный чат" };
    reportOutbox.finishDelivery(id, ack);
    await flushReportAck(id, ack);
    return;
  }

  let recipient = "";
  let introSent = false;
  let copiedCount = 0;
  let totalCount = 0;
  let status = "done";
  let reason = "";
  const floodBudget = { remainingMs: 60000 };
  try {
    recipient = String(job.tgId || "");
    if (!/^\d{5,20}$/.test(recipient)) throw new Error("некорректный Telegram ID");
    if (String(job.chatId || "") !== TARGET_CHAT_ID) throw new Error("неверный чат отчёта");
    if (job.type !== "prelim" && job.type !== "final") throw new Error("неверный тип отчёта");
    const ids = normalizeMessageIds(job.messageIds);
    totalCount = ids.length;

    reportOutbox.markStarted(id); // после этой точки повторное копирование после рестарта запрещено
    const intro = `${reportTypeLabel(job.type)} фотоотчёт\n`
      + `Выезд: ${String(job.tripName || "Выезд").slice(0, 200)}\n`
      + (job.projectName ? `Проект: ${String(job.projectName).slice(0, 200)}\n` : "")
      + `Дата выезда: ${String(job.date || "").slice(0, 40)}\n`
      + "Фото, видео и PDF (если он был сформирован) — ниже.";
    await tg("sendMessage", { chat_id: recipient, text: intro }, 65000, false, floodBudget);
    introSent = true;
    ({ copiedCount, totalCount } = await copyReportMessages(ids, (chunk) => tg("copyMessages", {
      chat_id: recipient,
      from_chat_id: TARGET_CHAT_ID,
      message_ids: chunk,
    }, 65000, false, floodBudget), (count) => { copiedCount = count; }));
    if (copiedCount !== totalCount) {
      status = "failed";
      reason = `Telegram скопировал ${copiedCount} из ${totalCount} сообщений`;
    }
  } catch (error) {
    status = error.uncertain ? "unknown" : "failed";
    reason = String(error && error.message || error).slice(0, 240);
  }

  if (status === "done") logEvent("info", `report_job ${id}: доставлено ${copiedCount} сообщений`);
  else logEvent("error", `report_job ${id}: ${status}: ${reason}`);
  if (introSent && status !== "done") {
    const warning = status === "unknown"
      ? `⚠️ Результат отправки части отчёта неизвестен. Достоверно скопировано: ${copiedCount} из ${totalCount}. Проверьте сообщения выше перед новым запросом.`
      : `⚠️ Отчёт доставлен не полностью: ${copiedCount} из ${totalCount} сообщений. Проверьте файлы выше.`;
    await tg("sendMessage", { chat_id: recipient, text: warning }, 65000, false, floodBudget).catch(() => {});
  }
  const ack = { claimId, status, ...(reason ? { error: reason } : {}) };
  reportOutbox.finishDelivery(id, ack); // ACK переживает перезапуск и сетевой сбой KPI
  await flushReportAck(id, ack);
}

// В рабочий чат файлы уже попали. Сохраняем запрос на диск до обращения
// к KPI; при неудаче основной записи индекс существующей карточки можно
// восстановить отдельным attach_report без повторной отправки Telegram-файлов.
async function postReportWithOutbox(primary, fallback = null) {
  const id = String(primary.report && primary.report.id || "");
  if (!id) throw new Error("Нет ID отчёта для сохранения в KPI");
  const retryPayload = fallback || primary;
  let durable = false;
  try {
    reportOutbox.queueReport(id, retryPayload);
    durable = true;
  } catch (error) {
    logEvent("error", `report_index ${id}: не удалось записать дисковую очередь: ${error.message}`);
  }
  try {
    await assertReportApiCompatible();
  } catch (error) {
    if (durable) reportOutbox.deferReport(id);
    error.indexQueued = durable;
    throw error;
  }
  try {
    const result = await bmApi("POST", primary);
    if (durable) {
      try { reportOutbox.removeReport(id); }
      catch (cleanupError) { logEvent("error", `report_index ${id}: очистка очереди: ${cleanupError.message}`); }
    }
    return result;
  } catch (error) {
    if (fallback) {
      try {
        await bmApi("POST", fallback);
        error.indexAttached = true;
        if (durable) {
          try { reportOutbox.removeReport(id); }
          catch (cleanupError) { logEvent("error", `report_index ${id}: очистка очереди: ${cleanupError.message}`); }
        }
      } catch (attachError) {
        logEvent("error", `report_index ${id}: attach_report: ${attachError.message}`);
        if (durable) reportOutbox.deferReport(id);
      }
    } else if (durable) {
      reportOutbox.deferReport(id);
    }
    error.indexQueued = durable && !error.indexAttached;
    if (!durable && !error.indexAttached) error.message += " (автоматический повтор недоступен: ошибка дисковой очереди)";
    throw error;
  }
}

async function flushReportIndex(maxItems = 3) {
  if (!bmEnabled()) return;
  const due = reportOutbox.reportEntries()
    .filter(([, entry]) => !entry.staged && (entry.retryAt || 0) <= Date.now())
    .slice(0, maxItems);
  if (due.length) {
    try { await assertReportApiCompatible(); }
    catch (error) {
      for (const [id] of due) reportOutbox.deferReport(id);
      logEvent("error", "report_index: несовместимый или недоступный KPI API:", error.message);
      return;
    }
  }
  for (const [id, entry] of due) {
    try {
      await bmApi("POST", entry.payload);
      reportOutbox.removeReport(id);
      logEvent("info", `report_index ${id}: восстановлен в KPI`);
    } catch (error) {
      reportOutbox.deferReport(id);
      logEvent("error", `report_index ${id}: ${error.message}`);
    }
  }
}

async function pollReportJobs() {
  if (reportJobsPolling || !bmEnabled() || !TARGET_CHAT_ID) return;
  reportJobsPolling = true;
  try {
    await flushReportIndex();
    for (const [id, ack] of reportOutbox.ackEntries()
      .filter(([, entry]) => (entry.retryAt || 0) <= Date.now()).slice(0, 3)) {
      await flushReportAck(id, ack);
    }
    for (const [id, entry] of reportOutbox.deliveryEntries()) await deliverReportJob(id, entry);
    // Пока локальная доставка не завершена, новые задания не захватываем.
    if (reportOutbox.deliveryEntries().length) return;

    let claimId = reportOutbox.pendingClaimId();
    if (!claimId) {
      claimId = randomBytes(12).toString("hex");
      reportOutbox.setClaim(claimId);
    }
    const data = await bmApi("POST", { op: "report_jobs", claimId });
    if (!Array.isArray(data.jobs)) throw new Error("report_jobs: отсутствует массив jobs");
    // Ответ сохраняется вместе с заданиями до удаления claimId. Если ответ
    // потерялся, следующий poll повторит тот же claimId и получит ту же пачку.
    reportOutbox.saveClaimedJobs(claimId, data.jobs);
    for (const [id, entry] of reportOutbox.deliveryEntries()) await deliverReportJob(id, entry);
  } catch (error) {
    logEvent("error", "report_jobs:", error.message);
  } finally {
    reportJobsPolling = false;
  }
}

// Дата выезда «YYYY-MM-DD» → «ДД / месяц словом» (без года); иначе как есть.
const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
function tripDateShort(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!m) return String(date || "");
  const day = parseInt(m[3], 10);
  const month = MONTHS_RU[parseInt(m[2], 10) - 1] || m[2];
  return `${day} / ${month}`;
}
// Подпись выезда на кнопке: «Название / Фамилия / ДД месяц» (без машинки).
function tripLabel(t) {
  const parts = [t.name || "Без названия"];
  if (t.responsible) parts.push(String(t.responsible).trim().split(/\s+/)[0]); // только фамилия
  const d = tripDateShort(t.date);
  if (d) parts.push(d);
  let label = parts.join(" / ").slice(0, 54);
  // Маркер уже полученных отчётов: подсказывает выбрать ТУ ЖЕ карточку для заключительного отчёта,
  // что и для предварительного — иначе отметки разойдутся по разным выездам и «качественный» не откроется.
  if (t.final) label += " ✅✅отчёты";
  else if (t.prelim) label += " ✅предв.";
  return label.slice(0, 64);
}

// ===== Клавиатуры =====
// [MINIAPP] Стартовое меню. Просмотр выездов и сводка за месяц переехали в мини-приложение —
// там же контакт заказчика, фото задачи и итоги по качеству.
// Кнопку web_app Telegram принимает ТОЛЬКО в личном чате: у групп положить её нельзя — сообщение
// целиком не уйдёт (BUTTON_TYPE_INVALID). Личный чат = положительный chat_id, группа = отрицательный.
function typeKeyboardFor(chatId, noWebApp) {
  const isPrivate = Number(chatId) > 0;
  const appBtn = (isPrivate && MINIAPP_OK && !noWebApp)
    ? { text: "🚗 Приложение по выездам", web_app: { url: MINIAPP_URL } }
    : { text: "🚗 Приложение по выездам", url: `https://t.me/${BOT_USERNAME}` };
  return {
    inline_keyboard: [
      [{ text: "🟦 Предварительный отчет", callback_data: "type_pre" }],
      [{ text: "✅ Заключительный отчет", callback_data: "type_final" }],
      [appBtn],
    ],
  };
}
// Отправка стартового меню. Если Telegram по какой-то причине не принял кнопку мини-приложения
// (BUTTON_TYPE_INVALID и т.п.), повторяем БЕЗ неё — сотрудник в любом случае получает меню
// и может сдать отчёт. Молчащий бот здесь недопустим.
const MENU_TEXT = "Привет! Выбери что требуется:";
async function sendTypeMenu(chatId) {
  try {
    return await sendMessage(chatId, MENU_TEXT, typeKeyboardFor(chatId));
  } catch (error) {
    logEvent("error", "меню с кнопкой мини-приложения не ушло:", error.message);
    return sendMessage(chatId, MENU_TEXT, typeKeyboardFor(chatId, true));
  }
}
const checklistKeyboard = {
  inline_keyboard: [[{ text: "Всё проверил — продолжить", callback_data: "checklist_ok" }]],
};
const commentKeyboard = {
  inline_keyboard: [[{ text: "Пропустить", callback_data: "skip_comment" }]],
};
// Когда задачи подтянуты из карточки выезда — кнопка вставить их как есть.
const useTasksKeyboard = {
  inline_keyboard: [[{ text: "Использовать задачи", callback_data: "use_tasks" }]],
};
// Заключительный, шаг «какие работы выполнены»: вставить задачи из карточки.
const useTasksDoneKeyboard = {
  inline_keyboard: [[{ text: "Использовать задачи", callback_data: "use_tasks_done" }]],
};
// После вставки задач в «выполнено»: оставить как есть или отредактировать.
const workDoneConfirmKeyboard = {
  inline_keyboard: [
    [{ text: "✅ Оставить как есть", callback_data: "workdone_keep" }],
    [{ text: "✏️ Отредактировать", callback_data: "workdone_edit" }],
  ],
};
const workNotDoneKeyboard = {
  inline_keyboard: [[{ text: "✅ Всё выполнено", callback_data: "work_all_done" }]],
};
const recommendationsKeyboard = {
  inline_keyboard: [[{ text: "Рекомендаций нет", callback_data: "no_recommendations" }]],
};
const mediaKeyboard = {
  inline_keyboard: [
    [{ text: "📤 Отправить отчёт", callback_data: "send_report" }],
    [{ text: "❌ Отменить", callback_data: "cancel" }],
  ],
};
// Кнопки оценки качества выезда (в рабочем чате; нажимают только оценщики).
const qualityKeyboard = {
  inline_keyboard: [
    [{ text: "✅ Выезд качественный", callback_data: "quality_ok" }],
    [{ text: "⚠️ Выезд не качественный", callback_data: "quality_bad" }],
  ],
};
const confirmKeyboard = {
  inline_keyboard: [
    [{ text: "✅ Подтвердить и отправить", callback_data: "confirm_send" }],
    [{ text: "➕ Добавить ещё файлы", callback_data: "add_more" }],
    [{ text: "❌ Отменить", callback_data: "cancel" }],
  ],
};
const dateKeyboard = {
  inline_keyboard: [[{ text: "📅 Сегодня (текущие дата и время)", callback_data: "date_now" }]],
};

// Текущие дата и время по Москве в формате ДД.ММ.ГГГГ ЧЧ:ММ.
function nowMoscow() {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

function reportTypeLabel(type) {
  return type === "final" ? "Заключительный" : "Предварительный";
}

// Экранирование для parse_mode HTML.
function htmlEscape(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MEDIA_PROMPT =
  "Теперь пришлите все фото и видео — по одному или альбомом.\nКогда закончите — нажмите «Отправить отчёт».";
const DATE_PROMPT =
  "Укажите дату выезда: нажмите «📅 Сегодня» или введите вручную (например, 15.06.2026).";

// ===== Старт нового отчёта =====
async function startReport(chatId, userId) {
  resetSession(userId);
  const session = getSession(userId);

  // Загружаем профиль (ФИО). При первом входе — просим заполнить.
  if (bmEnabled()) {
    try {
      const profile = await bmGetProfile(userId);
      if (profile && profile.fio) session.profileFio = profile.fio;
    } catch (error) {
      logEvent("error", "bmGetProfile:", error.message);
    }
    if (!session.profileFio) {
      session.step = "register_fio";
      await sendMessage(
        chatId,
        "Здравствуйте! Это первый вход. Напишите, пожалуйста, ваше ФИО — оно будет автоматически подставляться в отчёты (вводить каждый раз не нужно):"
      );
      return;
    }
  }

  session.step = "type";
  await sendTypeMenu(chatId);
}

// Меню выбора типа отчёта (после старта/регистрации).
function showTypeMenu(chatId, session) {
  session.step = "type";
  return sendTypeMenu(chatId);
}

// Показ чек-листа требований (общий шаг после выбора типа и выезда).
async function goChecklist(chatId, session) {
  session.step = "checklist";
  const items = CHECKLISTS[session.data.reportType === "final" ? "final" : "pre"];
  const list = items.map((t, i) => `${i + 1}. ${t}`).join("\n");
  await sendMessage(
    chatId,
    `Тип: ${reportTypeLabel(session.data.reportType)}.\n\nПроверьте перед отправкой:\n\n${list}`,
    checklistKeyboard
  );
}

// Шаг «ответственное лицо»: если в профиле есть ФИО — подставляем автоматически.
async function askResponsibleOrSkip(chatId, session) {
  if (session.profileFio) {
    session.data.responsible = session.profileFio;
    await sendMessage(chatId, `Ответственное лицо: ${session.profileFio} (из профиля).`);
    return goAfterResponsible(chatId, session);
  }
  session.step = "responsible";
  return sendMessage(chatId, "Кто ответственное лицо?");
}

// Шаги после ответственного лица (зависят от типа отчёта).
function goAfterResponsible(chatId, session) {
  if (session.data.reportType === "final") {
    session.step = "workdone";
    return sendMessage(
      chatId,
      session.data.tripTasks
        ? `Перечислите, какие работы выполнены.\n\nЗадачи из карточки выезда:\n${session.data.tripTasks}\n\nОтправьте свой текст, чтобы изменить, или «Использовать задачи» — чтобы вставить задачи из карточки.`
        : "Перечислите, какие работы выполнены:",
      session.data.tripTasks ? useTasksDoneKeyboard : undefined
    );
  }
  // Предварительный отчёт: задачи уже известны — они либо взяты из карточки выезда,
  // либо введены при заведении нового выезда. Отдельно спрашивать их не нужно.
  if (session.data.tripTasks) {
    session.data.comment = session.data.tripTasks;
    session.step = "media";
    return sendMessage(chatId, MEDIA_PROMPT, mediaKeyboard);
  }
  // Задач нет только в запасном сценарии (приложение недоступно) — тогда спрашиваем.
  session.step = "comment";
  return sendMessage(chatId, "Укажите перечень задач на данном выезде или нажмите «Пропустить».", commentKeyboard);
}

// Вторым действием после выбора типа — выбор выезда из отдела «Выезды».
async function offerTripChoice(chatId, session, page = 0, useCached = false) {
  // Интеграция должна быть доступна до оформления отчёта.
  if (!bmEnabled()) {
    session.step = "type";
    await sendMessage(chatId, "⚠️ Связь с программой выездов не настроена. Отчёт сейчас нельзя привязать к карточке и найти через поиск. Попробуйте позже.");
    return;
  }

  let trips = [];
  const fromCache = useCached && Array.isArray(session.tripList);
  try {
    trips = fromCache ? session.tripList : await bmGetTrips();
  } catch (error) {
    logEvent("error", "bmGetTrips:", error.message);
    // Не уводим сразу в «новый выезд»: при короткой сетевой икоте так появился бы дубль карточки
    // уже существующего выезда. Даём выбор — повторить список или всё же завести новый.
    session.step = "picktrip";
    await sendMessage(chatId,
      "⚠️ Не удалось получить список выездов из приложения.\n\nПопробуйте ещё раз — или заведите новый выезд, если его в списке и не было.",
      { inline_keyboard: [
        [{ text: "🔄 Повторить список", callback_data: "pick_retry" }],
        [{ text: "➕ Завести новый выезд", callback_data: "pick_create" }],
      ] });
    return;
  }

  session.tripList = trips.filter((t) => t && t.id);
  if (!fromCache) session.tripChoiceToken = randomBytes(3).toString("hex");
  session.tripChoices = {};
  session.tripList.forEach((t) => {
    session.tripChoices[String(t.id)] = t; // старые кнопки из уже отправленных сообщений
  });
  const pageSize = 15;
  const pageCount = Math.max(1, Math.ceil(session.tripList.length / pageSize));
  const currentPage = Math.max(0, Math.min(Number(page) || 0, pageCount - 1));
  const rows = [];
  for (let i = currentPage * pageSize; i < Math.min((currentPage + 1) * pageSize, session.tripList.length); i++) {
    // CRM ID может быть длиннее лимита Telegram callback_data (64 байта).
    rows.push([{ text: tripLabel(session.tripList[i]), callback_data: `pick_i${session.tripChoiceToken}_${i}` }]);
  }
  if (pageCount > 1) {
    const navigation = [];
    if (currentPage > 0) navigation.push({ text: "← Назад", callback_data: `pick_page_${session.tripChoiceToken}_${currentPage - 1}` });
    if (currentPage + 1 < pageCount) navigation.push({ text: "Далее →", callback_data: `pick_page_${session.tripChoiceToken}_${currentPage + 1}` });
    rows.push(navigation);
  }
  rows.push([{ text: "➕ Новый выезд — нет в списке", callback_data: "pick_create" }]);

  session.step = "picktrip";
  const head = session.tripList.length
    ? `Выберите выезд из отдела «Выезды» (${currentPage + 1}/${pageCount}) или заведите новый:`
    : "Незавершённых выездов в приложении нет — заведите новый.";
  await sendMessage(chatId, head, { inline_keyboard: rows });
}

// ===== Новый выезд: название → задачи (оба поля обязательны) =====
function askNewTripName(chatId, session) {
  session.step = "newtrip_name";
  // Без связи с приложением карточка не заведётся — не обещаем того, чего не будет.
  return sendMessage(chatId, bmEnabled()
    ? "Как называется выезд? Напишите название — оно станет названием карточки в приложении.\n\nНапример: ЖК «Прайм Парк», макет 1:500"
    : "Как называется выезд? Напишите название — оно попадёт в заголовок отчёта.\n\nНапример: ЖК «Прайм Парк», макет 1:500");
}
function askNewTripTasks(chatId, session) {
  session.step = "newtrip_tasks";
  return sendMessage(chatId, `Выезд: ${session.data.tripName}\n\nЧто нужно сделать на выезде? Перечислите задачи — они ${bmEnabled() ? "попадут в карточку выезда" : "войдут в отчёт"}.`);
}

// ===== Режим просмотра выездов (кнопка «Посмотреть выезды» в стартовом меню) =====
async function showTripsForView(chatId, session) {
  if (!bmEnabled()) {
    await sendMessage(chatId, "Просмотр выездов недоступен: интеграция с приложением не настроена.");
    return;
  }
  let trips = [];
  try {
    trips = await bmGetTrips();
  } catch (error) {
    logEvent("error", "bmGetTrips(view):", error.message);
    await sendMessage(chatId, "⚠️ Не удалось получить список выездов из приложения. Попробуйте позже.");
    return;
  }
  session.viewChoices = {};
  const rows = [];
  trips.slice(0, 30).forEach((t) => {
    if (!t || !t.id) return;
    session.viewChoices[t.id] = t;
    rows.push([{ text: tripLabel(t), callback_data: "view_" + t.id }]);
  });
  rows.push([{ text: "🏠 На старт", callback_data: "back_start" }]);
  const head = rows.length > 1
    ? "Выезды из отдела «Выезды» — выберите, чтобы посмотреть задачи:"
    : "Незавершённых выездов в приложении нет.";
  await sendMessage(chatId, head, { inline_keyboard: rows });
}

async function showTripDetails(chatId, session, tripId) {
  let t = session.viewChoices && session.viewChoices[tripId];
  if (!t && bmEnabled()) {
    try {
      const trips = await bmGetTrips();
      t = trips.find((x) => x && x.id === tripId);
    } catch (error) {
      logEvent("error", "bmGetTrips(details):", error.message);
    }
  }
  if (!t) {
    await sendMessage(chatId, "Выезд не найден — обновите список.", {
      inline_keyboard: [[{ text: "◀️ К списку", callback_data: "view_trips" }]],
    });
    return;
  }
  const parts = [`🚗 ${t.name || "Без названия"}`];
  if (t.date) parts.push(`📅 Дата: ${t.date}`);
  if (t.address) parts.push(`📍 Адрес: ${t.address}`);
  if (t.teamly) parts.push(`🔗 Teamly: ${t.teamly}`);
  parts.push("", "📋 Задачи:", t.comment ? t.comment : "— не указаны");
  await sendMessage(chatId, parts.join("\n"), {
    inline_keyboard: [
      [{ text: "◀️ Назад к списку", callback_data: "view_trips" }],
      [{ text: "🏠 На старт", callback_data: "back_start" }],
    ],
  });
}

// [MONTH-SUMMARY] Сводка выездов за месяц (текстом в чат): список + какие отчёты по каждому.
async function bmMonthSummary(month) {
  const data = await bmApi("GET", { op: "month_summary", month });
  return Array.isArray(data.trips) ? data.trips : [];
}
function mskYearMonth() {
  const parts = new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return {
    y: parseInt(parts.find((x) => x.type === "year").value, 10),
    mo: parseInt(parts.find((x) => x.type === "month").value, 10),
  };
}
const summaryBackKb = {
  inline_keyboard: [
    [{ text: "◀️ Выбрать другой месяц", callback_data: "summary_menu" }],
    [{ text: "🏠 На старт", callback_data: "back_start" }],
  ],
};
async function showSummaryMenu(chatId) {
  if (!bmEnabled()) {
    await sendMessage(chatId, "Сводка недоступна: интеграция с приложением не настроена.");
    return;
  }
  const { y, mo } = mskYearMonth();
  const rows = [];
  for (let i = 0; i < 6; i++) {
    let yy = y, m2 = mo - i;
    while (m2 <= 0) { m2 += 12; yy -= 1; }
    const ym = yy + "-" + String(m2).padStart(2, "0");
    rows.push([{ text: MONTHS_RU[m2 - 1] + " " + yy, callback_data: "sum_" + ym }]);
  }
  rows.push([{ text: "🏠 На старт", callback_data: "back_start" }]);
  await sendMessage(chatId, "📊 Выберите месяц — покажу список выездов и какие по ним отчёты:", { inline_keyboard: rows });
}
async function showMonthSummary(chatId, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) {
    await sendMessage(chatId, "Неверный месяц.", summaryBackKb);
    return;
  }
  let trips = [];
  try {
    trips = await bmMonthSummary(month);
  } catch (error) {
    logEvent("error", "bmMonthSummary:", error.message);
    await sendMessage(chatId, "⚠️ Не удалось получить сводку из приложения. Попробуйте позже.", summaryBackKb);
    return;
  }
  const [yy, mm] = month.split("-");
  const title = "📊 Сводка за " + (MONTHS_RU[parseInt(mm, 10) - 1] || mm) + " " + yy;
  if (!trips.length) {
    await sendMessage(chatId, title + "\n\nВыездов за этот месяц нет.", summaryBackKb);
    return;
  }
  // [REVIEW-COL] + новые статусы доски KPI: incoming/clarify (заявки) и review (работы завершены — на оценке)
  const statusRu = { incoming: "📥 Входящий запрос", clarify: "❓ На уточнении", planned: "🟦 Запланирован", review: "📝 На оценке", paused: "⏸ На паузе", bad: "❌ Брак", done: "✅ Выполнен" };
  let doneCount = 0;
  const lines = [];
  trips.forEach((t, i) => {
    if (t.status === "done") doneCount++;
    const rep = (t.prelim ? "предв.✅" : "предв.❌") + "  " + (t.final ? "заключ.✅" : "заключ.❌") + (t.quality === "yes" ? "  качество✅" : "");
    const dd = tripDateShort(t.date);
    lines.push(`${i + 1}. ${t.name || "Без названия"}${t.responsible ? " · " + t.responsible : ""}${dd ? " · " + dd : ""}`);
    lines.push(`    ${statusRu[t.status] || t.status} · ${rep}`);
  });
  const head = [title, `Всего выездов: ${trips.length} · выполнено: ${doneCount}`, ""];
  let text = head.concat(lines).join("\n");
  if (text.length > 4000) text = text.slice(0, 3980) + "\n… (список обрезан)";
  await sendMessage(chatId, text, summaryBackKb);
}

// Поля отчёта, зависящие от типа (для сводки и заголовка в чате).
function detailsLines(d) {
  if (d.reportType === "final") {
    return (
      `Выполненные работы: ${d.workDone || "—"}\n` +
      `Не выполнено: ${d.workNotDone || "—"}\n` +
      `Рекомендации: ${d.recommendations || "—"}\n`
    );
  }
  return `Перечень задач: ${d.comment ? d.comment : "—"}\n`;
}

// ===== Сводка перед отправкой =====
function buildSummary(session) {
  const d = session.data;
  return (
    `Проверьте отчёт перед отправкой:\n\n` +
    `Тип: ${reportTypeLabel(d.reportType)}\n` +
    `Выезд: ${d.tripName || d.projectName}\n` +
    (d.linkedProjectName ? `Проект: ${d.linkedProjectName}\n` : "") +
    `Дата выезда: ${d.visitDate}\n` +
    `Ответственное лицо: ${d.responsible}\n` +
    detailsLines(d) +
    `Файлов: ${session.media.length}\n\n` +
    `Отправить в рабочий чат?`
  );
}

// ===== Сборка и отправка готового отчёта в целевой чат =====
async function submitReport(chatId, userId, from) {
  const session = getSession(userId);

  // Защита от двойного нажатия — не отправляем отчёт повторно.
  if (session.submitting) return;
  if (!session.media.length) {
    await sendMessage(chatId, "Вы ещё не прислали ни одного фото или видео. Добавьте файлы.", mediaKeyboard);
    return;
  }
  if (!bmEnabled()) {
    await sendMessage(chatId, "⚠️ Связь с программой выездов не настроена. Отчёт сейчас нельзя сохранить для поиска. Данные в диалоге остались; попробуйте позже.", confirmKeyboard);
    return;
  }
  if (!session.data.tripId && !session.data.tripCreate) {
    await sendMessage(chatId, "Сначала выберите существующий выезд или создайте новый, чтобы отчёт появился в поиске.");
    await offerTripChoice(chatId, session);
    return;
  }
  session.submitting = true;

  const d = session.data;
  const total = session.media.length;
  const header =
    `${d.reportType === "final" ? "✅" : "🟦"} ${reportTypeLabel(d.reportType)} фотоотчёт\n\n` +
    `Выезд: ${d.tripName || d.projectName}\n` +
    (d.linkedProjectName ? `Проект: ${d.linkedProjectName}\n` : "") +
    `Дата выезда: ${d.visitDate}\n` +
    `Ответственное лицо: ${d.responsible}\n` +
    detailsLines(d) +
    `Файлов: ${total}\n` +
    `Отправил: ${senderName(from)}`;

  // Заголовок в рабочий чат. Если упало — бот не в группе / нет прав: сообщаем и даём повторить.
  let headerMessageId;
  try {
    const headerMessage = await sendMessage(TARGET_CHAT_ID, header);
    headerMessageId = Number(headerMessage && headerMessage.message_id);
    if (!Number.isSafeInteger(headerMessageId) || headerMessageId <= 0) {
      throw new Error("Telegram не вернул ID заголовка отчёта");
    }
  } catch (error) {
    logEvent("error", "target header error:", error.message);
    session.submitting = false;
    await sendMessage(
      chatId,
      "❌ Не удалось отправить в рабочий чат. Проверьте, что бот добавлен в группу и может писать сообщения. " +
        "Данные сохранены — нажмите «Подтвердить и отправить» ещё раз.",
      confirmKeyboard
    );
    return;
  }

  await sendMessage(chatId, "Отправляю файлы…").catch((error) => {
    logEvent("warn", "private progress message:", error.message);
  });

  // Каждое медиа копируем по file_id (без перезагрузки — поэтому размер не ограничен).
  // Пауза между файлами + автоповтор 429 в tg() — чтобы не терять файлы из-за лимита Telegram.
  const total0 = session.media.length;
  logEvent("info", `Пересылка ${total0} файлов в рабочий чат (отправитель: ${senderName(from)})`);
  let sent = 0;
  let failed = 0;
  const mediaMessageIds = [];
  for (let i = 0; i < session.media.length; i++) {
    const item = session.media[i];
    try {
      const copied = await tg("copyMessage", {
        chat_id: TARGET_CHAT_ID,
        from_chat_id: item.chatId,
        message_id: item.messageId,
      });
      const copiedId = Number(copied && copied.message_id);
      if (!Number.isSafeInteger(copiedId) || copiedId <= 0) {
        throw new Error("Telegram не вернул ID скопированного файла");
      }
      mediaMessageIds.push(copiedId);
      sent += 1;
    } catch (error) {
      failed += 1;
      logEvent("error", `copyMessage #${i + 1}/${total0} не удалось: ${error.message}`);
    }
    // Throttle: пауза между отправками снижает риск упереться в лимит группы.
    await sleep(400);
  }
  logEvent("info", `Переслано ${sent}/${total0}, ошибок ${failed}`);

  if (sent === 0) {
    session.submitting = false;
    await sendMessage(chatId,
      "❌ Ни один файл не дошёл до рабочего чата. Данные отчёта сохранены — нажмите «Подтвердить и отправить» ещё раз.",
      confirmKeyboard
    );
    return;
  }

  const report = {
    id: "m" + headerMessageId,
    type: d.reportType === "final" ? "final" : "prelim",
    chatId: TARGET_CHAT_ID,
    headerMessageId,
    mediaMessageIds,
    pdfMessageId: null,
    visitDate: String(d.visitDate || ""),
    projectName: String(d.linkedProjectName || ""),
    sentAt: new Date().toISOString(),
  };

  // PDF может строиться долго. Уже скопированные в рабочий чат медиа фиксируем
  // до его создания; при перезапуске отчёт восстановится хотя бы без PDF.
  let stagedPayload = null;
  if (d.reportType === "final") {
    stagedPayload = d.tripCreate ? {
      op: "create", kind: "final", name: d.tripName || d.projectName,
      date: d.visitDate, comment: d.tripTasks || "", workDone: d.workDone,
      workNotDone: d.workNotDone, recommendations: d.recommendations,
      by: senderName(from), report,
    } : { op: "attach_report", tripId: d.tripId, report };
    try {
      reportOutbox.queueReport(report.id, stagedPayload, true);
    } catch (error) {
      logEvent("error", `report_index ${report.id}: не удалось подготовить дисковую очередь: ${error.message}`);
    }
  }

  // Предварительный отчёт: пометить карточку выезда в приложении (если выезд выбран из списка).
  // Бот отмечает trip.checks.prelim → в KPI-приложении видно «Предварительный отчёт ✓».
  // Новый выезд в предварительном отчёте: сначала заводим карточку, потом ставим отметку.
  if (d.reportType !== "final" && bmEnabled() && !d.tripId && d.tripCreate) {
    try {
      const created = await postReportWithOutbox({
        op: "create",
        kind: "prelim",              // карточка заводится по ПРЕДВАРИТЕЛЬНОМУ отчёту
        name: d.tripName || d.projectName,
        date: d.visitDate,
        comment: d.tripTasks || d.comment || "",
        by: senderName(from),
        report,
      });
      if (created && created.id) {
        d.tripId = created.id;
        await sendMessage(chatId, `✅ В приложении создана карточка выезда «${d.tripName || d.projectName}» с задачами.`).catch(() => {});
      }
    } catch (error) {
      logEvent("error", "bm create (pre):", error.message);
      await sendMessage(chatId,
        "⚠️ Отчёт отправлен в чат, но карточка выезда пока не создана: " + error.message +
        (error.indexQueued
          ? "\n\nБот сохранил запрос на повтор. Не создавайте карточку вручную, чтобы не получить дубль."
          : "\n\nСообщите руководителю: автоматический повтор недоступен.")
      ).catch(() => {});
    }
  }
  if (d.reportType !== "final" && bmEnabled() && d.tripId && !d.tripCreate) {
    try {
      const prelim = { op: "preliminary", tripId: d.tripId, tasks: d.tripTasks || d.comment || "", by: senderName(from), report };
      await postReportWithOutbox(prelim, { op: "attach_report", tripId: d.tripId, report });
      logEvent("info", "Отметка предварительного отчёта поставлена, tripId=" + d.tripId);
      await sendMessage(chatId,
        `✅ Бот отметил в карточке выезда${d.tripName ? " «" + d.tripName + "»" : ""}: предварительный отчёт получен.`
      ).catch(() => {});
    } catch (error) {
      logEvent("error", "bm preliminary mark:", error.message);
      await sendMessage(chatId,
        "⚠️ Предварительный отчёт отправлен в чат, но отметку в карточке поставить не удалось: " + error.message +
        (error.indexAttached
          ? "\n\nФайлы уже доступны через поиск. Проверьте отметку отчёта и задачи в карточке выезда."
          : error.indexQueued
            ? "\n\nБот повторит сохранение файлов для поиска. Отметку нужно проверить в карточке выезда."
            : "\n\nСообщите руководителю: автоматический повтор недоступен.")
      ).catch(() => {});
    }
  } else if (d.reportType !== "final" && bmEnabled() && !d.tripId && !d.tripCreate) {
    // Выезд не выбран из списка → отмечать нечего. Предупреждаем сразу, чтобы «качественный» потом не оказался заблокирован.
    await sendMessage(chatId,
      "⚠️ Выезд не был выбран из списка, поэтому отметка «предварительный отчёт получен» в карточке не проставлена.\n\n" +
      "Чтобы выезд можно было отметить «качественным», отправьте предварительный отчёт ещё раз через /start и выберите выезд из списка."
    ).catch(() => {});
  }

  // Фирменный PDF-отчёт для заказчика — только по заключительному выезду.
  let pdfNote = "";
  if (d.reportType === "final") {
    try {
      await sendMessage(chatId, "Формирую фирменный PDF-отчёт для заказчика…").catch((error) => {
        logEvent("warn", "private PDF progress message:", error.message);
      });
      const photoIds = session.media
        .filter((m) => m.kind === "photo" && m.fileId)
        .slice(0, PDF_MAX_PHOTOS)
        .map((m) => m.fileId);
      const photos = [];
      let photoBytes = 0;
      for (const fileId of photoIds) {
        try {
          const photo = await downloadFile(fileId);
          if (photoBytes + photo.length > PDF_INPUT_BUDGET_BYTES) {
            logEvent("warn", "PDF photo skipped: input size budget exceeded");
            continue;
          }
          photos.push(photo);
          photoBytes += photo.length;
        } catch (error) {
          logEvent("error", "photo download error:", error.message);
        }
      }
      const pdfData = {
        tripName: d.tripName || d.projectName,
        projectName: d.linkedProjectName || "",
        visitDate: d.visitDate,
        responsible: d.responsible,
        workDone: d.workDone,
        workNotDone: d.workNotDone,
        recommendations: d.recommendations,
      };
      let pdfPhotos = photos;
      let pdf;
      do {
        pdf = await buildVisitPdf(pdfData, pdfPhotos, { brand: BRAND });
        if (pdf.length <= PDF_UPLOAD_LIMIT_BYTES) break;
        if (!pdfPhotos.length) throw new Error("PDF превышает лимит загрузки Telegram 50 МБ");
        logEvent("warn", `PDF ${pdf.length} bytes exceeds Telegram limit, reducing photo count`);
        pdfPhotos = pdfPhotos.slice(0, Math.floor(pdfPhotos.length / 2));
      } while (true);
      const filename = pdfFilename(d);
      const caption = "Направляю Вам файл с отчетом по работам";
      // В рабочий чат (после отчёта) и сотруднику в личку.
      const pdfMessage = await sendDocument(TARGET_CHAT_ID, pdf, filename, caption);
      const pdfId = Number(pdfMessage && pdfMessage.message_id);
      if (Number.isSafeInteger(pdfId) && pdfId > 0) {
        report.pdfMessageId = pdfId;
        // Личная отправка PDF может длиться долго. Фиксируем ID файла из рабочего
        // чата сразу, чтобы рестарт не восстановил только фото и видео.
        try { reportOutbox.queueReport(report.id, stagedPayload, true); }
        catch (error) { logEvent("error", `report_index ${report.id}: не удалось сохранить PDF ID: ${error.message}`); }
      }
      try {
        await sendDocument(chatId, pdf, filename, caption);
        pdfNote = `\n📄 PDF-отчёт сформирован (фото в нём: ${pdfPhotos.length}) и отправлен в чат и вам в личку.`;
      } catch (error) {
        logEvent("error", "pdf private send error:", error.message);
        pdfNote = "\n⚠️ PDF-отчёт отправлен в рабочий чат, но в личку отправить его не удалось.";
      }
    } catch (error) {
      logEvent("error", "pdf error:", error.message);
      pdfNote = "\n⚠️ PDF-отчёт сформировать не удалось — текст и файлы в чат отправлены.";
    }

    report.sentAt = new Date().toISOString();

    // Запись результата в карточку выезда KPI-приложения (если интеграция включена).
    let kpiTripId = d.tripId || null;
    if (bmEnabled()) {
      try {
        if (d.tripCreate) {
          // Запасная кнопка «Создать карточку» — заводим выезд из данных бота.
          const created = await postReportWithOutbox({
            op: "create",
            kind: "final",
            name: d.tripName || d.projectName,
            date: d.visitDate,
            comment: d.tripTasks || "",
            workDone: d.workDone,
            workNotDone: d.workNotDone,
            recommendations: d.recommendations,
            by: senderName(from),
            report,
          });
          kpiTripId = created.id || null;
          // Новая карточка → есть только заключительный отчёт; предупреждаем, иначе «качественный» будет заблокирован.
          await sendMessage(chatId,
            `✅ Создана карточка выезда «${d.tripName || d.projectName}» с отметкой «заключительный отчёт получен».\n\n` +
            "⚠️ В этой карточке нет предварительного отчёта — «качественный» откроется только после того, как по этому же выезду поступит и предварительный отчёт."
          ).catch(() => {});
        } else if (kpiTripId) {
          const finalReport = {
            op: "final_report",
            tripId: kpiTripId,
            workDone: d.workDone,
            workNotDone: d.workNotDone,
            recommendations: d.recommendations,
            by: senderName(from),
            report,
          };
          await postReportWithOutbox(finalReport, { op: "attach_report", tripId: kpiTripId, report });
          await sendMessage(chatId,
            `✅ Бот отметил в карточке выезда${d.tripName ? " «" + d.tripName + "»" : ""}: заключительный отчёт получен.`
          ).catch(() => {});
        } else {
          // Выезд не выбран и карточка не создана → отмечать нечего. Сообщаем, чтобы отметку не искали зря.
          await sendMessage(chatId,
            "⚠️ Выезд не был выбран из списка, поэтому отметка «заключительный отчёт получен» в карточке не проставлена.\n\n" +
            "Отправьте заключительный отчёт ещё раз через /start и выберите выезд из списка (тот же, что и для предварительного отчёта)."
          ).catch(() => {});
        }
      } catch (error) {
        logEvent("error", "bm kpi-запись:", error.message);
        // [B1] Не молчим: отчёт ушёл в чат, но в карточку выезда (приложение) не записался.
        await sendMessage(chatId,
          "⚠️ Отчёт отправлен в рабочий чат, но запись в карточке выезда не завершена: " + error.message +
          (error.indexAttached
            ? "\n\nФайлы уже доступны через поиск. Проверьте отметку отчёта и тексты работ в карточке выезда."
            : error.indexQueued
              ? "\n\nБот сохранил запрос на повтор. Не создавайте карточку вручную, чтобы не получить дубль."
              : "\n\nСообщите руководителю: автоматический повтор недоступен.")
        ).catch(() => {});
      }
    }

    // Кнопки оценки качества выезда — в рабочий чат (нажимают только оценщики).
    // Если выезд привязан к карточке — оценка запишется в KPI (callback несёт tripId).
    const qk = kpiTripId
      ? {
          inline_keyboard: [
            [{ text: "✅ Выезд качественный", callback_data: "quality_ok|" + kpiTripId }],
            [{ text: "⚠️ Выезд не качественный", callback_data: "quality_bad|" + kpiTripId }],
          ],
        }
      : qualityKeyboard;
    try {
      await sendMessage(
        TARGET_CHAT_ID,
        `🔎 Оценка качества выезда\n\n` +
          `Выезд: ${d.tripName || d.projectName}\n` +
          (d.linkedProjectName ? `Проект: ${d.linkedProjectName}\n` : "") +
          `Дата выезда: ${d.visitDate}\n` +
          `Выездник: ${d.responsible}`,
        qk
      );
    } catch (error) {
      logEvent("error", "quality buttons error:", error.message);
    }

    // Третье сообщение — тег ответственных для уведомления.
    try {
      const mentions = NOTIFY_FINAL
        .map((u) => u.id
          ? `<a href="tg://user?id=${u.id}">${htmlEscape(u.name)}</a>`
          : `@${htmlEscape(u.username)}`)
        .join(" ");
      await tg("sendMessage", {
        chat_id: TARGET_CHAT_ID,
        text: `🔔 ${mentions} — поступил заключительный отчёт по выезду «${htmlEscape(d.tripName || d.projectName)}». Просьба проверить.`,
        parse_mode: "HTML",
      });
    } catch (error) {
      logEvent("error", "notify mentions error:", error.message);
    }
  }

  resetSession(userId);

  if (sent > 0) {
    const tail = sent < total ? ` (из ${total}; ${total - sent} не удалось)` : "";
    await sendMessage(
      chatId,
      `✅ Отчёт отправлен в рабочий чат. Файлов переслано: ${sent}${tail}.${pdfNote}\n\nНовый отчёт — /start.`
    );
  } else {
    await sendMessage(chatId, `❌ Не удалось переслать файлы. Попробуйте ещё раз: /start.${pdfNote}`);
  }
}

// ===== Обработка обычных сообщений =====
async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from.id;

  // [BAD-REASON] Рабочая группа: ловим причину «не качественный» от оценщика; прочие сообщения групп игнорируем.
  if (message.chat.type !== "private") {
    if (String(chatId) === String(TARGET_CHAT_ID)) {
      try { await maybeHandleBadReason(message); } catch (error) { logEvent("error", "badReason:", error.message); }
    }
    return;
  }

  if (!isAllowed(userId)) {
    await sendMessage(
      chatId,
      `🚫 Нет доступа к боту.\n\nВаш Telegram ID: ${userId}\nПередайте его администратору, чтобы вас добавили.`
    );
    return;
  }

  const text = (message.text || "").trim();

  if (text === "/start" || text === "/new") {
    await startReport(chatId, userId);
    return;
  }
  // [MINIAPP] Запасные входы: кнопок «Посмотреть выезды» и «Сводка за месяц» в меню больше нет
  // (их заменило мини-приложение), но команды остаются — на случай, если приложение не открылось
  // или нужна общая сводка по всем выездам месяца.
  if (text === "/trips" || text === "/vyezdy") {
    await showTripsForView(chatId, getSession(userId));
    return;
  }
  if (text === "/summary" || text === "/svodka") {
    await showSummaryMenu(chatId);
    return;
  }
  if (text === "/cancel") {
    resetSession(userId);
    await sendMessage(chatId, "Отменено. Чтобы начать заново — /start.");
    return;
  }
  // Изменить ФИО профиля.
  if (text === "/profile" || text === "/fio") {
    const session = getSession(userId);
    session.step = "register_fio";
    let cur = session.profileFio;
    if (!cur && bmEnabled()) {
      try {
        const p = await bmGetProfile(userId);
        cur = p && p.fio;
      } catch (error) {
        logEvent("error", "bmGetProfile(/profile):", error.message);
      }
    }
    await sendMessage(chatId, `Ваше ФИО: ${cur || "не задано"}\n\nВведите новое ФИО:`);
    return;
  }

  const session = getSession(userId);

  // Приём фото/видео работает на шаге сбора файлов и на шаге сводки (можно дослать).
  const incomingMedia = message.photo || message.video || message.document || message.animation;
  // Файл прислали раньше времени (например, на шаге названия или задач). Отвечаем ОДИН раз:
  // альбом из десяти фото иначе давал десять одинаковых переспросов подряд.
  if (incomingMedia && session.step !== "media" && session.step !== "confirm" && session.step !== "idle") {
    if (!session.earlyMediaHint) {
      session.earlyMediaHint = true;
      await sendMessage(chatId, "Фото и видео попрошу чуть позже — сейчас ответьте текстом на вопрос выше.");
      setTimeout(() => { const ss = sessions.get(userId); if (ss) ss.earlyMediaHint = false; }, 20000);
    }
    return;
  }
  if (incomingMedia && (session.step === "media" || session.step === "confirm")) {
    // Сохраняем ссылку для пересылки (copyMessage) + file_id фото для вставки в PDF.
    const item = { chatId, messageId: message.message_id, kind: "other", fileId: null };
    if (message.photo && message.photo.length) {
      item.kind = "photo";
      item.fileId = message.photo[message.photo.length - 1].file_id; // наибольший размер
    } else if (message.document && /^image\//.test(message.document.mime_type || "")) {
      item.kind = "photo"; // изображение, присланное «файлом»
      item.fileId = message.document.file_id;
    } else if (message.video) {
      item.kind = "video";
    }
    session.media.push(item);
    session.step = "media";
    if (!session.mediaHintShown) {
      session.mediaHintShown = true;
      await sendMessage(chatId, "Файлы принимаются. Присылайте ещё, а когда закончите — «Отправить отчёт».", mediaKeyboard);
    }
    return;
  }

  switch (session.step) {
    // Шаг остался для старых сообщений в истории чата (кнопка «использовать название»).
    case "project":
      if (!text) return sendMessage(chatId, "Введите наименование проекта текстом.");
      session.data.projectName = text;
      session.step = "date";
      return sendMessage(chatId, DATE_PROMPT, dateKeyboard);

    // ── Новый выезд: название, затем задачи. Оба поля обязательны. ──
    case "newtrip_name": {
      const name = (text || "").trim();
      if (!name) return sendMessage(chatId, "Напишите название выезда текстом — например: ЖК «Прайм Парк», макет 1:500");
      if (name.length > 120) return sendMessage(chatId, "Слишком длинное название — уложитесь в 120 знаков.");
      session.data.tripName = name;
      session.data.projectName = name;      // подпись PDF, если отдельный проект не привязан
      session.data.linkedProjectName = "";
      return askNewTripTasks(chatId, session);
    }

    case "newtrip_tasks": {
      const tasks = (text || "").trim();
      if (!tasks) return sendMessage(chatId, "Перечислите задачи текстом — без них карточка выезда будет пустой.");
      session.data.tripTasks = tasks;
      session.data.comment = tasks;         // в отчёт идут те же задачи
      return goChecklist(chatId, session);
    }

    case "register_fio": {
      const fio = (text || "").trim();
      if (!fio) return sendMessage(chatId, "Введите ФИО текстом (например: Иванов Иван).");
      session.profileFio = fio;
      let fioSaved = !bmEnabled(); // без интеграции профиль живёт в сессии — это норма
      if (bmEnabled()) {
        try {
          await bmSaveProfile(userId, fio);
          fioSaved = true;
        } catch (error) {
          logEvent("error", "bmSaveProfile:", error.message);
        }
      }
      await sendMessage(chatId, fioSaved
        ? `Спасибо, ${fio}! Профиль сохранён.`
        : `Принято: ${fio}. Сохранить профиль в приложении сейчас не удалось — использую имя в этой сессии.`);
      return showTypeMenu(chatId, session);
    }

    case "date":
      if (!text) return sendMessage(chatId, "Введите дату выезда текстом.");
      session.data.visitDate = text;
      return askResponsibleOrSkip(chatId, session);

    case "responsible":
      if (!text) return sendMessage(chatId, "Введите ответственное лицо текстом.");
      session.data.responsible = text;
      return goAfterResponsible(chatId, session);

    case "workdone":
      if (!text) return sendMessage(chatId, "Опишите выполненные работы текстом.");
      session.data.workDone = text;
      session.step = "worknotdone";
      return sendMessage(chatId, "Какие работы не выполнены (если есть) и почему? Опишите или нажмите «Всё выполнено».", workNotDoneKeyboard);

    case "worknotdone":
      if (!text) return sendMessage(chatId, "Опишите невыполненные работы или нажмите «Всё выполнено».");
      session.data.workNotDone = text;
      session.step = "recommendations";
      return sendMessage(chatId, "Рекомендации по макету (если есть)? Опишите или нажмите «Рекомендаций нет».", recommendationsKeyboard);

    case "recommendations":
      if (!text) return sendMessage(chatId, "Опишите рекомендации или нажмите «Рекомендаций нет».");
      session.data.recommendations = text;
      session.step = "media";
      return sendMessage(chatId, MEDIA_PROMPT, mediaKeyboard);

    case "comment":
      session.data.comment = text;
      session.step = "media";
      return sendMessage(chatId, MEDIA_PROMPT, mediaKeyboard);

    case "media":
      return sendMessage(chatId, "Пришлите фото или видео, либо нажмите «Отправить отчёт».", mediaKeyboard);

    case "confirm":
      return sendMessage(chatId, "Нажмите «Подтвердить и отправить» или «Добавить ещё файлы».", confirmKeyboard);

    case "picktrip":
      return sendMessage(chatId, "Выберите выезд кнопкой выше или нажмите «➕ Новый выезд — нет в списке».");

    default:
      return sendMessage(chatId,
        "Чтобы создать фотоотчёт о выезде — отправьте /start.\n"
        + "Список выездов — /trips, сводка за месяц — /summary.");
  }
}

// ===== Обработка нажатий на кнопки =====
// [BAD-REASON] «Не качественный»/«Не выполнен» → сперва причина из чата, оценка запишется после её получения.
// Кнопки исходного сообщения НЕ убираем до записи: если причина не пришла (TTL/рестарт бота) — жмут заново.
async function requestBadReason(callback, { kind, tripId }) {
  const msg = callback.message;
  let ask = null;
  try {
    ask = await sendMessage(
      msg.chat.id,
      `⚠️ ${senderName(callback.from)}, укажите причину — ${kind === "board" ? "почему выезд не выполнен" : "почему выезд не качественный"}?\n\n` +
        `Ответьте (Reply) на это сообщение или просто напишите причину следующим сообщением. ` +
        `Причина попадёт в карточку выезда, карточка будет перемещена в «Брак».`
    );
  } catch (error) {
    logEvent("error", "requestBadReason:", error.message);
  }
  const chatMap = badReasonChatMap(msg.chat.id);
  const prev = chatMap.get(callback.from.id);
  if (prev && prev.tripId !== tripId && Date.now() - prev.ts <= BAD_REASON_TTL_MS) {
    // [REVIEW-168] У оценщика уже открыт запрос по ДРУГОМУ выезду — прежний аннулируем ЯВНО (не молча).
    await sendMessage(msg.chat.id, `ℹ️ ${senderName(callback.from)}, прежний запрос причины отменён — теперь жду причину по новой оценке. Прежнюю оценку можно поставить заново кнопкой.`).catch(() => {});
  }
  chatMap.set(callback.from.id, {
    kind,                                   // 'quality' (кнопка оценки) | 'board' (кнопка статуса)
    tripId,
    reviewerId: callback.from.id,
    reviewerName: senderName(callback.from),
    requestMsgId: ask && ask.message_id,
    voteChatId: msg.chat.id,
    voteMsgId: msg.message_id,
    voteText: msg.text || "",
    ts: Date.now(),
  });
  await tg("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "Напишите причину в чате — после этого оценка запишется.",
  }).catch(() => {});
}

// [BAD-REASON] Приём причины в рабочем чате. Возвращает true, если сообщение обработано как причина.
// [REVIEW-168] Матчинг: Reply на КОНКРЕТНЫЙ запрос → тот pending (любой автор — явный адресат);
// без Reply → только СВОЙ pending отправителя. Reply на постороннее сообщение — НЕ причина.
// Команды («/…») — не причина. Текст «отмена»/«-» — отменить запрос без записи оценки.
async function maybeHandleBadReason(message) {
  const chatMap = badReasonChatMap(message.chat.id);
  if (!chatMap.size) return false;
  // чистим протухшие (кнопки живы — жмут заново)
  for (const [rid, pp] of chatMap) { if (Date.now() - pp.ts > BAD_REASON_TTL_MS) chatMap.delete(rid); }
  if (!chatMap.size) return false;
  let p = null, isReply = false;
  if (message.reply_to_message) {
    // Reply: принимаем ТОЛЬКО если это ответ на один из НАШИХ запросов причины (иначе это чужой разговор)
    for (const pp of chatMap.values()) {
      if (pp.requestMsgId && message.reply_to_message.message_id === pp.requestMsgId) { p = pp; isReply = true; break; }
    }
    if (!p) return false;                               // reply на постороннее сообщение — не причина
  } else {
    p = message.from ? chatMap.get(message.from.id) : null; // без reply — только свой запрос
    if (!p) return false;
  }
  const text = (message.text || "").trim();
  if (!text) {                                          // фото/стикер вместо текста
    if (isReply) await sendMessage(message.chat.id, "Пришлите причину текстом, пожалуйста.").catch(() => {});
    return isReply;
  }
  if (text.startsWith("/")) return false;               // команды бота — не причина
  if (/^(отмена|-|отменить)$/i.test(text)) {            // явная отмена запроса причины
    chatMap.delete(p.reviewerId);
    await sendMessage(message.chat.id, "ℹ️ Запрос причины отменён — оценка не записана, кнопки остаются активными.").catch(() => {});
    return true;
  }
  const reason = text.slice(0, 2000);
  try {
    if (p.kind === "board") {
      await bmApi("POST", { op: "set_board", tripId: p.tripId, status: "bad", reason, by: p.reviewerName });
    } else {
      await bmApi("POST", { op: "set_quality", tripId: p.tripId, quality: "no", reason, by: p.reviewerName });
    }
  } catch (error) {
    logEvent("error", "bm bad reason:", error.message);
    chatMap.delete(p.reviewerId);
    await sendMessage(message.chat.id, "⚠️ Не удалось записать оценку в приложение: " + error.message + ". Нажмите кнопку оценки ещё раз.").catch(() => {});
    return true;
  }
  chatMap.delete(p.reviewerId);
  // Фиксируем оценку и причину в исходном сообщении с кнопками (кнопки убираются).
  const isBoard = p.kind === "board";
  const splitKey = isBoard ? "\n\n— Статус —" : "\n\n— Оценка —";
  const baseText = (p.voteText || "").split(splitKey)[0] || (isBoard ? "Отмечаем что выезд выполнен?" : "🔎 Оценка качества выезда");
  const mark = isBoard ? "— Статус —\n⚠️ Выезд отмечен как БРАК" : "— Оценка —\n⚠️ Выезд отмечен как НЕ качественный";
  const newText = `${baseText}\n\n${mark}\nПричина: ${reason}\nОценил: ${p.reviewerName} · ${nowMoscow()}`;
  try {
    await tg("editMessageText", { chat_id: p.voteChatId, message_id: p.voteMsgId, text: newText });
  } catch (error) {
    logEvent("error", "editMessageText(badReason):", error.message); // [REVIEW-168] сбой не глотаем молча
    await tg("editMessageReplyMarkup", { chat_id: p.voteChatId, message_id: p.voteMsgId }).catch(() => {});
  }
  await sendMessage(message.chat.id, "✅ Причина записана в карточку выезда. Карточка перемещена в «Брак».").catch(() => {});
  return true;
}

// Оценка качества выезда кнопками в рабочем чате. Реагирует только на оценщиков;
// остальным — всплывающее уведомление, сообщение не меняется.
async function handleQualityVote(callback) {
  const userId = callback.from.id;
  const msg = callback.message;

  if (!isReviewer(userId)) {
    await tg("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Оценивать качество выезда может только ответственный.",
      show_alert: true,
    });
    return;
  }

  const good = callback.data.startsWith("quality_ok");
  // tripId передаётся в callback после «|», если выезд был привязан к карточке.
  const tripId = callback.data.includes("|") ? callback.data.split("|")[1] : null;

  // [BAD-REASON] «Не качественный» → сперва спрашиваем причину в чате; оценка запишется после её получения.
  if (!good && bmEnabled() && tripId) {
    return requestBadReason(callback, { kind: "quality", tripId });
  }

  // Запись оценки в карточку выезда KPI-приложения.
  if (bmEnabled() && tripId) {
    try {
      await bmApi("POST", {
        op: "set_quality",
        tripId,
        quality: good ? "yes" : "no",
        by: senderName(callback.from),
      });
      clearBadReasonPending(msg.chat.id, callback.from.id, tripId); // [BAD-REASON] «качественный» по ЭТОМУ выезду отменяет СВОЙ запрос причины (чужие не трогаем)
    } catch (error) {
      logEvent("error", "bm set_quality:", error.message);
      // [REVIEW-168] Оценщик явно переключился на «качественный» — его незакрытый запрос причины по этому
      // выезду снимаем ДАЖЕ при отказе (409): иначе его следующее сообщение в чат ушло бы причиной брака.
      clearBadReasonPending(msg.chat.id, callback.from.id, tripId);
      // Правило приложения (HTTP 409): «качественный» нельзя без предв. И заключ. отчёта —
      // показываем причину как есть, кнопки оставляем (можно выбрать «не качественный»).
      const ruleBlock = error.code === 'reports_required' || /отч[её]т/i.test(error.message);
      await tg("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: ruleBlock
          ? "⚠️ " + error.message
          : "⚠️ Не удалось записать оценку в приложение: " + error.message + ". Попробуйте ещё раз.",
        show_alert: true,
      }).catch(() => {});
      return;
    }
  }

  const verdict = good ? "✅ Выезд отмечен как КАЧЕСТВЕННЫЙ" : "⚠️ Выезд отмечен как НЕ качественный";
  // Сохраняем исходный текст (проект/дата/выездник), отбрасывая прежнюю отметку, если была.
  const baseText = (msg.text || "🔎 Оценка качества выезда").split("\n\n— Оценка —")[0];
  const newText = `${baseText}\n\n— Оценка —\n${verdict}\nОценил: ${senderName(callback.from)} · ${nowMoscow()}`;

  try {
    // editMessageText без reply_markup убирает кнопки — повторно оценить нельзя.
    await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: newText });
  } catch (error) {
    logEvent("error", "editMessageText error:", error.message);
    await tg("editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
  }

  await tg("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: good ? "Отмечено: качественный" : "Отмечено: не качественный",
  });

  // После оценки — спросить у ответственного финальный статус выезда (Выполнен/Брак).
  if (bmEnabled() && tripId) {
    try {
      await sendMessage(
        TARGET_CHAT_ID,
        `${STATUS_MENTION} Отмечаем что выезд выполнен?`,
        {
          inline_keyboard: [
            [{ text: "✅ Выполнен", callback_data: "done_ok|" + tripId }],
            [{ text: "⚠️ Не выполнен", callback_data: "done_bad|" + tripId }],
          ],
        }
      );
    } catch (error) {
      logEvent("error", "status buttons:", error.message);
    }
  }
}

// Финальный статус выезда (кнопки «Выполнен/Не выполнен» в чате). Только оценщики.
async function handleStatusVote(callback) {
  const userId = callback.from.id;
  const msg = callback.message;

  if (!isReviewer(userId)) {
    await tg("answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Отмечать статус выезда может только ответственный.",
      show_alert: true,
    });
    return;
  }

  const done = callback.data.startsWith("done_ok");
  const tripId = callback.data.includes("|") ? callback.data.split("|")[1] : null;

  // [BAD-REASON] «Не выполнен» = брак → сперва причина из чата (как у кнопки «Не качественный»).
  if (!done && bmEnabled() && tripId) {
    return requestBadReason(callback, { kind: "board", tripId });
  }

  // Меняем статус выезда в карточке: done → «Выполнено», bad → «Брак».
  if (bmEnabled() && tripId) {
    try {
      await bmApi("POST", {
        op: "set_board",
        tripId,
        status: done ? "done" : "bad",
        by: senderName(callback.from),
      });
      clearBadReasonPending(msg.chat.id, callback.from.id, tripId); // [BAD-REASON] «выполнен» по ЭТОМУ выезду отменяет СВОЙ запрос причины (чужие не трогаем)
    } catch (error) {
      logEvent("error", "bm set_board:", error.message);
      // [B1] Не записалось — не помечаем, даём повторить (кнопки остаются).
      await tg("answerCallbackQuery", {
        callback_query_id: callback.id,
        text: "⚠️ Не удалось записать статус в приложение: " + error.message + ". Попробуйте ещё раз.",
        show_alert: true,
      }).catch(() => {});
      return;
    }
  }

  const verdict = done ? "✅ Выезд отмечен ВЫПОЛНЕННЫМ" : "⚠️ Выезд отмечен как БРАК";
  const baseText = (msg.text || "Отмечаем что выезд выполнен?").split("\n\n— Статус —")[0];
  const newText = `${baseText}\n\n— Статус —\n${verdict}\nОтметил: ${senderName(callback.from)} · ${nowMoscow()}`;

  try {
    await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: newText });
  } catch (error) {
    logEvent("error", "editMessageText(status):", error.message);
    await tg("editMessageReplyMarkup", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
  }

  await tg("answerCallbackQuery", {
    callback_query_id: callback.id,
    text: done ? "Отмечено: выполнен" : "Отмечено: брак",
  });
}

async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const userId = callback.from.id;
  const data = callback.data;

  // Кнопки оценки качества (в рабочем чате) — отдельная ветка со своей проверкой прав.
  // callback может нести tripId после «|» (quality_ok|<id>).
  if (data.startsWith("quality_ok") || data.startsWith("quality_bad")) {
    return handleQualityVote(callback);
  }
  // Кнопки финального статуса выезда (Выполнен/Брак) — тоже своя проверка прав.
  if (data.startsWith("done_ok") || data.startsWith("done_bad")) {
    return handleStatusVote(callback);
  }

  if (!isAllowed(userId)) {
    await tg("answerCallbackQuery", { callback_query_id: callback.id, text: "Нет доступа" });
    await sendMessage(chatId, `🚫 Нет доступа. Ваш Telegram ID: ${userId}`);
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: callback.id });

  const session = getSession(userId);

  // Пока бот ждёт НАЗВАНИЕ или ЗАДАЧИ, кнопки из старых сообщений не действуют. Иначе нажатие
  // «📅 Сегодня» или «Пропустить» в прошлой переписке перепрыгивало обязательный шаг: отчёт уходил
  // в чат с «Проект: undefined», а в приложении заводилась карточка без названия и задач.
  // Исключения — выход из тупика: начать заново и отменить.
  if ((session.step === "newtrip_name" || session.step === "newtrip_tasks")
      && data !== "back_start" && data !== "cancel") {
    await sendMessage(chatId, session.step === "newtrip_name"
      ? "Сначала напишите название выезда текстом (или /cancel, чтобы отменить)."
      : "Сначала перечислите задачи текстом (или /cancel, чтобы отменить).");
    return;
  }

  // Режим просмотра выездов (без оформления отчёта).
  // [MINIAPP] Кнопок «Посмотреть выезды» и «Сводка за месяц» в меню больше нет — их заменило
  // мини-приложение. Обработчики оставлены намеренно: в истории чатов остались старые сообщения
  // с этими кнопками, и нажатие на них должно работать, а не молчать.
  if (data === "view_trips") {
    await showTripsForView(chatId, session);
    return;
  }
  if (data.startsWith("view_")) {
    await showTripDetails(chatId, session, data.slice(5));
    return;
  }
  // [MONTH-SUMMARY] Сводка за месяц
  if (data === "summary_menu") {
    await showSummaryMenu(chatId);
    return;
  }
  if (data.startsWith("sum_")) {
    await showMonthSummary(chatId, data.slice(4));
    return;
  }
  if (data === "back_start") {
    await startReport(chatId, userId);
    return;
  }

  if (data === "type_pre" || data === "type_final") {
    session.data.reportType = data === "type_final" ? "final" : "pre";
    // Вторым действием — выбор выезда из отдела «Выезды».
    await offerTripChoice(chatId, session);
    return;
  }

  // Выбор выезда из списка / «➕ Новый выезд» (pick_create; pick_skip остался для старых сообщений).
  if (data.startsWith("pick_")) {
    const key = data.slice(5);
    if (session.step !== "picktrip") {
      await sendMessage(chatId, "Список выездов устарел. Начните оформление заново через /start.");
      return;
    }
    if (key === "retry") return offerTripChoice(chatId, session);
    const pageMatch = /^page_([a-f0-9]{6})_(\d{1,4})$/.exec(key);
    if (pageMatch) {
      if (pageMatch[1] !== session.tripChoiceToken) {
        await sendMessage(chatId, "Список выездов обновился. Используйте последнее сообщение со списком.");
        return;
      }
      return offerTripChoice(chatId, session, Number(pageMatch[2]), true);
    }
    if (key === "skip") {
      // Кнопки «Пропустить» больше нет. Нажатие в старом сообщении не оставляем молча:
      // без выезда отчёт не отметится в приложении.
      await sendMessage(chatId, "Отчёт теперь всегда привязывается к выезду. Выберите выезд из списка или заведите новый — /start.");
      return;
    } else if (key === "create") {
      // Новый выезд: спрашиваем название и задачи, карточка заведётся при отправке отчёта.
      session.data.tripId = null;
      session.data.tripCreate = true;
      return askNewTripName(chatId, session);
    } else {
      const indexMatch = /^i([a-f0-9]{6})_(\d+)$/.exec(key);
      if (indexMatch && indexMatch[1] !== session.tripChoiceToken) {
        await sendMessage(chatId, "Список выездов обновился. Используйте последнее сообщение со списком.");
        return;
      }
      const t = indexMatch
        ? session.tripList && session.tripList[Number(indexMatch[2])]
        : session.tripChoices && session.tripChoices[key];
      if (!t) {
        // Кнопка из старого сообщения (бот перезапускался — список в памяти пуст).
        await sendMessage(chatId, "Этот список выездов уже неактуален — начните заново командой /start.");
        return;
      }
      if (t) {
        session.data.tripCreate = false;   // выбрали существующую — новую карточку не создаём
        session.data.tripId = t.id;
        session.data.tripName = t.name || "";
        session.data.tripTasks = String(t.comment || "").trim(); // «Задачи на выезд» = поле comment
        session.data.linkedProjectName = String(t.projectName || "").trim();
        session.data.projectName = session.data.linkedProjectName || t.name || "";
      }
    }
    // Задачи выбранной карточки показываем как справку — заново их вводить не нужно.
    if (session.data.tripId && session.data.reportType !== "final") {
      if (session.data.tripTasks) {
        await sendMessage(chatId, `📋 Задачи по выезду «${session.data.tripName}»:\n${session.data.tripTasks}`);
      } else {
        // В карточке задач нет — без них отчёт бессмысленный, спрашиваем.
        await sendMessage(chatId, `📋 В карточке выезда «${session.data.tripName}» задачи не заполнены.`);
        return askNewTripTasks(chatId, session);
      }
    }
    await goChecklist(chatId, session);
    return;
  }

  if (data === "checklist_ok") {
    if (session.step === "newtrip_name" || session.step === "newtrip_tasks") {
      await tg("answerCallbackQuery", { callback_query_id: callback.id, text: "Сначала ответьте на вопрос выше", show_alert: true }).catch(() => {});
      return;
    }
    // Отдельного шага «наименование проекта» больше нет: название берётся из карточки выезда,
    // а у нового выезда его вводят в самом начале. Сразу спрашиваем дату.
    if (!session.data.projectName) session.data.projectName = session.data.tripName || "";
    // Страховка на случай старых кнопок из истории чата: без названия отчёт уйдёт с пустым
    // «Проект:» — спрашиваем его, а не молчим.
    if (!session.data.projectName) return askNewTripName(chatId, session);
    session.step = "date";
    await sendMessage(chatId, DATE_PROMPT, dateKeyboard);
    return;
  }

  // Использовать название проекта из выбранной карточки выезда.
  if (data === "use_project") {
    // Кнопка из старых сообщений: шага «наименование проекта» больше нет. Срабатываем ТОЛЬКО
    // если сессия действительно на нём — иначе нажатие в истории откатывало пройденные шаги.
    if (session.step !== "project") {
      // Обычным сообщением, а не alert'ом: ответ на старый callback Telegram отклоняет
      // («query is too old»), и сотрудник не видел ничего — бот выглядел сломанным.
      await sendMessage(chatId, "Это сообщение устарело — начните заново через /start.");
      return;
    }
    session.data.projectName = session.data.tripName || "";
    session.data.linkedProjectName = "";
    session.step = "date";
    await sendMessage(chatId, `Проект: ${session.data.projectName}\n\n${DATE_PROMPT}`, dateKeyboard);
    return;
  }

  if (data === "date_now") {
    session.data.visitDate = nowMoscow();
    await sendMessage(chatId, `Дата выезда: ${session.data.visitDate}`);
    await askResponsibleOrSkip(chatId, session);
    return;
  }

  if (data === "skip_comment") {
    // Кнопка из старых сообщений. Срабатывает только на своём шаге: раньше нажатие на шаге
    // медиа обнуляло session.data.comment, и в чат уходило «Перечень задач: —».
    if (session.step !== "comment") {
      await sendMessage(chatId, "Это сообщение устарело — задачи уже заполнены.");
      return;
    }
    session.data.comment = "";
    session.step = "media";
    await sendMessage(chatId, MEDIA_PROMPT, mediaKeyboard);
    return;
  }

  // Вставить задачи из карточки выезда как перечень задач (предварительный).
  if (data === "use_tasks") {
    session.data.comment = session.data.tripTasks || "";
    session.step = "media";
    await sendMessage(chatId, MEDIA_PROMPT, mediaKeyboard);
    return;
  }

  // Заключительный: вставить задачи из карточки в «выполненные работы» → предложить оставить/отредактировать.
  if (data === "use_tasks_done") {
    session.data.workDone = session.data.tripTasks || "";
    await sendMessage(
      chatId,
      `Подставлены задачи как выполненные работы:\n${session.data.workDone}\n\nЕсли выполнено всё — «Оставить как есть». Если что-то не выполнили — «Отредактировать» и пришлите исправленный список.`,
      workDoneConfirmKeyboard
    );
    return;
  }

  // Оставить подставленные задачи как выполненные работы и идти дальше.
  if (data === "workdone_keep") {
    session.step = "worknotdone";
    await sendMessage(
      chatId,
      "Какие работы не выполнены (если есть) и почему? Опишите или нажмите «Всё выполнено».",
      workNotDoneKeyboard
    );
    return;
  }

  // Отредактировать список выполненных работ вручную.
  if (data === "workdone_edit") {
    session.step = "workdone";
    await sendMessage(
      chatId,
      `Пришлите отредактированный список выполненных работ (скопируйте и уберите лишнее):\n${session.data.tripTasks || ""}`
    );
    return;
  }

  if (data === "work_all_done") {
    session.data.workNotDone = "Всё выполнено";
    session.step = "recommendations";
    await sendMessage(chatId, "Рекомендации по макету (если есть)? Опишите или нажмите «Рекомендаций нет».", recommendationsKeyboard);
    return;
  }

  if (data === "no_recommendations") {
    session.data.recommendations = "Нет";
    session.step = "media";
    await sendMessage(chatId, MEDIA_PROMPT, mediaKeyboard);
    return;
  }

  // Кнопка «Отправить отчёт» → показываем сводку для подтверждения.
  if (data === "send_report") {
    if (!session.media.length) {
      await sendMessage(chatId, "Вы ещё не прислали ни одного файла. Добавьте фото/видео.", mediaKeyboard);
      return;
    }
    session.step = "confirm";
    await sendMessage(chatId, buildSummary(session), confirmKeyboard);
    return;
  }

  if (data === "confirm_send") {
    await submitReport(chatId, userId, callback.from);
    return;
  }

  if (data === "add_more") {
    session.step = "media";
    await sendMessage(chatId, "Хорошо, пришлите ещё файлы. Когда закончите — «Отправить отчёт».", mediaKeyboard);
    return;
  }

  if (data === "cancel") {
    resetSession(userId);
    await sendMessage(chatId, "Отменено. Чтобы начать заново — /start.");
    return;
  }
}

async function handleUpdate(update) {
  if (update.message) return handleMessage(update.message);
  if (update.callback_query) return handleCallback(update.callback_query);
}

// ===== Цикл получения обновлений (long polling) =====
async function poll() {
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 50,
        allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update).catch((e) => logEvent("error", "handleUpdate:", e.message));
      }
    } catch (error) {
      logEvent("error", "poll error:", error.message);
      await sleep(3000);
    }
  }
}

// ===== HTTP-сервер (нужен Render/панели для проверки порта) =====
const app = express();
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: "bot", allowedUsers: ALLOWED_USER_IDS.length, hasTarget: Boolean(TARGET_CHAT_ID) });
});
// Журнал последних событий — защищён токеном (тем же BM_API_TOKEN). Для диагностики.
app.get("/api/logs", (req, res) => {
  const token = String(req.query.token || "");
  if (!BM_API_TOKEN || token !== BM_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const n = Math.min(Number(req.query.n) || 200, LOG_BUFFER.length);
  res.json({ ok: true, count: LOG_BUFFER.length, logs: LOG_BUFFER.slice(-n) });
});
app.get("*", (_req, res) => {
  res.type("html").send("<h1>Бот выездных фотоотчётов работает</h1><p>Откройте бота в Telegram и отправьте /start.</p>");
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`HTTP server on port ${PORT}`);
  if (!TELEGRAM_BOT_TOKEN || !TARGET_CHAT_ID || !BM_API_TOKEN) {
    logEvent("error", "Telegram/KPI интеграция не настроена; приём отчётов остановлен");
    process.exit(1);
  }
  if (ALLOWED_USER_IDS.length === 0) logEvent("error", "⚠️  ALLOWED_USER_IDS пуст — бот никого не пустит.");
  if (!MINIAPP_OK) {
    logEvent("error", "⚠️  MINIAPP_URL должен быть https-адресом без «#» — кнопка мини-приложения "
      + "заменена на обычную ссылку. Сейчас: " + (MINIAPP_URL || "(пусто)"));
  }
  try {
    await assertReportApiCompatible();
  } catch (error) {
    logEvent("error", "KPI API не поддерживает надёжный индекс отчётов:", error.message);
    process.exit(1);
  }
  console.log("Запуск Telegram-бота (long polling)…");
  poll();
  // Отдельный короткий цикл для запросов из мини-приложения; не ждёт long polling getUpdates.
  pollReportJobs();
  setInterval(pollReportJobs, REPORT_JOBS_POLL_MS);
});
