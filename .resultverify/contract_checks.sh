#!/usr/bin/env bash
set -u -o pipefail

VERIFY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$VERIFY_DIR/.." && pwd)"
PASSED=0
FAILED=0

pass() {
  PASSED=$((PASSED + 1))
  echo "CHECK $1 $2: PASS"
}

fail() {
  FAILED=$((FAILED + 1))
  echo "CHECK $1 $2: FAIL — $3"
}

check_file() {
  local contract="$1"
  local clause="$2"
  local relative="$3"
  if [ -f "$ROOT_DIR/$relative" ]; then
    pass "$contract" "$clause"
  else
    fail "$contract" "$clause" "missing $relative"
  fi
}

check_regex() {
  local contract="$1"
  local clause="$2"
  local relative="$3"
  local pattern="$4"
  if [ ! -f "$ROOT_DIR/$relative" ]; then
    fail "$contract" "$clause" "missing $relative"
  elif grep -Eq -- "$pattern" "$ROOT_DIR/$relative"; then
    pass "$contract" "$clause"
  else
    fail "$contract" "$clause" "pattern not found in $relative: $pattern"
  fi
}

check_fixed() {
  local contract="$1"
  local clause="$2"
  local relative="$3"
  local expected="$4"
  if [ ! -f "$ROOT_DIR/$relative" ]; then
    fail "$contract" "$clause" "missing $relative"
  elif grep -Fq -- "$expected" "$ROOT_DIR/$relative"; then
    pass "$contract" "$clause"
  else
    fail "$contract" "$clause" "literal not found in $relative: $expected"
  fi
}

check_fixed_any() {
  local contract="$1"
  local clause="$2"
  local expected="$3"
  shift 3
  local relative
  for relative in "$@"; do
    if [ -f "$ROOT_DIR/$relative" ] && grep -Fq -- "$expected" "$ROOT_DIR/$relative"; then
      pass "$contract" "$clause"
      return 0
    fi
  done
  fail "$contract" "$clause" "literal not found in contracted providers: $expected"
}

# C-PREVIEW-STORE@1 / T1 write_set and public surface.
check_file C-PREVIEW-STORE@1 write-set-controller server/src/imports/preview-stores.controller.ts
check_file C-PREVIEW-STORE@1 write-set-service server/src/imports/preview-stores.service.ts
check_file C-PREVIEW-STORE@1 write-set-dto server/src/imports/preview-stores.dto.ts
check_file C-PREVIEW-STORE@1 write-set-module server/src/imports/imports.module.ts
check_regex C-PREVIEW-STORE@1 controller-class server/src/imports/preview-stores.controller.ts 'class[[:space:]]+PreviewStoresController([^A-Za-z0-9_]|$)'
check_regex C-PREVIEW-STORE@1 route server/src/imports/preview-stores.controller.ts '@Post\([[:space:]]*['"'"'"]preview-stores['"'"'"]'
check_fixed C-PREVIEW-STORE@1 session-auth server/src/imports/preview-stores.controller.ts SessionAuthGuard
check_regex C-PREVIEW-STORE@1 binding-key-property server/src/imports/preview-stores.dto.ts 'bindingKey[!?]?[[:space:]]*:'
check_fixed C-PREVIEW-STORE@1 binding-key-matches server/src/imports/preview-stores.dto.ts @Matches
check_fixed C-PREVIEW-STORE@1 binding-key-length server/src/imports/preview-stores.dto.ts @Length
check_regex C-PREVIEW-STORE@1 service-class server/src/imports/preview-stores.service.ts 'class[[:space:]]+PreviewStoresService([^A-Za-z0-9_]|$)'
check_fixed C-PREVIEW-STORE@1 deterministic-prefix server/src/imports/preview-stores.service.ts store-preview-
check_fixed C-PREVIEW-STORE@1 sha256 server/src/imports/preview-stores.service.ts sha256
check_fixed C-PREVIEW-STORE@1 owner-membership server/src/imports/preview-stores.service.ts Role.OWNER
check_fixed C-PREVIEW-STORE@1 conflict-code server/src/imports/preview-stores.service.ts PREVIEW_STORE_CONFLICT
check_fixed C-PREVIEW-STORE@1 module-controller server/src/imports/imports.module.ts PreviewStoresController
check_fixed C-PREVIEW-STORE@1 module-service server/src/imports/imports.module.ts PreviewStoresService

