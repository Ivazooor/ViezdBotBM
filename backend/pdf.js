// ===== Генерация фирменного PDF-отчёта о выезде (для заказчика) =====
// Светлый документ в фирстиле «Бизнесмакет» (чёрный + золото), шрифт Montserrat.
// Используется только для ЗАКЛЮЧИТЕЛЬНОГО отчёта.
import PDFDocument from "pdfkit";
import { fileURLToPath } from "url";
import path from "path";

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
const FONTS = path.join(ASSETS, "fonts");
const BRAND_DIR = path.join(ASSETS, "brand");

const FONT = {
  regular: path.join(FONTS, "Montserrat-Regular.ttf"),
  medium: path.join(FONTS, "Montserrat-Medium.ttf"),
  semibold: path.join(FONTS, "Montserrat-SemiBold.ttf"),
  bold: path.join(FONTS, "Montserrat-Bold.ttf"),
};
const LOGO_WORDMARK = path.join(BRAND_DIR, "logo-wordmark.png"); // «бизнесмакет», 4119×680
const LOGO_MARK = path.join(BRAND_DIR, "mark.png"); // квадратный знак

// Фирменная палитра
const COLOR = {
  ink: "#141414", // почти чёрный — основной текст
  gold: "#C2A14D", // золото — акценты
  goldDark: "#9C7E36",
  muted: "#6E6E6E", // серый — подписи/лейблы
  line: "#E4E1DA", // светлые разделители
  soft: "#F6F3EC", // тёплая кремовая подложка под блоки
  white: "#FFFFFF",
  ok: "#3E7C4F", // зелёный — «всё выполнено»
};

// Контакты по умолчанию (можно переопределить через options.brand)
const DEFAULT_BRAND = {
  site: "бизнес-макет.рф",
  managerName: "Вербицкий Матвей Михайлович",
  managerPhone: "+7 985 433-75-90",
};

const PAGE = { size: "A4", margin: 46 };
const A4 = { w: 595.28, h: 841.89 };
const FOOTER_H = 60; // высота нижней зоны под подвал

// Соотношение сторон вордмарка (ширина/высота)
const WORDMARK_RATIO = 4119 / 680;

/**
 * Собрать PDF-отчёт.
 * @param {object} data { projectName, visitDate, responsible, workDone, workNotDone, recommendations, generatedAt }
 * @param {Buffer[]} photos массив буферов изображений (фото выезда), видео не включаются
 * @param {object} [options] { brand }
 * @returns {Promise<Buffer>}
 */
