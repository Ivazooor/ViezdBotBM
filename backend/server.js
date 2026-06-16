import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
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
const EXTRA_ALLOWED_IDS = "983796960,369094962,1416285563,475858355";
// Список Telegram ID сотрудников, которым разрешено отправлять отчёты.
// Объединяем .env и зашитые ID; Set убирает дубликаты.
const ALLOWED_USER_IDS = [
  ...new Set([...parseIds(process.env.ALLOWED_USER_IDS), ...parseIds(EXTRA_ALLOWED_IDS)]),
];
// Кто может оценивать качество выезда кнопками в рабочем чате. Зашиты по умолчанию
// (этим людям также автоматически открыт доступ к боту), переопределяется через .env.
const DEFAULT_REVIEWER_IDS =
  "814705792,508570326,165912761,163743492,1090755229,1504488231,898159043,466665113,758274157,97782197,369094962";
const QUALITY_REVIEWER_IDS = parseIds(process.env.QUALITY_REVIEWER_IDS || DEFAULT_REVIEWER_IDS);
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

// Интеграция с KPI-приложением (отдел «Выезды»): выбор карточки выезда + запись результата.
// Токен ТОЛЬКО из .env (репозиторий публичный — не хардкодить!). Пусто → интеграция отключена.
const BM_API_URL = (process.env.BM_API_URL || "https://xn----8sbbqciguqh9br.xn--p1ai/api/bot.php").trim();
const BM_API_TOKEN = (process.env.BM_API_TOKEN || "").trim();

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
async function tg(method, params = {}, timeoutMs = 65000) {
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
        logEvent("warn", `${method}: лимит 429, пауза ${retryAfter}s (попытка ${attempt + 1})`);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      // Прочие ошибки API (400/403 и т.п.) — повторять бессмысленно.
      throw new Error(`${method}: ${data.description || response.status}`);
    } catch (error) {
      lastErr = error;
      // Ошибка API (а не сети) — пробрасываем сразу.
      if (error.message && error.message.indexOf(`${method}:`) === 0) throw error;
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
  const response = await fetch(`${FILE_API}/${file.file_path}`);
  if (!response.ok) throw new Error(`download ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Отправить документ (PDF) в чат через multipart (нативные fetch/FormData/Blob Node 18+).
async function sendDocument(chatId, buffer, filename, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([buffer], { type: "application/pdf" }), filename);
  const response = await globalThis.fetch(`${API}/sendDocument`, { method: "POST", body: form });
  const data = await response.json();
  if (!data.ok) throw new Error(`sendDocument: ${data.description || response.status}`);
  return data.result;
}

// Имя PDF-файла вида «Отчет о выезде: <Проект> <Дата>.pdf».
function pdfFilename(d) {
  const clean = (s) => String(s || "").replace(/[\\/\n\r\t]+/g, " ").trim();
  const project = clean(d.projectName) || "проект";
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
    url += (url.includes("?") ? "&" : "?") + "op=" + encodeURIComponent(payload.op || "trips");
  } else {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(payload);
  }
  const response = await fetch(url, opts);
  const data = await response.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error || `api ${response.status}`);
  return data;
}

// Список незавершённых выездов для выбора в боте.
async function bmGetTrips() {
  const data = await bmApi("GET", { op: "trips" });
  return Array.isArray(data.trips) ? data.trips : [];
}

// ===== Клавиатуры =====
const typeKeyboard = {
  inline_keyboard: [
    [{ text: "🟦 Предварительный отчет", callback_data: "type_pre" }],
    [{ text: "✅ Заключительный отчет", callback_data: "type_final" }],
    [{ text: "👁 Посмотреть выезды", callback_data: "view_trips" }],
  ],
};
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

const MEDIA_PROMPT =
  "Теперь пришлите все фото и видео — по одному или альбомом.\nКогда закончите — нажмите «Отправить отчёт».";
const DATE_PROMPT =
  "Укажите дату выезда: нажмите «📅 Сегодня» или введите вручную (например, 15.06.2026).";

// ===== Старт нового отчёта =====
async function startReport(chatId, userId) {
  resetSession(userId);
  getSession(userId).step = "type";
  await sendMessage(chatId, "Привет! Выбери что требуется:", typeKeyboard);
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

// Вторым действием после выбора типа — выбор выезда из отдела «Выезды».
async function offerTripChoice(chatId, session) {
  const isFinal = session.data.reportType === "final";
  // Интеграция не настроена (нет токена) — идём по старому сценарию без привязки.
  if (!bmEnabled()) return goChecklist(chatId, session);

  let trips = [];
  try {
    trips = await bmGetTrips();
  } catch (error) {
    logEvent("error", "bmGetTrips:", error.message);
    await sendMessage(chatId, "⚠️ Не удалось получить список выездов из приложения. Продолжаем без привязки.");
    return goChecklist(chatId, session);
  }

  session.tripChoices = {};
  const rows = [];
  trips.slice(0, 30).forEach((t) => {
    if (!t || !t.id) return;
    session.tripChoices[t.id] = t;
    const label = `🚗 ${t.name || "Без названия"}${t.date ? " · " + t.date : ""}`;
    rows.push([{ text: label.slice(0, 60), callback_data: "pick_" + t.id }]);
  });
  if (isFinal) rows.push([{ text: "➕ Создать карточку", callback_data: "pick_create" }]);
  rows.push([{ text: "⏭ Пропустить", callback_data: "pick_skip" }]);

  session.step = "picktrip";
  const head = rows.length > 1
    ? "Выберите выезд из отдела «Выезды»:"
    : "Незавершённых выездов в приложении нет. Можно продолжить без привязки.";
  await sendMessage(chatId, head, { inline_keyboard: rows });
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
    const label = `🚗 ${t.name || "Без названия"}${t.date ? " · " + t.date : ""}`;
    rows.push([{ text: label.slice(0, 60), callback_data: "view_" + t.id }]);
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
    `Проект: ${d.projectName}\n` +
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
  session.submitting = true;

  const d = session.data;
  const total = session.media.length;
  const header =
    `${d.reportType === "final" ? "✅" : "🟦"} ${reportTypeLabel(d.reportType)} фотоотчёт\n\n` +
    `Проект: ${d.projectName}\n` +
    `Дата выезда: ${d.visitDate}\n` +
    `Ответственное лицо: ${d.responsible}\n` +
    detailsLines(d) +
    `Файлов: ${total}\n` +
    `Отправил: ${senderName(from)}`;

  // Заголовок в рабочий чат. Если упало — бот не в группе / нет прав: сообщаем и даём повторить.
  try {
    await sendMessage(TARGET_CHAT_ID, header);
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

  await sendMessage(chatId, "Отправляю файлы…");

  // Каждое медиа копируем по file_id (без перезагрузки — поэтому размер не ограничен).
  // Пауза между файлами + автоповтор 429 в tg() — чтобы не терять файлы из-за лимита Telegram.
  const total0 = session.media.length;
  logEvent("info", `Пересылка ${total0} файлов в рабочий чат (отправитель: ${senderName(from)})`);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < session.media.length; i++) {
    const item = session.media[i];
    try {
      await tg("copyMessage", {
        chat_id: TARGET_CHAT_ID,
        from_chat_id: item.chatId,
        message_id: item.messageId,
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      logEvent("error", `copyMessage #${i + 1}/${total0} не удалось: ${error.message}`);
    }
    // Throttle: пауза между отправками снижает риск упереться в лимит группы.
    await sleep(400);
  }
  logEvent("info", `Переслано ${sent}/${total0}, ошибок ${failed}`);

  // Фирменный PDF-отчёт для заказчика — только по заключительному выезду.
  let pdfNote = "";
  if (d.reportType === "final") {
    try {
      await sendMessage(chatId, "Формирую фирменный PDF-отчёт для заказчика…");
      const photoIds = session.media
        .filter((m) => m.kind === "photo" && m.fileId)
        .slice(0, PDF_MAX_PHOTOS)
        .map((m) => m.fileId);
      const photos = [];
      for (const fileId of photoIds) {
        try {
          photos.push(await downloadFile(fileId));
        } catch (error) {
          logEvent("error", "photo download error:", error.message);
        }
      }
      const pdf = await buildVisitPdf(
        {
          projectName: d.projectName,
          visitDate: d.visitDate,
          responsible: d.responsible,
          workDone: d.workDone,
          workNotDone: d.workNotDone,
          recommendations: d.recommendations,
        },
        photos,
        { brand: BRAND }
      );
      const filename = pdfFilename(d);
      const caption = "Направляю Вам файл с отчетом по работам";
      // В рабочий чат (после отчёта) и сотруднику в личку.
      await sendDocument(TARGET_CHAT_ID, pdf, filename, caption);
      await sendDocument(chatId, pdf, filename, caption);
      pdfNote = `\n📄 PDF-отчёт сформирован (фото в нём: ${photos.length}) и отправлен в чат и вам в личку.`;
    } catch (error) {
      logEvent("error", "pdf error:", error.message);
      pdfNote = "\n⚠️ PDF-отчёт сформировать не удалось — текст и файлы в чат отправлены.";
    }

    // Запись результата в карточку выезда KPI-приложения (если интеграция включена).
    let kpiTripId = d.tripId || null;
    if (bmEnabled()) {
      try {
        if (d.tripCreate) {
          // Запасная кнопка «Создать карточку» — заводим выезд из данных бота.
          const created = await bmApi("POST", {
            op: "create",
            name: d.projectName,
            date: d.visitDate,
            comment: d.tripTasks || "",
            workDone: d.workDone,
            workNotDone: d.workNotDone,
            recommendations: d.recommendations,
            by: senderName(from),
          });
          kpiTripId = created.id || null;
        } else if (kpiTripId) {
          await bmApi("POST", {
            op: "final_report",
            tripId: kpiTripId,
            workDone: d.workDone,
            workNotDone: d.workNotDone,
            recommendations: d.recommendations,
            by: senderName(from),
          });
        }
      } catch (error) {
        logEvent("error", "bm final_report:", error.message);
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
          `Проект: ${d.projectName}\n` +
          `Дата выезда: ${d.visitDate}\n` +
          `Выездник: ${d.responsible}`,
        qk
      );
    } catch (error) {
      logEvent("error", "quality buttons error:", error.message);
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

  // Работаем только в личной переписке с сотрудником.
  if (message.chat.type !== "private") return;

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
  if (text === "/cancel") {
    resetSession(userId);
    await sendMessage(chatId, "Отменено. Чтобы начать заново — /start.");
    return;
  }

  const session = getSession(userId);

  // Приём фото/видео работает на шаге сбора файлов и на шаге сводки (можно дослать).
  const incomingMedia = message.photo || message.video || message.document || message.animation;
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
    case "project":
      if (!text) return sendMessage(chatId, "Введите наименование проекта текстом.");
      session.data.projectName = text;
      session.step = "date";
      return sendMessage(chatId, DATE_PROMPT, dateKeyboard);

    case "date":
      if (!text) return sendMessage(chatId, "Введите дату выезда текстом.");
      session.data.visitDate = text;
      session.step = "responsible";
      return sendMessage(chatId, "Кто ответственное лицо?");

    case "responsible":
      if (!text) return sendMessage(chatId, "Введите ответственное лицо текстом.");
      session.data.responsible = text;
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
      session.step = "comment";
      return sendMessage(
        chatId,
        session.data.tripTasks
          ? `Задачи из карточки выезда подставлены:\n${session.data.tripTasks}\n\nОтправьте свой текст, чтобы изменить, или «Использовать задачи» — чтобы вставить задачи из карточки.`
          : "Укажите перечень задач на данном выезде или нажмите «Пропустить».",
        session.data.tripTasks ? useTasksKeyboard : commentKeyboard
      );

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
      return sendMessage(chatId, "Выберите выезд из списка кнопкой выше (или «Пропустить»).");

    default:
      return sendMessage(chatId, "Чтобы создать фотоотчёт о выезде — отправьте /start.");
  }
}

