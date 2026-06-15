import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";

dotenv.config();

// ===== Конфигурация =====
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
// Целевой чат/группа, куда бот пересылает готовые отчёты.
const TARGET_CHAT_ID = (process.env.TELEGRAM_CHAT_ID || "").trim();
// Список Telegram ID сотрудников, которым разрешено отправлять отчёты (через запятую).
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PORT = Number(process.env.PORT) || 3000;

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

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
  sessions.set(userId, { step: "idle", data: {}, media: [], mediaHintShown: false });
  return sessions.get(userId);
}

function getSession(userId) {
  return sessions.get(userId) || resetSession(userId);
}

function isAllowed(userId) {
  return ALLOWED_USER_IDS.length > 0 && ALLOWED_USER_IDS.includes(String(userId));
}

function senderName(from) {
  const parts = [from.first_name, from.last_name].filter(Boolean).join(" ");
  const uname = from.username ? ` (@${from.username})` : "";
  return `${parts || "Без имени"}${uname}`;
}

// ===== Вызов Telegram API =====
async function tg(method, params = {}, timeoutMs = 65000) {
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
    if (!data.ok) {
      throw new Error(`${method}: ${data.description || response.status}`);
    }
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

function sendMessage(chatId, text, replyMarkup) {
  const params = { chat_id: chatId, text };
  if (replyMarkup) params.reply_markup = replyMarkup;
  return tg("sendMessage", params);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== Клавиатуры =====
const typeKeyboard = {
  inline_keyboard: [
    [{ text: "🟦 Предварительный", callback_data: "type_pre" }],
    [{ text: "✅ Заключительный", callback_data: "type_final" }],
  ],
};
const checklistKeyboard = {
  inline_keyboard: [[{ text: "Всё проверил — продолжить", callback_data: "checklist_ok" }]],
};
const commentKeyboard = {
  inline_keyboard: [[{ text: "Пропустить комментарий", callback_data: "skip_comment" }]],
};
const mediaKeyboard = {
  inline_keyboard: [
    [{ text: "📤 Отправить отчёт", callback_data: "send_report" }],
    [{ text: "❌ Отменить", callback_data: "cancel" }],
  ],
};

function reportTypeLabel(type) {
  return type === "final" ? "Заключительный" : "Предварительный";
}

// ===== Старт нового отчёта =====
async function startReport(chatId, userId) {
  resetSession(userId);
  getSession(userId).step = "type";
  await sendMessage(
    chatId,
    "Здравствуйте! Создаём фотоотчёт о выезде.\n\nВыберите тип отчёта:",
    typeKeyboard
  );
}

// ===== Сборка и отправка готового отчёта в целевой чат =====
async function submitReport(chatId, userId, from) {
  const session = getSession(userId);
  const d = session.data;

  if (!session.media.length) {
    await sendMessage(chatId, "Вы ещё не прислали ни одного фото или видео. Добавьте файлы и нажмите «Отправить отчёт».");
    return;
  }

  const header =
    `${d.reportType === "final" ? "✅" : "🟦"} ${reportTypeLabel(d.reportType)} фотоотчёт\n\n` +
    `Проект: ${d.projectName}\n` +
    `Дата выезда: ${d.visitDate}\n` +
    `Ответственное лицо: ${d.responsible}\n` +
    `Комментарий: ${d.comment ? d.comment : "—"}\n` +
    `Файлов: ${session.media.length}\n` +
    `Отправил: ${senderName(from)}`;

  const total = session.media.length;
  await sendMessage(chatId, "Отправляю отчёт в рабочий чат…");

  // Сначала заголовок, затем каждое медиа копируем по file_id (без перезагрузки — поэтому размер не ограничен).
  await sendMessage(TARGET_CHAT_ID, header);

  let sent = 0;
  for (const item of session.media) {
    try {
      await tg("copyMessage", {
        chat_id: TARGET_CHAT_ID,
        from_chat_id: item.chatId,
        message_id: item.messageId,
      });
      sent += 1;
    } catch (error) {
      console.error("copyMessage error:", error.message);
    }
  }

  resetSession(userId);

  if (sent > 0) {
    const tail = sent < total ? ` (из ${total}; ${total - sent} не удалось)` : "";
    await sendMessage(
      chatId,
      `✅ Отчёт отправлен в рабочий чат. Файлов переслано: ${sent}${tail}.\n\nЧтобы создать новый отчёт — отправьте /start.`
    );
  } else {
    await sendMessage(chatId, "❌ Не удалось переслать файлы. Попробуйте ещё раз: /start.");
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

  switch (session.step) {
    case "project":
      if (!text) return sendMessage(chatId, "Введите наименование проекта текстом.");
      session.data.projectName = text;
      session.step = "date";
      return sendMessage(chatId, "Укажите дату выезда (например, 15.06.2026):");

    case "date":
      if (!text) return sendMessage(chatId, "Введите дату выезда текстом.");
      session.data.visitDate = text;
      session.step = "responsible";
      return sendMessage(chatId, "Кто ответственное лицо?");

    case "responsible":
      if (!text) return sendMessage(chatId, "Введите ответственное лицо текстом.");
      session.data.responsible = text;
      session.step = "comment";
      return sendMessage(chatId, "Добавьте комментарий или нажмите «Пропустить».", commentKeyboard);

    case "comment":
      session.data.comment = text;
      session.step = "media";
      return sendMessage(
        chatId,
        "Теперь пришлите все фото и видео — по одному или альбомом.\nКогда закончите — нажмите «Отправить отчёт».",
        mediaKeyboard
      );

    case "media": {
      const media = message.photo || message.video || message.document || message.animation;
      if (media) {
        // Сохраняем ссылку на сообщение, чтобы потом скопировать его по file_id в рабочий чат.
        session.media.push({ chatId, messageId: message.message_id });
        if (!session.mediaHintShown) {
          session.mediaHintShown = true;
          await sendMessage(
            chatId,
            "Файлы принимаются. Присылайте ещё, а когда закончите — нажмите «Отправить отчёт».",
            mediaKeyboard
          );
        }
        return;
      }
      return sendMessage(
        chatId,
        "Пришлите фото или видео, либо нажмите «Отправить отчёт».",
        mediaKeyboard
      );
    }

    default:
      return sendMessage(chatId, "Чтобы создать фотоотчёт о выезде — отправьте /start.");
  }
}

// ===== Обработка нажатий на кнопки =====
async function handleCallback(callback) {
  const chatId = callback.message.chat.id;
  const userId = callback.from.id;
  const data = callback.data;

  if (!isAllowed(userId)) {
    await tg("answerCallbackQuery", { callback_query_id: callback.id, text: "Нет доступа" });
    await sendMessage(chatId, `🚫 Нет доступа. Ваш Telegram ID: ${userId}`);
    return;
  }

  await tg("answerCallbackQuery", { callback_query_id: callback.id });

  const session = getSession(userId);

  if (data === "type_pre" || data === "type_final") {
    session.data.reportType = data === "type_final" ? "final" : "pre";
    session.step = "checklist";
    const items = CHECKLISTS[session.data.reportType === "final" ? "final" : "pre"];
    const list = items.map((t, i) => `${i + 1}. ${t}`).join("\n");
    await sendMessage(
      chatId,
      `Тип: ${reportTypeLabel(session.data.reportType)}.\n\nПроверьте перед отправкой:\n\n${list}`,
      checklistKeyboard
    );
    return;
  }

  if (data === "checklist_ok") {
    session.step = "project";
    await sendMessage(chatId, "Введите наименование проекта:");
    return;
  }

  if (data === "skip_comment") {
    session.data.comment = "";
    session.step = "media";
    await sendMessage(
      chatId,
      "Теперь пришлите все фото и видео — по одному или альбомом.\nКогда закончите — нажмите «Отправить отчёт».",
      mediaKeyboard
    );
    return;
  }

  if (data === "send_report") {
    await submitReport(chatId, userId, callback.from);
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
        await handleUpdate(update).catch((e) => console.error("handleUpdate:", e.message));
      }
    } catch (error) {
      console.error("poll error:", error.message);
      await sleep(3000);
    }
  }
}

// ===== HTTP-сервер (нужен Render для проверки порта) =====
const app = express();
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: "bot", allowedUsers: ALLOWED_USER_IDS.length, hasTarget: Boolean(TARGET_CHAT_ID) });
});
app.get("*", (_req, res) => {
  res.type("html").send("<h1>Бот выездных фотоотчётов работает</h1><p>Откройте бота в Telegram и отправьте /start.</p>");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP server on port ${PORT}`);
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("⚠️  TELEGRAM_BOT_TOKEN не задан — бот не запустится.");
    return;
  }
  if (!TARGET_CHAT_ID) console.error("⚠️  TELEGRAM_CHAT_ID (целевой чат) не задан.");
  if (ALLOWED_USER_IDS.length === 0) console.error("⚠️  ALLOWED_USER_IDS пуст — бот никого не пустит.");
  console.log("Запуск Telegram-бота (long polling)…");
  poll();
});
