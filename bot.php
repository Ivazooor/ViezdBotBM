<?php
// ViezdBot БМ — Telegram-бот выездных фотоотчётов (PHP, webhook).
// Сотрудник создаёт отчёт в переписке с ботом; бот пересылает фото/видео по file_id
// в рабочий чат (файлы до 2 ГБ — их грузит клиент сотрудника, бот лишь пересылает).

error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING);

$cfg = require __DIR__ . '/config.php';
$TOKEN   = trim($cfg['token'] ?? '');
$CHAT_ID = trim((string)($cfg['chat_id'] ?? ''));
$ALLOWED = array_map('strval', $cfg['allowed_ids'] ?? []);
$SECRET  = (string)($cfg['webhook_secret'] ?? '');
$API     = "https://api.telegram.org/bot{$TOKEN}";
$STATE_DIR = __DIR__ . '/data';

$CHECKLISTS = [
  'pre' => [
    'Сделана фото-фиксация до начала работ.',
    'Объект снят со всех сторон.',
    'Макет видно полностью (4–5 фото).',
    'Детализированы объекты, с которыми и вокруг которых будет идти работа.',
    'Сделана видео-фиксация до начала работ.',
    'Сделан видео-облёт: горизонтальное видео, плавно, видно состояние объекта; с демонстрацией интерактива, если он есть.',
  ],
  'final' => [
    'Убран за собой мусор.',
    'Итоговый фото-отчёт: объект со всех сторон, макет полностью (4–5 фото), детализированы объекты, с которыми велась работа.',
    'Итоговый видео-отчёт: горизонтальное видео, плавный облёт, видно итоговое состояние; с демонстрацией интерактива, если он есть.',
  ],
];

// ===== Состояние диалога (FSM) в файлах =====
function emptyState() {
  return ['step' => 'idle', 'data' => [], 'media' => [], 'mediaHintShown' => false, 'submitting' => false];
}
function statePath($uid) {
  global $STATE_DIR;
  return $STATE_DIR . '/' . preg_replace('/\D/', '', (string)$uid) . '.json';
}
function loadState($uid) {
  $p = statePath($uid);
  if (is_file($p)) {
    // Старые незавершённые диалоги (>3 ч) сбрасываем.
    if (time() - filemtime($p) > 3 * 3600) { @unlink($p); return emptyState(); }
    $j = json_decode(file_get_contents($p), true);
    if (is_array($j)) return $j + emptyState();
  }
  return emptyState();
}
function saveState($uid, $s) {
  global $STATE_DIR;
  if (!is_dir($STATE_DIR)) @mkdir($STATE_DIR, 0775, true);
  $p = statePath($uid);
  $tmp = $p . '.' . getmypid() . '.tmp';
  file_put_contents($tmp, json_encode($s, JSON_UNESCAPED_UNICODE));
  @rename($tmp, $p);
}
function resetState($uid) {
  $p = statePath($uid);
  if (is_file($p)) @unlink($p);
  return emptyState();
}

// ===== Вызовы Telegram API =====
function tg($method, $params = []) {
  global $API;
  $ch = curl_init("$API/$method");
  curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => json_encode($params, JSON_UNESCAPED_UNICODE),
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 60,
  ]);
  $res = curl_exec($ch);
  $err = curl_error($ch);
  curl_close($ch);
  if ($res === false) return ['ok' => false, 'description' => $err];
  $d = json_decode($res, true);
  return is_array($d) ? $d : ['ok' => false, 'description' => 'bad response'];
}
function sendMessage($chatId, $text, $kb = null) {
  $p = ['chat_id' => $chatId, 'text' => $text];
  if ($kb) $p['reply_markup'] = $kb;
  return tg('sendMessage', $p);
}

// ===== Клавиатуры =====
function kbType() {
  return ['inline_keyboard' => [
    [['text' => '🟦 Предварительный', 'callback_data' => 'type_pre']],
    [['text' => '✅ Заключительный', 'callback_data' => 'type_final']],
  ]];
}
function kbChecklist() {
  return ['inline_keyboard' => [[['text' => 'Всё проверил — продолжить', 'callback_data' => 'checklist_ok']]]];
}
function kbComment() {
  return ['inline_keyboard' => [[['text' => 'Пропустить комментарий', 'callback_data' => 'skip_comment']]]];
}
function kbMedia() {
  return ['inline_keyboard' => [
    [['text' => '📤 Отправить отчёт', 'callback_data' => 'send_report']],
    [['text' => '❌ Отменить', 'callback_data' => 'cancel']],
  ]];
}
function kbConfirm() {
  return ['inline_keyboard' => [
    [['text' => '✅ Подтвердить и отправить', 'callback_data' => 'confirm_send']],
    [['text' => '➕ Добавить ещё файлы', 'callback_data' => 'add_more']],
    [['text' => '❌ Отменить', 'callback_data' => 'cancel']],
  ]];
}

function typeLabel($t) { return $t === 'final' ? 'Заключительный' : 'Предварительный'; }

const MEDIA_PROMPT = "Теперь пришлите все фото и видео — по одному или альбомом.\nКогда закончите — нажмите «Отправить отчёт».";

