/**
 * 秒发卡铺 —— 卡密自动发货商店（Express + node:sqlite + V免签）
 *
 * 依赖：Node.js >= 22.13（内置 SQLite，无需另装数据库）、express
 * 配置：复制 .env.example 为 .env 后填写
 *
 * V免签 对接（szvone/vmqphp 标准商户API）：
 *   下单  GET  {VMQ_URL}/createOrder?payId,param,type,price,sign,isHtml=0,notifyUrl,returnUrl
 *         sign = md5(payId + param + type + price + key)，返回 JSON data.payUrl / data.orderId
 *   回调  GET  notifyUrl?payId,param,type,price,reallyPrice,sign
 *         sign = md5(payId + param + type + price + reallyPrice + key)
 *   兜底  每 8 秒用 data.orderId 调 {VMQ_URL}/checkOrder 轮询，
 *         已支付时返回的 data 是带签名参数的回调地址，解析后走同一套验签发货逻辑
 *   回调/轮询验证通过 → 标记已支付 → 原子取出卡密 → 自动发货
 */
import express from 'express';
import { createHash, randomBytes, randomInt, timingSafeEqual, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- 配置加载（支持 .env 与环境变量） ---------- */
function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3789);
const BASE_URL = (process.env.BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const VMQ_URL = (process.env.VMQ_URL || '').replace(/\/+$/, '');
const VMQ_KEY = process.env.VMQ_KEY || '';
const PRICE_JITTER = process.env.PRICE_JITTER === '1';

if (!ADMIN_PASSWORD || SESSION_SECRET.length < 16) {
  console.error('[启动失败] 请先复制 .env.example 为 .env，并设置 ADMIN_PASSWORD 和 SESSION_SECRET（≥16位随机串）');
  process.exit(1);
}

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

/* ---------- 数据库 ---------- */
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'faka.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       REAL NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
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
    status      TEXT NOT NULL DEFAULT 'pending', -- pending|paid|delivered|failed
    code        TEXT,
    pay_url     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    paid_at     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
`);
/* 旧库迁移：购买数量列、V免签云端订单号列（用于 checkOrder 轮询）、商品分类列 */
try { db.exec("ALTER TABLE orders ADD COLUMN qty INTEGER NOT NULL DEFAULT 1"); } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN vmq_order_id TEXT'); } catch {}
try { db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT ''"); } catch {}

/* 示例数据（首次启动写入，后台可自行增删） */
const seed = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (seed === 0) {
  const insP = db.prepare('INSERT INTO products(name, description, price) VALUES (?,?,?)');
  const insC = db.prepare('INSERT INTO codes(product_id, code) VALUES (?,?)');
  const samples = [
    ['会员月卡 · 通用', '示例商品：激活后有效期 30 天，支持所有套餐', 15.00,
      ['MF-MEMBER-KX2Q-7HJ1', 'MF-MEMBER-PL9M-42XW', 'MF-MEMBER-TZ6C-QQ83', 'MF-MEMBER-WN4D-58VF', 'MF-MEMBER-JR7S-26KB']],
    ['网课课程兑换码', '示例商品：兑换后永久有效，含全部章节', 39.90,
      ['MF-COURSE-AB12-CD34', 'MF-COURSE-EF56-GH78', 'MF-COURSE-IJ90-KL12']],
    ['游戏点卡 100 元', '示例商品：面值 100 元，官方渠道直充', 98.00,
      ['MF-POINTS-QQ11-WW22', 'MF-POINTS-EE33-RR44', 'MF-POINTS-TT55-YY66', 'MF-POINTS-UU77-II88']],
  ];
  for (const [name, desc, price, codes] of samples) {
    const r = insP.run(name, desc, price);
    for (const c of codes) insC.run(r.lastInsertRowid, c);
  }
  console.log('[初始化] 已写入 3 个示例商品与卡密，请到后台替换成真实商品');
}

/* ---------- 小工具 ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* 简易内存限流：按 IP 计数，每分钟上限 */
const buckets = new Map();
function rateLimit(max) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.t0 > 60_000) { b = { t0: now, n: 0 }; buckets.set(key, b); }
    b.n += 1;
    if (buckets.size > 5000) buckets.clear();
    if (b.n > max) return res.status(429).json({ error: '请求太频繁，请稍后再试' });
    next();
  };
}
app.use('/api', rateLimit(90));

const clean = (v, max = 100) => String(v ?? '').trim().slice(0, max);
const yuan = (n) => Number(n).toFixed(2);

function newOrderId() {
  // 时间戳 + 128bit 随机数，不可枚举
  const t = Date.now().toString(36).toUpperCase();
  return `MF${t}${randomBytes(9).toString('base64url').toUpperCase()}`;
}

/* 过期清理：45 分钟未支付的订单视为失效 */
function expireStale() {
  db.prepare(`UPDATE orders SET status='failed'
              WHERE status='pending' AND created_at < datetime('now','-45 minutes','localtime')`).run();
}

/* 卡密原子出库：一条 SQL 抢占（支持一次取多张） */
function popCode(orderId, productId) {
  const row = db.prepare(
    `SELECT id, code FROM codes WHERE product_id = ? AND used = 0 ORDER BY id LIMIT 1`
  ).get(productId);
  if (!row) return null;
  db.prepare(`UPDATE codes SET used = 1, order_id = ?, used_at = datetime('now','localtime')
              WHERE id = ? AND used = 0`).run(orderId, row.id);
  return db.prepare(`SELECT code FROM codes WHERE id = ? AND used = 1 AND order_id = ?`).get(row.id, orderId) || null;
}
function popCodes(orderId, productId, qty) {
  const out = [];
  for (let i = 0; i < qty; i++) {
    const c = popCode(orderId, productId);
    if (!c) break;
    out.push(c.code);
  }
  return out;
}

/* ---------- 公开接口 ---------- */
const productsPayload = () => db.prepare(`
  SELECT p.id, p.name, p.description, p.category, p.price,
         (SELECT COUNT(*) FROM codes c WHERE c.product_id = p.id AND c.used = 0) AS stock
  FROM products p WHERE p.active = 1 ORDER BY p.id
`).all();

app.get('/api/products', (req, res) => {
  expireStale();
  res.json({ products: productsPayload() });
});

/* 创建订单：校验 →（可选）同价加几分避免 V免签 并发冲突 → 调 V免签 拿支付链接 */
app.post('/api/order', rateLimit(8), async (req, res) => {
  expireStale();
  const productId = Number(req.body?.productId);
  const payType = Number(req.body?.payType) === 2 ? 2 : 1; // 1 微信 2 支付宝
  const contact = clean(req.body?.contact, 60);
  const qty = Math.min(10, Math.max(1, Math.floor(Number(req.body?.qty) || 1)));

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return res.status(400).json({ error: '商品不存在或已下架' });

  const stock = db.prepare('SELECT COUNT(*) AS n FROM codes WHERE product_id = ? AND used = 0').get(productId).n;
  if (stock < qty) return res.status(400).json({ error: stock < 1 ? '该商品已售罄' : `库存不足，仅剩 ${stock} 件` });

  if (!VMQ_URL || !VMQ_KEY) return res.status(503).json({ error: '支付通道尚未配置，请联系店主' });

  let price = Number((product.price * qty).toFixed(2));
  if (PRICE_JITTER && price < 10000) {
    const same = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status='pending' AND price = ?`).get(price).n;
    price = Number((price + (same % 3) * 0.01).toFixed(2)); // 总价基础上 +0.00 / +0.01 / +0.02
  }

  const orderId = newOrderId();
  const notifyUrl = `${BASE_URL}/vmq/notify`;
  const returnUrl = `${BASE_URL}/pay.html?order=${encodeURIComponent(orderId)}`;
  const param = contact;
  const priceStr = yuan(price);
  const sign = md5(orderId + param + payType + priceStr + VMQ_KEY);

  /* 标准 vmqphp API：GET /createOrder，sign = md5(payId+param+type+price+key) */
  const qs = new URLSearchParams({
    payId: orderId, param, type: String(payType), price: priceStr,
    sign, isHtml: '0', notifyUrl, returnUrl,
  });

  let payUrl = '';
  let vmqOrderId = '';
  try {
    const r = await fetch(`${VMQ_URL}/createOrder?${qs}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    if (j.code === 1 && j.data && typeof j.data.payUrl === 'string' && j.data.payUrl) {
      payUrl = j.data.payUrl;
      vmqOrderId = String(j.data.orderId || '');
    } else {
      console.error('[V免签] createOrder 返回异常:', JSON.stringify(j).slice(0, 300));
    }
  } catch (e) {
    console.error('[V免签] 请求失败:', e.message);
  }
  if (!payUrl) return res.status(502).json({ error: '支付通道暂时不可用，请稍后再试' });

  db.prepare(`INSERT INTO orders(order_id, product_id, product_name, price, pay_type, contact, pay_url, qty, vmq_order_id)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(orderId, productId, product.name, price, payType, contact, payUrl, qty, vmqOrderId);

  res.json({ orderId, price, payUrl, productName: product.name, qty });
});

