<?php
/**
 * 秒发卡铺 · PHP 版统一 API 入口
 * .htaccess 把 /api/* 与 /vmq/notify 重写到本文件（?_r=路径）。
 * 所有路由与 Node 版 (server.js) 保持同路径、同方法、同响应格式。
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

$CFG = require __DIR__ . '/config.php';
$GLOBALS['CFG'] = $CFG;

require __DIR__ . '/lib.php';

/* ---------- 公共引导 ---------- */
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$route = trim((string)($_GET['_r'] ?? ''), '/');
/* 前端直连模式会把 query 一起塞进 _r（如 admin/products/1/codes?status=unused&page=1），拆出来并入 $_GET */
if (strpos($route, '?') !== false) {
  [$route, $qs] = explode('?', $route, 2);
  $route = trim($route, '/');
  $extra = [];
  parse_str($qs, $extra);
  $_GET = array_merge($_GET, $extra);
}
/* 支持 PATH_INFO 形式：api.php/order/MFxxx */
if ($route === '' && isset($_SERVER['PATH_INFO'])) $route = trim($_SERVER['PATH_INFO'], '/');

try {
  route($method, $route);
} catch (Throwable $e) {
  @file_put_contents(DATA_DIR . '/php-error.log',
    '[' . now() . "] {$method} {$route}: " . $e->getMessage() . "\n" . $e->getTraceAsString() . "\n\n",
    FILE_APPEND);
  jerr('服务器开小差了，请稍后再试', 500);
}

/* ================================================================ */

