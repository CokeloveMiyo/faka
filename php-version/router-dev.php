<?php
/**
 * 仅用于本地测试：php -S 不支持 .htaccess，用此 router 模拟同样的 URL 重写。
 * 生产环境（Apache 虚拟主机）直接用 .htaccess，不需要本文件。
 */
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if (preg_match('#^/api(/|$)#', $uri)) {
  $_GET['_r'] = trim(preg_replace('#^/api/?#', '', $uri), '/');
  require __DIR__ . '/api.php';
  return true;
}
if ($uri === '/vmq/notify') {
  $_GET['_r'] = 'vmq/notify';
  require __DIR__ . '/api.php';
  return true;
}
if ($uri === '/admin') {
  header('Content-Type: text/html; charset=utf-8');
  readfile(__DIR__ . '/admin.html');
  return true;
}
return false; // 其余按静态文件处理（index.html / pay.html / assets/...）
