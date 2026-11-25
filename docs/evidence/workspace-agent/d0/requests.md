# D0 请求 / 响应脱敏形状

> 配套报告：[`probe.md`](probe.md)
> 探针：`scripts/model-capability-probe.cjs`（`--compact` 输出 `.tmp/d0-probe/shapes-compact.json`）
> 本文件**只保留形状**：字段名、类型、长度、`finish_reason`、usage 计数、错误码。
> 不含密钥、完整 prompt、模型正文、图片 base64、用户隐私；上游错误消息里的 key 也是上游打码后的 `****xxxx`。
> 图例：`mt` = `max_tokens`；`content=N` = 正文字符数；`reasoning=N` = `reasoning_content` 字符数；`rf` = `response_format`；`choice` = `tool_choice`。`N/A` 表示该通道不返回该字段。

## 1. 关键 wire body 模板（真实请求去除正文后的形状）

### 1.1 HTTP 适配器：纯文本基线（`baseline:deepseek-chat`）

```json
{
  "keys": ["max_tokens", "messages", "model", "stream", "temperature"],
  "model": "deepseek-chat",
  "stream": false,
  "temperature": 0.2,
  "max_tokens": 100,
  "messages": [{ "role": "user", "content": { "kind": "string", "length": 24 } }]
}
```

> 调用方请求 `maxTokens=8`，适配器按 100 下限 clamp；上游响应 `model` 为 `deepseek-flash`（别名）。

### 1.2 HTTP 适配器：tools + tool_choice（`tools:deepseek-flash`）

```json
{
  "keys": ["max_tokens", "messages", "model", "stream", "temperature", "tool_choice", "tools"],
  "model": "deepseek-flash",
  "stream": false,
  "temperature": 0.2,
  "max_tokens": 200,
  "tool_choice": "auto",
  "tools": {
    "count": 1,
    "types": ["function"],
    "names": ["probe_echo"],
    "parameterKeyCounts": [1]
  },
  "messages": [
    { "role": "system", "content": { "kind": "string", "length": 69 } },
    { "role": "user", "content": { "kind": "string", "length": 62 } }
  ]
}
```

### 1.3 HTTP 适配器：多轮工具循环第二轮（`tool-loop:deepseek-flash`）

```json
{
  "keys": ["max_tokens", "messages", "model", "stream", "temperature", "tool_choice", "tools"],
  "model": "deepseek-flash",
  "max_tokens": 100,
  "tool_choice": "auto",
  "messages": [
    { "role": "system", "content": { "kind": "string", "length": 27 } },
    { "role": "user", "content": { "kind": "string", "length": 62 } },
    { "role": "assistant", "content": { "kind": "null" }, "tool_calls": { "count": 1, "idsPresent": true } },
    { "role": "tool", "content": { "kind": "string", "length": 25 }, "tool_call_id": { "present": true } },
    { "role": "user", "content": { "kind": "string", "length": 29 } }
  ]
}
```

### 1.4 多模态 content parts（`multimodal-adapter:routing`）

```json
{
  "keys": ["max_tokens", "messages", "model", "stream", "temperature"],
  "model": "deepseek-flash",
  "max_tokens": 100,
  "messages": [{
    "role": "user",
    "content": {
      "kind": "parts",
      "count": 2,
      "parts": [
        { "type": "text", "textLength": 70 },
        { "type": "image_url", "url": { "scheme": "data:image/png;base64,", "length": 206 }, "detail": null }
      ]
    }
  }]
}
```

> 图片是脚本内生成的 64×64 纯红 PNG（136 B → data URL 206 字符）；base64 本体不落盘。调用方基础模型是 `deepseek-chat`，适配器因带图自动切到 `deepseek-flash`。

### 1.5 tools + response_format 同时发送（`tools+response_format:deepseek-flash`）

```json
{
  "keys": ["max_tokens", "messages", "model", "response_format", "stream", "temperature", "tool_choice", "tools"],
  "model": "deepseek-flash",
  "max_tokens": 300,
  "response_format": "json_object",
  "tool_choice": "auto",
  "tools": { "count": 1, "names": ["probe_echo"] }
}
```

> 实测 HTTP 200 + `tool_calls`，未出现 400；`response_format` 没有把带 tools 的响应强制成 JSON 正文。

