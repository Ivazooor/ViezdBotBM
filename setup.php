<?php
// Одноразовая настройка webhook. Открой этот файл в браузере ОДИН раз.
// Токен берётся из config.php (лежит рядом). После успеха файл можно удалить.

header('Content-Type: text/plain; charset=utf-8');

$cfg = require __DIR__ . '/config.php';
$token  = trim($cfg['token'] ?? '');
$secret = (string)($cfg['webhook_secret'] ?? '');

if ($token === '' || strpos($token, ':') === false) {
  echo "❌ Токен в config.php не задан или неверный. Проверьте строку 'token'.\n";
  exit;
}

// Адрес webhook = этот же домен/папка + bot.php (Telegram требует https).
$host = $_SERVER['HTTP_HOST'] ?? '';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$dir  = rtrim(dirname($path), '/');
$webhookUrl = "https://{$host}{$dir}/bot.php";

function api($token, $method, $params = []) {
  $ch = curl_init("https://api.telegram.org/bot{$token}/{$method}");
  curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $params,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 30,
  ]);
  $res = curl_exec($ch);
  $err = curl_error($ch);
  curl_close($ch);
  return $res !== false ? $res : "(ошибка соединения: $err)";
}

echo "1) Бот (getMe):\n" . api($token, 'getMe') . "\n\n";
echo "2) Ставлю webhook на: {$webhookUrl}\n";
echo api($token, 'setWebhook', [
  'url'             => $webhookUrl,
  'secret_token'    => $secret,
  'allowed_updates' => json_encode(['message', 'callback_query']),
  'drop_pending_updates' => 'true',
]) . "\n\n";
echo "3) Проверка (getWebhookInfo):\n" . api($token, 'getWebhookInfo') . "\n\n";
echo "Готово. Если в пункте 2 написано \"ok\":true — webhook установлен.\n";
echo "Теперь напишите боту /start. Этот файл (setup.php) можно удалить.\n";
