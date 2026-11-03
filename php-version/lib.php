<?php
/**
 * 秒发卡铺 · PHP 版公共库
 * 与 Node 版 (server.js) 行为对齐：数据库结构、API 响应格式、鉴权、验签、发货逻辑均一致。
 */

date_default_timezone_set($GLOBALS['CFG']['TIMEZONE']);

define('DATA_DIR', __DIR__ . '/data');
define('DB_PATH', DATA_DIR . '/faka.db');

/* ---------- 数据库 ---------- */
function db(): PDO {
  static $pdo = null;
  if ($pdo !== null) return $pdo;
  if (!in_array('sqlite', PDO::getAvailableDrivers(), true)) {
    header('Content-Type: text/plain; charset=utf-8');
    exit("[部署失败] 这台主机的 PHP 没有启用 pdo_sqlite 扩展。\n请到主机控制面板检查 PHP 设置（或联系客服开启 SQLite/PDO），开启后即可使用。");
  }
  if (!is_dir(DATA_DIR)) @mkdir(DATA_DIR, 0755, true);
  $pdo = new PDO('sqlite:' . DB_PATH, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
  ]);
  $pdo->exec('PRAGMA busy_timeout = 5000');
  $pdo->exec('PRAGMA journal_mode = WAL');
  db_migrate($pdo);
  return $pdo;
}

