<?php
// Диагностика: может ли хостинг достучаться до api.telegram.org изнутри PHP.
header('Content-Type: text/plain; charset=utf-8');

echo "PHP версия: " . PHP_VERSION . "\n";
echo "curl: " . (function_exists('curl_init') ? 'есть' : 'НЕТ') . "\n";
echo "allow_url_fopen: " . (ini_get('allow_url_fopen') ? 'вкл' : 'выкл') . "\n\n";

echo "Тест исходящего соединения с api.telegram.org (фиктивный токен, 10с лимит):\n";
$ch = curl_init("https://api.telegram.org/bot0:0/getMe");
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT        => 10,
  CURLOPT_CONNECTTIMEOUT => 8,
]);
$t0  = microtime(true);
$res = curl_exec($ch);
$dt  = round(microtime(true) - $t0, 1);
$err = curl_error($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

echo "  HTTP-код: {$code}\n";
echo "  время: {$dt}с\n";
echo "  ошибка curl: " . ($err ?: 'нет') . "\n";
echo "  ответ (начало): " . substr((string)$res, 0, 120) . "\n\n";

if ($code > 0 && $err === '') {
  echo "✅ Исходящие соединения РАБОТАЮТ. api.telegram.org доступен — бот сможет отвечать.\n";
} else {
  echo "❌ Исходящие к api.telegram.org НЕ работают (заблокированы или таймаут).\n";
  echo "   Это причина зависания setup.php. PHP-бот на этом хостинге отвечать не сможет.\n";
}
