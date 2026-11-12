import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

const QUERY = /^bmreport:([a-f0-9]{16}):(\d{1,3})$/;
const MAX_STATE_BYTES = 1024;
const CLASSIC_BUTTON = { text: "Обычное меню", callback_data: "report_classic" };

const STYLE = `
  body {
    margin: 0; padding: 12px 12px calc(18px + var(--tg-content-safe-area-inset-bottom, 0px)); color: #181c23;
    background: radial-gradient(ellipse at 95% 12%, #f9e68e, transparent 75%),
      radial-gradient(ellipse at 5% 18%, #bcd1e8, transparent 76%), #e5eaf0;
    font: 14px/1.4 system-ui, sans-serif;
  }
  #report { padding: 13px; border: 1px solid #fffe; border-radius: 21px; background: #fff9; }
  h2 { margin: 2px 0 8px; font-size: 20px; font-weight: 600; line-height: 1.15; }
  p { margin: 5px 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  .details { color: #505866; margin-bottom: 10px; font-size: 13px; line-height: 1.35; }
  nav { display: flex; gap: 3px; padding: 3px; margin-bottom: 11px; background: #fff8; border-radius: 20px; }
  nav span { flex: 1; padding: 4px 1px; border-radius: 15px; text-align: center; font-size: 11px; color: #505866; }
  nav .done { background: #dcf0e1; color: #12672c; }
  nav .current { background: #fff; color: #174d9e; }
  .row { display: flex; gap: 6px; margin-top: 6px; }
  .compact nav { margin-bottom: 6px; }
  .compact .details { margin-bottom: 6px; }
  .compact .row { margin-top: 3px; }
  .compact button.tile { border-radius: 11px; padding: 3px 7px; display: grid;
    grid-template-columns: minmax(0,1fr) auto; align-items: center; align-content: center; column-gap: 6px; line-height: 1.15; }
  .compact button small { margin-top: 0; }
  .compact button b { grid-column: 1 / -1; font-size: 12px; }
  .compact button .trip-date { grid-column: 2; grid-row: 2; }
  .compact button .warning { grid-column: 1; grid-row: 2; border: 0; background: none; padding: 0; font-size: 11px; line-height: 1.1; }
  .screen { animation: report-enter .20s ease-out; }
  @keyframes report-enter {
    from { opacity: .55; transform: translateY(5px); }
    to { opacity: 1; transform: translateY(0); }
  }
  button {
    flex: 1; min-width: 0; min-height: 42px; padding: 8px 9px;
    border: 1px solid #fffe; border-radius: 16px; background: #fffc;
    font: 550 13px/1.35 system-ui, sans-serif; color: #181c23;
    white-space: normal; overflow-wrap: anywhere;
    transition: background .15s, transform .15s;
  }
  button:active { transform: scale(.985); background: #fff4b9; }
  button:disabled { opacity: .65; }
  button.primary { background: #ffe66b; border-color: #efda76; }
  button.success { background: #dcf0e1; color: #12672c; border-color: #b7dfc0; }
  button.danger { background: #fff0f2; color: #a42636; border-color: #efc6ca; }
  button.attach { margin: 0 auto; max-width: 260px; background: #f6df43; border-color: #f6df43; }
  button.tile { padding: 10px; border-radius: 17px; background: #fffc; text-align: left; }
  button .mark { display: block; width: 25px; height: 25px; margin-bottom: 5px; border-radius: 50%;
    background: #deebff; color: #2165cd; text-align: center; line-height: 25px; }
  button .mark.lilac { background: #e9e0fc; color: #7042d5; }
  button b, button small { display: block; overflow-wrap: anywhere; }
  button b { font-size: 14px; font-weight: 650; }
  button small { color: #505866; margin-top: 4px; }
  button .project { color: #174d9e; }
  button .warning { display: inline-block; padding: 3px 6px; border: 1px solid #ead9a3; border-radius: 7px; background: #fff8d8; color: #855d08; }
  .status { margin-top: 8px; color: #505866; font-size: 12px; }
  .status:empty { display: none; }
  @media (max-width: 240px) {
    body { padding: 8px 8px calc(13px + var(--tg-content-safe-area-inset-bottom, 0px)); }
    #report { padding: 9px; }
    h2 { font-size: 18px; }
    .details { font-size: 12px; }
    button { padding: 6px; font-size: 12px; line-height: 1.25; }
    button.tile { padding: 8px; }
    .compact button b { font-size: 11px; }
    .compact button .trip-date { font-size: 9px; }
    .compact button .warning { font-size: 9px; }
    button b { font-size: 12px; }
    button small { font-size: 11px; }
  }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } .screen { animation: none; } }
`;