function db_migrate(PDO $db): void {
  $db->exec("
    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price       REAL NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      code       TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      order_id   TEXT,
      used_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_codes_product ON codes(product_id, used);
    CREATE TABLE IF NOT EXISTS orders (
      order_id    TEXT PRIMARY KEY,
      product_id  INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      price       REAL NOT NULL,
      pay_type    INTEGER NOT NULL DEFAULT 1,
      contact     TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'pending',
      code        TEXT,
      pay_url     TEXT,
      created_at  TEXT NOT NULL DEFAULT '',
      paid_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
  ");
  foreach ([
    "ALTER TABLE orders ADD COLUMN qty INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE orders ADD COLUMN vmq_order_id TEXT",
    "ALTER TABLE orders ADD COLUMN vmq_poll_at TEXT",
    "ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT ''",
  ] as $sql) { try { $db->exec($sql); } catch (Throwable $e) {} }

  /* 空库时写入示例商品（Node 版同款），后台可自行增删 */
  $n = (int)$db->query('SELECT COUNT(*) FROM products')->fetchColumn();
  if ($n === 0) {
    $insP = $db->prepare('INSERT INTO products(name, description, price, created_at) VALUES (?,?,?,?)');
    $insC = $db->prepare('INSERT INTO codes(product_id, code) VALUES (?,?)');
    $now = now();
    $samples = [
      ['会员月卡 · 通用', '示例商品：激活后有效期 30 天，支持所有套餐', 15.00,
        ['MF-MEMBER-KX2Q-7HJ1', 'MF-MEMBER-PL9M-42XW', 'MF-MEMBER-TZ6C-QQ83', 'MF-MEMBER-WN4D-58VF', 'MF-MEMBER-JR7S-26KB']],
      ['网课课程兑换码', '示例商品：兑换后永久有效，含全部章节', 39.90,
        ['MF-COURSE-AB12-CD34', 'MF-COURSE-EF56-GH78', 'MF-COURSE-IJ90-KL12']],
      ['游戏点卡 100 元', '示例商品：面值 100 元，官方渠道直充', 98.00,
        ['MF-POINTS-QQ11-WW22', 'MF-POINTS-EE33-RR44', 'MF-POINTS-TT55-YY66', 'MF-POINTS-UU77-II88']],
    ];
    foreach ($samples as [$name, $desc, $price, $codes]) {
      $insP->execute([$name, $desc, $price, $now]);
      $pid = (int)$db->lastInsertId();
      foreach ($codes as $c) $insC->execute([$pid, $c]);
    }
  }
}

/* ---------- 小工具 ---------- */
function now(): string { return date('Y-m-d H:i:s'); }

function clean($v, int $max = 100): string {
  return mb_substr(trim((string)($v ?? '')), 0, $max, 'UTF-8');
}

function md5s(string $s): string { return md5($s); }

function safeEqual($a, $b): bool {
  return hash_equals((string)$a, (string)$b);
}

/** 输出 JSON 并结束 */
function jout($data, int $code = 200): void {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  header('X-Content-Type-Options: nosniff');
  header('Referrer-Policy: same-origin');
  echo json_encode($data, JSON_UNESCAPED_UNICODE);
  exit;
}

function jerr(string $msg, int $code = 400): void { jout(['error' => $msg], $code); }

/** 解析 JSON 请求体（限 10KB） */
function body(): array {
  $raw = file_get_contents('php://input');
  if ($raw === false || strlen($raw) > 10240) return [];
  $j = json_decode($raw, true);
  return is_array($j) ? $j : [];
}

/** 客户端 IP（虚拟主机常在一层反代之后） */
function clientIp(): string {
  foreach (['HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'] as $k) {
    if (!empty($_SERVER[$k])) {
      $ip = trim(explode(',', $_SERVER[$k])[0]);
      if (filter_var($ip, FILTER_VALIDATE_IP)) return $ip;
    }
  }
  return 'unknown';
}

/**
 * 简易限流（文件计数版，Node 版为内存 Map）。
 * Node 版接口：全局 /api 90/分、下单 8/分、登录 10/分、lookup 40/分 —— 这里保持一致。
 */
function rateLimit(string $bucket, int $max): void {
  $key = md5($bucket . '|' . clientIp());
  $file = DATA_DIR . '/rl_' . $key . '.json';
  $t0 = time();
  $d = @json_decode((string)@file_get_contents($file), true);
  if (!is_array($d) || !isset($d['t0']) || $t0 - (int)$d['t0'] >= 60) $d = ['t0' => $t0, 'n' => 0];
  $d['n'] = (int)$d['n'] + 1;
  @file_put_contents($file, json_encode($d), LOCK_EX);
  /* 顺带清理过期计数文件（1% 概率触发） */
  if (random_int(1, 100) === 1) {
    foreach (glob(DATA_DIR . '/rl_*.json') ?: [] as $f) {
      if ($t0 - (int)@filemtime($f) > 300) @unlink($f);
    }
  }
  if ($d['n'] > $max) jerr('请求太频繁，请稍后再试', 429);
}

/* ---------- 订单号 ---------- */
function dec36(string $dec): string {
  $alpha = '0123456789abcdefghijklmnopqrstuvwxyz';
  $out = '';
  while ($dec !== '0' && $dec !== '') {
    $q = ''; $r = 0;
    foreach (str_split($dec) as $ch) {
      $cur = $r * 10 + (int)$ch;
      $q .= (string)intdiv($cur, 36);
      $r = $cur % 36;
    }
    $q = ltrim($q, '0');
    $out = $alpha[$r] . $out;
    $dec = $q === '' ? '0' : $q;
  }
  return $out === '' ? '0' : $out;
}

/** 时间戳 + 128bit 随机数，不可枚举（与 Node 版同格式：MF + base36 时间 + base64url 随机） */
function newOrderId(): string {
  $t = strtoupper(dec36((string)floor(microtime(true) * 1000)));
  $b64 = strtoupper(rtrim(strtr(base64_encode(random_bytes(9)), '+/', '-_'), '='));
  return 'MF' . $t . $b64;
}

/* ---------- 过期与出库 ---------- */
/** 45 分钟未支付 → failed */
function expireStale(): void {
  db()->prepare("UPDATE orders SET status='failed' WHERE status='pending' AND created_at < ?")
      ->execute([date('Y-m-d H:i:s', time() - 45 * 60)]);
}

/** 卡密原子出库：事务 + 抢占式 UPDATE（支持一次取多张） */
function popCodes(string $orderId, int $productId, int $qty): array {
  $db = db();
  $out = [];
  $db->exec('BEGIN IMMEDIATE');
  try {
    $sel = $db->prepare('SELECT id, code FROM codes WHERE product_id = ? AND used = 0 ORDER BY id LIMIT 1');
    $upd = $db->prepare("UPDATE codes SET used = 1, order_id = ?, used_at = ? WHERE id = ? AND used = 0");
    for ($i = 0; $i < $qty; $i++) {
      $sel->execute([$productId]);
      $row = $sel->fetch();
      if (!$row) break;
      $upd->execute([$orderId, now(), (int)$row['id']]);
      if ($upd->rowCount() === 1) $out[] = $row['code'];
    }
    $db->exec('COMMIT');
  } catch (Throwable $e) {
    $db->exec('ROLLBACK');
    throw $e;
  }
  return $out;
}

/* ---------- V免签 ---------- */
function vmqConfigured(): bool {
  return $GLOBALS['CFG']['VMQ_URL'] !== '' && $GLOBALS['CFG']['VMQ_KEY'] !== '';
}

/** HTTP GET（优先 curl，退回 file_get_contents） */
function httpGet(string $url, int $timeout = 8): ?string {
  if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => true,
      CURLOPT_TIMEOUT => $timeout,
      CURLOPT_CONNECTTIMEOUT => 5,
      CURLOPT_FOLLOWLOCATION => true,
      CURLOPT_SSL_VERIFYPEER => true,
      CURLOPT_SSL_VERIFYHOST => 2,
      CURLOPT_USERAGENT => 'MiaoFa/1.0',
    ]);
    $body = curl_exec($ch);
    $err  = curl_error($ch);
    curl_close($ch);
    return $body === false ? ($err ?: null) : (string)$body;
  }
  $ctx = stream_context_create(['http' => ['timeout' => $timeout, 'ignore_errors' => true]]);
  $body = @file_get_contents($url, false, $ctx);
  return $body === false ? null : $body;
}

