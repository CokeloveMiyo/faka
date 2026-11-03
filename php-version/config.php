<?php
/**
 * 秒发卡铺 · PHP 版配置
 * 上传到虚拟主机前，请逐项检查以下配置（尤其带「务必」字样的两项）。
 */

return [
  /* 对外访问地址，末尾不带斜杠。
     上线改成你的域名，例如 'http://faka.example.com'
     （注意主机是否支持 https，不支持就写 http://） */
  'BASE_URL' => 'http://你的域名',

  /* 后台登录密码 —— 务必修改！ */
  'ADMIN_PASSWORD' => 'change-me-please',

  /* 会话签名密钥 —— 务必改成 ≥16 位随机串（改完所有已登录会话失效，重新登录即可） */
  'SESSION_SECRET' => 'please-change-this-secret-0123456789',

  /* V免签 地址（末尾不带斜杠）与商户通讯密钥（在 V免签 后台「系统设置」里查看） */
  'VMQ_URL' => 'http://你的V免签地址',
  'VMQ_KEY' => '你的V免签商户密钥',

  /* 1 = 待支付订单出现相同金额时自动 +0.00~0.02 元，避免 V免签 并发金额冲突；0 = 关闭 */
  'PRICE_JITTER' => true,

  /* 时区：影响订单时间显示与 45 分钟过期判断 */
  'TIMEZONE' => 'Asia/Shanghai',
];
