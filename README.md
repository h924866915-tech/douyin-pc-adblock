# 抖音 PC 客户端 去广告 + 屏蔽自动更新

> 通过 Electron `preload` 注入实现，不改 exe、不劫持登录、不碰播放链路。
> 在 **抖音 PC 8.8.0（Windows x64）** 上实机验证：广告接口数据被剔除、App 推广浮窗被隐藏、自动更新全链路阻断，登录 / 播放 / 直播 / 消息 / 投稿 / 下载全部正常。

---

## 特性

**去广告（4 层，只动明确带广告标记的内容）**

| 层 | 处理对象 | 依据 |
|---|---|---|
| 数据层 | 信息流、直播、评论、弹幕、搜索等接口 JSON | `is_ad` / `is_ads` / `ad_info` / `ad_id` / `ad_data` —— 命中即整条剔除 |
| 字段层 | 广告附属字段 | `ad_info`、`ad_id`、`ad_data`、`ads_info`、`advertiser_info`、`ad_extra` 剥离 |
| DOM 层 | 带「广告 / 推广 / 赞助」角标的卡片 | 定位卡片容器后隐藏 |
| 浮层层 | 「抖音精选·下载 APP」这类固定推广浮窗、商城 / 游戏 / 下载类跳转 | 固定定位小浮层识别 + `window.open` 拦截 |

**屏蔽自动更新（四重，任一失效仍有兜底）**

1. `resources/app-update.yml` 更新源改为不可达地址
2. `hosts` 阻断更新 CDN（`lf-douyin-pc-web.douyinstatic.com`）
3. Windows 防火墙阻断更新进程出站（`app_shell_updater.exe`、`installer_downloader.exe`、`update-driver.exe` 等）
4. `launcher_config.json` 关闭 `need_update`，并禁用守护计划任务防止改动被还原

---

## 安装

需要 **管理员权限**（要改 `Program Files` 和 `hosts`）。

```
右键 apply-douyin-adblock.ps1 →「使用 PowerShell 运行」→ UAC 点「是」
```

或命令行：

```powershell
powershell -ExecutionPolicy Bypass -File .\apply-douyin-adblock.ps1
```

约 20 秒完成：备份 → 注入 → 封锁更新 → 重启客户端。

**可选参数**

```powershell
-DouyinRoot "D:\Apps\douyin"   # 客户端装在其他位置时指定根目录
-NoRestart                     # 只部署，不自动重启客户端
```

脚本**版本自适应**：优先读 `launcher_config.json` 的 `cur_path`，失败则扫描 `x.y.z` 目录取最高版本，所以客户端升级后（8.9.x / 9.x）直接重跑即可，不用改脚本。脚本幂等，重复执行不会叠加注入段。

---

## 卸载 / 还原

```
右键 restore-douyin.ps1 →「使用 PowerShell 运行」→ UAC 点「是」
```

还原 `preload.js`、更新地址、`hosts`、防火墙规则、守护计划任务。

---

## 日志

默认写入 `%LOCALAPPDATA%\douyin-adblock\`：

| 文件 | 内容 |
|---|---|
| `hits.log` | `[filtered_fetch]` / `[filtered_xhr]` 接口层命中；`[drop_item]` 被剔除的广告条目；`[dom]` / `[fixed_promo]` 界面层命中；`[stats]` 每 30 秒汇总 |
| `preload.log` | 注入加载诊断（哪个窗口、模块是否加载成功） |

自定义路径：设置环境变量 `DOUYIN_ADBLOCK_LOG`；设为 `off` 关闭日志。

---

## 已知边界

- 首屏 SSR 数据（React Server Components 流）不走 `fetch` / `XHR`，这部分由 DOM 层兜底；分页接口的插入式广告由数据层拦截。
- 顶部运营 banner（活动位）默认保留，避免布局留白 —— 需要的话按 [docs/CUSTOMIZE.md](docs/CUSTOMIZE.md) 调整。
- 桌面挂件（`douyin_widget.exe`）和托盘消息属于推送而非广告，可在客户端设置里关闭。
- 创作者挂车（`promotion_info`）**不算广告**，脚本刻意不动，避免把正常带货视频删掉。
- 客户端被大重构（preload 加载方式改变）时注入可能整体失效，需要重新定位注入点。
- 已屏蔽更新，所以客户端里点「检查更新」会提示网络异常，属预期。

---

## 工作原理

一句话：抖音 PC 是 Electron 应用，渲染窗口的 `preload` 是外部明文文件，且 `contextIsolation:false` / `sandbox:false` —— 注入的脚本和页面处于同一个 JS 世界，还能用 Node 能力。于是它既能劫持 `fetch` / `XMLHttpRequest` 改写广告数据，也能操作 DOM 隐藏广告卡片。

细节（注入点定位、抓到的真实广告字段、四重更新阻断、守护进程行为）见 [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)。

---

## 免责声明

- 仅供个人学习研究、在自己设备上使用。
- 本项目**不包含**任何字节跳动的代码或资源；注入脚本与部署脚本均为原创。
- 修改第三方客户端可能违反其用户协议，使用风险（包括账号、功能异常、后续版本失效）由使用者自行承担。
- 请勿用于商业分发或二次打包售卖。

## License

MIT