// ===== Обработка нажатий на кнопки =====
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

  // Запись оценки в карточку выезда KPI-приложения.
  if (bmEnabled() && tripId) {
    try {
      await bmApi("POST", {
        op: "set_quality",
        tripId,
        quality: good ? "yes" : "no",
        by: senderName(callback.from),
      });
    } catch (error) {
      logEvent("error", "bm set_quality:", error.message);
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

  if (!isAllowed(userId)) {
    await tg("answerCallbackQuery", { callback_query_id: callback.id, text: "Нет доступа" });
    await sendMessage(chatId, `🚫 Нет доступа. Ваш Telegram ID: ${userId}`);
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: callback.id });

  const session = getSession(userId);

  // Режим просмотра выездов (без оформления отчёта).
  if (data === "view_trips") {
    await showTripsForView(chatId, session);
    return;
  }
  if (data.startsWith("view_")) {
    await showTripDetails(chatId, session, data.slice(5));
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

  // Выбор выезда из списка / «Пропустить» / «Создать карточку».
  if (data.startsWith("pick_")) {
    const key = data.slice(5);
    if (key === "skip") {
      session.data.tripId = null;
    } else if (key === "create") {
      session.data.tripId = null;
      session.data.tripCreate = true; // карточка будет создана при отправке (только заключительный)
    } else {
      const t = session.tripChoices && session.tripChoices[key];
      if (t) {
        session.data.tripId = t.id;
        session.data.tripName = t.name || "";
        session.data.tripTasks = t.comment || ""; // «Задачи на выезд» = поле comment
      }
    }
    // Для предварительного — подтянуть и показать задачи из карточки.
    if (session.data.reportType !== "final" && session.data.tripId) {
      const tasks = session.data.tripTasks
        ? `📋 Задачи по выезду «${session.data.tripName}»:\n${session.data.tripTasks}`
        : `📋 В карточке выезда «${session.data.tripName}» задачи не указаны — впишете вручную.`;
      await sendMessage(chatId, tasks);
    }
    await goChecklist(chatId, session);
    return;
  }

  if (data === "checklist_ok") {
    session.step = "project";
    // Если выезд выбран из приложения — предлагаем его название кнопкой (или ввести вручную).
    if (session.data.tripName) {
      await sendMessage(
        chatId,
        "Введите наименование проекта или используйте название из карточки выезда:",
        { inline_keyboard: [[{ text: `📋 ${session.data.tripName}`.slice(0, 60), callback_data: "use_project" }]] }
      );
    } else {
      await sendMessage(chatId, "Введите наименование проекта:");
    }
    return;
  }

  // Использовать название проекта из выбранной карточки выезда.
  if (data === "use_project") {
    session.data.projectName = session.data.tripName || "";
    session.step = "date";
    await sendMessage(chatId, `Проект: ${session.data.projectName}\n\n${DATE_PROMPT}`, dateKeyboard);
    return;
  }

  if (data === "date_now") {
    session.data.visitDate = nowMoscow();
    session.step = "responsible";
    await sendMessage(chatId, `Дата выезда: ${session.data.visitDate}\n\nКто ответственное лицо?`);
    return;
  }

  if (data === "skip_comment") {
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server on port ${PORT}`);
  if (!TELEGRAM_BOT_TOKEN) {
    logEvent("error", "⚠️  TELEGRAM_BOT_TOKEN не задан — бот не запустится.");
    return;
  }
  if (!TARGET_CHAT_ID) logEvent("error", "⚠️  TELEGRAM_CHAT_ID (целевой чат) не задан.");
  if (ALLOWED_USER_IDS.length === 0) logEvent("error", "⚠️  ALLOWED_USER_IDS пуст — бот никого не пустит.");
  console.log("Запуск Telegram-бота (long polling)…");
  poll();
});