function isAllowed($uid) {
  global $ALLOWED;
  return count($ALLOWED) > 0 && in_array((string)$uid, $ALLOWED, true);
}
function senderName($from) {
  $name = trim(($from['first_name'] ?? '') . ' ' . ($from['last_name'] ?? ''));
  $uname = !empty($from['username']) ? ' (@' . $from['username'] . ')' : '';
  return ($name !== '' ? $name : 'Без имени') . $uname;
}

function buildSummary($s) {
  $d = $s['data'];
  return "Проверьте отчёт перед отправкой:\n\n"
    . "Тип: " . typeLabel($d['reportType'] ?? '') . "\n"
    . "Проект: " . ($d['projectName'] ?? '') . "\n"
    . "Дата выезда: " . ($d['visitDate'] ?? '') . "\n"
    . "Ответственное лицо: " . ($d['responsible'] ?? '') . "\n"
    . "Комментарий: " . (!empty($d['comment']) ? $d['comment'] : '—') . "\n"
    . "Файлов: " . count($s['media']) . "\n\n"
    . "Отправить в рабочий чат?";
}

// ===== Отправка готового отчёта в рабочий чат =====
function submitReport($chatId, $uid, $from) {
  global $CHAT_ID;
  $s = loadState($uid);
  if (!empty($s['submitting'])) return;                 // защита от двойного нажатия
  if (count($s['media']) === 0) {
    sendMessage($chatId, "Вы ещё не прислали ни одного файла. Добавьте фото/видео.", kbMedia());
    return;
  }
  $s['submitting'] = true;
  saveState($uid, $s);

  $d = $s['data'];
  $total = count($s['media']);
  $header = ($d['reportType'] === 'final' ? '✅' : '🟦') . ' ' . typeLabel($d['reportType']) . " фотоотчёт\n\n"
    . "Проект: " . $d['projectName'] . "\n"
    . "Дата выезда: " . $d['visitDate'] . "\n"
    . "Ответственное лицо: " . $d['responsible'] . "\n"
    . "Комментарий: " . (!empty($d['comment']) ? $d['comment'] : '—') . "\n"
    . "Файлов: " . $total . "\n"
    . "Отправил: " . senderName($from);

  $r = sendMessage($CHAT_ID, $header);
  if (empty($r['ok'])) {
    $s['submitting'] = false;
    saveState($uid, $s);
    sendMessage($chatId, "❌ Не удалось отправить в рабочий чат. Проверьте, что бот добавлен в группу и может писать. "
      . "Данные сохранены — нажмите «Подтвердить и отправить» ещё раз.", kbConfirm());
    return;
  }

  sendMessage($chatId, "Отправляю файлы…");
  $sent = 0;
  foreach ($s['media'] as $m) {
    $cr = tg('copyMessage', ['chat_id' => $CHAT_ID, 'from_chat_id' => $m['chatId'], 'message_id' => $m['messageId']]);
    if (!empty($cr['ok'])) $sent++;
  }

  resetState($uid);
  if ($sent > 0) {
    $tail = $sent < $total ? " (из $total; " . ($total - $sent) . " не удалось)" : "";
    sendMessage($chatId, "✅ Отчёт отправлен в рабочий чат. Файлов переслано: $sent$tail.\n\nНовый отчёт — /start.");
  } else {
    sendMessage($chatId, "❌ Не удалось переслать файлы. Попробуйте ещё раз: /start.");
  }
}

// ===== Обработка обычных сообщений =====
function handleMessage($message) {
  $chatId = $message['chat']['id'];
  $uid = $message['from']['id'];
  if (($message['chat']['type'] ?? '') !== 'private') return;

  if (!isAllowed($uid)) {
    sendMessage($chatId, "🚫 Нет доступа к боту.\n\nВаш Telegram ID: $uid\nПередайте его администратору, чтобы вас добавили.");
    return;
  }

  $text = trim($message['text'] ?? '');
  if ($text === '/start' || $text === '/new') {
    resetState($uid);
    $s = emptyState();
    $s['step'] = 'type';
    saveState($uid, $s);
    sendMessage($chatId, "Здравствуйте! Создаём фотоотчёт о выезде.\n\nВыберите тип отчёта:", kbType());
    return;
  }
  if ($text === '/cancel') {
    resetState($uid);
    sendMessage($chatId, "Отменено. Чтобы начать заново — /start.");
    return;
  }

  $s = loadState($uid);

  // Приём фото/видео на шаге сбора файлов и на шаге сводки.
  $hasMedia = isset($message['photo']) || isset($message['video']) || isset($message['document']) || isset($message['animation']);
  if ($hasMedia && ($s['step'] === 'media' || $s['step'] === 'confirm')) {
    $s['media'][] = ['chatId' => $chatId, 'messageId' => $message['message_id']];
    $s['step'] = 'media';
    $hint = empty($s['mediaHintShown']);
    $s['mediaHintShown'] = true;
    saveState($uid, $s);
    if ($hint) sendMessage($chatId, "Файлы принимаются. Присылайте ещё, а когда закончите — «Отправить отчёт».", kbMedia());
    return;
  }

  switch ($s['step']) {
    case 'project':
      if ($text === '') { sendMessage($chatId, "Введите наименование проекта текстом."); return; }
      $s['data']['projectName'] = $text; $s['step'] = 'date'; saveState($uid, $s);
      sendMessage($chatId, "Укажите дату выезда (например, 15.06.2026):");
      return;
    case 'date':
      if ($text === '') { sendMessage($chatId, "Введите дату выезда текстом."); return; }
      $s['data']['visitDate'] = $text; $s['step'] = 'responsible'; saveState($uid, $s);
      sendMessage($chatId, "Кто ответственное лицо?");
      return;
    case 'responsible':
      if ($text === '') { sendMessage($chatId, "Введите ответственное лицо текстом."); return; }
      $s['data']['responsible'] = $text; $s['step'] = 'comment'; saveState($uid, $s);
      sendMessage($chatId, "Добавьте комментарий или нажмите «Пропустить».", kbComment());
      return;
    case 'comment':
      $s['data']['comment'] = $text; $s['step'] = 'media'; saveState($uid, $s);
      sendMessage($chatId, MEDIA_PROMPT, kbMedia());
      return;
    case 'media':
      sendMessage($chatId, "Пришлите фото или видео, либо нажмите «Отправить отчёт».", kbMedia());
      return;
    case 'confirm':
      sendMessage($chatId, "Нажмите «Подтвердить и отправить» или «Добавить ещё файлы».", kbConfirm());
      return;
    default:
      sendMessage($chatId, "Чтобы создать фотоотчёт о выезде — отправьте /start.");
      return;
  }
}

