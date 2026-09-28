export function normalizeMessageIds(raw) {
  const ids = Array.isArray(raw) ? raw.map(Number) : [];
  if (!ids.length || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)
      || new Set(ids).size !== ids.length) {
    throw new Error("некорректные ID сообщений отчёта");
  }
  return ids.sort((a, b) => a - b);
}

// copyMessages may skip deleted/uncopyable messages within a successful batch.
// Continue with later batches and report the total instead of hiding valid media.
export async function copyReportMessages(ids, copyChunk, onProgress = () => {}) {
  let copiedCount = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const result = await copyChunk(ids.slice(i, i + 100));
    if (!Array.isArray(result) || result.length > Math.min(100, ids.length - i)) {
      throw new Error("Telegram вернул неожиданный ответ copyMessages");
    }
    copiedCount += result.length;
    onProgress(copiedCount);
  }
  return { copiedCount, totalCount: ids.length };
}