export function buildVisitPdf(data, photos = [], options = {}) {
  const brand = { ...DEFAULT_BRAND, ...(options.brand || {}) };

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: PAGE.size,
        margin: PAGE.margin,
        bufferPages: true, // нужно для подвала/нумерации в конце
        info: {
          Title: `Отчёт о выполненных работах — ${data.projectName || ""}`.trim(),
          Author: "Бизнесмакет",
          Subject: "Заключительный отчёт о выезде",
        },
      });

      doc.registerFont("reg", FONT.regular);
      doc.registerFont("med", FONT.medium);
      doc.registerFont("sb", FONT.semibold);
      doc.registerFont("bold", FONT.bold);

      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      const left = PAGE.margin;
      const right = A4.w - PAGE.margin;
      const contentW = right - left;
      const maxY = A4.h - FOOTER_H - 14; // нижняя граница контента

      // --- утилита: гарантировать вертикальное место, иначе новая страница ---
      const topContent = PAGE.margin + 10;
      function ensureSpace(h) {
        if (doc.y + h > maxY) {
          doc.addPage();
          doc.y = topContent;
        }
      }

      // ===== ШАПКА (только первая страница) =====
      drawHeader(doc, data, left, right, contentW);

      // ===== РЕКВИЗИТЫ =====
      drawMetaCard(doc, data, brand, left, contentW, ensureSpace);

      // ===== СОДЕРЖАНИЕ =====
      const notDoneAllDone = isAllDone(data.workNotDone);
      const noRecs = isEmptyish(data.recommendations);

      drawSection(doc, "Выполненные работы", left, contentW, ensureSpace, (innerY) =>
        drawBody(doc, valueOr(data.workDone, "—"), left, contentW, ensureSpace)
      );

      drawSection(doc, "Не выполнено / причины", left, contentW, ensureSpace, () => {
        if (notDoneAllDone) {
          drawBadgeLine(doc, "Все работы выполнены в полном объёме.", left, contentW, ensureSpace);
        } else {
          drawBody(doc, valueOr(data.workNotDone, "—"), left, contentW, ensureSpace);
        }
      });

      drawSection(doc, "Рекомендации по макету", left, contentW, ensureSpace, () => {
        drawBody(
          doc,
          noRecs ? "Особых рекомендаций нет." : data.recommendations,
          left,
          contentW,
          ensureSpace
        );
      });

      // ===== ФОТООТЧЁТ =====
      if (photos && photos.length) {
        drawSection(doc, `Фотоотчёт`, left, contentW, ensureSpace, () => {
          drawPhotoGrid(doc, photos, left, contentW, maxY, topContent, ensureSpace);
        });
      }

      // ===== Канты + подвалы на всех страницах =====
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        // Обнуляем поля, иначе footer-текст ниже нижнего поля заставит
        // pdfkit добавлять пустые страницы (авто-пагинация).
        doc.page.margins.bottom = 0;
        doc.page.margins.top = 0;
        drawTopRule(doc, left, right);
        drawFooter(doc, brand, left, right, contentW, i + 1, range.count);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ====================== СЕКЦИИ ВЁРСТКИ ======================

function drawHeader(doc, data, left, right, contentW) {
  doc.y = PAGE.margin + 6;

  // Логотип-вордмарк слева
  const logoH = 22;
  const logoW = logoH * WORDMARK_RATIO;
  try {
    doc.image(LOGO_WORDMARK, left, doc.y, { height: logoH });
  } catch (_) {}

  // Справа — тип документа мелким золотом
  doc
    .font("sb")
    .fontSize(8)
    .fillColor(COLOR.gold)
    .text("ОТЧЁТ О ВЫЕЗДЕ", left, doc.y + 6, {
      width: contentW,
      align: "right",
      characterSpacing: 1.2,
    });

  doc.y = PAGE.margin + 6 + logoH + 24;

  // Заголовок документа
  doc
    .font("bold")
    .fontSize(21)
    .fillColor(COLOR.ink)
    .text("ОТЧЁТ О ВЫПОЛНЕННЫХ РАБОТАХ", left, doc.y, {
      width: contentW,
      characterSpacing: 0.4,
    });

  // Золотая черта + подзаголовок
  const ly = doc.y + 8;
  doc.save().lineWidth(3).strokeColor(COLOR.gold).moveTo(left, ly).lineTo(left + 46, ly).stroke().restore();
  doc
    .font("med")
    .fontSize(10.5)
    .fillColor(COLOR.muted)
    .text("Заключительный отчёт о выезде специалиста", left, ly + 9, { width: contentW });

  doc.y = ly + 9 + 22;
}

