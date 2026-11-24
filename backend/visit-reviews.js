const callbackPattern = /^vr:(m[1-9]\d{0,15}):(quality|work)_(yes|no)$/;
const reasonPrompts = {
  quality: "Ответьте на это сообщение и укажите замечания по качеству.",
  work: "Ответьте на это сообщение и укажите, почему работы не выполнены.",
};

function short(value, limit = 160) {
  const line = String(value || "").replace(/\s+/g, " ").trim();
  return line.length > limit ? line.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "").trimEnd() + "…" : line;
}

export function createVisitReviews({ tg, api, chatId, botId, senderName, htmlEscape, warn, onSeen = async () => {} }) {
  const reportLinkBase = "https://t.me/c/" + chatId.replace(/^-100/, "") + "/";
  const inReviewChat = message => String(message?.chat?.id) === chatId && Boolean(message.text);

  function request(action, fields = {}) {
    return api({ op: "visit_review", chatId, action, ...fields });
  }

  function mention(reviewer) {
    if (/^[A-Za-z0-9_]{5,32}$/.test(reviewer.username)) return "@" + reviewer.username;
    const name = htmlEscape(short(reviewer.name, 80));
    const id = reviewer.ids[0];
    return /^\d{5,20}$/.test(id) ? '<a href="tg://user?id=' + id + '">@' + name + "</a>" : name;
  }

  function render(base, reportId, state, askingReason = false) {
    const step = !state.quality ? "quality" : !state.work ? "work" : "";
    const lines = [htmlEscape(base), "",
      '<a href="' + reportLinkBase + reportId.slice(1) + '">Открыть фотоотчёт</a>'];
    if (step) {
      lines.push("", "Проверяет " + mention(state.reviewer));
      if (!state.reviewer.ids.length) lines.push(htmlEscape(state.reviewer.note || "У куратора пока нет привязки Telegram."));
    }
    if (!state.linked) lines.push(state.expectsTrip ? "Отчёт ещё сохраняется в приложении."
      : "У этого отчёта отметки сохраняются в Telegram.");
    lines.push("", "1. Качество выезда" + (state.quality ? ": " + verdict("quality", state.quality) : ""));
    if (state.quality?.reason) lines.push("Причина: " + htmlEscape(short(state.quality.reason, 1100)));
    lines.push("2. Выполнение работ" + (state.work ? ": " + verdict("work", state.work) : ""));
    if (state.work?.reason) lines.push("Причина: " + htmlEscape(short(state.work.reason, 1100)));
    if (state.work) {
      if (state.quality.by !== state.work.by) {
        lines.push("", "Качество проверил(а): " + htmlEscape(short(state.quality.by)),
          "Выполнение проверил(а): " + htmlEscape(short(state.work.by)));
      } else {
        lines.push("", "Проверил(а): " + htmlEscape(short(state.work.by)));
      }
    }
    if (askingReason && step) lines.push("", reasonPrompts[step]);
    const labels = step === "quality" ? ["✅ Качественно", "⚠️ Есть замечания"]
      : ["✅ Работы выполнены", "⚠️ Работы не выполнены"];
    const buttons = step ? labels.map((text, i) => [{
      text, callback_data: ["vr", reportId, step + "_" + (i === 0 ? "yes" : "no")].join(":"),
    }]) : [];
    return { text: lines.join("\n"), parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons } };
  }

  function verdict(step, result) {
    if (step === "quality") return result.answer === "yes" ? "✅ Качественно" : "⚠️ Есть замечания";
    return result.answer === "yes" ? "✅ Выполнены" : "⚠️ Не выполнены";
  }

  function baseFromMessage(message) {
    return message.text.split("\n\n", 1)[0];
  }

  async function edit(message, reportId, state, askingReason = false) {
    try {
      await tg("editMessageText", {
        chat_id: chatId, message_id: message.message_id,
        ...render(baseFromMessage(message), reportId, state, askingReason),
      });
    } catch (error) {
      if (!/message is not modified/i.test(error.message)) throw error;
    }
  }

  function errorText(error) {
    return [400, 403, 404, 409].includes(error.status) ? error.message
      : "Проверка временно недоступна. Попробуйте ещё раз.";
  }

  async function prepare({ reportId, tripId, expectsTrip, tripName, projectName, date, employee }) {
    const state = await request("open", { reportId, tripId, expectsTrip, projectName: short(projectName, 200) });
    const base = ["🔎 Проверка выезда",
      "Выезд: " + short(tripName),
      projectName && "Проект: " + short(projectName),
      "Дата выезда: " + short(date, 64),
      "Выездник: " + short(employee),
    ].filter(Boolean).join("\n");
    return { chat_id: chatId, ...render(base, reportId, state) };
  }

  function deliver(payload) {
    // Telegram может принять sendMessage и потерять HTTP-ответ. У вызывающего есть
    // запасной способ открыть проверку из уже известного сообщения фотоотчёта.
    return tg("sendMessage", payload, 15000, false);
  }

  async function handleCallback(callback) {
    const match = callbackPattern.exec(callback.data);
    const answer = (text, showAlert = false) => tg("answerCallbackQuery", {
      callback_query_id: callback.id, text, show_alert: showAlert,
    });
    if (!match || !inReviewChat(callback.message)) return answer("Проверка доступна в чате фотоотчётов.", true);
    const [, reportId, step, choice] = match;
    const message = callback.message;
    const telegramUser = String(callback.from.id);
    const by = senderName(callback.from);
    const fields = { reportId, telegramUser, by };
    try {
      if (choice === "no") {
        const state = await request("read", fields);
        await onSeen(reportId);
        const current = !state.quality ? "quality" : !state.work ? "work" : "";
        if (current !== step) {
          await edit(message, reportId, state);
          return answer("Показано текущее состояние проверки.");
        }
        await edit(message, reportId, state, true);
        return answer("Ответьте на это сообщение и укажите причину.");
      }
      const state = await request(step + "_yes", fields);
      await onSeen(reportId);
      await edit(message, reportId, state);
      return answer(state.work ? "Проверка завершена." : "Качество записано. Отметьте выполнение работ.");
    } catch (error) {
      warn("Проверка выезда: " + error.message);
      return answer(errorText(error), true);
    }
  }

  async function handleReason(message) {
    if (!inReviewChat(message) || !message.reply_to_message) return false;
    const original = message.reply_to_message;
    // Telegram возвращает ссылку и текст запроса в цитате. Поэтому ответ можно
    // принять после перезапуска, проверив, что сообщение было отправлено этим ботом.
    if (String(original.from?.id) !== botId || !original.text?.startsWith("🔎 Проверка выезда\n")) return false;
    const step = Object.keys(reasonPrompts).find(key => original.text.endsWith("\n\n" + reasonPrompts[key]));
    if (!step) return false;
    const link = original.entities?.find(entity => entity.type === "text_link" && entity.url?.startsWith(reportLinkBase));
    const headerId = link?.url?.slice(reportLinkBase.length);
    const text = message.text.trim();
    if (!/^[1-9]\d{0,15}$/.test(headerId) || !text || text.startsWith("/")) return false;
    const reportId = "m" + headerId;
    try {
      const cancel = /^(отмена|отменить|-)$/i.test(text);
      const state = await request(cancel ? "read" : step + "_no", {
        reportId, telegramUser: String(message.from.id), by: senderName(message.from),
        reason: Array.from(text).slice(0, 2000).join(""),
      });
      await onSeen(reportId);
      await edit(original, reportId, state);
    } catch (error) {
      if (error.status === 403) return true;
      warn("Причина по выезду: " + error.message);
      await tg("sendMessage", { chat_id: chatId, text: errorText(error), reply_parameters: { message_id: message.message_id } });
    }
    return true;
  }

  return { prepare, deliver, handleCallback, handleReason, mention,
    authorize(reportId, userId) { return request("read", { reportId, telegramUser: String(userId) }); },
    async reviewer(tripId, userId) {
      const telegramUser = String(userId);
      const { reviewer, authorized } = await request("reviewer", { tripId, telegramUser });
      // Сервер до обновления возвращает только проверяющего.
      if (authorized !== true && !reviewer.ids.includes(telegramUser)) {
        throw Object.assign(new Error("Отметки может поставить только назначенный проверяющий."), { status: 403 });
      }
      return reviewer;
    },
  };
}