/* 买家轮询订单状态（仅凭不可枚举的订单号，卡密只在发货后返回） */
app.get('/api/order/:id', (req, res) => {
  expireStale();
  const o = db.prepare('SELECT order_id, product_name, price, status, code, pay_url, qty, created_at, paid_at FROM orders WHERE order_id = ?')
    .get(clean(req.params.id, 64));
  if (!o) return res.status(404).json({ error: '订单不存在' });
  res.json(o);
});

/* 买家查询：订单号精确查一单，或收件邮箱查该邮箱下全部订单 */
const ORDER_COLS = 'order_id, product_name, price, status, code, pay_url, qty, created_at, paid_at, contact';
app.get('/api/orders/lookup', rateLimit(40), (req, res) => {
  expireStale();
  const q = clean(req.query.q, 100);
  if (!q) return res.status(400).json({ error: '请输入订单号或收件邮箱' });

  if (q.includes('@')) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) return res.status(400).json({ error: '邮箱格式不正确' });
    const rows = db.prepare(`SELECT ${ORDER_COLS} FROM orders WHERE LOWER(contact) = LOWER(?) ORDER BY rowid DESC LIMIT 20`).all(q);
    if (!rows.length) return res.status(404).json({ error: '该邮箱下没有订单，请确认是否与下单时填写的一致' });
    return res.json({ by: 'email', orders: rows });
  }

  const o = db.prepare(`SELECT ${ORDER_COLS} FROM orders WHERE order_id = ?`).get(q);
  if (!o) return res.status(404).json({ error: '订单不存在，请检查订单号是否完整' });
  res.json({ by: 'order', orders: [o] });
});

