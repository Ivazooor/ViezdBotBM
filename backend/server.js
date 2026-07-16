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
const EXTRA_ALLOWED_IDS =
  "983796960,369094962,1416285563,475858355,1090755229,2003024692,1788196095,420290843,1504488231,709747902,5244003524,508570326,475386963,486635892,6341486734,1305025641,1175709298,862747793,1136597026,1119946044,5167474121,1186366279,916525382,663431978,455678231,5004731399,898159043,993245287,1088733519,6072230929,1432669716,636914019,8136543551,989537568,2108433058";
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
// Кого упоминать в вопросе «выезд выполнен?» (ответственный за финальный статус).
const STATUS_MENTION = (process.env.STATUS_MENTION || "@matiyver").trim();
// Кого тегать отдельным сообщением при заключительном отчёте (для уведомления).
// Упоминание по ID (tg://user?id=) уведомляет участников чата даже без username.
const NOTIFY_FINAL = [
  { id: "1504488231", name: "Руководитель" },
  { id: "508570326", name: "@danil_mck" },
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
// (или «⚠️ Не выполнен») → бот просит причину; принимаем Reply на запрос ИЛИ следующее текстовое
// сообщение ТОГО ЖЕ оценщика. Ключ — chatId (в чате ждём одну причину; новая кнопка перезаписывает).
// Хранится в памяти: рестарт бота сбрасывает ожидание — кнопки оценки остаются, можно нажать заново.
const pendingBadReasons = new Map();
const BAD_REASON_TTL_MS = 15 * 60 * 1000; // 15 минут на ввод причины

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
    const qs = Object.keys(payload)
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(payload[k]))
      .join("&");
    url += (url.includes("?") ? "&" : "?") + (qs || "op=trips");
  } else {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(payload);
  }
  // [B1] Устойчивость: сетевые сбои и 5xx повторяем (до 3 попыток с backoff).
  // 4xx (401 токен, 404 выезд не найден, 400) — постоянные ошибки, повтор бессмыслен.
  let lastErr;
  for (let attempt = 0; attempt <= 2; attempt++) {
    let response;
    try {
      response = await fetch(url, opts);
    } catch (netErr) {
      lastErr = new Error("сеть: " + netErr.message);
      if (attempt < 2) { logEvent("warn", "bmApi", payload.op || method, "сеть, повтор " + (attempt + 1)); await sleep(1000 * (attempt + 1)); continue; }
      throw lastErr;
    }
    if (response.status >= 500) {
      lastErr = new Error("api " + response.status);
      if (attempt < 2) { logEvent("warn", "bmApi", payload.op || method, "5xx, повтор " + (attempt + 1)); await sleep(1000 * (attempt + 1)); continue; }
      throw lastErr;
    }
    const data = await response.json().catch(() => ({}));
    if (!data.ok) { const e = new Error(data.error || `api ${response.status}`); if (data.code) e.code = data.code; throw e; }
    return data;
  }
  throw lastErr || new Error("bmApi: не удалось");
}

// Список незавершённых выездов для выбора в боте.
async function bmGetTrips() {
  const data = await bmApi("GET", { op: "trips" });
  return Array.isArray(data.trips) ? data.trips : [];
}