# C-PREVIEW-STORE@1 / T3 consumer write_set and exact frontend helper.
check_file C-PREVIEW-STORE@1 write-set-import-consumer src/services/importService.js
check_file C-PREVIEW-STORE@1 write-set-app-consumer src/App.jsx
check_regex C-PREVIEW-STORE@1 prepare-helper-export src/services/importService.js 'export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+prepareProjectPreview[[:space:]]*\('
check_fixed C-PREVIEW-STORE@1 preview-import-helper src/services/importService.js previewImport
check_fixed C-PREVIEW-STORE@1 apply-import-helper src/services/importService.js applyImport

# C-CANDIDATE-PLAN@1 / T2 write_set and bounded parameter chain symbols.
check_file C-CANDIDATE-PLAN@1 write-set-service src/services/frontendReconstruct/frontendReconstructService.js
check_file C-CANDIDATE-PLAN@1 write-set-ipc desktop/frontend-reconstruct-ipc.cjs
check_file C-CANDIDATE-PLAN@1 write-set-dry-run desktop/frontend-reconstruct/dry-run.cjs
check_regex C-CANDIDATE-PLAN@1 build-candidate-method src/services/frontendReconstruct/frontendReconstructService.js 'buildCandidate[[:space:]]*\('
check_regex C-CANDIDATE-PLAN@1 plan-key src/services/frontendReconstruct/frontendReconstructService.js '(^|[^A-Za-z0-9_])plan([^A-Za-z0-9_]|$)'
check_regex C-CANDIDATE-PLAN@1 store-id-key src/services/frontendReconstruct/frontendReconstructService.js '(^|[^A-Za-z0-9_])storeId([^A-Za-z0-9_]|$)'
check_regex C-CANDIDATE-PLAN@1 backend-versions-key src/services/frontendReconstruct/frontendReconstructService.js '(^|[^A-Za-z0-9_])backendVersions([^A-Za-z0-9_]|$)'
check_fixed C-CANDIDATE-PLAN@1 ipc-channel desktop/frontend-reconstruct-ipc.cjs frontend:build-candidate
check_fixed_any C-CANDIDATE-PLAN@1 payload-error-code FRONTEND_PAYLOAD_INVALID src/services/frontendReconstruct/frontendReconstructService.js desktop/frontend-reconstruct-ipc.cjs desktop/frontend-reconstruct/dry-run.cjs
check_fixed C-CANDIDATE-PLAN@1 resolve-candidate-plan desktop/frontend-reconstruct/dry-run.cjs resolveCandidatePlan
check_fixed C-CANDIDATE-PLAN@1 compose-call desktop/frontend-reconstruct/dry-run.cjs compose
check_fixed C-CANDIDATE-PLAN@1 legacy-default-plan desktop/frontend-reconstruct/dry-run.cjs DEFAULT_PLAN_FILE

# C-SIDEBAR-AUTOMATION@1 / T3 write_set and orchestration symbols.
check_file C-SIDEBAR-AUTOMATION@1 write-set-domain src/domain/frontendReconstruct.mjs
check_file C-SIDEBAR-AUTOMATION@1 write-set-attachments src/components/agent/AgentChatAttachments.jsx
check_file C-SIDEBAR-AUTOMATION@1 write-set-sidebar src/components/agent/AgentSidebarPanel.jsx
check_file C-SIDEBAR-AUTOMATION@1 write-set-styles src/styles/agent-sidebar.css
check_regex C-SIDEBAR-AUTOMATION@1 intent-helper-export src/domain/frontendReconstruct.mjs 'export[[:space:]]+function[[:space:]]+resolveFrontendGenerationIntent[[:space:]]*\('
check_fixed C-SIDEBAR-AUTOMATION@1 auto-request-action src/domain/frontendReconstruct.mjs FRONTEND_AUTO_REQUEST
check_fixed C-SIDEBAR-AUTOMATION@1 assistant-turn src/App.jsx runAppAssistantTurn
check_fixed C-SIDEBAR-AUTOMATION@1 preview-preparation src/App.jsx prepareProjectPreview
check_fixed C-SIDEBAR-AUTOMATION@1 candidate-build src/App.jsx buildCandidate
check_fixed C-SIDEBAR-AUTOMATION@1 candidate-verify src/App.jsx verifyCandidate
check_fixed C-SIDEBAR-AUTOMATION@1 store-info-phase src/App.jsx store-info
check_fixed C-SIDEBAR-AUTOMATION@1 panel-anchor src/App.jsx frontend-reconstruct-panel