### 1.6 直连 `modelChat`（`direct:tools`）

```json
{
  "keys": ["max_tokens", "messages", "model", "stream", "temperature", "thinking", "tool_choice", "tools"],
  "model": "deepseek-chat",
  "stream": false,
  "max_tokens": 200,
  "temperature": 0.2,
  "thinking": "disabled",
  "tool_choice": "auto",
  "tools": { "count": 1, "names": ["probe_echo"] }
}
```

> 直连始终显式带 `thinking:{type:"disabled"}`；传入 `response_format` / `reasoning_effort` 也不会出现在 wire（`direct:response_format_dropped`）。

## 2. 46 条用例：请求形状与结果（本次真实执行，2026-11-24T08:43Z）

| case | 通道 | 请求（脱敏） | 结果（脱敏） | ms |
| --- | --- | --- | --- | ---: |
| `baseline:deepseek-chat` | http-server-adapter | deepseek-chat mt=100 tools=0 | ok / finish=stop / truncated=false / content=4 | 1025 |
| `baseline:deepseek-flash` | http-server-adapter | deepseek-flash mt=100 tools=0 | ok / finish=stop / truncated=false / content=4 | 690 |
| `model-naming:deepseek-v4.1-flash` | http-server-adapter-wire | deepseek-v4.1-flash mt=4 tools=0 | HTTP 400 / error=invalid_request_error | 180 |
| `model-naming:cn:deepseek-v4.1-flash` | http-server-adapter-wire | cn:deepseek-v4.1-flash mt=4 tools=0 | HTTP 400 / error=invalid_request_error | 94 |
| `tools:deepseek-chat` | http-server-adapter | deepseek-chat mt=200 tools=1 choice=auto | ok / finish=tool_calls / truncated=false / content=undefined / tool_calls=1 | 930 |
| `tool-loop:deepseek-chat` | http-server-adapter | deepseek-chat mt=100 tools=1 choice=auto | ok / finish=stop / truncated=false / content=4 | 514 |
| `tools:deepseek-flash` | http-server-adapter | deepseek-flash mt=200 tools=1 choice=auto | ok / finish=tool_calls / truncated=false / content=undefined / tool_calls=1 | 809 |
| `tool-loop:deepseek-flash` | http-server-adapter | deepseek-flash mt=100 tools=1 choice=auto | ok / finish=stop / truncated=false / content=4 | 454 |
| `multimodal-raw:deepseek-chat` | http-server-adapter-wire | deepseek-chat mt=30 tools=0 | HTTP 200 / finish=stop / content=3 | 432 |
| `multimodal-raw:deepseek-flash` | http-server-adapter-wire | deepseek-flash mt=30 tools=0 | HTTP 200 / finish=length / content=0 / reasoning=120 | 506 |
| `multimodal-answer:deepseek-chat` | http-server-adapter-wire | deepseek-chat mt=800 tools=0 | HTTP 200 / finish=stop / content=3 | 888 |
| `multimodal-answer:deepseek-flash` | http-server-adapter-wire | deepseek-flash mt=800 tools=0 | HTTP 200 / finish=stop / content=3 / reasoning=124 | 592 |
| `multimodal-adapter:routing` | http-server-adapter | deepseek-flash mt=100 tools=0 | ok / finish=stop / truncated=false / content=3 | 791 |
| `multimodal-adapter:vision-model` | http-server-adapter | deepseek-flash mt=300 tools=0 | ok / finish=stop / truncated=false / content=3 | 1108 |
| `multimodal-direct:config-model` | direct-main-modelChat | deepseek-chat mt=300 tools=0 thinking=disabled | ok / finish=- / content=3 / tool_calls=0 / finishReasonMissing | 858 |
| `vision-budget:raw_100` | http-server-adapter-wire | deepseek-flash mt=100 tools=0 | HTTP 200 / finish=length / content=0 / reasoning=467 | 1737 |
| `vision-budget:adapter_100` | http-server-adapter | deepseek-flash mt=100 tools=0 | ERR DEEPSEEK_RESPONSE_INVALID | 1256 |
| `vision-budget:adapter_2000` | http-server-adapter | deepseek-flash mt=2000 tools=0 | ok / finish=stop / truncated=false / content=3294 | 18047 |
| `tools+response_format:deepseek-chat` | http-server-adapter | deepseek-chat mt=300 tools=1 choice=auto rf=json_object | ok / finish=tool_calls / truncated=false / content=undefined / tool_calls=1 | 1506 |
| `response_format:deepseek-chat` | http-server-adapter | deepseek-chat mt=100 tools=0 rf=json_object | ok / finish=stop / truncated=false / content=24 | 588 |
| `tools+response_format:deepseek-flash` | http-server-adapter | deepseek-flash mt=300 tools=1 choice=auto rf=json_object | ok / finish=tool_calls / truncated=false / content=undefined / tool_calls=1 | 835 |
| `response_format:deepseek-flash` | http-server-adapter | deepseek-flash mt=100 tools=0 rf=json_object | ok / finish=stop / truncated=false / content=11 | 599 |
| `truncation:max_tokens_16` | http-server-adapter | deepseek-chat mt=100 tools=0 | ok / finish=length / truncated=true / content=423 | 1182 |
| `max-output:adapter_8000` | http-server-adapter | deepseek-chat mt=8000 tools=0 | ok / finish=stop / truncated=false / content=32 | 824 |
| `max-output:raw_8192:deepseek-chat` | http-server-adapter-wire | deepseek-chat mt=8192 tools=0 | HTTP 200 / finish=stop / content=32 | 614 |
| `max-output:raw_8192:deepseek-flash` | http-server-adapter-wire | deepseek-flash mt=8192 tools=0 | HTTP 200 / finish=stop / content=3 / reasoning=69 | 486 |
| `max-output:raw_16384:deepseek-chat` | http-server-adapter-wire | deepseek-chat mt=16384 tools=0 | HTTP 200 / finish=stop / content=32 | 692 |
| `max-output:raw_32768:deepseek-flash` | http-server-adapter-wire | deepseek-flash mt=32768 tools=0 | HTTP 200 / finish=stop / content=38 / reasoning=72 | 1001 |
| `max-output:raw_65536:deepseek-flash` | http-server-adapter-wire | deepseek-flash mt=65536 tools=0 | HTTP 200 / finish=stop / content=29 / reasoning=67 | 833 |
| `max-output:raw_131072:deepseek-flash` | http-server-adapter-wire | deepseek-flash mt=131072 tools=0 | HTTP 200 / finish=stop / content=40 / reasoning=0 | 566 |
| `max-output:raw_262144:deepseek-flash` | http-server-adapter-wire | deepseek-flash mt=262144 tools=0 | HTTP 200 / finish=stop / content=6 / reasoning=61 | 530 |
| `error:invalid_model` | http-server-adapter | deepseek-model-does-not-exist mt=100 tools=0 | ERR DEEPSEEK_REQUEST_REJECTED / status=400 | 76 |
| `error:invalid_key` | http-server-adapter | deepseek-chat mt=100 tools=0 | ERR DEEPSEEK_AUTH_FAILED / status=401 | 84 |
| `timeout:local_1ms` | http-server-adapter | deepseek-chat mt=100 tools=0 | ERR DEEPSEEK_TIMEOUT | 2 |
| `error:invalid_key_raw` | http-server-adapter-wire | deepseek-chat mt=4 tools=0 | HTTP 401 / error=invalid_request_error | 175 |
| `direct:baseline` | direct-main-modelChat | deepseek-chat mt=8 tools=0 thinking=disabled | ok / finish=- / content=4 / tool_calls=0 / finishReasonMissing | 798 |
| `direct:tools` | direct-main-modelChat | deepseek-chat mt=200 tools=1 choice=auto thinking=disabled | ok / finish=- / content=0 / tool_calls=1 / finishReasonMissing | 702 |
| `direct:tool-loop` | direct-main-modelChat | deepseek-chat mt=100 tools=1 choice=auto thinking=disabled | ok / finish=- / content=4 / tool_calls=0 / finishReasonMissing | 885 |
| `direct:response_format_dropped` | direct-main-modelChat | deepseek-chat mt=40 tools=0 thinking=disabled | ok / finish=- / content=11 / tool_calls=0 / finishReasonMissing | 451 |
| `direct:truncation` | direct-main-modelChat | deepseek-chat mt=20 tools=0 thinking=disabled | ok / finish=- / content=74 / tool_calls=0 / finishReasonMissing | 975 |
| `stability:tools-flash:1` | http-server-adapter | deepseek-flash mt=200 tools=1 choice=auto | ok / finish=tool_calls / truncated=false / content=undefined / tool_calls=1 | 784 |
| `stability:tools-flash:2` | http-server-adapter | deepseek-flash mt=200 tools=1 choice=auto | ok / finish=tool_calls / truncated=false / content=undefined / tool_calls=1 | 624 |
| `stability:tools-flash:3` | http-server-adapter | deepseek-flash mt=200 tools=1 choice=auto | ok / finish=tool_calls / truncated=false / content=undefined / tool_calls=1 | 903 |
| `stability:image-adapter:1` | http-server-adapter | deepseek-flash mt=100 tools=0 | ok / finish=stop / truncated=false / content=3 | 1656 |
| `stability:image-adapter:2` | http-server-adapter | deepseek-flash mt=100 tools=0 | ok / finish=stop / truncated=false / content=3 | 1247 |
| `stability:image-adapter:3` | http-server-adapter | deepseek-flash mt=100 tools=0 | ERR DEEPSEEK_RESPONSE_INVALID | 1316 |

