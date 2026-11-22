/* ============================================================================
   douyin-ads.js — 抖音 PC 客户端 去广告模块（注入 preload，运行于渲染世界）
   由 preload.js 追加段 eval 加载；contextIsolation=false / sandbox=false，
   因此可直接劫持页面 fetch / XMLHttpRequest 并改写响应数据。

   去广告策略（分层，均不触碰非广告内容）：
     L1 数据层：命中广告实体的列表项直接剔除（is_ads / is_ad / ad_info / ad_id ...）
     L2 字段层：删除广告附属字段（ad_info, ad_id, ad_data, promotion_info ...）
     L3 DOM 层：移除带明确广告标记的卡片/角标容器（data-e2e / class 命中）
     L4 弹窗层：拦截商城/游戏/下载类推广跳转（window.open / 客户端 openSchema）
   全部动作写入 douyin-ads-hits.log 便于核对。
   ========================================================================== */
(function () {
  'use strict';

  var W = window;
  if (W.__hs_adblock_installed) return;
  W.__hs_adblock_installed = true;

  /* ---------------- 0. 运行环境 ---------------- */
  // 日志默认写到 %LOCALAPPDATA%\douyin-adblock\hits.log
  // 可用环境变量 DOUYIN_ADBLOCK_LOG 覆盖；设为空字符串或 noreport 可关闭日志
  var LOG = null;
  var fs = null;
  try {
    fs = require('fs');
    var os = require('os');
    var nodePath = require('path');
    var baseDir = process.env.LOCALAPPDATA || os.tmpdir();
    var logDir = nodePath.join(baseDir, 'douyin-adblock');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
    var envLog = process.env.DOUYIN_ADBLOCK_LOG;
    LOG = (envLog === undefined || envLog === null || envLog === '') ?
      nodePath.join(logDir, 'hits.log') : envLog;
    if (/^(noreport|off|none)$/i.test(String(LOG))) LOG = null;
  } catch (e) {
    fs = null;
    LOG = null;
  }
  var logCount = 0, LOG_MAX = 400;

  function log(tag, data) {
    if (!fs || !LOG || logCount > LOG_MAX) return;
    logCount++;
    try { fs.appendFileSync(LOG, new Date().toISOString() + ' [' + tag + '] ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 400) + '\n'); } catch (e) {}
  }

  var HOST = String(location.hostname || '');
  var IS_DOUYIN = /(^|\.)douyin\.com$/.test(HOST);
  if (!IS_DOUYIN) return;

  var STATS = { list: 0, field: 0, dom: 0, popup: 0 };

  /* ---------------- 1. 广告判定 ---------------- */
  // 只认明确的广告投放信号（is_ad / is_ads / ad_info / ad_id ...）。
  // 注意：promotion_info / is_promotion 属于创作者挂车（电商功能），不算广告位，
  // 这里刻意不判定，避免把正常带货视频当成广告删掉。
  function isAdEntity(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    if (o.is_ad === true || o.is_ad === 1 || o.is_ads === true || o.is_ads === 1) return true;
    if (o.is_advert === true || o.is_advert === 1) return true;
    if (o.ad_info && typeof o.ad_info === 'object') {
      for (var k in o.ad_info) return true;
    }
    if (o.ad_id !== undefined && o.ad_id !== null && o.ad_id !== '' && o.ad_id !== 0) return true;
    if (o.ad_data && typeof o.ad_data === 'object') {
      for (var k3 in o.ad_data) return true;
    }
    return false;
  }

  // 需要剥离的广告附属字段：只保留真正承载广告内容/计费数据的键。
  // ad_type / ad_label / ad_tag 这类是普通视频也会带的类型标记（ad_type: 0），
  // 删了没有去广告收益、反而增加改写开销，故不处理。
  var AD_FIELD_RE = /^(ad_info|ad_id|ad_data|ads_info|advertiser_info|ad_extra)$/i;

  // 需要清洗的接口（只处理抖音自家的数据接口，避免误伤静态资源）
  var API_RE = /\/aweme\/v\d+\/(web|v\d+)\/|webcast\/|passport\/|aweme\/v\d+\/following|series\/list|mix\/list|danmaku|hot\/search|suggest_words|comment\/list|search\/item|feed|module\/feed|tab\/feed|related/i;

  function shouldPatchUrl(u) {
    if (!u) return false;
    u = String(u);
    if (u.indexOf('douyin.com') < 0 && u.indexOf('webcast') < 0) return false;
    return API_RE.test(u);
  }

  /* ---------------- 2. 递归清洗 ---------------- */
  var droppedLog = 0;
  function logDropped(it) {
    if (droppedLog >= 25) return;
    droppedLog++;
    var id = it.aweme_id || it.item_id || it.room_id || it.id || it.card_id || '';
    log('drop_item', {
      id: String(id).slice(0, 24),
      desc: String(it.desc || it.title || '').slice(0, 24),
      is_ad: it.is_ad, is_ads: it.is_ads,
      has_ad_info: !!it.ad_info,
      ad_id: it.ad_id ? String(it.ad_id).slice(0, 20) : '',
      aweme_type: it.aweme_type
    });
  }

  var fieldLog = 0;
  function logField(key, val) {
    if (fieldLog >= 10) return;
    fieldLog++;
    var size = 0;
    try { size = JSON.stringify(val === undefined ? null : val).length; } catch (e) { size = -1; }
    log('drop_field', { k: key, size: size });
  }

  function cleanInPlace(node, depth) {
    if (!node || typeof node !== 'object' || depth > 14) return node;
    if (Array.isArray(node)) {
      for (var i = node.length - 1; i >= 0; i--) {
        var it = node[i];
        if (isAdEntity(it)) {
          logDropped(it);
          node.splice(i, 1);
          STATS.list++;
          continue;
        }
        cleanInPlace(it, depth + 1);
      }
      return node;
    }
    for (var key in node) {
      var v = node[key];
      if (v === undefined) continue;
      if (typeof v !== 'object' || v === null) {
        if (AD_FIELD_RE.test(key) && key !== 'is_ad' && key !== 'is_ads') {
          try { logField(key, node[key]); delete node[key]; STATS.field++; } catch (e) {}
        }
        continue;
      }
      if (AD_FIELD_RE.test(key) && key !== 'is_ad' && key !== 'is_ads') {
        try { logField(key, node[key]); delete node[key]; STATS.field++; } catch (e) {}
        continue;
      }
      cleanInPlace(v, depth + 1);
    }
    return node;
  }

  function patchText(txt) {
    if (!txt || txt.length < 2 || txt.length > 1200000) return txt;
    var c = txt.charAt(0);
    if (c !== '{' && c !== '[') return txt;
    var j;
    try { j = JSON.parse(txt); } catch (e) { return txt; }
    var before = STATS.list + STATS.field;
    try { cleanInPlace(j, 0); } catch (e) { return txt; }
    if (STATS.list + STATS.field === before) return txt;
    try { return JSON.stringify(j); } catch (e) { return txt; }
  }

  /* ---------------- 3. fetch 劫持 ---------------- */
  var nativeFetch = W.fetch;
  if (nativeFetch) {
    W.fetch = function (input, init) {
      var url = '';
      try { url = (input && input.url) ? input.url : String(input); } catch (e) {}
      var p = nativeFetch.apply(this, arguments);
      if (!shouldPatchUrl(url)) return p;
      return p.then(function (res) {
        try {
          if (!res || !res.ok) return res;
          var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
          if (ct && ct.indexOf('json') < 0) return res;
          return res.clone().text().then(function (txt) {
            var out = patchText(txt);
            if (out === txt) return res;
            log('filtered_fetch', { u: String(url).slice(0, 140), cut: txt.length - out.length });
            var h = new Headers(res.headers);
            h.delete('content-length');
            h.delete('content-encoding');
            h.delete('content-type');
            h.set('content-type', 'application/json; charset=utf-8');
            return new Response(out, { status: res.status, statusText: res.statusText, headers: h });
          }, function () { return res; });
        } catch (e) { return res; }
      });
    };
  }

  /* ---------------- 4. XHR 劫持 ---------------- */
  try {
    var XHR = W.XMLHttpRequest;
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    var textDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'responseText');
    var respDesc = Object.getOwnPropertyDescriptor(XHR.prototype, 'response');

    XHR.prototype.open = function (m, u) {
      try { this.__hs_url = String(u); } catch (e) {}
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      var self = this, url = this.__hs_url || '';
      var ret = origSend.apply(this, arguments);
      if (!shouldPatchUrl(url) || !textDesc || !textDesc.get) return ret;

      function patchedText() {
        var raw = textDesc.get.call(self);
        if (self.__hs_pt !== undefined) return self.__hs_pt;
        var out = patchText(raw);
        self.__hs_pt = out;
        if (out !== raw) log('filtered_xhr', { u: String(url).slice(0, 140), cut: raw.length - out.length });
        return out;
      }

      try {
        Object.defineProperty(self, 'responseText', { configurable: true, get: patchedText });
      } catch (e) {}

      if (respDesc && respDesc.get) {
        try {
          Object.defineProperty(self, 'response', {
            configurable: true,
            get: function () {
              var v = respDesc.get.call(self);
              try {
                if (typeof v === 'string') return patchedText();
                if (v && typeof v === 'object') cleanInPlace(v, 0);
              } catch (e) {}
              return v;
            }
          });
        } catch (e) {}
      }
      return ret;
    };
  } catch (e) {}

  /* ---------------- 5. DOM 层 ---------------- */
  var CSS_TEXT = [
    '[data-e2e="feed-ad"]',
    '[data-e2e="ad-banner"]',
    '[data-e2e="ad-card"]',
    '[data-e2e="search-ad"]',
    '[class*="ad-banner"]',
    '[class*="adBanner"]',
    '[class*="advert-card"]',
    '[class*="advertCard"]',
    '[class*="advertisement"]',
    '[class*="promotion-card"]',
    '[class*="promotionCard"]',
    '[class*="commerce-card"]',
    '[id*="ad-banner"]'
  ].join(',') + '{display:none!important}';

  function injectCss() {
    try {
      var s = document.createElement('style');
      s.id = 'hs-adblock-style';
      s.textContent = CSS_TEXT;
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {}
  }

  var AD_BADGE_RE = /^(广告|广告·.*|推广|赞助|品牌广告)$/;

  function isFeedContext(el) {
    var p = el, n = 0;
    while (p && p !== document.body && n < 12) {
      var e2e = p.getAttribute && p.getAttribute('data-e2e');
      if (e2e && /feed|video|search|result|list/i.test(e2e)) return true;
      p = p.parentElement; n++;
    }
    return false;
  }

  function sweepAds() {
    var removed = 0;
    // L3-a 明确广告容器
    var marked = document.querySelectorAll('[data-e2e="feed-ad"],[data-e2e="ad-card"],[data-e2e="ad-banner"],[class*="advert-card"],[class*="advertisement"]');
    for (var i = 0; i < marked.length; i++) {
      try { marked[i].style.display = 'none'; removed++; } catch (e) {}
    }
    // L3-b 带"广告"角标的 feed 卡片
    var leaves = document.querySelectorAll(
      '[data-e2e="feed-video"] span,[data-e2e="feed-video"] div,[data-e2e="feed-active-video"] span,' +
      '[data-e2e="feed-item"] span,[data-e2e="search-result-item"] span,[data-e2e="search-result"] span,' +
      '[data-e2e="live-card"] span,[data-e2e="recommend-list"] span'
    );
    var hits = 0;
    for (var k = 0; k < leaves.length && hits < 12; k++) {
      var el = leaves[k];
      if (el.childElementCount) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 8 || !AD_BADGE_RE.test(t)) continue;
      var card = el;
      for (var d = 0; d < 8 && card.parentElement; d++) {
        card = card.parentElement;
        var e2e = card.getAttribute && card.getAttribute('data-e2e');
        if (e2e && /feed-video|feed-item|video-item|search-result/i.test(e2e)) break;
      }
      try {
        card.style.display = 'none';
        hits++; removed++;
        log('dom_card', { badge: t, e2e: card.getAttribute && card.getAttribute('data-e2e') });
      } catch (e) {}
    }
    if (removed) STATS.dom += removed;
    try { sweepPromo(); } catch (e) {}
    try { sweepFixedPromo(); } catch (e) {}
  }

  /* L3-c 客户端下载 / App 推广浮层（左下"抖音精选·去App"这类固定浮窗） */
  var PROMO_TEXT_RE = /^(去App|去APP|打开App|打开APP|下载抖音|下载App|下载APP|立即下载|手机随时随地看|扫码下载|安装抖音|打开抖音App)$/;

  function hidePromoLayer(el) {
    var box = el, target = null;
    for (var d = 0; d < 10 && box && box !== document.body; d++) {
      var cs = null;
      try { cs = getComputedStyle(box); } catch (e) {}
      if (cs && (cs.position === 'fixed')) { target = box; break; }
      if (cs && cs.position === 'absolute') target = box;
      box = box.parentElement;
    }
    if (!target || target === document.body || target === document.documentElement) {
      // 没有固定定位祖先时，退化为隐藏按钮自身所在的紧邻卡片
      target = el.parentElement && el.parentElement.parentElement ? el.parentElement.parentElement : el;
    }
    try {
      var r = target.getBoundingClientRect();
      if (r.width > window.innerWidth * 0.85 && r.height > window.innerHeight * 0.85) {
        target = el.parentElement || el; // 防止误伤整页容器
      }
    } catch (e) {}
    try {
      target.style.display = 'none';
      log('promo_layer', { text: (el.textContent || '').trim().slice(0, 20) });
      return true;
    } catch (e) { return false; }
  }

  function sweepPromo() {
    var els = document.querySelectorAll('div,span,a,button,p,em');
    var hits = 0;
    for (var i = 0; i < els.length && hits < 6; i++) {
      var el = els[i];
      if (el.childElementCount) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 10 || !PROMO_TEXT_RE.test(t)) continue;
      if (hidePromoLayer(el)) { hits++; STATS.dom++; }
    }
  }

  /* L3-d 固定定位的小尺寸 App 推广浮窗（左下"抖音精选 / 下载APP"这类） */
  var FIXED_PROMO_RE = /(抖音精选|下载APP|下载App|去App|打开抖音App|扫码下载|手机随时随地看)/i;
  var lastFixedScan = 0;

  function sweepFixedPromo() {
    var now = Date.now();
    if (now - lastFixedScan < 8000) return;
    lastFixedScan = now;
    if (!document.body) return;
    var all = document.body.getElementsByTagName('*');
    var hits = 0;
    for (var i = 0; i < all.length && hits < 5; i++) {
      var el = all[i];
      if (el.__hs_hidden) continue;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.width > 460 || r.height > 460) continue;      // 只要小浮层
      if (r.width * r.height < 1200) continue;
      var cs;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.position !== 'fixed') continue;
      var t = String(el.innerText || el.textContent || '').replace(/\s+/g, '');
      if (!t || t.length > 60) continue;
      if (!FIXED_PROMO_RE.test(t)) continue;
      try {
        el.style.display = 'none';
        el.__hs_hidden = 1;
        hits++; STATS.dom++;
        log('fixed_promo', { w: Math.round(r.width), h: Math.round(r.height), text: t.slice(0, 30) });
      } catch (e) {}
    }
  }

  var sweepTimer = null;
  function scheduleSweep() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(function () { sweepTimer = null; try { sweepAds(); } catch (e) {} }, 600);
  }

  /* ---------------- 6. 推广跳转拦截 ---------------- */
  var POPUP_RE = /(mall|shop|goods|product|store|game|download|\/promotion|advert|activity\/pull)/i;
  var nativeOpen = W.open;
  W.open = function (u) {
    try {
      if (u && POPUP_RE.test(String(u))) {
        STATS.popup++;
        log('popup_block', String(u).slice(0, 200));
        return null;
      }
    } catch (e) {}
    return nativeOpen.apply(this, arguments);
  };

  /* ---------------- 7. 启动 ---------------- */
  function boot() {
    injectCss();
    try { sweepAds(); } catch (e) {}
    try {
      var mo = new MutationObserver(function () { scheduleSweep(); });
      mo.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    setInterval(function () { try { sweepAds(); } catch (e) {} }, 3000);
    log('boot', { href: location.href.slice(0, 120) });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
    try { injectCss(); } catch (e) {}
  } else {
    boot();
  }

  // 统计落盘（便于核对效果）
  setInterval(function () {
    if (STATS.list || STATS.field || STATS.dom || STATS.popup) {
      log('stats', STATS);
    }
  }, 30000);
})();