# C-ADOPT-CONTINUE@1 / T3 candidate actions and destination.
check_file C-ADOPT-CONTINUE@1 write-set-panel src/components/screenRef/FrontendCandidatePanel.jsx
check_fixed C-ADOPT-CONTINUE@1 adopt-handler src/components/screenRef/FrontendCandidatePanel.jsx onAdopt
check_fixed C-ADOPT-CONTINUE@1 reset-handler src/components/screenRef/FrontendCandidatePanel.jsx onReset
check_fixed C-ADOPT-CONTINUE@1 adopt-button-id src/components/screenRef/FrontendCandidatePanel.jsx frontend-adopt-button
check_fixed C-ADOPT-CONTINUE@1 reset-button-id src/components/screenRef/FrontendCandidatePanel.jsx frontend-reset-button
check_fixed C-ADOPT-CONTINUE@1 adopt-button-copy src/components/screenRef/FrontendCandidatePanel.jsx 按这个骨架继续制作
check_fixed C-ADOPT-CONTINUE@1 reset-button-copy src/components/screenRef/FrontendCandidatePanel.jsx 修改要求并重新生成
check_fixed C-ADOPT-CONTINUE@1 prompt-studio-phase src/App.jsx prompt-studio

# Behavioral and data-integrity requirements intentionally are not grep-verified.
echo "NEEDS_DYNAMIC_VERIFICATION R1: 单图与明确文字先写回资料再启动同一轮候选；不明确时保留附件并追问；旧响应不得跨项目写入。"
echo "NEEDS_DYNAMIC_VERIFICATION R2: 当前项目 CompositionPlan、storeId、后端版本进入同一 attempt；非法 Plan/绑定 fail closed；证据保留 Plan 来源与摘要。"
echo "NEEDS_DYNAMIC_VERIFICATION R3: 相同绑定与 payload 幂等；不同绑定数据隔离；新 payload 仅更新当前门店并递增对应版本。"
echo "NEEDS_DYNAMIC_VERIFICATION R4: planned 自动构建、静态门禁和同 attempt 微信验证；needs-input/rejected 停止；BLOCKED/NOT_RUN/FAIL 不采用。"
echo "NEEDS_DYNAMIC_VERIFICATION R5: 采用绑定当前 candidate/run/attempt/digest；继续制作进入 prompt-studio 且不打开微信；重生成保留输入且不覆盖已采用版本。"
echo "NEEDS_DYNAMIC_VERIFICATION R6: 最终预览准备当前 adopted 数据后导出、写 AppID 并调起工具；请求打开与运行时 PASS 分开；失败步骤可见且不回退演示门店。"
echo "NEEDS_DYNAMIC_VERIFICATION C-PREVIEW-STORE@1: 201/409/422、事务与并发 OWNER 唯一性、sha256 入参、固定 ensure→preview→apply 顺序和 Idempotency-Key。"
echo "NEEDS_DYNAMIC_VERIFICATION C-CANDIDATE-PLAN@1: 256 KiB/键白名单/storeId/版本校验，显式非法 Plan 禁止回退，构建失败不进入微信验证，attempt 不互相覆盖。"
echo "NEEDS_DYNAMIC_VERIFICATION C-SIDEBAR-AUTOMATION@1: explicit/implicit/none 分类、revision/run 迟到响应拒绝、双击拒绝、失败后附件保留和重试不重复写字段。"
echo "NEEDS_DYNAMIC_VERIFICATION C-ADOPT-CONTINUE@1: 静态失败/runtime FAIL 禁止继续；BLOCKED/NOT_RUN 需 partial 确认；adopted 记录完整后才跳转；onReset 保留已采用快照。"
echo "NEEDS_DYNAMIC_VERIFICATION M1-M6: sidebar-m1-real-analysis.md 只证明两次真实分析 planned 与 DSL 结构差异，不证明 dry-run、Electron UIA 或微信运行时通过。"

echo "CHECKS: $PASSED passed, $FAILED failed"
if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
exit 0