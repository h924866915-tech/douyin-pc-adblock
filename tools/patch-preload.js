#!/usr/bin/env node
// patch-preload.js — 安全改写 preload.js 的独立工具（可选，主流程由 .ps1 脚本自带）
//
// 用途：把注入引导段追加到抖音客户端 preload.js 末尾，并在写入前做语法自检。
// 与 apply-douyin-adblock.ps1 的效果一致，适合想手动控制或二次开发的人。
//
// 用法：
//   node patch-preload.js --version-dir "C:\Program Files (x86)\ByteDance\douyin\8.8.0" --append .\inject\preload-append.js
//   node patch-preload.js --version-dir "<版本目录>" --revert
//
// 说明：
//   · 统一用 UTF-8 读写，避免 PowerShell 5.1 下中文被 ANSI 解码破坏脚本
//   · 原文件备份为 preload.js.dshbak（首次创建，之后不覆盖，保证能回到最初状态）
//   · 写入前 new Function() 做语法校验，失败则不落盘
'use strict';

const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(name);

let versionDir = arg('--version-dir', '');
if (!versionDir) {
  console.error('缺少 --version-dir，例如：');
  console.error('  --version-dir "C:\\Program Files (x86)\\ByteDance\\douyin\\8.8.0"');
  process.exit(1);
}
versionDir = path.resolve(versionDir);

const PRE = path.join(versionDir, 'resources', 'app.asar.unpacked', 'preload.js');
const BAK = PRE + '.dshbak';
const MARKER = '/* hs_preload_bootstrap */';

if (!fs.existsSync(PRE)) {
  console.error('找不到 preload.js：', PRE);
  process.exit(1);
}
if (!fs.existsSync(BAK)) {
  fs.copyFileSync(PRE, BAK);
  console.log('已备份原始 preload.js ->', BAK);
}

const syntax = (code) => {
  try { new Function(code); return null; } catch (e) { return e.message; }
};

let base = fs.readFileSync(BAK, 'utf8');
const cut = base.indexOf(MARKER);
if (cut > -1) base = base.slice(0, cut);

if (flag('--revert')) {
  fs.writeFileSync(PRE, base, 'utf8');
  console.log('已还原，preload.js =', fs.statSync(PRE).size, '字节');
  process.exit(0);
}

const appendFile = arg('--append', path.join(__dirname, '..', 'inject', 'preload-append.js'));
if (!fs.existsSync(appendFile)) {
  console.error('找不到注入引导段：', appendFile);
  process.exit(1);
}

const out = base + '\n' + MARKER + '\n' + fs.readFileSync(appendFile, 'utf8');
const err = syntax(out);
if (err) {
  console.error('语法校验失败，未写入：', err);
  process.exit(2);
}
fs.writeFileSync(PRE, out, 'utf8');
console.log('注入完成，preload.js =', fs.statSync(PRE).size, '字节');