> `content=undefined` 出现在“只有 tool_calls、正文为 null”的适配器结果中（`content.kind=null`），不是文案缺失。

## 3. 决定性用例的响应细节

| case | 响应形状 |
| --- | --- |
| `tools:deepseek-flash` | `{finishReason:"tool_calls", truncated:false, content:null, toolCalls:{count:1,names:["probe_echo"],argumentsParseOk:[true],argumentsLengths:[14]}, usage:{promptTokens:350,completionTokens:105,totalTokens:455}}` |
| `tool-loop:deepseek-flash` | `{finishReason:"stop", truncated:false, content:{kind:"string",length:4}, toolCalls:null, usage:{promptTokens:409,completionTokens:2,totalTokens:411}}` |
| `multimodal-answer:deepseek-flash` | `{status:200, finish_reason:"stop", content:{kind:"string",length:3}, reasoning:{present:true,length:124}, usage:{prompt_tokens:231,completion_tokens:30,total_tokens:261}, derived:{answerIsRed:true}}` |
| `multimodal-answer:deepseek-chat` | `{status:200, finish_reason:"stop", content:{kind:"string",length:3}, reasoning:{present:false}, usage:{prompt_tokens:205,completion_tokens:1,total_tokens:206}, derived:{answerIsRed:true}}` |
| `multimodal-raw:deepseek-flash` | `{status:200, finish_reason:"length", content:{kind:"string",length:0}, reasoning:{present:true,length:120}, usage:{prompt_tokens:225,completion_tokens:30,total_tokens:255}}` |
| `vision-budget:raw_100` | `{status:200, finish_reason:"length", content:{kind:"string",length:0}, reasoning:{present:true,length:467}, usage:{prompt_tokens:228,completion_tokens:100,total_tokens:328}}` |
| `vision-budget:adapter_100` | `AgentModelError{code:"DEEPSEEK_RESPONSE_INVALID", status:null, retryable:true}`（空正文 + length 在适配器内先被当作非法响应） |
| `vision-budget:adapter_2000` | `{finishReason:"stop", truncated:false, content:{kind:"string",length:3294}, usage:{promptTokens:228,completionTokens:1894,totalTokens:2122}}` |
| `truncation:max_tokens_16` | `{finishReason:"length", truncated:true, content:{kind:"string",length:423}, usage:{promptTokens:14,completionTokens:100,totalTokens:114}}`（请求 16 被 clamp 到 100） |
| `max-output:adapter_8000` | `{finishReason:"stop", content:{kind:"string",length:32}}`（`max_tokens=8000` 被接受） |
| `max-output:raw_262144:deepseek-flash` | `{status:200, finish_reason:"stop", content:{kind:"string",length:6}, reasoning:{present:true,length:61}, usage:{prompt_tokens:33,completion_tokens:23,total_tokens:56}}` |
| `direct:baseline` | `{keys:["content","model","toolCalls","usage"], model:"deepseek-flash", content:{kind:"string",length:4}, toolCalls:{count:0}, usage:{promptTokens:10,completionTokens:2}, finishReasonPresent:false, truncatedPresent:false}` |
| `direct:tools` | `{keys:["content","model","toolCalls","usage"], model:"deepseek-flash", content:{kind:"string",length:0}, toolCalls:{count:1,names:["probe_echo"],argumentsParseOk:[true],argumentsLengths:[14],idsPresent:true}, usage:{promptTokens:325,completionTokens:39}, finishReasonPresent:false, truncatedPresent:false}` |
| `direct:truncation` | `{keys:["content","model","toolCalls","usage"], content:{kind:"string",length:74}, usage:{promptTokens:14,completionTokens:20}, finishReasonPresent:false, truncatedPresent:false}` |

