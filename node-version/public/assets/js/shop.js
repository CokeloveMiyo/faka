/* 秒发卡铺 · 店面逻辑：商品选择、数量、下单、订单查询弹窗 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const money = (n) => Number(n).toFixed(2);

  const state = { products: [], productId: null, qty: 1, payType: 1, cat: '' };

  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.append(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  /* ---------- 商品加载与渲染 ---------- */
  async function loadProducts() {
    try {
      const r = await fetch('/api/products');
      const { products } = await r.json();
      state.products = products || [];
      renderCats();
      renderProducts();
    } catch {
      $('#prod-list').innerHTML = '<p class="loading">商品加载失败，请刷新重试。</p>';
    }
  }

  /* 顶栏分类：取在售商品的非空分类，点击过滤商品 */
  function renderCats() {
    const box = $('#cats');
    const cats = [...new Set(state.products.map((p) => (p.category || '').trim()).filter(Boolean))];
    if (!cats.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const items = ['全部', ...cats];
    if (state.cat && !cats.includes(state.cat)) state.cat = '';
    box.innerHTML = items.map((c) =>
      `<button class="cat${c === state.cat ? ' is-active' : ''}" type="button" data-cat="${esc(c)}">${esc(c)}</button>`
    ).join('');
    $$('#cats .cat').forEach((b) => b.addEventListener('click', () => {
      state.cat = b.dataset.cat === '全部' ? '' : b.dataset.cat;
      $$('#cats .cat').forEach((x) => x.classList.toggle('is-active', x === b));
      renderProducts();
    }));
  }

  function renderProducts() {
    const box = $('#prod-list');
    const list = state.cat ? state.products.filter((p) => (p.category || '').trim() === state.cat) : state.products;
    if (!state.products.length) {
      box.innerHTML = '<p class="loading">暂时没有在售商品，稍后再来看看。</p>';
      return;
    }
    if (!list.length) {
      box.innerHTML = '<p class="loading">该分类下暂时没有在售商品。</p>';
      return;
    }
    box.innerHTML = list.map((p) => {
      const out = p.stock <= 0;
      const badge = out
        ? '<span class="prod__badge">已售罄</span>'
        : p.stock <= 3 ? `<span class="prod__badge">仅剩 ${p.stock} 件</span>` : '';
      return `<button class="prod${p.id === state.productId ? ' is-active' : ''}" type="button"
        role="radio" aria-checked="${p.id === state.productId}" data-id="${p.id}" ${out ? 'disabled' : ''}>
        <span class="prod__radio" aria-hidden="true"></span>
        <span class="prod__info">
          <span class="prod__name">${esc(p.name)}${badge}</span>
          <span class="prod__meta">${esc(p.description)}</span>
        </span>
        <span class="prod__price"><b>¥${money(p.price)}</b> <small>/ 件</small></span>
      </button>`;
    }).join('');
    $$('#prod-list .prod').forEach((b) => b.addEventListener('click', () => selectProduct(Number(b.dataset.id))));
    const inList = list.some((p) => p.id === state.productId && p.stock > 0);
    if (state.productId == null || !inList) {
      const first = list.find((p) => p.stock > 0) || list[0];
      selectProduct(first.id);
    } else {
      syncUI();
    }
  }

  function selectProduct(id) {
    state.productId = id;
    $$('#prod-list .prod').forEach((b) => {
      const on = Number(b.dataset.id) === id;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
    state.qty = 1;
    syncUI();
  }

  const current = () => state.products.find((p) => p.id === state.productId);

  function syncUI() {
    const p = current();
    if (!p) return;
    // 品牌区跟随所选商品
    $('#brand-name').textContent = p.name;
    $('#brand-desc').textContent = p.description || '选好商品，扫码付款，卡密自动发到你的邮箱。';
    // 数量上限
    const max = Math.max(1, Math.min(10, p.stock || 1));
    if (state.qty > max) state.qty = max;
    $('#qty-val').textContent = state.qty;
    $('#qty-minus').disabled = state.qty <= 1;
    $('#qty-plus').disabled = state.qty >= max;
    // 合计
    $('#total-val').textContent = money(p.price * state.qty);
  }

  $('#qty-minus').addEventListener('click', () => { state.qty = Math.max(1, state.qty - 1); syncUI(); });
  $('#qty-plus').addEventListener('click', () => { state.qty = Math.min(10, state.qty + 1); syncUI(); });

  /* ---------- 支付方式 ---------- */
  $$('.pay').forEach((b) => b.addEventListener('click', () => {
    state.payType = Number(b.dataset.pay);
    $$('.pay').forEach((x) => {
      const on = x === b;
      x.classList.toggle('is-active', on);
      x.setAttribute('aria-checked', String(on));
    });
  }));

  /* ---------- 下单 ---------- */
  const errBox = $('#form-err');
  const btnBuy = $('#btn-buy');
  const tipModal = $('#pay-tip');

  function openTip() {
    tipModal.hidden = false;
    $('#pay-tip-go').focus();
  }
  function closeTip() { tipModal.hidden = true; }
  $$('[data-tip-close]', tipModal).forEach((b) => b.addEventListener('click', closeTip));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !tipModal.hidden) closeTip();
  });

  btnBuy.addEventListener('click', () => {
    errBox.textContent = '';
    const p = current();
    if (!p) { errBox.textContent = '请先选择商品'; return; }
    const contact = $('#contact').value.trim();
    if (!contact || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
      errBox.textContent = '请填写有效的收件邮箱'; $('#contact').focus(); return;
    }
    if (!$('#agree').checked) { errBox.textContent = '请先阅读并同意购买须知'; return; }
    openTip();   // 先看付款提示，确认后才创建订单
  });

  $('#pay-tip-go').addEventListener('click', async () => {
    closeTip();
    const p = current();
    if (!p) return;
    const contact = $('#contact').value.trim();
    btnBuy.disabled = true;
    btnBuy.textContent = '正在创建订单…';
    try {
      const r = await fetch('/api/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: p.id, qty: state.qty, payType: state.payType, contact }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || '下单失败，请稍后再试');
      sessionStorage.setItem('mf_last_order', data.orderId);
      location.href = '/pay.html?order=' + encodeURIComponent(data.orderId); // 支付页内含二维码/打开按钮
    } catch (e) {
      errBox.textContent = e.message;
      btnBuy.disabled = false;
      btnBuy.textContent = '确认购买';
    }
  });

  /* ---------- 我的订单 弹窗 ---------- */
  const modal = $('#orders-modal');
  const resultBox = $('#order-result');
  let pollTimer = 0;

  function openModal(prefill = '') {
    modal.hidden = false;
    $('#order-id').value = prefill;
    resultBox.innerHTML = '';
    if (prefill) lookup(prefill);
    else setTimeout(() => $('#order-id').focus(), 60);
  }
  function closeModal() {
    modal.hidden = true;
    clearInterval(pollTimer); pollTimer = 0;
  }
  $('#open-orders').addEventListener('click', () => openModal(sessionStorage.getItem('mf_last_order') || ''));
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
  $('#order-lookup').addEventListener('click', () => {
    const q = $('#order-id').value.trim();
    if (!q) { resultBox.innerHTML = '<p class="lookup-empty">请输入订单号或收件邮箱</p>'; return; }
    lookup(q);
  });
  $('#order-id').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#order-lookup').click(); });

  const statusText = { pending: '待支付', paid: '已收款', delivered: '已发货', failed: '已失效' };

  /* 订单号查单笔；收件邮箱查该邮箱下的全部订单 */
  async function lookup(q, opt = {}) {
    const silent = !!opt.silent;      // 轮询刷新时不闪「查询中」
    if (!silent) {
      clearInterval(pollTimer); pollTimer = 0;
      resultBox.innerHTML = '<p class="lookup-empty">查询中…</p>';
    }
    try {
      const r = await fetch(`/api/orders/lookup?q=${encodeURIComponent(q)}`);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || '查询失败');
      renderList(d, q);
      if (d.orders.some((o) => o.status === 'pending')) {
        if (!pollTimer) pollTimer = setInterval(() => lookup(q, { silent: true }), 3000);
      } else { clearInterval(pollTimer); pollTimer = 0; }
    } catch (e) {
      clearInterval(pollTimer); pollTimer = 0;
      resultBox.innerHTML = `<p class="lookup-empty">${esc(e.message)}</p>`;
    }
  }

  function renderList(d, q) {
    const head = d.by === 'email'
      ? `<div class="result__head"><span><b>${esc(q)}</b> 名下共 ${d.orders.length} 笔订单</span><span>按下单时间倒序</span></div>`
      : '';
    resultBox.innerHTML = head + d.orders.map(orderCard).join('');
    $$('.code-copy', resultBox).forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.code); toast('已复制到剪贴板'); }
      catch { toast(b.dataset.code); }
    }));
    $$('[data-refresh]', resultBox).forEach((b) => b.addEventListener('click', () => lookup(b.dataset.refresh, { silent: true })));
  }

  function orderCard(o) {
    const codes = String(o.code || '').split('\n').filter(Boolean);
    return `
      <div class="ord">
        <div class="ord__head">
          <div>
            <div class="ord__name">${esc(o.product_name)}${o.qty > 1 ? ` × ${o.qty}` : ''}</div>
            <div class="ord__no">订单号 ${esc(o.order_id)}</div>
          </div>
          <span class="pill pill--${o.status}">${statusText[o.status] || o.status}</span>
        </div>
        <div class="ord__body">
          <div class="ord__row"><span>金额</span><span>¥${money(o.price)}</span></div>
          <div class="ord__row"><span>下单时间</span><span>${esc(o.created_at)}</span></div>
          ${o.paid_at ? `<div class="ord__row"><span>支付时间</span><span>${esc(o.paid_at)}</span></div>` : ''}
          ${o.status === 'delivered' ? `
            <div class="ord__codes">${codes.map((c, i) => `
              <div class="code-row"><code>${esc(c)}</code>
                <button class="code-copy" type="button" data-code="${esc(c)}">复制${codes.length > 1 ? ` · ${i + 1}` : ''}</button>
              </div>`).join('')}
            </div>
            <p class="ord__hint">卡密已发货，请妥善保存。凭订单号或收件邮箱可随时回来查看。</p>`
          : o.status === 'pending' ? `
            <p class="ord__hint">订单等待支付中，45 分钟内有效。</p>
            <div class="ord__actions">
              ${o.pay_url ? `<a class="btn-pay" href="${esc(o.pay_url)}">继续支付</a>` : ''}
              <button class="btn-ghost2" type="button" data-refresh="${esc(o.order_id)}">刷新状态</button>
            </div>`
          : o.status === 'paid' ? `
            <p class="ord__hint">款项已确认，正在补发货，请稍候刷新；如有疑问联系店主。</p>
            <div class="ord__actions"><button class="btn-ghost2" type="button" data-refresh="${esc(o.order_id)}">刷新状态</button></div>`
          : `<p class="ord__hint">订单已失效。如已付款请联系店主处理。</p>`}
        </div>
      </div>`;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- 启动 ---------- */
  loadProducts();
})();
