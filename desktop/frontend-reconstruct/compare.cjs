'use strict';

/**
 * P3 可观察项对照（只读、无像素测量）。
 *
 * 输入是**已经过 Composer 的候选产物**（`dry-run.cjs` 的 outputDir）与模型 Draft，
 * 输出一组可观察检查项。这里刻意只做“看得见、可复现、非主观”的判断：
 *
 * 1. 分区顺序：Draft 里的节点顺序在生成 WXML 中同序出现；
 * 2. 关键组件/按钮：每个 component / button 都在页面上真的渲染了；
 * 3. 关键动作：button 绑定的是真实控制器处理器（bind:tap=<handler>）；
 * 4. 插槽锚点：每个 slot 的开闭注释与 fallback 锚点都完整（缺锚点可定位）；
 * 5. 主题：Draft 用到的颜色 token 都由 Base 的 theme CSS 变量提供（变量必须真实定义）；
 * 6. 空白页：每页至少渲染一个可见节点（不是只剩空壳）；
 * 7. 密度 / 溢出：**不做**像素或百分比判断，如实标 `not_checked` 并说明原因；
 * 8. 关键动作可点：只读微信运行报告里已有的真实点击结论，没跑就 `not_run`，失败就 `fail`，
 *    被工具阻塞就 `not_checked` —— 绝不把未执行说成通过。
 *
 * 因此本模块不会出现“相似度 97%”“像素 100%”这类无依据承诺；所有结论都指向
 * 具体的 DSL path（`$.pages[i].nodes[j]...`）与输出文件。
 *
 * 参考图的区域识别（unknownRegions/lowConfidence/degradations）由 P1 的 UiRequirement
 * 负责并原样展示；这里验证的是“模型 Draft 的结构/主题/动作是否真的落到产物与运行时”，
 * 不做图像相似度打分（那是没有依据的像素承诺）。
 */

const fs = require('node:fs');
const path = require('node:path');

const { toWxmlDataExpression, THEME_CSS_VARS } = require('./render.cjs');

const CHECK = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  NOT_RUN: 'not_run',
  NOT_CHECKED: 'not_checked',
  NOT_APPLICABLE: 'not_applicable',
});

const CODES = Object.freeze({
  OUTPUT_UNREADABLE: 'OBS_OUTPUT_UNREADABLE',
  SECTION_MISSING: 'OBS_SECTION_MISSING',
  SECTION_ORDER: 'OBS_SECTION_ORDER',
  COMPONENT_MISSING: 'OBS_COMPONENT_MISSING',
  ACTION_MISSING: 'OBS_ACTION_MISSING',
  SLOT_ANCHOR_MISSING: 'SLOT_ANCHOR_MISSING',
  THEME_VAR_MISSING: 'OBS_THEME_VAR_MISSING',
  BLANK_PAGE: 'OBS_BLANK_PAGE',
  DENSITY_NOT_MEASURED: 'OBS_DENSITY_NOT_MEASURED',
  OVERFLOW_NOT_MEASURED: 'OBS_OVERFLOW_NOT_MEASURED',
  ACTION_NOT_CLICKABLE: 'OBS_ACTION_NOT_CLICKABLE',
  ACTION_CLICK_NOT_RUN: 'OBS_ACTION_CLICK_NOT_RUN',
});

/** 运行时报告里与 Base 关键动作对应的真实点击链路（只读匹配，不改微信脚本）。 */
const RUNTIME_FLOWS = Object.freeze([
  { action: 'home.goMenu', label: '真实点击·首页选桌', title: '首页 →「开始点餐」进入菜单' },
  { action: 'menu.onCheckout', label: '真实点击·结算提交下单', title: '选菜 → 结算提交下单' },
]);

const MAX_CHECK_DETAIL = 160;
const MAX_MESSAGE = 200;

function truncate(value, limit) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length <= limit ? text : text.slice(0, limit) + '…';
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    return null;
  }
}

function escapeWxml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function check(id, status, message, extra) {
  return {
    id,
    status,
    message: truncate(message, MAX_MESSAGE),
    ...(extra || {}),
  };
}