/* ---------- V免签 验签+发货（回调与轮询共用） ---------- */
function handleNotify(q) {
  const { payId = '', param = '', type = '', price = '', reallyPrice = '', sign = '' } = q;
  const expect = md5(String(payId) + String(param) + String(type) + String(price) + String(reallyPrice) + VMQ_KEY);
  if (!safeEqual(sign, expect)) { console.warn('[验签] 失败:', payId); return false; }

  const order = db.prepare(`SELECT * FROM orders WHERE order_id = ?`).get(String(payId));
  if (!order) return true; // 非本店订单，视作已处理
  if (order.status !== 'pending') return true; // 已处理，幂等

  /* 到账金额校验：金额递增模式下 reallyPrice 只会 >= 下单金额 */
  if (Number(reallyPrice || 0) + 0.005 < order.price) {
    console.error('[回调] 到账金额低于订单金额，转人工核对:', order.order_id, reallyPrice);
    db.prepare(`UPDATE orders SET status='paid', paid_at=datetime('now','localtime') WHERE order_id = ?`).run(order.order_id);
    return true;
  }

  const codes = popCodes(order.order_id, order.product_id, order.qty || 1);
  if (!codes.length) {
    console.error('[回调] 已收款但库存为空！订单:', order.order_id);
    db.prepare(`UPDATE orders SET status='paid', paid_at=datetime('now','localtime') WHERE order_id = ?`).run(order.order_id);
    return true; // 钱已收，先记为已支付，补发货见后台
  }
  db.prepare(`UPDATE orders SET status='delivered', code=?, paid_at=datetime('now','localtime') WHERE order_id = ?`)
    .run(codes.join('\n'), order.order_id);
  console.log('[发货] 订单', order.order_id, '已发', codes.length, '张卡密');
  return true;
}

app.get('/vmq/notify', (req, res) => {
  res.send(handleNotify(req.query) ? 'success' : 'fail');
});