const SCRIPT = `
  (() => {
    const widget = window.TelegramWidget;
    if (!widget) return;
    const root = document.getElementById("report");
    const steps = ["Выезд", "Данные", "Файлы", "Итог"];
    let renderedNonce = "";

    function add(parent, tag, text, className) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text) element.textContent = text;
      parent.appendChild(element);
      return element;
    }

    function render() {
      if (!widget.chatData) return;
      const [nonce, stage, title, details, rows] = JSON.parse(widget.chatData);
      if (nonce === renderedNonce) return;
      renderedNonce = nonce;
      root.textContent = "";
      const screen = add(root, "section", "", stage === 0 ? "screen compact" : "screen");
      if (stage >= 0) {
        const nav = add(screen, "nav");
        steps.forEach((label, index) => add(nav, "span", label,
          index === stage ? "current" : index < stage ? "done" : ""));
      }
      add(screen, "h2", title);
      if (details.length) {
        const description = add(screen, "div", "", "details");
        for (const detail of details) add(description, "p", detail);
      }
      const buttons = [];
      for (const row of rows) {
        const line = add(screen, "div", "", "row");
        for (const [text, tone, project, detail, warning, icon, lilac] of row) {
          const button = add(line, "button", "", tone);
          button.type = "button";
          button.setAttribute("data-action", String(buttons.length));
          buttons.push(button);
          if (tone === "tile") {
            if (icon) add(button, "span", icon, lilac ? "mark lilac" : "mark");
            add(button, "b", text);
            if (project) add(button, "small", "Проект · " + project, "project");
            if (detail) add(button, "small", detail, "trip-date");
            if (warning) add(button, "small", "⚠ Нет предварительной фиксации", "warning");
          } else {
            button.textContent = text;
          }
        }
      }
      const status = add(screen, "p", "", "status");
      screen.addEventListener("click", async event => {
        let target = event.target;
        while (target && target !== screen && !target.hasAttribute("data-action")) target = target.parentNode;
        if (!target || target === screen || target.disabled) return;
        for (const button of buttons) button.disabled = true;
        try {
          const answer = await widget.request("bmreport:" + nonce + ":" + target.getAttribute("data-action"));
          status.textContent = answer?.result || "";
        } catch {
          status.textContent = "Не удалось выполнить действие. Попробуйте ещё раз.";
        } finally {
          for (const button of buttons) button.disabled = false;
        }
      });
    }

    widget.onEvent("chatDataChanged", render);
    render();
    widget.ready();
  })();
`;

export const reportWidgetHtml = "<style>" + STYLE + '</style><div id="report"></div><script>' + SCRIPT + "</script>";
const widgetSourceFits = Buffer.byteLength(reportWidgetHtml) <= 32768
  && deflateSync(reportWidgetHtml, { level: 9 }).length <= 3980;

export function encodeReportPanel({ title, details, rows, stage, cards = {} }, nonce) {
  const actions = [];
  const visibleRows = rows.map(row => row.flatMap(button => {
    const { callback_data: action, web_app: app, url } = button;
    if (!action && !app && !url) return [];
    actions.push(button);
    const card = Object.hasOwn(cards, action) ? cards[action] : null;
    if (card) return [[card.title, "tile", card.project || "", card.detail || "",
      card.warning ? 1 : 0, card.icon || "", card.lilac ? 1 : 0]];
    const tone = action === "attach_help" ? "attach" : button.style || "";
    return [[button.text, tone]];
  }));
  return { chatData: JSON.stringify([nonce, stage ?? -1, title, details.filter(Boolean), visibleRows]), actions };
}

// A widget is clipped at 600 px. Keep room for navigation even at the narrowest bubble.
export function reportWidgetFits(panel) {
  const lines = (value, columns) => String(value || "").split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / columns)), 0);
  let height = 74 + (Number.isInteger(panel.stage) ? 34 : 0);
  for (const detail of panel.details.filter(Boolean)) height += 18 * lines(detail, 21) + 5;
  for (const row of panel.rows) {
    let rowHeight = 42;
    for (const button of row) {
      const card = panel.cards?.[button.callback_data];
      let buttonHeight = 16 + 17 * lines(button.text, Math.floor(20 / row.length));
      if (card && panel.stage === 0) {
        buttonHeight = card.warning ? 44 : 42;
      } else if (card) {
        buttonHeight = 20 + 19 * lines(card.title, 19) + (card.icon ? 30 : 0);
        for (const value of [card.project && "Проект · " + card.project, card.detail, card.warning]) {
          if (value) buttonHeight += 17 * lines(value, 20) + 4;
        }
      }
      rowHeight = Math.max(rowHeight, buttonHeight);
    }
    height += rowHeight + 7;
  }
  if (panel.stage === 0) height -= 7 + 3 * panel.rows.length;
  return height <= (panel.stage === 0 ? 565 : 555)
    && Buffer.byteLength(encodeReportPanel(panel, "0000000000000000").chatData) <= MAX_STATE_BYTES;
}

export function isReportWidgetQuery(query) {
  return typeof query.data === "string" && query.data.startsWith("bmreport:");
}

function detailPage(panel, page, text, count) {
  const navigation = [];
  if (page > 0) navigation.push({ text: "← Текст", callback_data: "panel_page:" + (page - 1) });
  if (page + 1 < count) navigation.push({ text: "Ещё текст →", callback_data: "panel_page:" + (page + 1) });
  return { ...panel, details: [text], rows: [...(navigation.length ? [navigation] : []), ...panel.rows] };
}