## 4. 错误体（真实上游，已脱敏）

### 4.1 400 未知模型（`model-naming:deepseek-v4.1-flash`）

```json
{
  "status": 400,
  "bodyBytes": 252,
  "keys": ["error"],
  "error": {
    "keys": ["code", "message", "param", "type"],
    "code": "invalid_request_error",
    "type": "invalid_request_error",
    "param": null,
    "messageLength": 153,
    "messagePreview": "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash. (request_id: …)"
  }
}
```

### 4.2 401 无效密钥（`error:invalid_key_raw`）

```json
{
  "status": 401,
  "bodyBytes": 204,
  "error": {
    "keys": ["code", "message", "param", "type"],
    "code": "invalid_request_error",
    "type": "authentication_error",
    "param": null,
    "messageLength": 106,
    "messagePreview": "Authentication Fails, Your api key: ****0000 is invalid (request_id: …)"
  }
}
```

> `****0000` 是上游对“探针故意使用的无效 key”的打码，不是真实密钥。

### 4.3 成功响应顶层键

`["choices","created","id","model","object","system_fingerprint","usage"]`；`choices[0].message` 的键为 `["content","role"]` 或（推理模型）`["content","reasoning_content","role"]`；usage 键包含 `prompt_tokens/completion_tokens/total_tokens`，推理模型另有 `completion_tokens_details`、`prompt_tokens_details`、`prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`。

