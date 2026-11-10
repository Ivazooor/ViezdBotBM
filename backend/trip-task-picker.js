import { randomBytes } from "node:crypto";

const choices = [
  "Осмотреть макет и зафиксировать состояние",
  "Смонтировать и выровнять макет",
  "Подключить и проверить подсветку",
  "Проверить управление и интерактив",
  "Устранить замечания на объекте",
  "Демонтировать и упаковать макет",
];

export const taskCallback = /^visit_tasks:([a-f0-9]{10}):([0-5]|custom|list|done|back|cancel)$/;

export function newTaskPicker() {
  return { token: randomBytes(5).toString("hex"), selected: new Set(), manual: false };
}

export function changeTaskPicker(picker, action) {
  if (action === "custom" || action === "list") {
    picker.manual = action === "custom";
    return;
  }
  if (picker.manual || !/^[0-5]$/.test(action)) return;
  const index = Number(action);
  if (picker.selected.has(index)) picker.selected.delete(index);
  else picker.selected.add(index);
}

export function taskPickerText(picker, custom = "") {
  return [...choices.filter((_, index) => picker.selected.has(index)), custom.trim()].filter(Boolean).join("\n");
}

export function taskPickerPanel(picker, tripName) {
  const button = (text, action, style) => ({
    text, callback_data: "visit_tasks:" + picker.token + ":" + action, ...(style ? { style } : {}),
  });
  const cancel = button("Отмена", "cancel", "danger");
  if (picker.manual) {
    return {
      title: "Своя задача",
      details: [tripName, "Пришлите задачу текстом. Она добавится к выбранным пунктам."],
      rows: [[button("← К готовым задачам", "list"), cancel]],
    };
  }
  return {
    title: "Задачи на выезд",
    details: [tripName, "Выберите один или несколько пунктов. Повторное нажатие снимает отметку."],
    rows: [
      ...choices.map((text, index) => {
        const selected = picker.selected.has(index);
        return [button((selected ? "✓ " : "○ ") + text, index, selected ? "success" : undefined)];
      }),
      [button("Продолжить · " + picker.selected.size, "done", "primary")],
      [button("Своя задача", "custom")],
      [button("← К выездам", "back"), cancel],
    ],
  };
}