function fitReportPanel(panel, page) {
  if (reportWidgetFits(panel)) return panel;
  if (panel.cards || !reportWidgetFits(detailPage(panel, 1, "", 3))) return null;
  const text = Array.from(panel.details.filter(Boolean).join("\n"));
  const pages = [];
  for (let offset = 0; offset < text.length;) {
    let low = 1;
    let high = Math.min(text.length - offset, MAX_STATE_BYTES);
    let fit = 0;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      if (reportWidgetFits(detailPage(panel, 1, text.slice(offset, offset + size).join(""), 3))) {
        fit = size;
        low = size + 1;
      } else {
        high = size - 1;
      }
    }
    if (!fit) return null;
    let end = offset + fit;
    if (end < text.length) {
      for (let boundary = end - 1; boundary > offset + Math.floor(fit * .7); boundary--) {
        if (/\s/.test(text[boundary])) { end = boundary + 1; break; }
      }
    }
    pages.push(text.slice(offset, end).join(""));
    offset = end;
  }
  return pages[page] === undefined ? null : detailPage(panel, page, pages[page].trim(), pages.length);
}

export function createReportPanels({ tg, fallback, warn }) {
  const sendClassic = (chatId, panel) => fallback(
    chatId, panel.title, panel.fallbackDetails || panel.details, panel.fallbackRows || panel.rows,
  );
  const request = (method, params) => tg(method, params, 6000, false, { remainingMs: 0 });

  async function markup(chatId, messageId, rows) {
    return request("editMessageReplyMarkup", {
      chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows },
    });
  }

  async function send(chatId, session, panel, page = 0) {
    session.reportFallback = { step: session.step, panel };
    const widget = session.reportWidget;
    const legacy = () => {
      if (widget) session.classicReport = true;
      delete session.reportWidget;
      return sendClassic(chatId, panel);
    };
    if (session.classicReport || Number(chatId) <= 0 || !widgetSourceFits) return legacy();

    const screen = fitReportPanel(panel, page);
    if (!screen) return legacy();
    const nonce = randomBytes(8).toString("hex");
    const { chatData, actions } = encodeReportPanel(screen, nonce);
    const current = { nonce, step: session.step, actions };
    try {
      if (widget) {
        const id = widget.messageId;
        await request("editMessageWidgetData", { chat_id: chatId, message_id: id, chat_data: chatData });
        session.reportWidget = { ...widget, ...current };
        if (widget.hasKeyboard) {
          try {
            await markup(chatId, id, []);
            session.reportWidget.hasKeyboard = false;
          } catch {
            // The new screen is already available even if Telegram left a native button below.
          }
        }
        return;
      }
      const message = await request("sendWidget", {
        chat_id: chatId, html: reportWidgetHtml, allow_queries: true, chat_data: chatData,
        reply_markup: { inline_keyboard: [[CLASSIC_BUTTON]] },
      });
      const hasClassicButton = message.reply_markup?.inline_keyboard?.some(
        row => row.some(button => button.callback_data === CLASSIC_BUTTON.callback_data),
      );
      if (!hasClassicButton) {
        session.classicReport = true;
        return legacy();
      }
      session.reportWidget = { ...current, messageId: message.message_id, hasKeyboard: true };
      return message;
    } catch {
      warn("Виджет отчёта недоступен, отправлено обычное меню.");
      return legacy();
    }
  }

  async function receive(query, session, allowed) {
    const match = QUERY.exec(query.data || "");
    const widget = session?.reportWidget;
    const action = match && widget?.actions[Number(match[2])];
    const valid = allowed && action && query.type?.type === "data"
      && query.chat?.type === "private" && query.chat.id === query.from?.id
      && query.message_id === widget.messageId && match[1] === widget.nonce
      && session.step === widget.step && !session.submitting;
    const code = valid ? action.callback_data || "" : "";
    let answer = valid ? "" : "Откройте последнее сообщение бота.";
    if (code === "attach_help") answer = "Нажмите скрепку рядом с полем сообщения Telegram и выберите фото или видео.";
    if (valid && code && !["attach_help", "bmcards"].includes(code)) widget.actions = [];
    await request("answerWidgetQuery", { widget_query_id: query.id, data: answer }).catch(() => {});
    if (!valid || code === "attach_help") return null;
    if (code.startsWith("panel_page:")) {
      await send(query.chat.id, session, session.reportFallback.panel, Number(code.slice(11)));
      return null;
    }
    return action;
  }

  async function showLink(chatId, session, button) {
    const widget = session.reportWidget;
    if (!widget) return false;
    try {
      await markup(chatId, widget.messageId, [[button]]);
      widget.hasKeyboard = true;
      return true;
    } catch {
      return false;
    }
  }

  async function resumeClassic(chatId, session) {
    session.classicReport = true;
    delete session.reportWidget;
    if (session.reportFallback?.step !== session.step) return false;
    await sendClassic(chatId, session.reportFallback.panel);
    return true;
  }

  return { send, receive, resumeClassic, showLink };
}