// ===== Обработка нажатий на кнопки =====
function handleCallback($cb) {
  global $CHECKLISTS;
  $chatId = $cb['message']['chat']['id'];
  $uid = $cb['from']['id'];
  $data = $cb['data'] ?? '';

  if (!isAllowed($uid)) {
    tg('answerCallbackQuery', ['callback_query_id' => $cb['id'], 'text' => 'Нет доступа']);
    sendMessage($chatId, "🚫 Нет доступа. Ваш Telegram ID: $uid");
    return;
  }
  tg('answerCallbackQuery', ['callback_query_id' => $cb['id']]);

  $s = loadState($uid);

  if ($data === 'type_pre' || $data === 'type_final') {
    $type = $data === 'type_final' ? 'final' : 'pre';
    $s['data']['reportType'] = $type; $s['step'] = 'checklist'; saveState($uid, $s);
    $items = $CHECKLISTS[$type];
    $list = '';
    foreach ($items as $i => $t) $list .= ($i + 1) . ". $t\n";
    sendMessage($chatId, "Тип: " . typeLabel($type) . ".\n\nПроверьте перед отправкой:\n\n" . trim($list), kbChecklist());
    return;
  }
  if ($data === 'checklist_ok') {
    $s['step'] = 'project'; saveState($uid, $s);
    sendMessage($chatId, "Введите наименование проекта:");
    return;
  }
  if ($data === 'skip_comment') {
    $s['data']['comment'] = ''; $s['step'] = 'media'; saveState($uid, $s);
    sendMessage($chatId, MEDIA_PROMPT, kbMedia());
    return;
  }
  if ($data === 'send_report') {
    if (count($s['media']) === 0) {
      sendMessage($chatId, "Вы ещё не прислали ни одного файла. Добавьте фото/видео.", kbMedia());
      return;
    }
    $s['step'] = 'confirm'; saveState($uid, $s);
    sendMessage($chatId, buildSummary($s), kbConfirm());
    return;
  }
  if ($data === 'confirm_send') {
    submitReport($chatId, $uid, $cb['from']);
    return;
  }
  if ($data === 'add_more') {
    $s['step'] = 'media'; saveState($uid, $s);
    sendMessage($chatId, "Хорошо, пришлите ещё файлы. Когда закончите — «Отправить отчёт».", kbMedia());
    return;
  }
  if ($data === 'cancel') {
    resetState($uid);
    sendMessage($chatId, "Отменено. Чтобы начать заново — /start.");
    return;
  }
}

// ===== Точка входа (webhook) =====
$raw = file_get_contents('php://input');

// GET в браузере (пустое тело) — страница-проверка, без секрета.
if ($raw === '' || $raw === false) {
  header('Content-Type: text/html; charset=utf-8');
  echo '<h1>ViezdBot работает</h1><p>Откройте бота в Telegram и отправьте /start.</p>';
  exit;
}

// Это webhook (POST с телом) — проверяем секрет от Telegram.
if ($SECRET !== '') {
  $got = $_SERVER['HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN'] ?? '';
  if (!hash_equals($SECRET, $got)) { http_response_code(403); echo 'forbidden'; exit; }
}

$update = json_decode($raw, true);
if (is_array($update)) {
  try {
    if (isset($update['message'])) handleMessage($update['message']);
    elseif (isset($update['callback_query'])) handleCallback($update['callback_query']);
  } catch (Throwable $e) {
    error_log('ViezdBot error: ' . $e->getMessage());
  }
}
http_response_code(200);
echo 'ok';