function route(string $method, string $route): void {
  $db = db();

  /* ---------- V免签 回调（无需限流，验签把关） ---------- */
  if ($route === 'vmq/notify' && $method === 'GET') {
    echo handleNotify($_GET) ? 'success' : 'fail';
    exit;
  }

  /* ---------- 公开接口（全局限流 90/分） ---------- */
  rateLimit('api', 90);

  if ($route === 'products' && $method === 'GET') {
    expireStale();
    jout(['products' => productsPayload()]);
  }

  if ($route === 'order' && $method === 'POST') {
    rateLimit('order', 8);
    expireStale();
    $b = body();
    $productId = (int)($b['productId'] ?? 0);
    $payType = ((int)($b['payType'] ?? 1)) === 2 ? 2 : 1; // 1 微信 2 支付宝
    $contact = clean($b['contact'] ?? '', 60);
    $qty = min(10, max(1, (int)floor((float)($b['qty'] ?? 1) ?: 1)));

    $st = $db->prepare('SELECT * FROM products WHERE id = ? AND active = 1');
    $st->execute([$productId]);
    $product = $st->fetch();
    if (!$product) jerr('商品不存在或已下架');

    $st = $db->prepare('SELECT COUNT(*) FROM codes WHERE product_id = ? AND used = 0');
    $st->execute([$productId]);
    $stock = (int)$st->fetchColumn();
    if ($stock < $qty) jerr($stock < 1 ? '该商品已售罄' : "库存不足，仅剩 {$stock} 件");

    if (!vmqConfigured()) jerr('支付通道尚未配置，请联系店主', 503);

    $price = round((float)$product['price'] * $qty, 2);
    if ($GLOBALS['CFG']['PRICE_JITTER'] && $price < 10000) {
      $st = $db->prepare("SELECT COUNT(*) FROM orders WHERE status='pending' AND price = ?");
      $st->execute([$price]);
      $same = (int)$st->fetchColumn();
      $price = round($price + ($same % 3) * 0.01, 2); // 总价基础上 +0.00 / +0.01 / +0.02
    }

    $orderId = newOrderId();
    $BASE = rtrim($GLOBALS['CFG']['BASE_URL'], '/');
    $notifyUrl = "{$BASE}/api.php?_r=" . rawurlencode('vmq/notify');
    $returnUrl = "{$BASE}/pay.html?order=" . urlencode($orderId);
    $param = $contact;
    $priceStr = number_format($price, 2, '.', '');
    $sign = md5($orderId . $param . $payType . $priceStr . $GLOBALS['CFG']['VMQ_KEY']);

    /* 标准 vmqphp API：GET /createOrder，sign = md5(payId+param+type+price+key) */
    $qs = http_build_query([
      'payId' => $orderId, 'param' => $param, 'type' => (string)$payType, 'price' => $priceStr,
      'sign' => $sign, 'isHtml' => '0', 'notifyUrl' => $notifyUrl, 'returnUrl' => $returnUrl,
    ]);
    $raw = httpGet(rtrim($GLOBALS['CFG']['VMQ_URL'], '/') . "/createOrder?{$qs}", 8);
    $payUrl = '';
    $vmqOrderId = '';
    if ($raw !== null) {
      $j = json_decode($raw, true);
      if (is_array($j) && (int)($j['code'] ?? 0) === 1
          && isset($j['data']['payUrl']) && is_string($j['data']['payUrl']) && $j['data']['payUrl'] !== '') {
        $payUrl = $j['data']['payUrl'];
        $vmqOrderId = (string)($j['data']['orderId'] ?? '');
      }
    }
    if ($payUrl === '') jerr('支付通道暂时不可用，请稍后再试', 502);

    $db->prepare("INSERT INTO orders(order_id, product_id, product_name, price, pay_type, contact, pay_url, qty, vmq_order_id, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?)")
       ->execute([$orderId, $productId, $product['name'], $price, $payType, $contact, $payUrl, $qty, $vmqOrderId, now()]);

    jout(['orderId' => $orderId, 'price' => $price, 'payUrl' => $payUrl, 'productName' => $product['name'], 'qty' => $qty]);
  }

  if (preg_match('#^order/([A-Za-z0-9\-_]{1,64})$#', $route, $m) && $method === 'GET') {
    expireStale();
    $st = $db->prepare('SELECT order_id, product_name, price, status, code, pay_url, qty, created_at, paid_at FROM orders WHERE order_id = ?');
    $st->execute([$m[1]]);
    $o = $st->fetch();
    if (!$o) jerr('订单不存在', 404);
    $o['qty'] = (int)$o['qty'];
    $o['price'] = (float)$o['price'];
    pollVmQForOrder(o_full($m[1]));
    jout($o);
  }

  if ($route === 'orders/lookup' && $method === 'GET') {
    rateLimit('lookup', 40);
    expireStale();
    $q = clean($_GET['q'] ?? '', 100);
    if ($q === '') jerr('请输入订单号或收件邮箱');

    if (strpos($q, '@') !== false) {
      if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $q)) jerr('邮箱格式不正确');
      $st = $db->prepare('SELECT order_id, product_name, price, status, code, pay_url, qty, created_at, paid_at, contact
                          FROM orders WHERE LOWER(contact) = LOWER(?) ORDER BY rowid DESC LIMIT 20');
      $st->execute([$q]);
      $rows = $st->fetchAll();
      if (!$rows) jerr('该邮箱下没有订单，请确认是否与下单时填写的一致', 404);
      foreach ($rows as &$r) { $r['qty'] = (int)$r['qty']; $r['price'] = (float)$r['price']; }
      jout(['by' => 'email', 'orders' => $rows]);
    }

    $st = $db->prepare('SELECT order_id, product_name, price, status, code, pay_url, qty, created_at, paid_at, contact
                        FROM orders WHERE order_id = ?');
    $st->execute([$q]);
    $o = $st->fetch();
    if (!$o) jerr('订单不存在，请检查订单号是否完整', 404);
    $o['qty'] = (int)$o['qty'];
    $o['price'] = (float)$o['price'];
    jout(['by' => 'order', 'orders' => [$o]]);
  }

  /* ---------- 管理后台 ---------- */
  if ($route === 'admin/login' && $method === 'POST') {
    rateLimit('login', 10);
    $b = body();
    if (!safeEqual(clean($b['password'] ?? '', 128), $GLOBALS['CFG']['ADMIN_PASSWORD'])) {
      jerr('密码不对', 401);
    }
    jout(['token' => issueToken()]);
  }

  /* 以下全部需要登录 */
  adminOnly();

  if ($route === 'admin/summary' && $method === 'GET') {
    expireStale();
    $today = date('Y-m-d');
    $st = $db->prepare("SELECT COUNT(*) n, COALESCE(SUM(price),0) s FROM orders
      WHERE status IN ('paid','delivered') AND substr(paid_at,1,10) = ?");
    $st->execute([$today]);
    $todayRow = $st->fetch();

    $pending = (int)$db->query("SELECT COUNT(*) FROM orders WHERE status='pending'")->fetchColumn();

    $stock = (int)$db->query("SELECT COALESCE(SUM((SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.used=0)),0)
      FROM products p WHERE p.active=1")->fetchColumn();

    $st = $db->prepare("SELECT substr(paid_at,1,10) d, COUNT(*) n, COALESCE(SUM(price),0) s FROM orders
      WHERE status IN ('paid','delivered') AND paid_at >= ?
      GROUP BY substr(paid_at,1,10) ORDER BY d");
    $st->execute([date('Y-m-d H:i:s', time() - 13 * 86400)]);
    $days = [];
    foreach ($st->fetchAll() as $r) $days[$r['d']] = $r;

    $series = [];
    for ($i = 13; $i >= 0; $i--) {
      $ts = time() - $i * 86400;
      $key = date('Y-m-d', $ts);
      $hit = $days[$key] ?? null;
      $series[] = ['d' => substr($key, 5), 'n' => $hit ? (int)$hit['n'] : 0, 's' => $hit ? (float)$hit['s'] : 0];
    }

    $lowStock = $db->query("
      SELECT p.id, p.name,
             (SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.used=0) AS stock
      FROM products p WHERE p.active=1 ORDER BY stock ASC, p.id LIMIT 5")->fetchAll();
    foreach ($lowStock as &$r) { $r['id'] = (int)$r['id']; $r['stock'] = (int)$r['stock']; }

    jout([
      'todayOrders' => (int)$todayRow['n'],
      'todayRevenue' => (float)$todayRow['s'],
      'pendingOrders' => $pending,
      'stockTotal' => $stock,
      'series' => $series,
      'lowStock' => $lowStock,
      'vmqConfigured' => vmqConfigured(),
    ]);
  }

  if ($route === 'admin/orders' && $method === 'GET') {
    expireStale();
    $status = clean($_GET['status'] ?? '', 20);
    if (in_array($status, ['pending', 'paid', 'delivered', 'failed'], true)) {
      $st = $db->prepare('SELECT * FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 100');
      $st->execute([$status]);
    } else {
      $st = $db->query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100');
    }
    jout(['orders' => castOrders($st->fetchAll())]);
  }

  if ($route === 'admin/products' && $method === 'GET') {
    $rows = $db->query("
      SELECT p.*, (SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.used=0) AS stock,
             (SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.used=1) AS sold
      FROM products p ORDER BY p.id")->fetchAll();
    foreach ($rows as &$r) {
      $r['id'] = (int)$r['id'];
      $r['price'] = (float)$r['price'];
      $r['active'] = (int)$r['active'];
      $r['stock'] = (int)$r['stock'];
      $r['sold'] = (int)$r['sold'];
    }
    jout(['products' => $rows]);
  }

  if ($route === 'admin/products' && $method === 'POST') {
    $b = body();
    $name = clean($b['name'] ?? '', 60);
    $description = clean($b['description'] ?? '', 200);
    $category = clean($b['category'] ?? '', 20);
    $price = (float)($b['price'] ?? 0);
    if ($name === '') jerr('商品名不能为空');
    if (!is_finite($price) || $price <= 0 || $price > 10000) jerr('价格需在 0~10000 之间');
    $db->prepare('INSERT INTO products(name, description, price, category) VALUES (?,?,?,?)')
       ->execute([$name, $description, $price, $category]);
    jout(['id' => (int)$db->lastInsertId()]);
  }

  if (preg_match('#^admin/products/(\d+)/toggle$#', $route, $m) && $method === 'POST') {
    $db->prepare('UPDATE products SET active = 1 - active WHERE id = ?')->execute([(int)$m[1]]);
    jout(['ok' => true]);
  }

  if (preg_match('#^admin/products/(\d+)$#', $route, $m)) {
    $id = (int)$m[1];
    $st = $db->prepare('SELECT id FROM products WHERE id = ?');
    $st->execute([$id]);
    if (!$st->fetch()) jerr('商品不存在', 404);

    if ($method === 'PUT') {
      $b = body();
      $name = clean($b['name'] ?? '', 60);
      $description = clean($b['description'] ?? '', 200);
      $category = clean($b['category'] ?? '', 20);
      $price = (float)($b['price'] ?? 0);
      if ($name === '') jerr('商品名不能为空');
      if (!is_finite($price) || $price <= 0 || $price > 10000) jerr('价格需在 0~10000 之间');
      $db->prepare('UPDATE products SET name=?, description=?, price=?, category=? WHERE id=?')
         ->execute([$name, $description, $price, $category, $id]);
      jout(['ok' => true]);
    }
    if ($method === 'DELETE') {
      $st = $db->prepare("SELECT COUNT(*) FROM orders WHERE product_id = ? AND status = 'pending'");
      $st->execute([$id]);
      $pending = (int)$st->fetchColumn();
      if ($pending) jerr("该商品还有 {$pending} 笔待支付订单，处理完再删");
      $db->exec('BEGIN IMMEDIATE');
      try {
        $db->prepare('DELETE FROM codes WHERE product_id = ?')->execute([$id]);
        $db->prepare('DELETE FROM products WHERE id = ?')->execute([$id]);
        $db->exec('COMMIT');
      } catch (Throwable $e) {
        $db->exec('ROLLBACK');
        throw $e;
      }
      jout(['ok' => true]);
    }
  }

  if (preg_match('#^admin/orders/([A-Za-z0-9\-_]{1,64})$#', $route, $m) && $method === 'DELETE') {
    $st = $db->prepare('DELETE FROM orders WHERE order_id = ?');
    $st->execute([$m[1]]);
    if ($st->rowCount() === 0) jerr('订单不存在', 404);
    jout(['ok' => true]);
  }

  if (preg_match('#^admin/products/(\d+)/codes$#', $route, $m)) {
    $id = (int)$m[1];
    adminProductExists($id);

    if ($method === 'GET') {
      $status = clean($_GET['status'] ?? '', 10);
      $q = clean($_GET['q'] ?? '', 60);
      $pageSize = 50;
      $where = ['product_id = ?'];
      $args = [$id];
      if ($status === 'unused') $where[] = 'used = 0';
      if ($status === 'used') $where[] = 'used = 1';
      if ($q !== '') { $where[] = 'code LIKE ?'; $args[] = "%{$q}%"; }
      $w = implode(' AND ', $where);

      $st = $db->prepare("SELECT COUNT(*) FROM codes WHERE {$w}");
      $st->execute($args);
      $total = (int)$st->fetchColumn();
      $pages = max(1, (int)ceil($total / $pageSize));
      $page = min($pages, max(1, (int)($_GET['page'] ?? 1)));

      $st = $db->prepare('SELECT SUM(used = 0) AS unused, SUM(used = 1) AS used FROM codes WHERE product_id = ?');
      $st->execute([$id]);
      $stat = $st->fetch();

      $args[] = $pageSize;
      $args[] = ($page - 1) * $pageSize;
      $st = $db->prepare("SELECT id, code, used, order_id, used_at FROM codes WHERE {$w}
        ORDER BY used ASC, id DESC LIMIT ? OFFSET ?");
      $st->execute($args);
      $rows = $st->fetchAll();
      foreach ($rows as &$r) { $r['id'] = (int)$r['id']; $r['used'] = (int)$r['used']; }

      jout([
        'total' => $total, 'pages' => $pages, 'page' => $page, 'pageSize' => $pageSize,
        'unused' => (int)($stat['unused'] ?: 0), 'used' => (int)($stat['used'] ?: 0),
        'codes' => $rows,
      ]);
    }

    if ($method === 'POST') {
      $b = body();
      $text = (string)($b['codes'] ?? '');
      $lines = array_values(array_filter(array_map('trim', preg_split('/\r?\n/', $text) ?: []), function ($s) { return $s !== ''; }));
      if (!count($lines)) jerr('没有可导入的卡密');
      if (count($lines) > 2000) jerr('单次最多 2000 条');

      $db->exec('BEGIN IMMEDIATE');
      try {
        /* 允许重复卡密（与现行为一致）：duplicate 只做提示，不阻断 */
        $st = $db->prepare('SELECT code FROM codes WHERE product_id = ?');
        $st->execute([$id]);
        $existing = [];
        foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $c) $existing[$c] = true;
        $ins = $db->prepare('INSERT INTO codes(product_id, code) VALUES (?,?)');
        $n = 0; $dup = 0;
        foreach ($lines as $c) {
          $code = mb_substr($c, 0, 300, 'UTF-8');
          if (isset($existing[$code])) $dup++; else $existing[$code] = true;
          $ins->execute([$id, $code]);
          $n++;
        }
        $db->exec('COMMIT');
      } catch (Throwable $e) {
        $db->exec('ROLLBACK');
        throw $e;
      }
      jout(['added' => $n, 'duplicate' => $dup]);
    }
  }

  if (preg_match('#^admin/products/(\d+)/codes/gen$#', $route, $m) && $method === 'POST') {
    $id = (int)$m[1];
    adminProductExists($id);

    $b = body();
    $prefix = trim((string)($b['prefix'] ?? ''));
    $prefix = preg_replace('/[^A-Za-z0-9_\-]/', '', $prefix) ?? '';
    $qty = (int)floor((float)($b['qty'] ?? 0));
    if ($prefix === '') jerr('请先填写卡密前缀');
    if (mb_strlen($prefix) > 12) jerr('前缀最多 12 位，要给随机部分留 4 位');
    if ($qty < 1 || $qty > 2000) jerr('生成数量需在 1~2000 之间');

    $randLen = 16 - strlen($prefix);
    $st = $db->prepare('SELECT code FROM codes WHERE product_id = ?');
    $st->execute([$id]);
    $existing = [];
    foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $c) $existing[$c] = true;

    $out = [];
    $guard = $qty * 40;
    while (count($out) < $qty && $guard-- > 0) {
      $code = $prefix . randCode($randLen);
      if (isset($existing[$code])) continue;
      $existing[$code] = true;
      $out[] = $code;
    }
    if (!count($out)) jerr('生成失败，请重试', 500);

    $db->exec('BEGIN IMMEDIATE');
    try {
      $ins = $db->prepare('INSERT INTO codes(product_id, code) VALUES (?,?)');
      foreach ($out as $c) $ins->execute([$id, $c]);
      $db->exec('COMMIT');
    } catch (Throwable $e) {
      $db->exec('ROLLBACK');
      throw $e;
    }
    jout(['added' => count($out), 'requested' => $qty, 'length' => 16, 'sample' => array_slice($out, 0, 3)]);
  }

  jerr('Not Found', 404);
}

/* ---------- 辅助 ---------- */

function o_full(string $orderId): array {
  $st = db()->prepare('SELECT * FROM orders WHERE order_id = ?');
  $st->execute([$orderId]);
  $o = $st->fetch();
  return $o ?: [];
}

function castOrders(array $rows): array {
  foreach ($rows as &$r) {
    foreach (['id', 'product_id', 'pay_type', 'qty'] as $k) if (isset($r[$k])) $r[$k] = (int)$r[$k];
    if (isset($r['price'])) $r['price'] = (float)$r['price'];
  }
  return $rows;
}

function adminProductExists(int $id): void {
  $st = db()->prepare('SELECT id FROM products WHERE id = ?');
  $st->execute([$id]);
  if (!$st->fetch()) jerr('商品不存在', 404);
}

/* ---------- 随机卡密（与 Node 版同规则：大写+小写+数字+下划线，避开易混淆字符，每条四类齐备） ---------- */

function randChars(int $len): string {
  static $alpha = null;
  if ($alpha === null) $alpha = 'ABCDEFGHJKMNPQRSTUVWXYZ' . 'abcdefghjkmnpqrstuvwxyz' . '23456789' . '_';
  $s = '';
  for ($i = 0; $i < $len; $i++) $s .= $alpha[random_int(0, strlen($alpha) - 1)];
  return $s;
}

function randCode(int $len): string {
  if ($len < 4) return randChars($len);
  $needUpper = '/[A-Z]/'; $needLower = '/[a-z]/'; $needDigit = '/[0-9]/';
  for ($i = 0; $i < 80; $i++) {
    $s = randChars($len);
    if (preg_match($needUpper, $s) && preg_match($needLower, $s)
        && preg_match($needDigit, $s) && strpos($s, '_') !== false) return $s;
  }
  /* 极端情况兜底：随机位置强制补上四类字符 */
  $chars = str_split(randChars($len));
  $pools = ['ABCDEFGHJKMNPQRSTUVWXYZ', 'abcdefghjkmnpqrstuvwxyz', '23456789', '_'];
  $picks = array_slice(range(0, $len - 1), 0, 4);
  shuffle($picks);
  foreach ($picks as $k => $pos) {
    $pool = $pools[$k];
    $chars[$pos] = $pool[random_int(0, strlen($pool) - 1)];
  }
  return implode('', $chars);
}