function drawMetaCard(doc, data, brand, left, contentW, ensureSpace) {
  const rows = [
    ["Проект", valueOr(data.projectName, "—")],
    ["Дата выезда", valueOr(data.visitDate, "—")],
    ["Исполнитель работ", valueOr(data.responsible, "—")],
  ];

  const padX = 16;
  const padY = 14;
  const labelW = 130;
  const valW = contentW - padX * 2 - labelW;
  const rowGap = 9;

  // высота карточки
  doc.font("med").fontSize(11);
  let inner = 0;
  rows.forEach(([, v], i) => {
    const h = doc.heightOfString(v, { width: valW });
    inner += Math.max(h, 13) + (i < rows.length - 1 ? rowGap : 0);
  });
  const cardH = inner + padY * 2;

  ensureSpace(cardH + 8);
  const cardY = doc.y;

  // фон
  doc.save();
  roundedRect(doc, left, cardY, contentW, cardH, 9).fill(COLOR.soft);
  // золотая полоска-акцент слева
  doc.save();
  roundedRect(doc, left, cardY, contentW, cardH, 9).clip();
  doc.rect(left, cardY, 4, cardH).fill(COLOR.gold);
  doc.restore();
  doc.restore();

  // строки
  let y = cardY + padY;
  rows.forEach(([label, value]) => {
    const h = Math.max(doc.font("med").fontSize(11).heightOfString(value, { width: valW }), 13);
    doc
      .font("sb")
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text(label.toUpperCase(), left + padX, y + 1.5, { width: labelW - 8, characterSpacing: 0.6 });
    doc
      .font("med")
      .fontSize(11)
      .fillColor(COLOR.ink)
      .text(value, left + padX + labelW, y, { width: valW });
    y += h + rowGap;
  });

  doc.y = cardY + cardH + 22;
}

// Заголовок секции с золотой риской + контент через callback
function drawSection(doc, title, left, contentW, ensureSpace, drawContent) {
  ensureSpace(34);
  const ty = doc.y;
  // золотая вертикальная риска
  doc.save().rect(left, ty + 1, 3.5, 14).fill(COLOR.gold).restore();
  doc
    .font("sb")
    .fontSize(12.5)
    .fillColor(COLOR.ink)
    .text(title, left + 12, ty, { width: contentW - 12, characterSpacing: 0.3 });
  doc.y = ty + 22;
  drawContent();
  doc.y += 16; // отступ после секции
}

function drawBody(doc, text, left, contentW, ensureSpace) {
  doc.font("reg").fontSize(10.5).fillColor(COLOR.ink);
  const str = String(text == null ? "—" : text);
  const h = doc.heightOfString(str, { width: contentW, lineGap: 3 });
  ensureSpace(h);
  doc.text(str, left, doc.y, { width: contentW, lineGap: 3, align: "left" });
}

// Зелёная плашка-строка «всё выполнено»
function drawBadgeLine(doc, text, left, contentW, ensureSpace) {
  ensureSpace(24);
  const y = doc.y;
  const h = 22;
  doc.save();
  roundedRect(doc, left, y, contentW, h, 6).fill("#EEF5EF");
  doc.restore();
  // галочка вектором
  const cx = left + 16;
  const cy = y + h / 2;
  doc.save().lineWidth(1.8).strokeColor(COLOR.ok);
  doc.moveTo(cx - 4, cy).lineTo(cx - 1, cy + 3.5).lineTo(cx + 5, cy - 4).stroke();
  doc.restore();
  doc
    .font("med")
    .fontSize(10.5)
    .fillColor(COLOR.ok)
    .text(text, left + 30, y + (h - 12) / 2, { width: contentW - 40 });
  doc.y = y + h;
}

// Сетка фото 2 колонки: фото целиком (contain) на белой карточке с мягкой тенью.
function drawPhotoGrid(doc, photos, left, contentW, maxY, topContent, ensureSpace) {
  const cols = 2;
  const gap = 16;
  const cellW = (contentW - gap * (cols - 1)) / cols;
  const cellH = 172;
  const capH = 16;
  const rowH = cellH + capH + 20;

  for (let i = 0; i < photos.length; i += cols) {
    // перенос ряда на новую страницу при нехватке места
    if (doc.y + rowH > maxY) {
      doc.addPage();
      doc.y = topContent;
    }
    const rowY = doc.y;
    for (let c = 0; c < cols; c++) {
      const idx = i + c;
      if (idx >= photos.length) break;
      const x = left + c * (cellW + gap);
      drawPhotoCell(doc, photos[idx], x, rowY, cellW, cellH, idx + 1);
    }
    doc.y = rowY + rowH;
  }
}

