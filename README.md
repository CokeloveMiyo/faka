# 秒发卡铺（faka）

一个轻量的**自动发卡网店**：买家选商品 → 扫码支付 → 卡密自动发货，含完整管理后台。前后端全部开源，无框架依赖。

对接 **V免签**（个人免签支付，微信/支付宝收款码 + 金额递增匹配）。

## 两个版本

| 目录 | 技术栈 | 适用场景 |
|---|---|---|
| [`node-version/`](node-version/) | Node.js（Express，唯一依赖）+ SQLite | 自己的 VPS / 宝塔服务器 |
| [`php-version/`](php-version/) | 纯 PHP（PDO SQLite，零依赖） | 共享虚拟主机（PHP + FTP 即可） |

两版功能一致：同一套页面、同一套 API 路径、同一套发货逻辑。

## 功能

- **店面**：商品单选、数量、邮箱、微信/支付宝支付；顶栏分类过滤；「我的订单」按订单号/邮箱查询
- **支付**：V免签 下单 → 付款页二维码 → 回调验签后原子出库卡密；另有买家查询时兜底轮询（节流 ≥7s）
- **后台**：营收总览（14 天曲线）、订单管理、商品 CRUD（含分类）、卡密库（导入/随机生成 16 位强规则卡密/筛选/分页）
- **安全**：回调强制验签（timing-safe）、管理员 HMAC 令牌、接口限流、45 分钟未支付自动过期、敏感目录禁止 Web 访问

## 快速开始

### Node 版

```bash
cd node-version
cp .env.example .env      # 填写 BASE_URL / ADMIN_PASSWORD / SESSION_SECRET / VMQ_URL / VMQ_KEY
npm install
node server.js            # 默认 http://127.0.0.1:3789
```

### PHP 版

详见 [php-version/部署说明.md](php-version/部署说明.md)。要点：

1. 改 `config.php`（域名、后台密码、会话密钥、V免签 地址与密钥）
2. 全部文件 FTP 上传到网站根目录（**别漏掉 `.htaccess`**）
3. 首次访问自动建库，浏览器打开 `/check.php` 可做部署诊断（确认后删除）

> PHP 版前端直连 `api.php`，**不依赖** URL 重写；`.htaccess` 仅为美化 URL 的可选项。

## 目录结构（PHP 版）

```
├── index.html      店面
├── admin.html      管理后台
├── pay.html        支付/取卡页
├── api.php         唯一 API 入口
├── lib.php         公共库（建库、鉴权、验签、出库）
├── config.php      配置（敏感信息，入库存库前已全部替换为占位符）
├── check.php       部署诊断（上线确认后删除）
├── assets/         前端样式与脚本
└── data/           SQLite 数据库（运行时自动生成，不入库）
```

## 隐私说明

本仓库为**脱敏版**：已移除真实支付密钥、后台密码、主机/FTP 信息与业务数据库。`config.php` / `.env` 中的占位符需自行填写。`data/`、日志、截图等运行产物不入库。

## License

仅供学习交流使用。
