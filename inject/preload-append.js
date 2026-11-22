/* hs_preload_bootstrap — loads douyin-ads.js into the renderer world and
   persists renderer events to disk. Runs inside preload
   (contextIsolation=false, sandbox=false => same JS world as the page,
   full node require available).

   Logs go to %LOCALAPPDATA%\douyin-adblock\ :
     events.log   renderer events emitted by the injected module
     preload.log  bootstrap diagnostics
   Override the events log path with DOUYIN_ADBLOCK_LOG. */
;(function () {
  var fs, nodePath, logDir, EVENT_LOG, BOOT_LOG;

  try {
    fs = require('fs');
    nodePath = require('path');
    var os = require('os');
    var baseDir = process.env.LOCALAPPDATA || os.tmpdir();
    logDir = nodePath.join(baseDir, 'douyin-adblock');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
    var envLog = process.env.DOUYIN_ADBLOCK_LOG;
    EVENT_LOG = (envLog === undefined || envLog === null || envLog === '') ?
      nodePath.join(logDir, 'events.log') : envLog;
    if (/^(noreport|off|none)$/i.test(String(EVENT_LOG))) EVENT_LOG = null;
    BOOT_LOG = nodePath.join(logDir, 'preload.log');
  } catch (e) {
    return;
  }

  try {
    fs.appendFileSync(BOOT_LOG, '[' + new Date().toISOString() + '] bootstrap href=' + location.href + '\n');
  } catch (e) {}

  try {
    if (EVENT_LOG) {
      document.addEventListener('__hs_probe', function (e) {
        try { fs.appendFileSync(EVENT_LOG, String(e && e.detail) + '\n'); } catch (err) {}
      }, true);
    }
  } catch (e) {}

  try {
    var p = nodePath.join(__dirname, 'douyin-ads.js');
    if (!fs.existsSync(p)) {
      fs.appendFileSync(BOOT_LOG, 'module missing: ' + p + '\n');
      return;
    }
    var code = fs.readFileSync(p, 'utf8');
    // Wrap in a Function so the module keeps preload's require/__dirname/module
    var fn = new Function('require', '__dirname', 'module', 'exports', code);
    fn(require, __dirname, module, module.exports);
    fs.appendFileSync(BOOT_LOG, 'module evaluated: ' + p + '\n');
  } catch (e) {
    try { fs.appendFileSync(BOOT_LOG, 'module eval error: ' + (e && e.stack || e) + '\n'); } catch (e2) {}
  }
})();
