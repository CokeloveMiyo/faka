<?php
/**
 * 秒发卡铺 · 部署诊断页（上线后可删除本文件）
 * 浏览器访问 /check.php 即可看到主机环境是否满足运行条件。
 */
error_reporting(E_ALL);
header('Content-Type: text/plain; charset=utf-8');

echo "==== 秒发卡铺 部署诊断 ====\n\n";

/* 1. PHP 版本 */
echo "[1] PHP 版本：" . PHP_VERSION . "\n";
if (version_compare(PHP_VERSION, '7.2.0', '>=')) echo "    OK（要求 >= 7.2）\n";
else echo "    !! 版本过低，程序要求 7.2 及以上\n";

/* 2. pdo_sqlite */
echo "\n[2] PDO 驱动：";
$drivers = PDO::getAvailableDrivers();
echo $drivers ? implode(', ', $drivers) : '（无）';
echo "\n";
if (in_array('sqlite', $drivers, true)) echo "    OK（pdo_sqlite 已启用）\n";
else echo "    !! 缺少 pdo_sqlite，请到主机面板开启 SQLite/PDO，否则程序无法运行\n";

/* 3. data 目录 */
$dir = __DIR__ . '/data';
echo "\n[3] data 目录：{$dir}\n";
if (!is_dir($dir)) {
  $ok = @mkdir($dir, 0755, true);
  echo $ok ? "    原不存在，已尝试创建成功\n" : "    !! 目录不存在且无法创建（检查目录权限）\n";
} else {
  echo "    存在\n";
}
echo is_writable($dir) ? "    OK（可写）\n" : "    !! 目录不可写，请把 data 目录权限设为 755 或 777\n";

/* 4. 数据库文件 */
$db = $dir . '/faka.db';
echo "\n[4] 数据库文件 faka.db：";
if (!file_exists($db)) { echo "不存在（首次访问 api 会自动建空库，并写入 3 个示例商品）\n"; }
else {
  echo "存在，" . round(filesize($db) / 1024, 1) . " KB\n";
  if (in_array('sqlite', $drivers, true)) {
    try {
      $pdo = new PDO('sqlite:' . $db);
      $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
      $n = (int)$pdo->query('SELECT COUNT(*) FROM products')->fetchColumn();
      $m = (int)$pdo->query('SELECT COUNT(*) FROM codes')->fetchColumn();
      echo "    OK（可正常打开，当前 {$n} 个商品 / {$m} 条卡密）\n";
    } catch (Throwable $e) {
      echo "    !! 打开失败：" . $e->getMessage() . "\n";
    }
  }
}

/* 5. 静态页与 JS */
echo "\n[5] 关键文件存在性：\n";
foreach (['index.html', 'admin.html', 'pay.html', 'api.php', 'lib.php', 'config.php',
          'assets/js/shop.js', 'assets/js/qrcode.min.js'] as $f) {
  echo (file_exists(__DIR__ . "/{$f}") ? "    OK  {$f}\n" : "    !! 缺少 {$f}\n");
}

/* 6. .htaccess 重写测试（可选能力，现在前端已不依赖它） */
echo "\n[6] URL 重写：本程序已改为直连 api.php，不再依赖 .htaccess 重写。\n";
echo '    ' . (function_exists('apache_get_modules') && in_array('mod_rewrite', apache_get_modules() ?: [], true)
  ? "当前主机 mod_rewrite 已开启（/api/* 旧地址也能用）\n"
  : "当前主机 mod_rewrite 状态未知或未开启（不影响使用）\n");

echo "\n==== 诊断结束 ====\n";
echo "以上没有 \"!!\" 即部署环境正常。确认无误后建议删除本文件（check.php）。\n";
