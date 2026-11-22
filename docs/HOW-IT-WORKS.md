# 工作原理与实证记录

本文记录定位注入点、抓取真实广告字段、封锁更新链路的完整依据，便于后续版本维护。

---

## 1. 客户端结构（抖音 PC 8.8.0 / Windows x64）

```
C:\Program Files (x86)\ByteDance\douyin\
├── douyin.exe                  ← Electron 主进程（含启动器逻辑）
├── launcher_config.json        ← 指向当前版本目录，含 need_update 字段
├── douyin_guard.exe            ← 守护进程（app-shell-guard）
├── app_guard_crash_reporter\
└── 8.8.0\
    ├── app_shell_updater.exe   ← 壳更新器
    ├── installer_downloader.exe← 安装包下载器
    ├── douyin.backup           ← 主 exe 的备份（守护用）
    ├── douyin_guard.backup     ← 守护程序备份
    ├── md5.json                ← 文件校验清单（1109 条）
    ├── main.dll                ← 197 MB，主进程业务（编译产物）
    └── resources\
        ├── app.asar            ← 14 MB，内含 index.js / preload.js 均为 166 字节 loader
        ├── app-update.yml      ← electron-updater 配置（generic provider）
        ├── app.asar.unpacked\
        │   ├── preload.js      ← ★ 渲染进程 preload，明文、外部文件、可改
        │   ├── douyin-ads.js   ← 本项目注入的模块
        │   └── __META-INF__\win32x64.node  ← 真正的 JS 逻辑（V8 编译产物）
        └── app.asar.unpacked\node_modules\@byted\app-shell-guard\  ← 守护逻辑（明文 JS）
```

关键结论：

- `app.asar` 里的 `index.js` / `preload.js` / `mainWorker.js` 都只有 166 字节，内容形如
  `require("./__META-INF__/"+process.platform+process.arch+".node").link(...)`，
  真正的业务代码是编译进 `.node` 的字节码 → **改 asar 内部没有意义**。
- 渲染进程的 `webPreferences.preload` 明确指向
  `resources\app.asar.unpacked\preload.js`（从进程命令行实证）：

  ```
  --isOpenContextIsolation=open
  "webPreferences":{"webviewTag":true,"devTools":true,"sandbox":false,
   "preload":"C:\\Program Files (x86)\\ByteDance\\douyin\\8.8.0\\resources\\app.asar.unpacked\\preload.js",
   "nodeIntegration":false,"contextIsolation":false}
  ```

  即：`contextIsolation:false` + `sandbox:false` → preload 与页面**同一个 JS 世界**，
  且 preload 里 `require` 可用。这是整个方案的立足点。

---

## 2. 注入方式

`preload.js` 末尾追加一段引导（标记 `/* hs_preload_bootstrap */`），它在 preload 作用域里：

```js
var code = fs.readFileSync(path.join(__dirname, 'douyin-ads.js'), 'utf8');
var fn = new Function('require', '__dirname', 'module', 'exports', code);
fn(require, __dirname, module, module.exports);
```

用 `new Function` 包装而不是 `eval`，是为了让模块仍然拿到 preload 的 `require` / `__dirname`
（默认的 `(0, eval)` 会在全局作用域执行，那里没有 `require`，日志与控制逻辑会静默失效）。

模块内部再自行判断 `location.hostname` 是否属于 `douyin.com`，只在这些页面生效。

**写入必须用 UTF-8 无 BOM 统一读写。** 用 PowerShell 5.1 的 `Get-Content -Raw` 读 UTF-8 文件会按
ANSI(GBK) 解码，中文注释变乱码后重新编码会破坏 JS 结构，导致整个 preload 语法错误、JSBridge 失效。

---

## 3. 真实广告字段（实机抓包，非推测）

从 `www.douyin.com/` / `www.douyin.com/jingxuan` / `www.douyin.com/follow` /
`live.douyin.com/` 的响应中确认存在：