// Мягкая тень под карточкой (имитация drop-shadow несколькими полупрозрачными слоями).
function drawSoftShadow(doc, x, y, w, h, r) {
  doc.save();
  const layers = 7;
  for (let i = layers; i >= 1; i--) {
    doc.fillOpacity(0.04);
    doc.fillColor("#1A1A1A");
    doc.roundedRect(x - i, y - i + 2.5, w + i * 2, h + i * 2, r + i).fill();
  }
  doc.restore();
}

function drawPhotoCell(doc, buf, x, y, w, h, num) {
  const r = 7;
  const pad = 8; // паспарту: фото не прилипает к краям карточки

  // тень → белая карточка (визуально «возвышается» над листом)
  drawSoftShadow(doc, x, y, w, h, r);
  doc.save();
  roundedRect(doc, x, y, w, h, r).fill(COLOR.white);
  doc.restore();

  // фото целиком (contain) по центру карточки
  try {
    const img = doc.openImage(buf);
    const scale = Math.min((w - pad * 2) / img.width, (h - pad * 2) / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = x + (w - dw) / 2;
    const dy = y + (h - dh) / 2;
    doc.image(buf, dx, dy, { width: dw, height: dh });
  } catch (_) {
    doc
      .font("reg")
      .fontSize(9)
      .fillColor(COLOR.muted)
      .text("Изображение недоступно", x, y + h / 2 - 6, { width: w, align: "center" });
  }

  // тонкая рамка карточки
  doc.save().lineWidth(0.8).strokeColor(COLOR.line);
  roundedRect(doc, x, y, w, h, r).stroke();
  doc.restore();

  // подпись
  doc
    .font("med")
    .fontSize(8.5)
    .fillColor(COLOR.muted)
    .text(`Фото ${num}`, x, y + h + 7, { width: w, align: "center" });
}

// Верхний золотой кант
function drawTopRule(doc, left, right) {
  doc.save().rect(0, 0, A4.w, 4).fill(COLOR.gold).restore();
}

// Подвал: разделитель + бренд + контакт ответственного + номер страницы
function drawFooter(doc, brand, left, right, contentW, pageNo, pageCount) {
  const y = A4.h - FOOTER_H;
  // разделитель
  doc.save().lineWidth(0.8).strokeColor(COLOR.line).moveTo(left, y).lineTo(right, y).stroke().restore();

  // знак + сайт слева
  let tx = left;
  try {
    doc.image(LOGO_MARK, left, y + 9, { height: 11 });
    tx = left + 16;
  } catch (_) {}
  doc
    .font("sb")
    .fontSize(8.5)
    .fillColor(COLOR.ink)
    .text(brand.site, tx, y + 10, { width: 200, lineBreak: false });

  // номер страницы справа
  doc
    .font("med")
    .fontSize(8)
    .fillColor(COLOR.muted)
    .text(`${pageNo} / ${pageCount}`, right - 60, y + 10, { width: 60, align: "right" });

  // контакт ответственного — нижняя строка
  doc
    .font("reg")
    .fontSize(8)
    .fillColor(COLOR.muted)
    .text(
      `Ответственный менеджер: ${brand.managerName} · тел. ${brand.managerPhone}`,
      left,
      y + 26,
      { width: contentW, align: "left" }
    );
}

// ====================== ХЕЛПЕРЫ ======================

function roundedRect(doc, x, y, w, h, r) {
  return doc.roundedRect(x, y, w, h, r);
}

function valueOr(v, fallback) {
  const s = (v == null ? "" : String(v)).trim();
  return s ? s : fallback;
}

function isEmptyish(v) {
  const s = (v == null ? "" : String(v)).trim().toLowerCase();
  return !s || s === "нет" || s === "-" || s === "—";
}

function isAllDone(v) {
  const s = (v == null ? "" : String(v)).trim().toLowerCase();
  return s === "всё выполнено" || s === "все выполнено";
}