// Профиль сотрудника (ФИО) по Telegram ID.
async function bmGetProfile(userId) {
  const data = await bmApi("GET", { op: "profile", uid: String(userId) });
  return data.profile || null;
}
async function bmSaveProfile(userId, fio) {
  return bmApi("POST", { op: "save_profile", uid: String(userId), fio });
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
const typeKeyboard = {
  inline_keyboard: [
    [{ text: "🟦 Предварительный отчет", callback_data: "type_pre" }],
    [{ text: "✅ Заключительный отчет", callback_data: "type_final" }],
    [{ text: "👁 Посмотреть выезды", callback_data: "view_trips" }],
    [{ text: "📊 Сводка за месяц", callback_data: "summary_menu" }],
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
  await sendMessage(chatId, "Привет! Выбери что требуется:", typeKeyboard);
}

// Меню выбора типа отчёта (после старта/регистрации).
function showTypeMenu(chatId, session) {
  session.step = "type";
  return sendMessage(chatId, "Привет! Выбери что требуется:", typeKeyboard);
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
  session.step = "comment";
  return sendMessage(
    chatId,
    session.data.tripTasks
      ? `Задачи из карточки выезда подставлены:\n${session.data.tripTasks}\n\nОтправьте свой текст, чтобы изменить, или «Использовать задачи» — чтобы вставить задачи из карточки.`
      : "Укажите перечень задач на данном выезде или нажмите «Пропустить».",
    session.data.tripTasks ? useTasksKeyboard : commentKeyboard
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
    rows.push([{ text: tripLabel(t), callback_data: "pick_" + t.id }]);
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
  const statusRu = { planned: "🟦 Запланирован", paused: "⏸ На паузе", bad: "❌ Брак", done: "✅ Выполнен" };
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

  // Предварительный отчёт: пометить карточку выезда в приложении (если выезд выбран из списка).
  // Бот отмечает trip.checks.prelim → в KPI-приложении видно «Предварительный отчёт ✓».
  if (d.reportType !== "final" && bmEnabled() && d.tripId) {
    try {
      await bmApi("POST", { op: "preliminary", tripId: d.tripId, by: senderName(from) });
      logEvent("info", "Отметка предварительного отчёта поставлена, tripId=" + d.tripId);
      await sendMessage(chatId,
        `✅ Бот отметил в карточке выезда${d.tripName ? " «" + d.tripName + "»" : ""}: предварительный отчёт получен.`
      ).catch(() => {});
    } catch (error) {
      logEvent("error", "bm preliminary mark:", error.message);
      await sendMessage(chatId,
        "⚠️ Предварительный отчёт отправлен в чат, но отметку в приложении поставить не удалось:\n" +
        error.message + "\n\nСообщите руководителю — отметку можно поставить вручную в карточке выезда."
      ).catch(() => {});
    }
  } else if (d.reportType !== "final" && bmEnabled() && !d.tripId) {
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
          // Новая карточка → есть только заключительный отчёт; предупреждаем, иначе «качественный» будет заблокирован.
          await sendMessage(chatId,
            `✅ Создана карточка выезда «${d.projectName}» с отметкой «заключительный отчёт получен».\n\n` +
            "⚠️ В этой карточке нет предварительного отчёта — «качественный» откроется только после того, как по этому же выезду поступит и предварительный отчёт."
          ).catch(() => {});
        } else if (kpiTripId) {
          await bmApi("POST", {
            op: "final_report",
            tripId: kpiTripId,
            workDone: d.workDone,
            workNotDone: d.workNotDone,
            recommendations: d.recommendations,
            by: senderName(from),
          });
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
          "⚠️ Отчёт отправлен в рабочий чат, но сохранить его в приложении (карточка выезда) не удалось:\n" +
          error.message + "\n\nДанные не потеряны — сообщите руководителю, выезд можно заполнить вручную."
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
          `Проект: ${d.projectName}\n` +
          `Дата выезда: ${d.visitDate}\n` +
          `Выездник: ${d.responsible}`,
        qk
      );
    } catch (error) {
      logEvent("error", "quality buttons error:", error.message);
    }

    // Третье сообщение — тег ответственных (для уведомления), упоминание по ID.
    try {
      const mentions = NOTIFY_FINAL
        .map((u) => `<a href="tg://user?id=${u.id}">${htmlEscape(u.name)}</a>`)
        .join(" ");
      await tg("sendMessage", {
        chat_id: TARGET_CHAT_ID,
        text: `🔔 ${mentions} — поступил заключительный отчёт по выезду «${htmlEscape(d.projectName)}». Просьба проверить.`,
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
      return sendMessage(chatId, "Выберите выезд из списка кнопкой выше (или «Пропустить»).");

    default:
      return sendMessage(chatId, "Чтобы создать фотоотчёт о выезде — отправьте /start.");
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
      `⚠️ ${senderName(callback.from)}, укажите причину — почему выезд не качественный?\n\n` +
        `Ответьте (Reply) на это сообщение или просто напишите причину следующим сообщением. ` +
        `Причина попадёт в карточку выезда, карточка будет перемещена в «Брак».`
    );
  } catch (error) {
    logEvent("error", "requestBadReason:", error.message);
  }
  pendingBadReasons.set(String(msg.chat.id), {
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
async function maybeHandleBadReason(message) {
  const key = String(message.chat.id);
  const p = pendingBadReasons.get(key);
  if (!p) return false;
  if (Date.now() - p.ts > BAD_REASON_TTL_MS) { pendingBadReasons.delete(key); return false; } // протухло — кнопки живы, жмут заново
  const isReply = !!(message.reply_to_message && p.requestMsgId && message.reply_to_message.message_id === p.requestMsgId);
  const fromReviewer = !!(message.from && message.from.id === p.reviewerId);
  if (!isReply && !fromReviewer) return false;          // чужие сообщения в чате не трогаем
  const text = (message.text || "").trim();
  if (!text) {                                          // фото/стикер вместо текста
    if (isReply) await sendMessage(message.chat.id, "Пришлите причину текстом, пожалуйста.").catch(() => {});
    return isReply;
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
    pendingBadReasons.delete(key);
    await sendMessage(message.chat.id, "⚠️ Не удалось записать оценку в приложение: " + error.message + ". Нажмите кнопку оценки ещё раз.").catch(() => {});
    return true;
  }
  pendingBadReasons.delete(key);
  // Фиксируем оценку и причину в исходном сообщении с кнопками (кнопки убираются).
  const isBoard = p.kind === "board";
  const splitKey = isBoard ? "\n\n— Статус —" : "\n\n— Оценка —";
  const baseText = (p.voteText || "").split(splitKey)[0] || (isBoard ? "Отмечаем что выезд выполнен?" : "🔎 Оценка качества выезда");
  const mark = isBoard ? "— Статус —\n⚠️ Выезд отмечен как БРАК" : "— Оценка —\n⚠️ Выезд отмечен как НЕ качественный";
  const newText = `${baseText}\n\n${mark}\nПричина: ${reason}\nОценил: ${p.reviewerName} · ${nowMoscow()}`;
  try {
    await tg("editMessageText", { chat_id: p.voteChatId, message_id: p.voteMsgId, text: newText });
  } catch (error) {
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
      pendingBadReasons.delete(String(msg.chat.id)); // [BAD-REASON] «качественный» отменяет незакрытый запрос причины
    } catch (error) {
      logEvent("error", "bm set_quality:", error.message);
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
      pendingBadReasons.delete(String(msg.chat.id)); // [BAD-REASON] «выполнен» отменяет незакрытый запрос причины
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

  // Режим просмотра выездов (без оформления отчёта).
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
    await sendMessage(chatId, `Дата выезда: ${session.data.visitDate}`);
    await askResponsibleOrSkip(chatId, session);
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