| 接口 | 字段 | 含义 |
|---|---|---|
| `/aweme/v1/web/aweme/post/` | `aweme_list[].is_ads` | 作品是否广告 |
| `/aweme/v1/web/follow/feed/` | `data[].is_ad` | 关注流条目是否广告 |
| `/webcast/feed/` | `data[].is_ad` | 直播推荐条目是否广告 |
| `/aweme/v1/web/danmaku/get_v2/` | `danmaku_list[].is_ad` | 弹幕广告 |
| `/aweme/v1/web/aweme/detail/` | `text_extra[].is_commerce` | 文案里的商品标记 |
| `/aweme/v1/web/user/profile/` | `user.commerce_info` | 用户商业信息 |
| `/aweme/v1/web/multi/aweme/detail/` | `ad_info` / `ad_id` / `ad_type` | 广告投放数据（其中 `ad_type:0` 是普通视频也会带的类型标记，**不要删**） |

判定原则：

- 只认 `is_ad` / `is_ads` / `is_advert` / `ad_info` / `ad_id` / `ad_data` 这些**明确投放信号**。
- `promotion_info` / `is_promotion` 属于创作者挂车（电商功能），**不判定为广告**，
  否则会把正常带货视频当成广告删掉。

---

## 4. 更新链路与四重阻断

```
客户端主进程 ──读──> resources/app-update.yml (generic provider)
                └──> https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/douyin-pc-client/releases/
                            │
                            ├─ 下载/校验：app_shell_updater.exe │ installer_downloader.exe
                            └─ 驱动更新：node_modules/@byted/electron-update-driver/exe/bin/x64/*.exe
```

对应阻断：

1. 改写 `app-update.yml` 的 `url` → `https://127.0.0.1:9/douyin-update-disabled/`
2. `hosts` 将更新 CDN 指向 `0.0.0.0`（`ipconfig /flushdns` 生效）
3. Windows 防火墙出站阻断上述 5 个更新进程（规则名 `Douyin-UpdateBlock-*`）
4. `launcher_config.json` 的 `need_update` 设为 `false`

额外：`LaunchDouyinGuard` 计划任务（`\DouyinUser\DouyinGuard\`，每小时运行
`douyin_guard.exe --start-from=taskschd`）被禁用，避免守护流程在文件被改动后回滚。

> 守护的行为要点（来自 `douyin_guard.exe` 字符串与 `@byted/app-shell-guard` 源码）：
> 它通过 MCS 拉取远程命令（`pc_appguard_command_fetch_result` / `pc_appguard_heartbeat`），
> 带 MD5 校验地下载并运行文件；`douyin.backup` / `douyin_guard.backup` 是主程序与守护自身的备份。
> 它并没有在本地用它自己还原过被修改的 `preload.js`（实测改后重启多次均保持），
> 但禁用计划任务是更稳妥的选择。

---

## 5. md5.json 的处理

`8.8.0\md5.json` 是 1109 条文件的 MD5 清单，包含 `resources\app.asar.unpacked\preload.js`、
`launcher_config.json`、`resources\app-update.yml` 等。

部署脚本会把这几个改动过的文件条目重算写入，使清单与实际文件一致，避免客户端完整性检查报错。
（`md5.json` 的原始版本会备份在本地 `backup\`，不进入本仓库。）

---

## 6. 为什么不用其他方案

| 方案 | 问题 |
|---|---|
| 改 `app.asar` 内部 | 业务逻辑在 `.node` 字节码里，asar 内只有 166 字节 loader |
| 改 `main.dll` / `douyin.exe` | 会触发守护备份还原，且无源码可依 |
| 拦截网络（代理 / hosts 封域） | 广告与正常数据同域同接口，封域会把功能一起封掉 |
| 纯 CSS 隐藏 | 广告视频仍会加载播放，流量与时长照旧 |
| `--remote-debugging-port` 调查 | 启动器不透传该参数，实测无法开启 CDP |