/* 兜底轮询：每 8 秒查一次 V免签 checkOrder（本地测试 / 回调丢失时也能发货） */
async function pollVmQ() {
  if (!VMQ_URL || !VMQ_KEY) return;
  const rows = db.prepare(`
    SELECT order_id, vmq_order_id FROM orders
    WHERE status='pending' AND vmq_order_id IS NOT NULL AND vmq_order_id != ''
      AND created_at >= datetime('now','-10 minutes','localtime')`).all();
  for (const r of rows) {
    try {
      const res = await fetch(`${VMQ_URL}/checkOrder?orderId=${encodeURIComponent(r.vmq_order_id)}`,
        { signal: AbortSignal.timeout(6000) });
      const j = await res.json().catch(() => ({}));
      if (j.code === 1 && typeof j.data === 'string' && j.data.startsWith('http')) {
        const q = Object.fromEntries(new URL(j.data).searchParams);
        if (handleNotify(q)) console.log('[轮询] 检测到已支付并处理:', r.order_id);
      }
    } catch { /* 网络抖动忽略，下轮再试 */ }
  }
}
setInterval(pollVmQ, 8000);

/* 支付二维码：把 payUrl 内容渲染成 SVG（微信 wxp:// 链接无法直接打开，扫码才有效） */
app.get('/api/qr', rateLimit(120), async (req, res) => {
  const data = clean(req.query.d, 1000);
  if (!data) return res.status(400).end();
  try {
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1, width: 260, errorCorrectionLevel: 'M' });
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(svg);
  } catch { res.status(400).end(); }
});

/* ---------- 管理后台鉴权 ---------- */
function issueToken() {
  const exp = Date.now() + 12 * 3600 * 1000;
  const mac = createHmac('sha256', SESSION_SECRET).update(`admin.${exp}`).digest('base64url');
  return `${exp}.${mac}`;
}
function verifyToken(token) {
  const [expStr, mac] = String(token || '').split('.');
  const exp = Number(expStr);
  if (!exp || !mac || exp < Date.now()) return false;
  return safeEqual(mac, createHmac('sha256', SESSION_SECRET).update(`admin.${exp}`).digest('base64url'));
}
function adminOnly(req, res, next) {
  if (verifyToken(req.headers.authorization?.replace(/^Bearer\s+/i, ''))) return next();
  res.status(401).json({ error: '请先登录' });
}

app.post('/api/admin/login', rateLimit(10), (req, res) => {
  if (!safeEqual(clean(req.body?.password, 128), ADMIN_PASSWORD)) {
    return res.status(401).json({ error: '密码不对' });
  }
  res.json({ token: issueToken() });
});

app.get('/api/admin/summary', adminOnly, (req, res) => {
  expireStale();
  const today = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(price),0) s FROM orders
    WHERE status IN ('paid','delivered') AND date(paid_at)=date('now','localtime')`).get();
  const pending = db.prepare(`SELECT COUNT(*) n FROM orders WHERE status='pending'`).get().n;
  const stock = db.prepare(`SELECT COALESCE(SUM((SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.used=0)),0) n
    FROM products p WHERE p.active=1`).get().n;
  const days = db.prepare(`SELECT date(paid_at) d, COUNT(*) n, COALESCE(SUM(price),0) s FROM orders
    WHERE status IN ('paid','delivered') AND paid_at >= datetime('now','-13 days','localtime')
    GROUP BY date(paid_at) ORDER BY d`).all();
  // 补齐 14 天（含空日）
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hit = days.find((r) => r.d === key);
    series.push({ d: key.slice(5), n: hit ? hit.n : 0, s: hit ? hit.s : 0 });
  }
  const lowStock = db.prepare(`
    SELECT p.id, p.name,
           (SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.used=0) AS stock
    FROM products p WHERE p.active=1 ORDER BY stock ASC, p.id LIMIT 5`).all();
  res.json({
    todayOrders: today.n, todayRevenue: Number(today.s), pendingOrders: pending, stockTotal: stock,
    series, lowStock,
    vmqConfigured: Boolean(VMQ_URL && VMQ_KEY),
  });
});

app.get('/api/admin/orders', adminOnly, (req, res) => {
  expireStale();
  const status = clean(req.query.status, 20);
  const rows = ['pending', 'paid', 'delivered', 'failed'].includes(status)
    ? db.prepare(`SELECT * FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 100`).all(status)
    : db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 100`).all();
  res.json({ orders: rows });
});

