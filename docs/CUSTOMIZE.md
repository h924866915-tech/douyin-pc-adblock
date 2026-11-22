# 自定义规则

所有过滤规则都在 `inject\douyin-ads.js`，改完重启客户端生效（或重跑部署脚本）。

---

## 1. 判定哪些条目是广告

```js
function isAdEntity(o) {
  if (o.is_ad === true || o.is_ad === 1 || o.is_ads === true || o.is_ads === 1) return true;
  if (o.is_advert === true || o.is_advert === 1) return true;
  if (o.ad_info && typeof o.ad_info === 'object') { for (var k in o.ad_info) return true; }
  if (o.ad_id !== undefined && o.ad_id !== null && o.ad_id !== '' && o.ad_id !== 0) return true;
  if (o.ad_data && typeof o.ad_data === 'object') { for (var k3 in o.ad_data) return true; }
  return false;
}
```

新增信号示例（比如抖音以后改成 `is_sponsored`）：

```js
if (o.is_sponsored === true || o.is_sponsored === 1) return true;
```

**注意**：只加"明确投放"的信号。像 `promotion_info`（创作者挂车）、`ad_type`（普通视频也有 `ad_type: 0`）
这类不要加，否则会误删正常内容。

---

## 2. 剥离哪些字段

```js
var AD_FIELD_RE = /^(ad_info|ad_id|ad_data|ads_info|advertiser_info|ad_extra)$/i;
```

字段剥离只影响"广告标记本身"，作用是把广告数据的残留（计费 / 监测信息）清掉；
真正让广告消失的是上面的条目剔除。加字段时优先确认它不会影响正常渲染。

---

## 3. 哪些接口需要处理

```js
var API_RE = /\/aweme\/v\d+\/(web|v\d+)\/|webcast\/|passport\/|aweme\/v\d+\/following|series\/list|mix\/list|danmaku|hot\/search|suggest_words|comment\/list|search\/item|feed|module\/feed|tab\/feed|related/i;

function shouldPatchUrl(u) {
  if (!u) return false;
  u = String(u);
  if (u.indexOf('douyin.com') < 0 && u.indexOf('webcast') < 0) return false;
  return API_RE.test(u);
}
```

收紧（只处理 feed 类）：

```js
var API_RE = /\/feed\/|module\/feed|tab\/feed|aweme\/post|aweme\/detail|comment\/list/i;
```

放宽会带来不必要的 JSON 解析开销（每个响应都要 parse + stringify 一次）。

---

## 4. DOM 层：加广告选择器

```js
var CSS_TEXT = [
  '[data-e2e="feed-ad"]',
  '[class*="ad-banner"]',
  '[class*="advert-card"]',
  // 在这里加新选择器
].join(',') + '{display:none!important}';
```

同时 `sweepAds()` 里的 `marked` 查询也要同步加一份，用于运行时反复清理
（有些卡片是异步插入的，CSS 命中后仍会被重新挂载）。

---

## 5. 推广浮层：加识别词

```js
var FIXED_PROMO_RE = /(抖音精选|下载APP|下载App|去App|打开抖音App|扫码下载|手机随时随地看)/i;
```

匹配逻辑：`position:fixed` + 尺寸小于 460×460 + 文本命中关键词 → 隐藏该层。

---

## 6. 想把顶部运营 banner 也清掉

默认保留（清空后页面顶部会留白）。要清的话，在 `cleanInPlace` 后加一个针对
`/aweme/v1/web/solution/resource/list/` 且 `spot_keys` 含 `douyin_pc_banner` 的判断，
把响应里的 `resource_list` 置空：

```js
if (/douyin_pc_banner/.test(url)) {
  try { var j = JSON.parse(txt); if (j && j.resource_list) j.resource_list = []; txt = JSON.stringify(j); } catch (e) {}
}
```

---

## 7. 调试

- 看命中：`%LOCALAPPDATA%\douyin-adblock\hits.log`
- 看加载：`%LOCALAPPDATA%\douyin-adblock\preload.log`
  （如果这里没有 `module evaluated`，说明 preload 注入没生效，先确认 `preload.js` 里是否有
  `/* hs_preload_bootstrap */` 标记）
- 临时关日志：设环境变量 `DOUYIN_ADBLOCK_LOG=off`
- 日志上限 400 行 / 会话，`[stats]` 每 30 秒汇总一次计数

`hits.log` 常见标签：

| 标签 | 含义 |
|---|---|
| `[filtered_fetch]` / `[filtered_xhr]` | 某个接口的响应被改写（`cut` 为长度差） |
| `[drop_item]` | 被剔除的广告条目（含 `id` / `desc` / `is_ad` / `has_ad_info`） |
| `[drop_field]` | 被剥离的字段（含键名与原始大小） |
| `[dom_card]` | 按角标隐藏的卡片 |
| `[fixed_promo]` | 隐藏的推广浮层（含尺寸与文本） |
| `[popup_block]` | 被拦截的推广跳转 |
| `[stats]` | 汇总计数 |
