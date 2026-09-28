import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const EMPTY = () => ({ version: 1, reports: {}, pendingClaimId: null, deliveries: {}, acks: {} });

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A single small JSON journal is enough for this bot. Every transition is a full,
// atomic replacement; never reset a damaged file silently and lose message IDs.
export class ReportOutbox {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.directory = path.dirname(this.filePath);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.reports)
          || !isRecord(parsed.deliveries) || !isRecord(parsed.acks)
          || (parsed.pendingClaimId !== null && !/^[a-f0-9]{24}$/.test(parsed.pendingClaimId))) {
        throw new Error("Повреждён файл очереди отчётов: " + this.filePath);
      }
      this.state = parsed;
      // A final report may have been interrupted while its PDF was built.
      // Its already copied media still needs to become searchable after restart.
      const staged = Object.values(this.state.reports).filter((entry) => entry.staged);
      if (staged.length) {
        for (const entry of staged) { entry.staged = false; entry.retryAt = 0; }
        this.write(this.state);
      }
    } else {
      this.state = EMPTY();
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
      // После rename файл уже содержит next. Если fsync каталога завершится ошибкой,
      // следующие обновления не должны записать поверх него прежнее состояние.
      this.state = next;
      const dirFd = fs.openSync(this.directory, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (_) {}
      throw error;
    }
  }

  update(change) {
    const next = structuredClone(this.state);
    change(next);
    this.write(next);
  }

  reportEntries() { return Object.entries(this.state.reports); }
  queueReport(id, payload, staged = false) {
    this.update((s) => {
      const old = s.reports[id];
      if (old && !old.staged && JSON.stringify(old.payload) !== JSON.stringify(payload)) {
        throw new Error("Отчёт уже в очереди с другим содержимым: " + id);
      }
      if (old && old.staged) {
        // Во время сборки PDF дополняем запись известным message_id файла.
        // После готовности отчёта переводим её из staged в обычную очередь.
        old.payload = payload;
        old.staged = staged;
        old.retryAt = 0;
      } else if (!old) {
        s.reports[id] = { payload, staged, retryAt: 0, attempts: 0 };
      }
    });
  }
  removeReport(id) { this.update((s) => { delete s.reports[id]; }); }
  deferReport(id) {
    this.update((s) => {
      if (!s.reports[id]) return;
      const entry = s.reports[id];
      entry.attempts = (entry.attempts || 0) + 1;
      entry.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(entry.attempts, 6));
    });
  }

  pendingClaimId() { return this.state.pendingClaimId; }
  setClaim(id) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Некорректный claimId");
    this.update((s) => {
      if (s.pendingClaimId && s.pendingClaimId !== id) throw new Error("Предыдущий claim ещё не разрешён");
      s.pendingClaimId = id;
    });
  }
  saveClaimedJobs(claimId, jobs) {
    if (!Array.isArray(jobs)) throw new Error("Некорректный ответ report_jobs");
    this.update((s) => {
      if (s.pendingClaimId !== claimId) throw new Error("Ответ на другой claimId");
      for (const job of jobs) {
        const id = String(job && job.id || "");
        if (!/^[a-f0-9]{24}$/.test(id) || s.deliveries[id] || s.acks[id]) {
          throw new Error("Некорректный или повторный job ID");
        }
        s.deliveries[id] = { claimId, job, started: false };
      }
      s.pendingClaimId = null;
    });
  }

  deliveryEntries() { return Object.entries(this.state.deliveries); }
  markStarted(id) {
    this.update((s) => {
      if (!s.deliveries[id]) throw new Error("Заявка не найдена в локальной очереди");
      s.deliveries[id].started = true;
    });
  }
  finishDelivery(id, ack) {
    this.update((s) => {
      if (!s.deliveries[id]) throw new Error("Заявка не найдена в локальной очереди");
      s.acks[id] = ack;
      delete s.deliveries[id];
    });
  }
  ackEntries() { return Object.entries(this.state.acks); }
  deferAck(id) {
    this.update((s) => {
      if (!s.acks[id]) return;
      const ack = s.acks[id];
      ack.attempts = (ack.attempts || 0) + 1;
      ack.retryAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(ack.attempts, 6));
    });
  }
  removeAck(id) { this.update((s) => { delete s.acks[id]; }); }
}