## 5. 直连通道的静态边界（真实 `normalizeChatPayload` 调用，无 HTTP）

| 输入 | 结果 |
| --- | --- |
| `maxTokens=8000` + `response_format` + `reasoning_effort` | 实际 body `max_tokens=1200`；body keys `[max_tokens,messages,model,stream,temperature,thinking]`；`response_format` 不存在；`reasoning_effort` 不存在；`thinking={type:"disabled"}` |
| 9 个 tools | 抛 `MODEL_REQUEST_INVALID`（“工具数量超过上限。”） |
| `image_url` 用 `https://…` 外链 | 抛 `MODEL_REQUEST_INVALID`（“图片只接受内联 JPEG/PNG/WebP 的 data URL。”） |
| 内联 64×64 PNG（136 B / data URL 206 字符） | 接受；parts `["text","image_url"]` |

## 6. 本地代理（BLOCKED，无透传结论）

```json
{
  "targets": [
    { "host": "127.0.0.1", "port": 17863,
      "connectivity": { "connected": false, "error": { "code": "ECONNREFUSED", "message": "connect ECONNREFUSED 127.0.0.1:17863" } },
      "httpModels": { "error": { "name": "TypeError", "code": "ECONNREFUSED", "message": "fetch failed" } } },
    { "host": "192.168.222.1", "port": 17863,
      "connectivity": { "connected": false, "error": { "code": "ETIMEDOUT" } } }
  ]
}
```

> 没有一次经过代理的请求，因此“代理是否原样透传 tools / tool_choice / response_format / finish_reason”一律 **BLOCKED**，不得引用为 PASS/FAIL。

## 7. `/models` 旁证（不用于推断能力）

`GET /models` → 200，`modelIds=["deepseek-flash","deepseek-v4-pro"]`。`deepseek-chat` 未列出但被接受（别名，响应 model 为 `deepseek-flash`）。能力结论全部来自 `/chat/completions` 真实调用，见 §2/§3。
