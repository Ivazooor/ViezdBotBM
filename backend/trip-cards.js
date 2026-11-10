import { readFileSync } from "node:fs";

const html = readFileSync(new URL("trip-card.html", import.meta.url), "utf8");
const refPattern = /^[a-f0-9]{24}$/;
const statuses = {
  planned: "Запланирован", review: "Ждёт оценки", paused: "На паузе",
  good: "Качественный", bad: "Требуется доработка",
};
const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" });
const timeFormat = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });

function shortDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : "";
}

function cardName(trip) {
  return Array.from(String(trip.name || "Выезд").replace(/\s+/g, " ").trim()).slice(0, 88).join("") || "Выезд";
}

export function createTripCards({ tg, readTrips, miniAppUrl, miniAppLink, botUsername, warn }) {
  const directPath = new RegExp("^/" + (botUsername || "").replace(/[^a-z0-9_]/gi, "") + "(?:/[a-z0-9_]{1,64})?/?$", "i");
  let direct;
  let app;
  try {
    const link = new URL(miniAppLink);
    if (link.origin === "https://t.me" && !link.username && !link.password && directPath.test(link.pathname)) {
      link.search = "";
      link.hash = "";
      direct = link;
    }
  } catch {}
  try {
    const link = new URL(miniAppUrl);
    if (link.protocol === "https:" && !link.hash && !link.username && !link.password) app = link;
  } catch {}

  function urlFor(base, ref, photos) {
    const url = new URL(base);
    if (base === direct) {
      url.searchParams.set("startapp", "trip_" + ref + (photos ? "_photos" : ""));
    } else {
      url.searchParams.set("trip", ref);
      if (photos) url.searchParams.set("view", "photos");
    }
    return url.href;
  }

  function snapshot(trip) {
    const first = shortDate(trip.date);
    const end = shortDate(trip.dateEnd);
    return {
      ref: trip.ref, title: cardName(trip),
      date: first ? first + (end && end !== first ? " – " + end : "") : "Дата уточняется",
      status: statuses[trip.status] || statuses.planned,
      tone: trip.status === "good" || trip.status === "bad" ? trip.status : "",
      prelim: Boolean(trip.prelim), final: Boolean(trip.final),
      photos: Math.max(0, Math.trunc(Number(trip.photos) || 0)),
      updated: timeFormat.format(new Date()),
      open: direct ? urlFor(direct, trip.ref, false) : "",
      photoOpen: direct && Number(trip.photos) > 0 ? urlFor(direct, trip.ref, true) : "",
    };
  }

  function fallbackButtons(trip) {
    const base = app || direct;
    if (!base) return undefined;
    const button = (text, photos) => {
      const url = urlFor(base, trip.ref, photos);
      const style = photos ? {} : { style: "primary" };
      return app ? { text, ...style, web_app: { url } } : { text, ...style, url };
    };
    return { inline_keyboard: [
      [button("Открыть выезд", false)],
      ...(trip.photos > 0 ? [[button("Смотреть фото", true)]] : []),
    ] };
  }

  async function sendText(chatId, text, reply_markup) {
    return tg("sendMessage", { chat_id: chatId, text, reply_markup, protect_content: true });
  }

  async function getCards(userId, ref = "") {
    const trips = await readTrips(userId, ref);
    return Array.isArray(trips) ? trips.filter(trip => trip && refPattern.test(trip.ref)) : [];
  }

  async function showList(chatId, userId) {
    try {
      const trips = await getCards(userId);
      if (!trips.length) return sendText(chatId, "У вас пока нет назначенных выездов.");
      return sendText(chatId, "Мои выезды\nВыберите выезд, чтобы открыть его карточку.", {
        inline_keyboard: trips.map(trip => [{
          text: [shortDate(trip.date), cardName(trip)].filter(Boolean).join(" · ").slice(0, 90),
          callback_data: "bmcard:" + trip.ref,
        }]),
      });
    } catch (error) {
      const message = error.code === "employee_link_required"
        ? "Откройте приложение по выездам и привяжите учётную запись сотрудника."
        : "Не удалось загрузить карточки. Попробуйте ещё раз или откройте приложение.";
      return sendText(chatId, message);
    }
  }

  async function showCard(chatId, userId, ref) {
    let trip;
    try { trip = (await getCards(userId, ref)).find(item => item.ref === ref); }
    catch (error) {
      return sendText(chatId, error.code === "employee_link_required"
        ? "Привяжите учётную запись в приложении по выездам."
        : "Не удалось загрузить выезд. Попробуйте ещё раз.");
    }
    if (!trip) return sendText(chatId, "Выезд больше не доступен. Откройте список «Мои выезды».");
    const card = snapshot(trip);
    const text = [
      card.title, card.date + " · " + card.status,
      "Предварительный: " + (card.prelim ? "сдан" : "ожидается"),
      "Заключительный: " + (card.final ? "сдан" : "ожидается"),
      "Фото задания: " + card.photos,
    ].join("\n");
    if (app || direct) {
      try {
        await tg("sendWidget", {
          chat_id: chatId, html, chat_data: JSON.stringify(card), allow_queries: true,
          caption: text, reply_markup: fallbackButtons(trip),
        }, 5000, false, { remainingMs: 0 });
        return;
      } catch (error) {
        warn("Карточка выезда: sendWidget недоступен");
        if (error.uncertain) return;
      }
    }
    return sendText(chatId, text, fallbackButtons(trip));
  }

  async function refresh(query, allowed) {
    const match = /^bmcard:([a-f0-9]{24})$/.exec(query.data || "");
    const finish = (message = "") => tg("answerWidgetQuery", {
      widget_query_id: query.id, data: message,
    }, 3000, false, { remainingMs: 0 });
    if (!allowed || !match || query.type?.type !== "data" || query.chat?.type !== "private" ||
        query.chat.id !== query.from?.id || !Number.isInteger(query.message_id)) {
      return finish("Карточка недоступна.");
    }

    let card;
    try {
      const trip = (await getCards(query.from.id, match[1])).find(item => item.ref === match[1]);
      if (trip) card = snapshot(trip);
    } catch (error) {
      if (error.code !== "employee_link_required") return finish("Не удалось обновить. Попробуйте ещё раз.");
    }
    if (!card) {
      card = { ref: match[1], title: "Выезд недоступен", unavailable: true };
    }
    try {
      await tg("editMessageWidgetData", {
        chat_id: query.chat.id, message_id: query.message_id, chat_data: JSON.stringify(card),
      }, 3000, false, { remainingMs: 0 });
    } catch (error) {
      if (!/not modified/i.test(error.message)) return finish("Не удалось обновить. Откройте приложение.");
    }
    return finish(card.unavailable ? "Карточка недоступна." : "Карточка обновлена.");
  }

  return { showList, showCard, refresh };
}