/** 验签 + 发货（回调与轮询共用）。返回 true=已处理（V免签 要求回 success） */
function handleNotify(array $q): bool {
  $key = $GLOBALS['CFG']['VMQ_KEY'];
  $payId = (string)($q['payId'] ?? '');
  $param = (string)($q['param'] ?? '');
  $type = (string)($q['type'] ?? '');
  $price = (string)($q['price'] ?? '');
  $reallyPrice = (string)($q['reallyPrice'] ?? '');
  $sign = (string)($q['sign'] ?? '');
  $expect = md5($payId . $param . $type . $price . $reallyPrice . $key);
  if (!safeEqual($sign, $expect)) return false;

  $db = db();
  $st = $db->prepare('SELECT * FROM orders WHERE order_id = ?');
  $st->execute([$payId]);
  $order = $st->fetch();
  if (!$order) return true;           // 非本店订单，视作已处理
  if ($order['status'] !== 'pending') return true; // 幂等

  /* 到账金额校验：金额递增模式下 reallyPrice 只会 >= 下单金额 */
  if ((float)$reallyPrice + 0.005 < (float)$order['price']) {
    $db->prepare("UPDATE orders SET status='paid', paid_at=? WHERE order_id=?")->execute([now(), $order['order_id']]);
    return true;
  }

  $codes = popCodes($order['order_id'], (int)$order['product_id'], max(1, (int)($order['qty'] ?: 1)));
  if (count($codes) === 0) {
    /* 钱已收但库存为空：先记为已支付，补发货见后台 */
    $db->prepare("UPDATE orders SET status='paid', paid_at=? WHERE order_id=?")->execute([now(), $order['order_id']]);
    return true;
  }
  $db->prepare("UPDATE orders SET status='delivered', code=?, paid_at=? WHERE order_id=?")
     ->execute([implode("\n", $codes), now(), $order['order_id']]);
  return true;
}

/**
 * 兜底轮询（替代 Node 版的 setInterval）：买家支付页每 3 秒会调 /api/order/:id，
 * 服务端趁此机会对“10 分钟内创建、仍待支付”的这笔订单调 V免签 checkOrder，
 * 已支付则走同一套验签发货；每次查询间隔 ≥7 秒，避免频繁请求云端。
 */
function pollVmQForOrder(array $order): void {
  if (!vmqConfigured()) return;
  $vmqOrderId = (string)($order['vmq_order_id'] ?? '');
  if ($vmqOrderId === '') return;
  if ((string)($order['created_at'] ?? '') < date('Y-m-d H:i:s', time() - 10 * 60)) return;

  $db = db();
  $last = (string)($order['vmq_poll_at'] ?? '');
  if ($last !== '' && time() - strtotime($last) < 7) return;
  $db->prepare('UPDATE orders SET vmq_poll_at=? WHERE order_id=?')->execute([now(), $order['order_id']]);

  $url = rtrim($GLOBALS['CFG']['VMQ_URL'], '/') . '/checkOrder?orderId=' . urlencode($vmqOrderId);
  $raw = httpGet($url, 6);
  if ($raw === null) return;
  $j = json_decode($raw, true);
  if (!is_array($j) || (int)($j['code'] ?? 0) !== 1 || !is_string($j['data'] ?? null)) return;
  if (strpos($j['data'], 'http') !== 0) return;
  $parts = parse_url($j['data']);
  if (!$parts || empty($parts['query'])) return;
  parse_str($parts['query'], $qq);
  if (handleNotify($qq)) {
    /* 已处理 */
  }
}

/* ---------- 后台鉴权（与 Node 版 token 完全兼容） ---------- */
function issueToken(): string {
  $exp = (time() + 12 * 3600) * 1000; // 毫秒，Node 版同格式
  $mac = rtrim(strtr(base64_encode(hash_hmac('sha256', "admin.{$exp}", $GLOBALS['CFG']['SESSION_SECRET'], true)), '+/', '-_'), '=');
  return "{$exp}.{$mac}";
}

function verifyToken(?string $token): bool {
  $parts = explode('.', (string)$token);
  if (count($parts) !== 2) return false;
  [$expStr, $mac] = $parts;
  $exp = (int)$expStr;
  if ($exp <= 0 || $exp < time() * 1000) return false;
  $expect = rtrim(strtr(base64_encode(hash_hmac('sha256', "admin.{$exp}", $GLOBALS['CFG']['SESSION_SECRET'], true)), '+/', '-_'), '=');
  return safeEqual($mac, $expect);
}

function adminToken(): ?string {
  $h = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
  if (preg_match('/^Bearer\s+(.+)$/i', $h, $m)) return trim($m[1]);
  return null;
}

function adminOnly(): void {
  if (verifyToken(adminToken())) return;
  jerr('请先登录', 401);
}

/* ---------- 商品 ---------- */
function productsPayload(): array {
  $rows = db()->query("
    SELECT p.id, p.name, p.description, p.category, p.price,
           (SELECT COUNT(*) FROM codes c WHERE c.product_id = p.id AND c.used = 0) AS stock
    FROM products p WHERE p.active = 1 ORDER BY p.id
  ")->fetchAll();
  foreach ($rows as &$r) {
    $r['id'] = (int)$r['id'];
    $r['price'] = (float)$r['price'];
    $r['stock'] = (int)$r['stock'];
  }
  return $rows;
}
