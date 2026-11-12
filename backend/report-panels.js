import { randomBytes } from "node:crypto";
import { deflateSync } from "node:zlib";

const QUERY = /^bmreport:([a-f0-9]{16}):(\d{1,3})$/;
const STEPS = ["Выезд", "Данные", "Файлы", "Итог"];
const FALLBACK_COMMAND = "/report_classic";

const STYLE = `
  body {
    margin: 0; padding: 12px 12px 18px; color: #181c23;
    background: radial-gradient(ellipse at 95% 12%, #f9e68e, transparent 75%),
      radial-gradient(ellipse at 5% 18%, #bcd1e8, transparent 76%), #e5eaf0;
    font: 14px/1.4 system-ui, sans-serif;
  }
  main { padding: 13px; border: 1px solid #fffe; border-radius: 21px; background: #fff9; }
  h2 { margin: 2px 0 8px; font-size: 20px; font-weight: 600; line-height: 1.15; }
  p { margin: 5px 0; overflow-wrap: anywhere; white-space: pre-wrap; }
  .details { color: #505866; margin-bottom: 10px; font-size: 13px; line-height: 1.35; }
  nav { display: flex; gap: 3px; padding: 3px; margin-bottom: 11px; background: #fff8; border-radius: 20px; }
  nav span { flex: 1; padding: 4px 1px; border-radius: 15px; text-align: center; font-size: 11px; color: #505866; }
  nav .done { background: #dcf0e1; color: #12672c; }
  nav .current { background: #fff; color: #174d9e; }
  .row { display: flex; gap: 6px; margin-top: 7px; }
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
    body { padding: 8px 8px 13px; }
    main { padding: 9px; }
    h2 { font-size: 18px; }
    .details { font-size: 12px; }
    button.tile { padding: 8px; }
    button b { font-size: 12px; }
    button small { font-size: 11px; }
  }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
`;

const SCRIPT = `
  (() => {
    const widget = TelegramWidget;
    const status = document.getElementById("status");
    const buttons = Array.from(document.querySelectorAll("button[data-query]"));
    for (const button of buttons) {
      button.addEventListener("click", async () => {
        for (const item of buttons) item.disabled = true;
        try {
          const answer = await widget.request(button.dataset.query);
          status.textContent = answer.result || "";
        } catch {
          status.textContent = "Не удалось выполнить действие. Попробуйте ещё раз.";
        } finally {
          for (const item of buttons) item.disabled = false;
        }
      });
    }
    widget.ready();
  })();
`;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function tile(card) {
  return [
    card.icon && '<span aria-hidden="true" class="mark' + (card.lilac ? ' lilac' : '') + '">' + escapeHtml(card.icon) + '</span>',
    "<b>" + escapeHtml(card.title) + "</b>",
    card.project && '<small class="project">Проект · ' + escapeHtml(card.project) + "</small>",
    card.detail && "<small>" + escapeHtml(card.detail) + "</small>",
    card.warning && '<small class="warning">⚠ ' + escapeHtml(card.warning) + "</small>",
  ].filter(Boolean).join("");
}

function progress(stage) {
  if (!Number.isInteger(stage)) return "";
  const items = STEPS.map((step, index) => {
    const attr = index === stage ? ' class="current"' : index < stage ? ' class="done"' : "";
    return "<span" + attr + ">" + step + "</span>";
  });
  return "<nav>" + items.join("") + "</nav>";
}

export function renderReportWidget({ title, details, rows, stage, cards = {} }, nonce) {
  const actions = [];
  const buttons = rows.map(row => '<div class="row">' + row.map(button => {
    const { callback_data: action, web_app: app, url } = button;
    if (!action && !app && !url) return "";
    const card = Object.hasOwn(cards, action) ? cards[action] : null;
    const tone = card ? "tile"
      : action === "attach_help" ? "attach"
      : ["primary", "success", "danger"].includes(button.style) ? button.style : "";
    const query = "bmreport:" + nonce + ":" + actions.length;
    actions.push(button);
    return '<button type="button" class="' + tone + '" data-query="' + query + '">'
      + (card ? tile(card) : escapeHtml(button.text)) + "</button>";
  }).join("") + "</div>").join("");
  const description = details.filter(Boolean).map(line => "<p>" + escapeHtml(line) + "</p>").join("");
  const html = "<style>" + STYLE + "</style><main>" + progress(stage) + "<h2>" + escapeHtml(title) + "</h2>"
    + (description ? '<div class="details">' + description + "</div>" : "")
    + buttons + '<p id="status" class="status" aria-live="polite"></p></main><script>' + SCRIPT + "</script>";
  return { html, actions };
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
      if (card) {
        buttonHeight = 20 + 19 * lines(card.title, 19) + (card.icon ? 30 : 0);
        for (const value of [card.project && "Проект · " + card.project, card.detail, card.warning]) {
          if (value) buttonHeight += 17 * lines(value, 20) + 4;
        }
      }
      rowHeight = Math.max(rowHeight, buttonHeight);
    }
    height += rowHeight + 7;
  }
  return height <= (panel.stage === 0 ? 520 : 555);
}

export function isReportWidgetQuery(query) {
  return typeof query.data === "string" && query.data.startsWith("bmreport:");
}

export function createReportPanels({ tg, fallback, warn }) {
  const sendClassic = (chatId, panel) => fallback(
    chatId, panel.title, panel.fallbackDetails || panel.details, panel.fallbackRows || panel.rows,
  );

  async function send(chatId, session, panel) {
    delete session.reportWidget;
    session.reportFallback = { step: session.step, panel };
    const legacy = () => sendClassic(chatId, panel);
    if (session.classicReport || Number(chatId) <= 0 || !reportWidgetFits(panel)) return legacy();

    const nonce = randomBytes(8).toString("hex");
    const { html, actions } = renderReportWidget(panel, nonce);
    if (Buffer.byteLength(html) > 32768 || deflateSync(html, { level: 9 }).length > 3980) return legacy();

    try {
      const message = await tg("sendWidget", {
        chat_id: chatId,
        html,
        allow_queries: true,
        caption: panel.title + "\nЕсли карточка не открылась, отправьте " + FALLBACK_COMMAND + ".",
      }, 6000, false, { remainingMs: 0 });
      session.reportWidget = { nonce, step: session.step, messageId: message.message_id, actions };
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
    // Опрос обрабатывает действия последовательно. Устаревший или повторный запрос
    // не должен запустить тот же переход после отправки следующей панели.
    if (valid && action.callback_data && !["attach_help", "bmcards"].includes(action.callback_data)) {
      delete session.reportWidget;
    }
    await tg("answerWidgetQuery", {
      widget_query_id: query.id,
      data: valid ? "" : "Откройте последнее сообщение бота.",
    }, 3000, false, { remainingMs: 0 }).catch(() => {});
    return valid ? action : null;
  }

  async function resumeClassic(chatId, session) {
    session.classicReport = true;
    delete session.reportWidget;
    if (session.reportFallback?.step !== session.step) return false;
    await sendClassic(chatId, session.reportFallback.panel);
    return true;
  }

  return { send, receive, resumeClassic };
}
