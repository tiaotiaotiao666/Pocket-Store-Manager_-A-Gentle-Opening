'use strict';

/**
 * R 组：真实 Flash 一轮（R01–R07）——只在 E0-R1/R2 落地后执行。
 *
 * 依据：计划 §4 E0-V1「另外执行真实 Flash」+ rev15 §14.7/§14.8 + D0 结论（§12.1）。
 * 铁律：真实模型的证据必须可复核（输入图 sha256、实际响应 model、工具 trace、treeDigest、截断/重试）；
 * 环境不可用（Key/网络/微信/CLI）就写 BLOCKED/NOT_RUN，绝不把 mock 当真实。
 */

const RUNTIME_REQUIRES = ['run-coordinator', 'model-call-scheduler', 'agent-runtime'];

const CASES = [
  {
    id: 'R01',
    group: 'R 真实 Flash（需 E0-R1/R2）',
    title: '真实小参考图经 assetId 解析为受控资产（mime/字节/sha256 可复核）',
    x: ['X2'],
    requires: RUNTIME_REQUIRES,
    basis: 'rev15 §14.8-1/2/3',
    expected: 'resolveAssetImage({userDataDir,projectId,assetId}) 只接受 assetId；返回 {assetId,mime,bytes,sha256,dataUrl}；'
      + 'sha256 与原始输入图一致；symlink/junction/越界 → 拒绝',
    reason: 'resolveAssetImage 未落地（t7 E0-R2）',
  },
  {
    id: 'R02',
    group: 'R 真实 Flash（需 E0-R1/R2）',
    title: '多模态消息含真实 image_url data URL（顺序稳定、仅内存）',
    x: ['X2'],
    requires: RUNTIME_REQUIRES,
    basis: 'rev15 §14.8 / §14.8-4',
    expected: 'buildMultimodalContent 产出 [{type:"text"},{type:"image_url",image_url:{url:"data:image/…"}}]；'
      + '不带 base64 进入 attempt.json/run.json/项目快照/trace/日志（跑完对落盘文件全量扫描断言）',
    reason: 'buildMultimodalContent 未落地（t7）',
  },
  {
    id: 'R03',
    group: 'R 真实 Flash（需 E0-R1/R2）',
    title: '回答依赖图像内容（仅 assetId 文本时不得“看懂图”）',
    x: ['X2'],
    requires: RUNTIME_REQUIRES,
    basis: 'rev15 §14.8-6',
    expected: '带图提问主色/元素能被正确回答；同一提示不带图或只给 assetId 文本时不得产生同样结论 → 证明多模态真实',
    reason: '需要真实模型调用 + 视觉资产（t7 验收）',
  },
  {
    id: 'R04',
    group: 'R 真实 Flash（需 E0-R1/R2）',
    title: '真实模型调用工具写出 menu 源码（工具 trace 可复核）',
    x: ['X1', 'X8'],
    requires: RUNTIME_REQUIRES,
    basis: 'rev15 §14.3/§14.7',
    expected: '工具名只出现 11 个模型可见工具；write_files 真实落 attempt/candidate；trace 只含工具标签与相对路径；'
      + 'revision/treeDigest 记录在案',
    reason: 'direct 工具循环未落地（t6 E0-R1）',
  },
  {
    id: 'R05',
    group: 'R 真实 Flash（需 E0-R1/R2）',
    title: '读取检查结果并修复一次（issue→repair 闭环）',
    x: ['X4', 'X7'],
    requires: RUNTIME_REQUIRES,
    basis: '计划 §4 E0-V1 真实 Flash 第 2 条',
    expected: '模型读 source.check / composer.dry-run 的 issues 后进行一次定向修复；修复前后 treeDigest 与 issue 集合可追溯；'
      + '修复走新 revision（或新 attempt），不覆盖已提交候选',
    reason: '需要检查回灌链路（t5）+ direct runtime（t6）',
  },
  {
    id: 'R06',
    group: 'R 真实 Flash（需 E0-R1/R2）',
    title: '截断与重试如实记录：finish=length 时不回放工具',
    x: ['X8'],
    requires: RUNTIME_REQUIRES,
    basis: 'rev15 §14.7 / D0 D-RT-1',
    expected: '空正文 + finish_reason=length 记为 truncated；truncated 时本批 tool_calls 不执行、返回 output_truncated；'
      + '重试次数/原因入证据；不把截断内容当完整源码写入工作树',
    reason: '需要 requestChat 返回 finishReason/truncated（t6）',
  },
  {
    id: 'R07',
    group: 'R 真实 Flash（需 E0-R1/R2）',
    title: '微信/UIA 不可用时如实 BLOCKED，不得称微信通过',
    x: ['X10'],
    requires: ['run-coordinator'],
    basis: '计划 §4 E0 通过条件 + rev15 §14.11',
    expected: 'wechat.verify 工具缺失/CLI EPERM → status=BLOCKED 且行为 partial，不阻止 direct 工具闭环判定；'
      + '报告中不得把 React 预览截图当微信运行时截图',
    reason: 'A0/E0-Git 已实测微信 CLI 写 AppData EPERM（环境 BLOCKED）；待具备可 spawn 环境再跑',
  },
];

module.exports = { CASES };