app.get('/api/admin/products', adminOnly, (req, res) => {
  res.json({
    products: db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.used=0) AS stock,
             (SELECT COUNT(*) FROM codes c WHERE c.product_id=p.id AND c.used=1) AS sold
      FROM products p ORDER BY p.id`).all(),
  });
});

app.post('/api/admin/products', adminOnly, (req, res) => {
  const name = clean(req.body?.name, 60);
  const description = clean(req.body?.description, 200);
  const category = clean(req.body?.category, 20);
  const price = Number(req.body?.price);
  if (!name) return res.status(400).json({ error: '商品名不能为空' });
  if (!Number.isFinite(price) || price <= 0 || price > 10000) return res.status(400).json({ error: '价格需在 0~10000 之间' });
  const r = db.prepare('INSERT INTO products(name, description, price, category) VALUES (?,?,?,?)').run(name, description, price, category);
  res.json({ id: r.lastInsertRowid });
});

app.post('/api/admin/products/:id/toggle', adminOnly, (req, res) => {
  db.prepare('UPDATE products SET active = 1 - active WHERE id = ?').run(Number(req.params.id) || 0);
  res.json({ ok: true });
});

/* 编辑商品：名称 / 说明 / 价格 */
/* 编辑商品：名称 / 说明 / 价格 / 分类 */
app.put('/api/admin/products/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: '商品不存在' });
  const name = clean(req.body?.name, 60);
  const description = clean(req.body?.description, 200);
  const category = clean(req.body?.category, 20);
  const price = Number(req.body?.price);
  if (!name) return res.status(400).json({ error: '商品名不能为空' });
  if (!Number.isFinite(price) || price <= 0 || price > 10000) return res.status(400).json({ error: '价格需在 0~10000 之间' });
  db.prepare('UPDATE products SET name = ?, description = ?, price = ?, category = ? WHERE id = ?')
    .run(name, description, price, category, id);
  res.json({ ok: true });
});

/* 删除商品：连同其卡密一起删（已售卡密的历史记录在订单里保留） */
app.delete('/api/admin/products/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: '商品不存在' });
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE product_id = ? AND status = 'pending'`).get(id).n;
  if (pending) return res.status(400).json({ error: `该商品还有 ${pending} 笔待支付订单，处理完再删` });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM codes WHERE product_id = ?').run(id);
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[删除商品] 失败:', e.message);
    return res.status(500).json({ error: '删除失败，请重试' });
  }
  res.json({ ok: true });
});

/* 删除订单（只删本系统的记录，云端支付单不回收） */
app.delete('/api/admin/orders/:id', adminOnly, (req, res) => {
  const r = db.prepare('DELETE FROM orders WHERE order_id = ?').run(clean(req.params.id, 64));
  if (!r.changes) return res.status(404).json({ error: '订单不存在' });
  res.json({ ok: true });
});

/* 查看某商品的卡密明细：状态筛选 / 搜索 / 分页 */
app.get('/api/admin/products/:id/codes', adminOnly, (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: '商品不存在' });

  const status = clean(req.query.status, 10);
  const q = clean(req.query.q, 60);
  const pageSize = 50;
  const where = ['product_id = ?'];
  const args = [id];
  if (status === 'unused') where.push('used = 0');
  if (status === 'used') where.push('used = 1');
  if (q) { where.push('code LIKE ?'); args.push(`%${q}%`); }

  const w = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM codes WHERE ${w}`).get(...args).n;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pages, Math.max(1, Number(req.query.page) || 1));
  const stat = db.prepare('SELECT SUM(used = 0) AS unused, SUM(used = 1) AS used FROM codes WHERE product_id = ?').get(id);

  const rows = db.prepare(`SELECT id, code, used, order_id, used_at FROM codes WHERE ${w}
    ORDER BY used ASC, id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);

  res.json({
    total, pages, page, pageSize,
    unused: Number(stat.unused || 0), used: Number(stat.used || 0),
    codes: rows,
  });
});

