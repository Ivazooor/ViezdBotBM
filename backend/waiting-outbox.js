import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// Квитанции после ответа Telegram сохраняются до подтверждения сайтом.
// После рестарта бот сначала подтверждает их, затем берёт новые задания.
export class WaitingOutbox {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.directory = path.dirname(this.filePath);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!parsed || parsed.version !== 1 || !parsed.receipts
          || typeof parsed.receipts !== "object" || Array.isArray(parsed.receipts)) {
        throw new Error("Повреждён файл квитанций Жду: " + this.filePath);
      }
      this.state = parsed;
    } else {
      this.state = { version: 1, receipts: {} };
      this.write(this.state);
    }
  }

  write(next) {
    const temp = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify(next));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.filePath);
      this.state = next;
      const dirFd = fs.openSync(this.directory, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (_) {}
      throw error;
    }
  }

  entries() { return Object.entries(this.state.receipts); }
  has(key) { return Object.hasOwn(this.state.receipts, key); }
  save(key, receipt) {
    if (!/^[a-f0-9]{24}:[0-9]{5,20}$/.test(key)) throw new Error("Некорректный ключ квитанции Жду");
    const next = structuredClone(this.state);
    const previous = next.receipts[key];
    const resolvingIntent = previous && previous.stage === "intent"
      && previous.id === receipt.id && previous.chatId === receipt.chatId
      && previous.claimId === receipt.claimId && receipt.stage !== "intent";
    if (previous && !resolvingIntent && JSON.stringify(previous) !== JSON.stringify(receipt)) {
      throw new Error("Квитанция Жду уже записана с другим результатом");
    }
    next.receipts[key] = receipt;
    this.write(next);
  }
  remove(key) {
    if (!this.has(key)) return;
    const next = structuredClone(this.state);
    delete next.receipts[key];
    this.write(next);
  }
}