/** 递归摊平 Draft 节点（container 内的子节点沿用父路径 + `.children[k]`）。 */
function flattenNodes(pages) {
  const out = [];
  pages.forEach((page, pageIndex) => {
    const pagePath = '$.pages[' + pageIndex + ']';
    const walk = (nodes, basePath) => {
      (Array.isArray(nodes) ? nodes : []).forEach((node, index) => {
        const nodePath = basePath + '.nodes[' + index + ']';
        out.push({ pageIndex, pageId: page.pageId, node, path: nodePath });
        if (node && node.type === 'container' && Array.isArray(node.children)) {
          walk(node.children, nodePath);
        }
      });
    };
    walk(page.nodes, pagePath);
  });
  return out;
}

/** 单节点在 WXML 里的“可观察签名”（用真实渲染结果里的稳定片段，不依赖 class 名）。 */
function nodeSignature(entry) {
  const { node, pageId, path: nodePath } = entry;
  if (!node || typeof node !== 'object') return null;
  try {
    if (node.type === 'component') return { kind: CODES.COMPONENT_MISSING, value: '<' + node.componentId + ' ' };
    if (node.type === 'slot') return { kind: CODES.SLOT_ANCHOR_MISSING, value: '@slot:' + node.slotId };
    if (node.type === 'button') {
      const handler = String(node.action || '').split('.')[1] || '';
      return {
        kind: CODES.ACTION_MISSING,
        value: 'bind:tap="' + escapeWxml(handler) + '">' + escapeWxml(node.label) + '</button>',
      };
    }
    if (node.type === 'text') {
      const expression = toWxmlDataExpression(node.textToken, pageId, nodePath + '.textToken');
      return { kind: CODES.SECTION_MISSING, value: '>{{' + escapeWxml(expression) + '}}</text>' };
    }
  } catch (error) {
    return { kind: CODES.SECTION_MISSING, value: '', error: truncate(error.message, MAX_CHECK_DETAIL) };
  }
  return null;
}

function themeTokensOf(entry) {
  const style = entry.node && entry.node.style;
  if (!style || typeof style !== 'object') return [];
  const out = [];
  for (const field of ['colorToken', 'backgroundColorToken', 'borderColorToken']) {
    if (typeof style[field] === 'string') out.push({ field, token: style[field] });
  }
  return out;
}

function themeVarOf(token) {
  return THEME_CSS_VARS[token];
}

/**
 * 可观察项对照。
 *
 * @param {object} options
 * @param {object} options.draft          已通过 P2 校验的 FrontendPackDraft
 * @param {string} options.outputDir     Composer 产物目录（`<attempt>/verification/.../candidate`）
 * @param {object} [options.requirement] 可选：P1 UiRequirement（只用 visual.density 说明“未测量”）
 * @param {object} [options.runtimeReport] 可选：wechat-devtools-run.v1 报告（只读）
 * @returns {{ok:boolean, checks:object[], issues:object[], summary:string}}
 */