/* 粘贴卡密：一行一个，自动去空行。允许重复卡密（同一卡密可多次入库） */
app.post('/api/admin/products/:id/codes', adminOnly, (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: '商品不存在' });
  const text = String(req.body?.codes || '');
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return res.status(400).json({ error: '没有可导入的卡密' });
  if (lines.length > 2000) return res.status(400).json({ error: '单次最多 2000 条' });

  const existing = new Set(db.prepare('SELECT code FROM codes WHERE product_id = ?').all(id).map((r) => r.code));
  const ins = db.prepare('INSERT INTO codes(product_id, code) VALUES (?,?)');
  let n = 0, dup = 0;
  for (const c of lines) {
    const code = c.slice(0, 300);
    if (existing.has(code)) dup++; else existing.add(code);
    ins.run(id, code);
    n++;
  }
  res.json({ added: n, duplicate: dup });
});

/* 随机生成卡密：用户指定前缀 + 随机部分，总长固定 16 位 */
const CODE_LEN = 16;
/* 随机部分字符集：大写 + 小写 + 数字 + 下划线，去掉易混淆的 I O l i o 0 1 */
const CODE_UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LOWER = 'abcdefghjkmnpqrstuvwxyz';
const CODE_DIGIT = '23456789';
const CODE_ALPHABET = CODE_UPPER + CODE_LOWER + CODE_DIGIT + '_';
const CODE_NEED = [/[A-Z]/, /[a-z]/, /[0-9]/, /_/];   // 每条都要覆盖四类字符

function randChars(len) {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
function randCode(len) {
  if (len < 4) return randChars(len);
  for (let i = 0; i < 80; i++) {
    const s = randChars(len);
    if (CODE_NEED.every((re) => re.test(s))) return s;
  }
  // 极端情况兜底：随机位置强制补上四类字符
  const chars = randChars(len).split('');
  const picks = [...Array(len).keys()].sort(() => Math.random() - 0.5).slice(0, 4);
  const pools = [CODE_UPPER, CODE_LOWER, CODE_DIGIT, '_'];
  picks.forEach((pos, k) => {
    const pool = pools[k];
    chars[pos] = pool[randomInt(pool.length)];
  });
  return chars.join('');
}

app.post('/api/admin/products/:id/codes/gen', adminOnly, (req, res) => {
  const id = Number(req.params.id) || 0;
  if (!db.prepare('SELECT id FROM products WHERE id = ?').get(id)) return res.status(404).json({ error: '商品不存在' });

  const prefix = String(req.body?.prefix ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  const qty = Math.floor(Number(req.body?.qty));
  if (!prefix) return res.status(400).json({ error: '请先填写卡密前缀' });
  if (prefix.length > 12) return res.status(400).json({ error: '前缀最多 12 位，要给随机部分留 4 位' });
  if (!Number.isFinite(qty) || qty < 1 || qty > 2000) return res.status(400).json({ error: '生成数量需在 1~2000 之间' });

  const randLen = CODE_LEN - prefix.length;
  const existing = new Set(db.prepare('SELECT code FROM codes WHERE product_id = ?').all(id).map((r) => r.code));
  const out = [];
  let guard = qty * 40;
  while (out.length < qty && guard-- > 0) {
    const code = prefix + randCode(randLen);
    if (existing.has(code)) continue;
    existing.add(code);
    out.push(code);
  }
  if (!out.length) return res.status(500).json({ error: '生成失败，请重试' });

  const ins = db.prepare('INSERT INTO codes(product_id, code) VALUES (?,?)');
  db.exec('BEGIN');
  try {
    for (const c of out) ins.run(id, c);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('[生成卡密] 写入失败:', e.message);
    return res.status(500).json({ error: '写入失败，请重试' });
  }
  console.log('[生成卡密] 商品', id, '生成', out.length, '条，前缀', prefix);
  res.json({ added: out.length, requested: qty, length: CODE_LEN, sample: out.slice(0, 3) });
});

/* ---------- 静态页面 ---------- */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, extensions: ['html'] }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use((req, res) => res.status(404).send('Not Found'));
app.listen(PORT, () => {
  console.log(`秒发卡铺已启动: ${BASE_URL}`);
  console.log(`  店面   ${BASE_URL}/`);
  console.log(`  后台   ${BASE_URL}/admin`);
  if (!VMQ_URL || !VMQ_KEY) console.log('  [提示] 尚未配置 V免签（.env 中 VMQ_URL / VMQ_KEY），支付下单会提示未配置');
});
