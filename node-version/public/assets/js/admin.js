/* 掌柜台 · 后台逻辑：登录、总览、订单、商品与库存 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  let token = sessionStorage.getItem('mf_admin_token') || '';
  let currentView = 'overview';
  let orderStatus = '';
  let orderQuery = '';

  const money = (n) => Number(n).toFixed(2);
  const api = async (path, opts = {}) => {
    const r = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
    });
    if (r.status === 401) { logout(); throw new Error('登录已过期'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || '请求失败');
    return data;
  };

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  /* ---------- 登录 ---------- */
  const login = $('#login');
  const shell = $('#shell');

  function enter() {
    login.hidden = true;
    shell.hidden = false;
    switchView('overview');
  }
  function logout() {
    token = '';
    sessionStorage.removeItem('mf_admin_token');
    shell.hidden = true;
    login.hidden = false;
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = $('#login-pass').value;
    $('#login-err').textContent = '';
    try {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '登录失败');
      token = data.token;
      sessionStorage.setItem('mf_admin_token', token);
      enter();
    } catch (err) {
      $('#login-err').textContent = err.message;
    }
  });
  $('#logout').addEventListener('click', logout);

  /* ---------- 视图切换 ---------- */
  function switchView(name) {
    currentView = name;
    $$('.rail__btn[data-view]').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
    $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    if (name === 'overview') loadOverview();
    if (name === 'orders') loadOrders();
    if (name === 'products') loadProducts();
  }
  $$('.rail__btn[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.goto)));

  if (token) {
    // 先验证旧 token 再进入
    api('/api/admin/summary').then(enter).catch(() => logout());
  }

  /* ---------- 总览 ---------- */
  const kpiDefs = [
    { key: 'revenue', label: '今日收款', unit: '元' },
    { key: 'orders', label: '今日订单', unit: '单' },
    { key: 'pending', label: '待支付', unit: '单' },
    { key: 'stock', label: '在库卡密', unit: '张' },
  ];
  let chartKey = 'revenue';
  let lastSummary = null;

  async function loadOverview() {
    const s = await api('/api/admin/summary');
    lastSummary = s;
    $('#ov-date').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

    const values = {
      revenue: money(s.todayRevenue),
      orders: s.todayOrders,
      pending: s.pendingOrders,
      stock: s.stockTotal,
    };
    const kpis = $('#kpis');
    kpis.textContent = '';
    for (const d of kpiDefs) {
      const b = document.createElement('button');
      b.className = `kpi${Number(values[d.key]) === 0 ? ' is-zero' : ''}`;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(chartKey === d.key));
      b.dataset.key = d.key;
      b.innerHTML = `<span class="kpi-label">${d.label}</span><span class="kpi-value">${values[d.key]}<span class="kpi-unit">${d.unit}</span></span>`;
      b.addEventListener('click', () => { chartKey = d.key; renderKpis(); renderChart(); });
      kpis.append(b);
    }
    if (!$(`.kpi[data-key="${chartKey}"]`)) chartKey = 'revenue';

    renderChart();
    renderCompare();
    renderLowStock(s.lowStock, s.stockTotal);
    renderRecent();
  }
  function renderKpis() {
    $$('#kpis .kpi').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.key === chartKey)));
  }

  function renderChart() {
    if (!lastSummary) return;
    const series = lastSummary.series;
    const key = chartKey === 'orders' ? 'n' : 's';
    const unit = chartKey === 'orders' ? '单' : '元';
    const box = $('#chart');
    box.textContent = '';
    const W = 900, H = 240, padL = 44, padR = 10, padT = 14, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const max = Math.max(...series.map((d) => d[key]), 1);
    const niceMax = max <= 5 ? 5 : Math.ceil(max / 5) * 5;
    const x = (i) => padL + (iw * i) / (series.length - 1);
    const y = (v) => padT + ih * (1 - v / niceMax);

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `近十四天${chartKey === 'orders' ? '订单量' : '收款'}趋势`);

    // 3-4 条网格线 + 刻度
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = (niceMax / steps) * i;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', padL); line.setAttribute('x2', W - padR);
      line.setAttribute('y1', y(v)); line.setAttribute('y2', y(v));
      line.setAttribute('class', 'grid');
      svg.append(line);
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', padL - 8); t.setAttribute('y', y(v) + 4);
      t.setAttribute('text-anchor', 'end');
      t.setAttribute('class', 'tick-label');
      t.textContent = v % 1 ? v.toFixed(1) : v;
      svg.append(t);
    }
    // 主线（唯一数据色）
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('class', 'line-main');
    path.setAttribute('d', series.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(''));
    svg.append(path);
    // x 轴标签（首/中/尾）
    for (const i of [0, Math.floor(series.length / 2), series.length - 1]) {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', x(i)); t.setAttribute('y', H - 6);
      t.setAttribute('text-anchor', i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle');
      t.setAttribute('class', 'tick-label');
      t.textContent = series[i].d;
      svg.append(t);
    }
    box.append(svg);
    if (Number(lastSummary.todayRevenue) === 0 && chartKey === 'revenue') {
      const note = document.createElement('p');
      note.className = 'zero-note';
      note.textContent = '今天还没有收款。第一笔进来，这条线就有了起点。';
      box.append(note);
    }
  }

  function renderCompare() {
    const s = lastSummary.series;
    const today = s[s.length - 1], yest = s[s.length - 2] || { n: 0, s: 0 };
    const fmt = (v, isMoney) => (isMoney ? `${money(v)} 元` : `${v} 单`);
    const diff = (a, b, isMoney) => {
      const d = Number((a - b).toFixed(2));
      const abs = isMoney ? `${money(Math.abs(d))} 元` : `${Math.abs(d)} 单`;
      return d === 0 ? '与昨天持平' : `${d > 0 ? '多' : '少'} ${abs}`;
    };
    const tb = $('#compare-table');
    tb.innerHTML = `<thead><tr><th>对比昨天</th><th class="num">今天</th><th class="num">变化</th></tr></thead>
      <tbody>
        <tr><td>收款</td><td class="num">${fmt(today.s, true)}</td><td class="num">${diff(today.s, yest.s, true)}</td></tr>
        <tr><td>订单</td><td class="num">${fmt(today.n, false)}</td><td class="num">${diff(today.n, yest.n, false)}</td></tr>
      </tbody>`;
  }

  function renderLowStock(rows, total) {
    $('#stock-total').textContent = `在库共 ${total} 张`;
    const ul = $('#low-stock');
    ul.textContent = '';
    const maxStock = Math.max(...rows.map((r) => r.stock), 1);
    for (const r of rows) {
      const li = document.createElement('li');
      li.className = r.stock === 0 ? 'is-out' : r.stock <= 3 ? 'is-low' : '';
      li.innerHTML = `<span class="bar-name">${r.name}</span>
        <span class="bar-count">${r.stock} 张</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(4, (r.stock / maxStock) * 100)}%"></span></span>`;
      ul.append(li);
    }
    if (!rows.length) ul.innerHTML = '<li><span class="bar-name">还没有在售商品</span></li>';
  }

  async function renderRecent() {
    const { orders } = await api('/api/admin/orders');
    const tb = $('#recent-orders');
    const st = { pending: '待支付', paid: '已收款', delivered: '已发货', failed: '已失效' };
    const rows = orders.slice(0, 5);
    tb.innerHTML = `<thead><tr><th>商品</th><th class="num">金额</th><th>状态</th><th>时间</th></tr></thead>` +
      rows.map((o) => `<tr><td>${esc(o.product_name)}</td><td class="num">${money(o.price)}</td>
        <td><span class="st-${o.status}">${st[o.status]}</span></td><td>${esc(o.created_at)}</td></tr>`).join('') ||
      '<tbody><tr><td>今天还没有订单。</td></tr></tbody>';
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- 订单 ---------- */
  $$('#order-tabs [role="tab"]').forEach((t) => t.addEventListener('click', () => {
    orderStatus = t.dataset.status;
    $$('#order-tabs [role="tab"]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    loadOrders();
  }));
  $('#order-search').addEventListener('input', (e) => { orderQuery = e.target.value.trim().toLowerCase(); loadOrders(); });
  $('#orders-refresh').addEventListener('click', loadOrders);

  async function loadOrders() {
    const { orders } = await api(`/api/admin/orders${orderStatus ? `?status=${orderStatus}` : ''}`);
    const st = { pending: '待支付', paid: '已收款', delivered: '已发货', failed: '已失效' };
    const filtered = orderQuery
      ? orders.filter((o) => [o.order_id, o.product_name, o.contact].some((f) => String(f).toLowerCase().includes(orderQuery)))
      : orders;
    const tb = $('#orders-body');
    $('#order-count').textContent = `${filtered.length} 笔`;
    $('#orders-empty').hidden = filtered.length > 0;
    tb.innerHTML = filtered.map((o) => `<tr>
      <td class="oid">${esc(o.order_id)}</td>
      <td>${esc(o.product_name)}</td>
      <td class="num">${money(o.price)}</td>
      <td><span class="st-${o.status}">${st[o.status]}</span></td>
      <td>${esc(o.contact) || '—'}</td>
      <td>${esc(o.paid_at || o.created_at)}</td>
      <td>${o.code ? `${esc(o.code)} <button class="copy" data-code="${esc(o.code)}">复制</button>` : '—'}</td>
      <td><button class="btn-ghost btn-ghost--danger btn-ghost--sm" data-del="${esc(o.order_id)}">删除</button></td>
    </tr>`).join('');
    $$('#orders-body .copy').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.code); toast('卡密已复制'); }
      catch { toast(b.dataset.code); }
    }));
    $$('#orders-body [data-del]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.del;
      const o = orders.find((x) => x.order_id === id);
      const warn = o && o.status === 'pending' ? '\n\n注意：这是待支付订单，若买家已经付款，删除后将无法自动发货。' : '';
      if (!confirm(`删除订单 ${id}？${warn}\n\n删除后该订单与卡密凭据不再可查，且不可撤销。`)) return;
      try {
        await api(`/api/admin/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast('订单已删除');
        loadOrders();
      } catch (err) { toast(err.message); }
    }));
  }

  /* ---------- 商品与库存 ---------- */
  $('#product-add-toggle').addEventListener('click', () => {
    const f = $('#product-form');
    f.hidden = !f.hidden;
    $('#product-add-toggle').setAttribute('aria-expanded', String(!f.hidden));
  });
  $('#product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/admin/products', {
        method: 'POST',
        body: JSON.stringify({
          name: fd.get('name'), description: fd.get('description'), price: Number(fd.get('price')),
          category: String(fd.get('category') || '').trim(),
        }),
      });
      e.target.reset();
      e.target.hidden = true;
      toast('商品已上架，记得补卡密');
      loadProducts();
    } catch (err) { toast(err.message); }
  });

  let allProducts = [];
  let prodCat = '';          // '' = 全部；'__none__' = 未分类；其它 = 分类名

  async function loadProducts() {
    const { products } = await api('/api/admin/products');
    allProducts = products;
    /* 分类下拉建议：现有全部分类 */
    $('#cat-options').innerHTML = [...new Set(products.map((p) => p.category).filter(Boolean))]
      .map((c) => `<option value="${esc(c)}"></option>`).join('');
    renderCatFilter();
    renderProdRows();
  }

  /* 按分类统计商品数 */
  function catCounts() {
    const counts = new Map();
    let none = 0;
    for (const p of allProducts) {
      const c = (p.category || '').trim();
      if (!c) { none += 1; continue; }
      counts.set(c, (counts.get(c) || 0) + 1);
    }
    return { counts, none };
  }

  function renderCatFilter() {
    const box = $('#cat-filter');
    const { counts, none } = catCounts();
    if (!counts.size) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const items = [['', '全部', allProducts.length]];
    for (const [c, n] of counts) items.push([c, c, n]);
    if (none) items.push(['__none__', '未分类', none]);
    box.innerHTML = items.map(([v, label, n]) =>
      `<button type="button" role="tab" aria-selected="${v === prodCat}" data-cat="${esc(v)}">${esc(label)}<span class="cat-n">${n}</span></button>`
    ).join('');
    $$('#cat-filter [data-cat]').forEach((b) => b.addEventListener('click', () => {
      prodCat = b.dataset.cat;
      renderCatFilter();
      renderProdRows();
    }));
  }

  function renderProdRows() {
    const box = $('#product-list');
    if (!allProducts.length) {
      box.innerHTML = '<p class="empty">还没有商品，用右上角「新商品」上架第一个。</p>';
      return;
    }
    const products = prodCat === '__none__'
      ? allProducts.filter((p) => !(p.category || '').trim())
      : prodCat ? allProducts.filter((p) => (p.category || '').trim() === prodCat) : allProducts;
    if (!products.length) {
      box.innerHTML = '<p class="empty">这个分类下还没有商品。</p>';
      return;
    }
    box.innerHTML = products.map((p) => `<div class="prod-row" data-id="${p.id}">
      <span class="prod-name">${esc(p.name)}${p.active ? '' : '（已下架）'}${p.category ? ` <span class="prod-cat">${esc(p.category)}</span>` : ''}</span>
      <span class="prod-price">¥${money(p.price)}</span>
      <span class="prod-stock ${p.stock <= 3 ? 'is-low' : ''}">在库 ${p.stock} / 已售 ${p.sold}</span>
      <span class="prod-actions">
        <button class="btn-ghost" data-act="codes">卡密库</button>
        <button class="btn-ghost" data-act="edit">编辑</button>
        <button class="btn-ghost" data-act="toggle">${p.active ? '下架' : '上架'}</button>
        <button class="btn-ghost btn-ghost--danger" data-act="del">删除</button>
      </span>
      <p class="prod-desc">${esc(p.description)}</p>
    </div>`).join('') || '<p class="empty">还没有商品，用右上角「新商品」上架第一个。</p>';

    $$('#product-list [data-act="toggle"]').forEach((b) => b.addEventListener('click', async (e) => {
      const id = e.target.closest('.prod-row').dataset.id;
      try { await api(`/api/admin/products/${id}/toggle`, { method: 'POST' }); loadProducts(); }
      catch (err) { toast(err.message); }
    }));

    /* 删除商品 */
    $$('#product-list [data-act="del"]').forEach((b) => b.addEventListener('click', async (e) => {
      const rowEl = e.target.closest('.prod-row');
      const name = rowEl.querySelector('.prod-name').textContent.trim();
      if (!confirm(`删除「${name}」？\n\n该商品未售出的卡密会一并删除，已售出订单记录保留。此操作不可撤销。`)) return;
      try {
        await api(`/api/admin/products/${rowEl.dataset.id}`, { method: 'DELETE' });
        toast('商品已删除');
        loadProducts();
      } catch (err) { toast(err.message); }
    }));

    /* 编辑商品：行内展开表单 */
    $$('#product-list [data-act="edit"]').forEach((b) => b.addEventListener('click', () => {
      const rowEl = b.closest('.prod-row');
      const old = rowEl.querySelector('.edit-panel');
      if (old) { old.remove(); return; }
      const p = products.find((x) => String(x.id) === rowEl.dataset.id);
      if (!p) return;
      const panel = document.createElement('div');
      panel.className = 'codes-panel edit-panel';
      panel.innerHTML = `<div class="grid-3">
          <label>商品名<input name="name" maxlength="60" value="${esc(p.name)}"></label>
          <label>一句话说明<input name="description" maxlength="200" value="${esc(p.description)}"></label>
          <label>价格（元）<input name="price" type="number" min="0.01" max="10000" step="0.01" value="${money(p.price)}"></label>
        </div>
        <label class="edit-cat">分类<input name="category" maxlength="20" list="cat-options" placeholder="留空表示不分类" value="${esc(p.category || '')}"></label>
        <div class="edit-actions">
          <button class="btn-primary" type="button" data-save>保存修改</button>
          <button class="btn-ghost" type="button" data-cancel>取消</button>
        </div>`;
      panel.querySelector('[data-cancel]').addEventListener('click', () => panel.remove());
      panel.querySelector('[data-save]').addEventListener('click', async () => {
        const q = (s) => panel.querySelector(s).value.trim();
        try {
          await api(`/api/admin/products/${rowEl.dataset.id}`, {
            method: 'PUT',
            body: JSON.stringify({ name: q('[name="name"]'), description: q('[name="description"]'), price: Number(q('[name="price"]')), category: q('[name="category"]') }),
          });
          toast('商品已更新');
          loadProducts();
        } catch (err) { toast(err.message); }
      });
      rowEl.append(panel);
    }));

    /* 卡密库：查看明细 + 搜索 + 状态筛选 + 翻页 + 导入 */
    $$('#product-list [data-act="codes"]').forEach((b) => b.addEventListener('click', () => {
      const rowEl = b.closest('.prod-row');
      const old = rowEl.querySelector('.codes-panel');
      if (old) { old.remove(); return; }
      const p = products.find((x) => String(x.id) === rowEl.dataset.id);
      if (!p) return;

      const panel = document.createElement('div');
      panel.className = 'codes-panel codes-lib';
      rowEl.append(panel);
      const state = { status: '', q: '', page: 1 };
      let mode = '';                 // '' | 'import' | 'gen'
      let genPrefix = '';
      let genQty = 10;
      let focusSearch = false;

      const render = async () => {
        const d = await api(`/api/admin/products/${p.id}/codes?status=${state.status}&page=${state.page}&q=${encodeURIComponent(state.q)}`);
        state.page = d.page;
        const stockEl = rowEl.querySelector('.prod-stock');
        if (stockEl) {
          stockEl.textContent = `在库 ${d.unused} / 已售 ${d.used}`;
          stockEl.classList.toggle('is-low', d.unused <= 3);
        }
        panel.innerHTML = `
          <div class="codes-lib__head">
            <span class="codes-lib__stats">在库 <b>${d.unused}</b> · 已售 <b>${d.used}</b> · 共 ${d.total} 条</span>
            <input class="codes-lib__search" type="search" placeholder="搜索卡密内容" value="${esc(state.q)}" aria-label="搜索卡密">
          </div>
          <div class="codes-tabs" role="tablist" aria-label="卡密状态">
            ${[['', '全部'], ['unused', '未使用'], ['used', '已使用']].map(([k, label]) =>
              `<button type="button" role="tab" data-st="${k}" aria-selected="${state.status === k}">${label}</button>`).join('')}
          </div>
          ${d.codes.length ? `<ul class="code-list">${d.codes.map((c) => `
            <li class="code-item">
              <code class="code-item__val">${esc(c.code)}</code>
              <span class="code-tag ${c.used ? 'is-used' : ''}">${c.used ? '已售' : '在库'}</span>
              <span class="code-item__meta">${c.used ? `售于 ${esc(c.used_at || '')}${c.order_id ? ` · ${esc(c.order_id)}` : ''}` : '未售出'}</span>
              <button class="copy" type="button" data-code="${esc(c.code)}">复制</button>
            </li>`).join('')}</ul>`
            : '<p class="empty">这个筛选下还没有卡密。</p>'}
          <div class="codes-lib__foot">
            <span class="codes-lib__page">第 ${d.page} / ${d.pages} 页</span>
            <button class="btn-ghost" type="button" data-page="prev" ${d.page <= 1 ? 'disabled' : ''}>上一页</button>
            <button class="btn-ghost" type="button" data-page="next" ${d.page >= d.pages ? 'disabled' : ''}>下一页</button>
            <button class="btn-ghost" type="button" data-mode="import">${mode === 'import' ? '收起导入' : '导入卡密'}</button>
            <button class="btn-ghost" type="button" data-mode="gen">${mode === 'gen' ? '收起生成' : '随机生成'}</button>
          </div>
          ${mode === 'import' ? `<div class="codes-import">
            <label>粘贴卡密，一行一个</label>
            <textarea placeholder="XXXX-XXXX-XXXX&#10;XXXX-XXXX-XXXX"></textarea>
            <span class="hint">单次最多 2000 条，空行会自动忽略。卡密允许重复，重复的会照常入库。</span>
            <button class="btn-primary" type="button" data-do-import>确认导入</button>
          </div>` : ''}
          ${mode === 'gen' ? `<div class="codes-gen">
            <div class="codes-gen__row">
              <label>卡密前缀<input class="codes-gen__prefix" maxlength="12" placeholder="如 MF" value="${esc(genPrefix)}" autocomplete="off" spellcheck="false"></label>
              <label>生成数量<input class="codes-gen__qty" type="number" min="1" max="2000" step="1" value="${genQty}"></label>
              <p class="codes-gen__preview">${genPrefix ? `${esc(genPrefix)} + ${16 - genPrefix.length} 位随机 = 16 位` : '前缀 + 随机 = 共 16 位'}</p>
            </div>
            <span class="hint">前缀可用大小写字母、数字、横线和下划线（最多 12 位，区分大小写）。随机部分由<b>大写 + 小写 + 数字 + 下划线</b>组成，每条都同时包含这四类，并跳过与现有库存重复的卡密。</span>
            <button class="btn-primary" type="button" data-do-gen>生成并入库</button>
          </div>` : ''}`;

        const search = panel.querySelector('.codes-lib__search');
        search.addEventListener('input', (e) => {
          state.q = e.target.value.trim();
          state.page = 1;
          focusSearch = true;
          clearTimeout(panel.__t);
          panel.__t = setTimeout(render, 260);
        });
        if (focusSearch) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); focusSearch = false; }

        panel.querySelectorAll('[data-st]').forEach((t) => t.addEventListener('click', () => {
          state.status = t.dataset.st; state.page = 1; render();
        }));
        panel.querySelectorAll('[data-page]').forEach((t) => t.addEventListener('click', () => {
          state.page += t.dataset.page === 'next' ? 1 : -1;
          render();
        }));
        panel.querySelectorAll('.copy').forEach((c) => c.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(c.dataset.code); toast('卡密已复制'); }
          catch { toast(c.dataset.code); }
        }));
        panel.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
          mode = mode === btn.dataset.mode ? '' : btn.dataset.mode;
          render();
        }));

        const doImport = panel.querySelector('[data-do-import]');
        if (doImport) doImport.addEventListener('click', async () => {
          try {
            const r = await api(`/api/admin/products/${p.id}/codes`, {
              method: 'POST', body: JSON.stringify({ codes: panel.querySelector('.codes-import textarea').value }),
            });
            toast(r.duplicate
              ? `已导入 ${r.added} 条，其中 ${r.duplicate} 条与现有库存重复（已一并入库）`
              : `已导入 ${r.added} 条卡密`);
            mode = '';
            state.page = 1;
            await render();          // 面板就地刷新，行上的库存数字同步更新
          } catch (err) { toast(err.message); }
        });

        /* 随机生成卡密：先填前缀，再指定数量 */
        const prefixInput = panel.querySelector('.codes-gen__prefix');
        if (prefixInput) {
          const qtyInput = panel.querySelector('.codes-gen__qty');
          const preview = panel.querySelector('.codes-gen__preview');
          prefixInput.addEventListener('input', () => {
            const v = prefixInput.value.trim();
            preview.textContent = !v
              ? '前缀 + 随机 = 共 16 位'
              : (v.length > 12 ? '前缀最多 12 位' : `${v} + ${16 - v.length} 位随机 = 16 位`);
          });
          prefixInput.focus();
          panel.querySelector('[data-do-gen]').addEventListener('click', async () => {
            const prefix = prefixInput.value.trim();
            const qty = Number(qtyInput.value);
            if (!prefix) { toast('请先填写卡密前缀'); prefixInput.focus(); return; }
            if (prefix.replace(/[^A-Za-z0-9_-]/g, '').length !== prefix.length) { toast('前缀只能用字母、数字、横线和下划线'); return; }
            if (!Number.isFinite(qty) || qty < 1 || qty > 2000) { toast('数量需在 1~2000 之间'); return; }
            genPrefix = prefix; genQty = qty;
            try {
              const r = await api(`/api/admin/products/${p.id}/codes/gen`, {
                method: 'POST', body: JSON.stringify({ prefix, qty }),
              });
              toast(`已生成 ${r.added} 条 ${r.length} 位卡密`);
              mode = '';
              state.status = '';
              state.page = 1;
              await render();
            } catch (err) { toast(err.message); }
          });
        }
      };

      render().catch((err) => toast(err.message));
    }));
  }
})();