function compareObservable(options) {
  const opts = options || {};
  const draft = opts.draft;
  const outputDir = opts.outputDir;
  const checks = [];

  if (!draft || !Array.isArray(draft.pages) || draft.pages.length === 0) {
    return {
      ok: false,
      checks: [check('input', CHECK.FAIL, '缺少可对照的 Draft 页面')],
      issues: [{
        code: CODES.OUTPUT_UNREADABLE,
        path: '$.pages',
        field: null,
        file: null,
        message: '缺少可对照的 Draft 页面',
        severity: 'error',
        source: 'observable',
      }],
      summary: '可观察项对照未执行：缺少 Draft',
    };
  }
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) {
    return {
      ok: false,
      checks: [check('input', CHECK.FAIL, '缺少候选产物目录')],
      issues: [{
        code: CODES.OUTPUT_UNREADABLE,
        path: '$.pages',
        field: null,
        file: null,
        message: '缺少候选产物目录',
        severity: 'error',
        source: 'observable',
      }],
      summary: '可观察项对照未执行：缺少产物目录',
    };
  }

  const themeCss = readText(path.join(outputDir, 'theme.generated.wxss')) || '';
  const flat = flattenNodes(draft.pages);
  const issues = [];

  // ---- 1/2/3/4/6：逐页结构与锚点 ----
  draft.pages.forEach((page, pageIndex) => {
    const pageId = page.pageId;
    const pagePath = '$.pages[' + pageIndex + ']';
    const wxmlFile = path.join(outputDir, 'pages', pageId, 'index.wxml');
    const wxssFile = path.join(outputDir, 'pages', pageId, 'index.wxss');
    const wxml = readText(wxmlFile);
    const wxss = readText(wxssFile);
    if (wxml === null) {
      checks.push(check('page:' + pageId, CHECK.FAIL, '产物缺少页面 WXML', { code: CODES.OUTPUT_UNREADABLE, path: pagePath, file: 'pages/' + pageId + '/index.wxml' }));
      issues.push({
        code: CODES.OUTPUT_UNREADABLE,
        path: pagePath,
        field: null,
        file: 'pages/' + pageId + '/index.wxml',
        message: '产物缺少页面 WXML',
        severity: 'error',
        source: 'observable',
      });
      return;
    }

    const entries = flat.filter((entry) => entry.pageIndex === pageIndex);
    const found = [];
    let cursor = 0;
    let orderBroken = null;
    let missing = null;
    for (const entry of entries) {
      const signature = nodeSignature(entry);
      if (!signature || !signature.value) continue;
      const at = wxml.indexOf(signature.value, cursor);
      if (at >= 0) {
        cursor = at + signature.value.length;
        found.push({ entry, signature, at });
        continue;
      }
      const anywhere = wxml.indexOf(signature.value);
      if (anywhere >= 0) {
        // 渲染出来了但顺序不对：先记录第一个顺序问题，后续仍继续扫（便于一次性定位）。
        if (!orderBroken) orderBroken = { entry, signature, at: anywhere };
      } else if (!missing) {
        missing = { entry, signature };
      }
    }

    if (entries.length === 0) {
      checks.push(check('blank:' + pageId, CHECK.FAIL, 'Draft 页面没有任何节点，生成结果必然是空白页', { code: CODES.BLANK_PAGE, path: pagePath, file: 'pages/' + pageId + '/index.wxml' }));
      issues.push({
        code: CODES.BLANK_PAGE,
        path: pagePath,
        field: null,
        file: 'pages/' + pageId + '/index.wxml',
        message: 'Draft 页面没有任何节点，生成结果必然是空白页',
        severity: 'error',
        source: 'observable',
      });
    } else if (missing) {
      checks.push(check('sections:' + pageId, CHECK.FAIL, '节点未在产物中渲染：' + missing.signature.kind, {
        code: missing.signature.kind,
        path: missing.entry.path,
        file: 'pages/' + pageId + '/index.wxml',
      }));
      issues.push({
        code: missing.signature.kind === CODES.SLOT_ANCHOR_MISSING ? CODES.SLOT_ANCHOR_MISSING : CODES.SECTION_MISSING,
        path: missing.entry.path,
        field: null,
        file: 'pages/' + pageId + '/index.wxml',
        message: '节点未在产物中渲染：' + missing.signature.kind,
        severity: 'error',
        source: 'observable',
      });
    } else if (orderBroken) {
      checks.push(check('sections:' + pageId, CHECK.FAIL, '节点顺序与 Draft 不一致', {
        code: CODES.SECTION_ORDER,
        path: orderBroken.entry.path,
        file: 'pages/' + pageId + '/index.wxml',
      }));
      issues.push({
        code: CODES.SECTION_ORDER,
        path: orderBroken.entry.path,
        field: null,
        file: 'pages/' + pageId + '/index.wxml',
        message: '节点顺序与 Draft 不一致',
        severity: 'error',
        source: 'observable',
      });
    } else {
      checks.push(check('sections:' + pageId, CHECK.PASS, entries.length + ' 个节点按 Draft 顺序渲染', { path: pagePath }));
    }

    // 空白页：有节点但一个签名都没渲染出来。
    if (entries.length > 0 && found.length === 0) {
      checks.push(check('blank:' + pageId, CHECK.FAIL, '页面已生成但没有任何可观察节点（空白页风险）', {
        code: CODES.BLANK_PAGE,
        path: pagePath,
        file: 'pages/' + pageId + '/index.wxml',
      }));
      issues.push({
        code: CODES.BLANK_PAGE,
        path: pagePath,
        field: null,
        file: 'pages/' + pageId + '/index.wxml',
        message: '页面已生成但没有任何可观察节点（空白页风险）',
        severity: 'error',
        source: 'observable',
      });
    }

    // ---- 插槽锚点：fallback 成对存在（缺锚点可定位到 slotId） ----
    for (const entry of entries) {
      if (!entry.node || entry.node.type !== 'slot') continue;
      const slotId = entry.node.slotId;
      const open = wxml.indexOf('@slot-fallback:' + slotId + ' -->') >= 0;
      const close = wxml.indexOf('@slot-fallback:' + slotId + ':end -->') >= 0;
      if (open && close) continue;
      checks.push(check('slot-anchor:' + pageId + ':' + slotId, CHECK.FAIL, '插槽 fallback 锚点不完整：' + slotId, {
        code: CODES.SLOT_ANCHOR_MISSING,
        path: entry.path + '.slotId',
        file: 'pages/' + pageId + '/index.wxml',
      }));
      issues.push({
        code: CODES.SLOT_ANCHOR_MISSING,
        path: entry.path + '.slotId',
        field: 'slotId',
        file: 'pages/' + pageId + '/index.wxml',
        message: '插槽 fallback 锚点不完整：' + slotId,
        severity: 'error',
        source: 'observable',
      });
    }

    // ---- 主题：Draft 用到的 token 必须落到真实 CSS 变量 ----
    const usedTokens = new Map();
    for (const entry of entries) {
      for (const used of themeTokensOf(entry)) {
        if (usedTokens.has(used.token)) continue;
        usedTokens.set(used.token, { entry, field: used.field });
      }
    }
    for (const [token, used] of usedTokens) {
      const cssVar = themeVarOf(token);
      if (!cssVar) {
        checks.push(check('theme:' + pageId + ':' + token, CHECK.FAIL, '未知主题 token：' + token, {
          code: CODES.THEME_VAR_MISSING,
          path: used.entry.path + '.style.' + used.field,
          file: 'pages/' + pageId + '/index.wxss',
        }));
        issues.push({
          code: CODES.THEME_VAR_MISSING,
          path: used.entry.path + '.style.' + used.field,
          field: 'style.' + used.field,
          file: 'pages/' + pageId + '/index.wxss',
          message: '未知主题 token：' + token,
          severity: 'error',
          source: 'observable',
        });
        continue;
      }
      const inPage = wxss !== null && wxss.includes('var(' + cssVar + ')');
      const defined = themeCss.includes(cssVar + ':');
      if (inPage && defined) continue;
      checks.push(check('theme:' + pageId + ':' + token, CHECK.FAIL, '主题变量未落地：' + cssVar, {
        code: CODES.THEME_VAR_MISSING,
        path: used.entry.path + '.style.' + used.field,
        file: 'pages/' + pageId + '/index.wxss',
      }));
      issues.push({
        code: CODES.THEME_VAR_MISSING,
        path: used.entry.path + '.style.' + used.field,
        field: 'style.' + used.field,
        file: 'pages/' + pageId + '/index.wxss',
        message: '主题变量未落地：' + cssVar,
        severity: 'error',
        source: 'observable',
      });
    }
    if (usedTokens.size > 0) {
      const failing = checks.filter((item) => item.id.startsWith('theme:' + pageId + ':') && item.status === CHECK.FAIL);
      if (failing.length === 0) {
        checks.push(check('theme:' + pageId, CHECK.PASS, usedTokens.size + ' 个主题 token 由 Base CSS 变量提供', { path: pagePath }));
      }
    }
  });

  // ---- 7. 密度：不做像素测量，如实标未检查 ----
  const density = opts.requirement && opts.requirement.visual ? opts.requirement.visual.density : undefined;
  if (density === 'compact' || density === 'comfortable') {
    checks.push(check('density', CHECK.NOT_CHECKED, '密度 ' + density + ' 属于视觉近似项：本链路不做像素测量，需真实运行截图人工确认', {
      code: CODES.DENSITY_NOT_MEASURED,
    }));
  } else {
    checks.push(check('density', CHECK.NOT_APPLICABLE, 'Draft/DSL 没有密度字段；不做像素级密度判断'));
  }

  // ---- 7b. 溢出：静态产物无法判定，如实标未检查 ----
  checks.push(check('overflow', CHECK.NOT_CHECKED, '溢出属于运行时视觉项：静态产物无法判定，本链路不做像素测量（不以百分比冒充结论）', {
    code: CODES.OVERFLOW_NOT_MEASURED,
  }));

  // ---- 8. 关键动作可点：只读微信运行报告，不伪造 ----
  const actions = flat
    .filter((entry) => entry.node && entry.node.type === 'button' && typeof entry.node.action === 'string')
    .map((entry) => ({ action: entry.node.action, path: entry.path }));
  const runtimeReport = opts.runtimeReport;
  const interactions = runtimeReport && Array.isArray(runtimeReport.interactions) ? runtimeReport.interactions : null;
  for (const flow of RUNTIME_FLOWS) {
    const used = actions.filter((entry) => entry.action === flow.action);
    if (used.length === 0) continue;
    if (!interactions) {
      checks.push(check('runtime-action:' + flow.action, CHECK.NOT_RUN, '微信运行时未执行，无法确认“' + flow.title + '”可点', {
        code: CODES.ACTION_CLICK_NOT_RUN,
        path: used[0].path,
      }));
      continue;
    }
    const matched = interactions.filter((item) => item && typeof item.label === 'string' && item.label.includes(flow.label));
    if (matched.length === 0) {
      checks.push(check('runtime-action:' + flow.action, CHECK.NOT_CHECKED, '本次微信报告没有“' + flow.title + '”链路结论（工具可能被阻塞），不冒充通过', {
        code: CODES.ACTION_CLICK_NOT_RUN,
        path: used[0].path,
      }));
      continue;
    }
    const failed = matched.find((item) => item.status !== 'PASS');
    if (failed) {
      const status = failed.status === 'FAIL' ? CHECK.FAIL : CHECK.NOT_CHECKED;
      const message = '关键动作未通过运行时验证：' + truncate(failed.detail || failed.status, MAX_CHECK_DETAIL);
      checks.push(check('runtime-action:' + flow.action, status, message, {
        code: CODES.ACTION_NOT_CLICKABLE,
        path: used[0].path + '.action',
      }));
      if (status === CHECK.FAIL) {
        issues.push({
          code: CODES.ACTION_NOT_CLICKABLE,
          path: used[0].path + '.action',
          field: 'action',
          file: null,
          message,
          severity: 'error',
          source: 'observable',
        });
      }
      continue;
    }
    checks.push(check('runtime-action:' + flow.action, CHECK.PASS, '真实点击链路通过：' + truncate(matched[0].detail || '', MAX_CHECK_DETAIL), {
      path: used[0].path,
    }));
  }

  const failedChecks = checks.filter((item) => item.status === CHECK.FAIL);
  const counts = {
    total: checks.length,
    pass: checks.filter((item) => item.status === CHECK.PASS).length,
    fail: failedChecks.length,
    notRun: checks.filter((item) => item.status === CHECK.NOT_RUN).length,
    notChecked: checks.filter((item) => item.status === CHECK.NOT_CHECKED).length,
    notApplicable: checks.filter((item) => item.status === CHECK.NOT_APPLICABLE).length,
  };
  const summary = '可观察项 ' + counts.total + ' 项：通过 ' + counts.pass
    + '，失败 ' + counts.fail
    + '，未执行 ' + counts.notRun
    + '，未测量 ' + counts.notChecked
    + '，不适用 ' + counts.notApplicable
    + '（不做像素百分比判断）';

  return { ok: failedChecks.length === 0, checks, issues, summary, counts };
}

module.exports = {
  CHECK,
  CODES,
  RUNTIME_FLOWS,
  flattenNodes,
  nodeSignature,
  compareObservable,
};
