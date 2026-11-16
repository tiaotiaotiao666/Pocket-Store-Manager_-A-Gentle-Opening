#!/usr/bin/env node
'use strict';

/**
 * 资产与产物安全扫描。
 *
 * 两层模式：
 * - mode=production：任何秘密、内网地址、外网 URL、绝对路径都不允许。
 * - mode=development：允许 127.0.0.1/localhost 作为本地联调地址，其余规则不变。
 *
 * 产物扫描额外禁止宿主依赖：process.env、src/、scripts/、server/、node_modules、
 * 以及对旧脚本 src/domain/catalog.mjs 的引用。
 */

const fs = require('node:fs');
const path = require('node:path');

const SECRET_PATTERNS = [
  { code: 'SECRET_DETECTED', pattern: /\bsk-[A-Za-z0-9_-]{8,}/ },
  { code: 'SECRET_DETECTED', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: 'SECRET_DETECTED', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: 'SECRET_DETECTED', pattern: /\b(app_?secret|appsecret|api_?key|secret_?key)\b\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { code: 'SECRET_DETECTED', pattern: /\b(password|passwd|pwd)\b\s*[:=]\s*['"][^'"]{4,}['"]/i },
];

const DB_PATTERNS = [
  { code: 'DB_CONNECTION', pattern: /\b(mysql|mariadb|mongodb|redis):\/\//i },
];

const ABSOLUTE_PATH_PATTERNS = [
  { code: 'PATH_ESCAPE', pattern: /\b[A-Za-z]:\\/ },
  { code: 'PATH_ESCAPE', pattern: /\\\\[A-Za-z0-9._-]+\\/ },
  { code: 'PATH_ESCAPE', pattern: /\bfile:\/\//i },
  { code: 'PATH_ESCAPE', pattern: /(^|['"`\s])\/(home|Users|var|etc|opt)\// },
];

const INTERNAL_HOST_PATTERNS = [
  { code: 'INTERNAL_ADDRESS', pattern: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/ },
  { code: 'INTERNAL_ADDRESS', pattern: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
  { code: 'INTERNAL_ADDRESS', pattern: /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/ },
];

const LOCAL_HOST_PATTERN = /\b(127\.0\.0\.1|localhost|0\.0\.0\.0)\b/;
const EXTERNAL_URL_PATTERN = /\bhttps?:\/\/[^\s'"`<>)]+/i;

const OUTPUT_HOST_PATTERNS = [
  { code: 'OUTPUT_HOST_DEPENDENCY', pattern: /\bprocess\.env\b/ },
  { code: 'OUTPUT_HOST_DEPENDENCY', pattern: /src\/domain\/catalog\.mjs/ },
  { code: 'OUTPUT_HOST_DEPENDENCY', pattern: /require\(\s*['"][^'"]*(scripts|server|node_modules)\// },
  { code: 'OUTPUT_HOST_DEPENDENCY', pattern: /require\(\s*['"](fs|path|child_process|electron)['"]\s*\)/ },
];

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * W1：只有「生成报告」里显式声明的 output.projectPath 允许出现 Windows 绝对路径
 * （那是产物位置的真实记录，不是泄漏）。豁免范围严格限定：
 * - 仅 generation-report.json 与 生成报告.md 两个文件；
 * - 仅限调用方传入的那几个字面值，其他任何绝对路径照旧报 PATH_ESCAPE；
 * - 屏蔽时用等长无关占位符，不改变换行结构，行号仍然准确。
 */
const REPORT_DECLARED_PATH_FILES = new Set(['generation-report.json', '生成报告.md']);
const DECLARED_PATH_PLACEHOLDER = '<declared-output-path>';

function maskDeclaredPaths(text, values) {
  let masked = String(text);
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    // JSON 里反斜杠是转义的（"C:\\Users\\..."），两种形态都要屏蔽，
    // 否则报告 JSON 仍会命中 PATH_ESCAPE。
    const variants = new Set([value, value.replace(/\\/g, '\\\\')]);
    for (const variant of variants) {
      if (!variant) continue;
      const pieces = masked.split(variant);
      if (pieces.length > 1) masked = pieces.join(DECLARED_PATH_PLACEHOLDER);
    }
  }
  return masked;
}

function fileLine(content, index) {
  const start = content.lastIndexOf('\n', index) + 1;
  const end = content.indexOf('\n', index);
  return content.slice(start, end < 0 ? content.length : end).trim();
}

function scanText(text, options) {
  const opts = options || {};
  const file = opts.file || '<inline>';
  const mode = opts.mode === 'production' ? 'production' : 'development';
  const findings = [];
  const content = String(text);
  const lines = content.split('\n');

  const rules = [...SECRET_PATTERNS, ...DB_PATTERNS, ...INTERNAL_HOST_PATTERNS];
  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    const pattern = new RegExp(rule.pattern.source, flags);
    let match = pattern.exec(content);
    while (match) {
      findings.push({
        file,
        line: lineNumber(content, match.index),
        pattern: fileLine(content, match.index).slice(0, 120),
        code: rule.code,
      });
      match = pattern.exec(content);
    }
  }

  // 绝对路径规则只对「屏蔽掉已声明产物路径」的文本生效，其余规则仍看原文。
  const declared = Array.isArray(opts.declaredPaths) ? opts.declaredPaths : [];
  const pathSource = declared.length > 0 ? maskDeclaredPaths(content, declared) : content;
  for (const rule of ABSOLUTE_PATH_PATTERNS) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
    const pattern = new RegExp(rule.pattern.source, flags);
    let match = pattern.exec(pathSource);
    while (match) {
      findings.push({
        file,
        line: lineNumber(pathSource, match.index),
        pattern: fileLine(content, match.index).slice(0, 120),
        code: rule.code,
      });
      match = pattern.exec(pathSource);
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!EXTERNAL_URL_PATTERN.test(line)) continue;
    const isLocal = LOCAL_HOST_PATTERN.test(line);
    const isBaseUrlLine = /(^|["'\s])baseUrl["']?\s*[:=]/.test(line) || /\bapi\.baseUrl\b/.test(line);
    if (isLocal && mode === 'production') {
      findings.push({ file, line: index + 1, pattern: line.trim().slice(0, 120), code: 'LOCALHOST_IN_PRODUCTION' });
      continue;
    }
    if (isLocal && mode === 'development') continue;
    if (isBaseUrlLine) {
      if (mode === 'production' && !/https:\/\//i.test(line)) {
        findings.push({ file, line: index + 1, pattern: line.trim().slice(0, 120), code: 'API_BASE_URL_NOT_HTTPS' });
      }
      continue;
    }
    if (opts.allowExternalUrls) continue;
    findings.push({ file, line: index + 1, pattern: line.trim().slice(0, 120), code: 'EXTERNAL_URL' });
  }

  if (opts.output) {
    for (const rule of OUTPUT_HOST_PATTERNS) {
      const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g';
      const pattern = new RegExp(rule.pattern.source, flags);
      let match = pattern.exec(content);
      while (match) {
        findings.push({
          file,
          line: lineNumber(content, match.index),
          pattern: fileLine(content, match.index).slice(0, 120),
          code: rule.code,
        });
        match = pattern.exec(content);
      }
    }
  }

  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return findings;
}

const TEXT_EXTENSIONS = new Set(['.js', '.json', '.wxml', '.wxss', '.md', '.txt', '.mjs', '.cjs', '.ts']);

function listFiles(target) {
  const files = [];
  if (!fs.existsSync(target)) return files;
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  fs.readdirSync(target, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') return;
      files.push(...listFiles(full));
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(full);
    }
  });
  return files.sort();
}

function scanSources(targets, options) {
  const opts = options || {};
  const findings = [];
  targets.forEach((target) => {
    listFiles(target).forEach((file) => {
      const text = fs.readFileSync(file, 'utf8');
      findings.push(...scanText(text, { mode: opts.mode, file, output: Boolean(opts.output), allowExternalUrls: Boolean(opts.allowExternalUrls) }));
    });
  });
  return { ok: findings.length === 0, findings };
}

function scanOutput(dir, options) {
  const opts = options || {};
  const findings = [];
  const declaredPaths = Array.isArray(opts.declaredPaths) ? opts.declaredPaths : [];
  listFiles(dir).forEach((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const relative = path.relative(dir, file).replace(/\\/g, '/');
    // 声明路径豁免只作用于生成报告本身，业务文件一律不豁免。
    const allowPaths = REPORT_DECLARED_PATH_FILES.has(relative) ? declaredPaths : [];
    findings.push(...scanText(text, {
      mode: opts.mode,
      file: relative,
      output: true,
      allowExternalUrls: Boolean(opts.allowExternalUrls),
      declaredPaths: allowPaths,
    }));
  });
  return { ok: findings.length === 0, findings };
}

module.exports = {
  scanText,
  scanSources,
  scanOutput,
  listFiles,
  maskDeclaredPaths,
  REPORT_DECLARED_PATH_FILES,
  SECRET_PATTERNS,
  ABSOLUTE_PATH_PATTERNS,
  INTERNAL_HOST_PATTERNS,
};