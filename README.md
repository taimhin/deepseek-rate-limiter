# DeepSeek API 限流器

一個用 TypeScript 寫成的 **DeepSeek API 限流器 + 代理伺服器**，同時提供可重用的函式庫。它會把請求排隊，按 RPM、TPM、並行數與每日配額放行，遇到 429 自動退避重試，讓你的程式不會再把限流錯誤直接丟給使用者。

- 兩種用法：**OpenAI 相容代理**（改一個 `baseURL` 就能用）或 **程式內函式庫**（`DeepSeekClient` / `DeepSeekLimiter`）
- 無需修改原本的 OpenAI SDK 程式碼
- 有測試（42 個）、TypeScript 嚴格模式、GitHub Actions CI、Docker 支援

```
你的程式 / OpenAI SDK
        │  POST /v1/chat/completions
        ▼
┌──────────────────────────────────────────┐
│  Proxy（Express）                         │
│  驗證 → 估算 tokens → FIFO 排隊           │
│  RPM bucket  TPM bucket  並行數  每日配額  │
└──────────────────┬───────────────────────┘
                   │ 429 / 5xx 自動重試 + Retry-After
                   ▼
          https://api.deepseek.com
```

---

## 功能

| 功能 | 說明 |
| --- | --- |
| RPM 限流 | Token bucket，連續補充，避免固定視窗邊界爆量 |
| TPM 限流 | 先以 prompt + 保留 completion tokens 預扣，回應後用真實 `usage.total_tokens` 結算 |
| 並行限制 | 同時最多 N 個 in-flight 請求 |
| FIFO 排隊 | 佇列、排隊逾時、佇列上限；容量不足時等待而不是立刻失敗 |
| 429 自動重試 | 指數退避 + jitter，遵守 `Retry-After`；429 時全域冷卻，暫停所有請求 |
| 每日配額 | 每日 token / request 上限，可設定時區偏移的換日時間 |
| 串流支援 | SSE 原樣轉發，並從最後一個 chunk 取得 usage 結算 |
| 監控 | `/stats` JSON、`/metrics` Prometheus 格式、`/healthz` |
| 安全 | API key 只留在伺服器；可選 `PROXY_API_KEY` 保護代理；預設只綁 `127.0.0.1` |

---

## 快速開始

需求：**Node.js >= 20.3**（用到 `AbortSignal.any`）。

```bash
git clone <your-repo-url> deepseek-rate-limiter
cd deepseek-rate-limiter
npm install

cp .env.example .env
# 編輯 .env，填入 DEEPSEEK_API_KEY

npm run dev
```

預設監聽 `http://127.0.0.1:8787`：

```bash
curl http://127.0.0.1:8787/healthz
# {"status":"ok","uptimeSeconds":1,"active":0,"queued":0}
```

> 第一次啟動前，你也可以用 `DEEPSEEK_API_KEY=sk-... npm run dev` 直接帶入金鑰。

---

## 當作代理使用

代理只負責限流與轉發，DeepSeek 金鑰放在伺服器端。客戶端只需要把 OpenAI SDK 的 `baseURL` 指向代理：

### OpenAI JavaScript SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  // 若 .env 設了 PROXY_API_KEY，這裡填代理金鑰；否則填任意非空字串
  apiKey: process.env.PROXY_API_KEY ?? "not-needed",
});

const completion = await client.chat.completions.create({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "用一句話介紹澳門" }],
});
console.log(completion.choices[0]?.message.content);
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="not-needed",  # 或你的 PROXY_API_KEY
)

resp = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "用一句話介紹澳門"}],
)
print(resp.choices[0].message.content)
```

### curl（含串流）

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $PROXY_API_KEY" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Explain token buckets"}],
    "stream": true
  }'
```

常見的「OpenAI 相容」工具（Continue、Cline、LangChain、LiteLLM 等）也可以直接填：

```
Base URL: http://127.0.0.1:8787/v1
API Key:  <PROXY_API_KEY 或任意非空字串>
Model:    deepseek-chat / deepseek-reasoner
```

---

## 當作函式庫使用

不想跑代理，也可以直接在程式裡排隊與限流：

```ts
import { DeepSeekClient } from "deepseek-rate-limiter";

const client = new DeepSeekClient({
  apiKey: process.env.DEEPSEEK_API_KEY!,
  limiterOptions: {
    requestsPerMinute: 60,
    tokensPerMinute: 60_000,
    maxConcurrency: 4,
    dailyTokenQuota: 2_000_000,
    queueTimeoutMs: 120_000,
  },
  maxRetries: 3,
});

const response = await client.chat({
  model: "deepseek-chat",
  messages: [{ role: "user", content: "Hello" }],
});

console.log(response.choices?.[0]?.message?.content);
console.log(client.limiter.snapshot().daily);
```

串流：

```ts
for await (const chunk of client.chatStream({
  model: "deepseek-reasoner",
  messages: [{ role: "user", content: "Explain token buckets" }],
})) {
  process.stdout.write(chunk.choices?.[0]?.delta?.content ?? "");
}
```

完整範例在 [`examples/library.ts`](examples/library.ts) 與 [`examples/stream.ts`](examples/stream.ts)。

只想要限流器、自己控制 HTTP 請求：

```ts
import { DeepSeekLimiter } from "deepseek-rate-limiter";

const limiter = new DeepSeekLimiter({
  requestsPerMinute: 60,
  tokensPerMinute: 60_000,
  maxConcurrency: 8,
});

const lease = await limiter.acquire(estimatedTokens);
try {
  const res = await fetch("https://api.deepseek.com/chat/completions", { /* ... */ });
  const json = await res.json();
  lease.settle(json.usage?.total_tokens); // 用真實用量校正
} finally {
  lease.release();
}
```

---

## 運作原理

### 1. Token bucket（RPM / TPM）

每分鐘額度換算成「每毫秒補充多少 token」，桶子持續補充，不用傳統的固定時間視窗。這樣不會出現「視窗最後一秒塞 60 個請求、下一秒再塞 60 個」的邊界爆量。

`DEEPSEEK_BURST_MULTIPLIER` 可以額外放大桶子容量（例如設 `2` 表示一開始最多可累積兩分鐘的額度）。

### 2. 預扣 + 結算

TPM 無法在送出請求前知道實際花費，所以：

1. 用內建的估算器算 prompt tokens（CJK 約 1 字 1 token、ASCII 約 4 字 1 token）
2. 加上 `max_tokens`（沒設定時用 `DEEPSEEK_EXPECTED_COMPLETION_TOKENS`）作為保留額度
3. 請求完成後，用 DeepSeek 回傳的 `usage.total_tokens` 結算：
   - 實際 < 保留 → 退還額度
   - 實際 > 保留 → 桶子進入負值（debt），之後補充時先償還

串流請求會自動加上 `stream_options.include_usage: true`，取得最後的 usage chunk。

### 3. 排隊與 429

- 請求按 FIFO 排隊，佇列頭部必須同時符合「並行數 / RPM / TPM / 每日配額」才會放行。
- 等太久 → `429`（`QUEUE_TIMEOUT`）；佇列滿 → `429`（`QUEUE_FULL`）；每日額度用完 → `429`（`DAILY_QUOTA_EXCEEDED`）。
- 上游回 429 時，代理會依 `Retry-After` 或指數退避設定**全域冷卻**，讓所有請求一起暫停，而不是各自重試轟炸 API。
- 5xx / 網路錯誤同樣會重試，次數由 `DEEPSEEK_MAX_RETRIES` 控制。

---

## 設定

複製 `.env.example` 為 `.env`。所有變數都有預設值，除了 `DEEPSEEK_API_KEY`。

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | **必填** | DeepSeek API 金鑰，只留在伺服器 |
| `HOST` | `127.0.0.1` | 監聽位址；Docker 內設 `0.0.0.0` |
| `PORT` | `8787` | 監聽埠 |
| `PROXY_API_KEY` | 空 | 設定後，客戶端必須帶 `Authorization: Bearer <key>` 或 `x-api-key` |
| `CORS_ORIGIN` | 空 | 允許的 CORS 來源，空白表示關閉 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 上游 API 位址 |
| `REQUEST_TIMEOUT_MS` | `600000` | 單次上游請求逾時（10 分鐘，顧及長 reasoning） |
| `DEEPSEEK_RPM` | `60` | 每分鐘請求數 |
| `DEEPSEEK_TPM` | `60000` | 每分鐘 token 數（prompt + 保留 completion） |
| `DEEPSEEK_MAX_CONCURRENCY` | `8` | 同時進行中的上游請求上限 |
| `DEEPSEEK_BURST_MULTIPLIER` | `1` | 桶子容量倍數（1 = 一分鐘額度） |
| `DEEPSEEK_MAX_QUEUE_SIZE` | `200` | 最多等待中的請求數；`0` = 不排隊 |
| `DEEPSEEK_QUEUE_TIMEOUT_MS` | `120000` | 最長等待時間；`0` = 不限 |
| `DEEPSEEK_DAILY_TOKEN_QUOTA` | `0` | 每日 token 上限；`0` = 關閉 |
| `DEEPSEEK_DAILY_REQUEST_QUOTA` | `0` | 每日請求上限；`0` = 關閉 |
| `DEEPSEEK_UTC_OFFSET_MINUTES` | `0` | 每日配額換日時區偏移，`480` = UTC+8 |
| `DEEPSEEK_MAX_RETRIES` | `3` | 首次嘗試後的重試次數 |
| `DEEPSEEK_RETRY_BASE_MS` | `500` | 退避基準延遲 |
| `DEEPSEEK_RETRY_MAX_MS` | `30000` | 退避最大延遲 |
| `DEEPSEEK_EXPECTED_COMPLETION_TOKENS` | `512` | 未設定 `max_tokens` 時保留的 completion tokens |
| `DEEPSEEK_FORCE_INCLUDE_USAGE` | `true` | 串流請求自動要求 usage |

> DeepSeek 官方並沒有公開固定的 RPM/TPM 數字，實際額度會依模型與帳戶狀況變動。請依照你的方案調整，並保留一點餘裕。這裡的預設值偏保守。

---

## API 端點

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | 主要端點，支援 `stream: true` |
| `GET` | `/v1/models` | 轉發模型列表 |
| `GET` | `/healthz` | 健康檢查（不需要驗證） |
| `GET` | `/stats` | 限流器快照 + 程序統計（需要代理金鑰，若有設定） |
| `GET` | `/metrics` | Prometheus 文字格式 |

`/stats` 範例（節錄）：

```json
{
  "ok": true,
  "limiter": {
    "limits": { "requestsPerMinute": 60, "tokensPerMinute": 60000, "maxConcurrency": 8 },
    "usage": { "rpmTokens": 42.5, "tpmTokens": 51200, "active": 2, "queued": 5 },
    "daily": { "day": "2026-11-12", "tokensUsed": 125000, "tokenLimit": 2000000 }
  },
  "metrics": { "requestsTotal": 120, "requestsSucceeded": 118, "rateLimited": 2 }
}
```

錯誤回應採用 OpenAI 風格：

```json
{
  "error": {
    "message": "Request waited more than 120000ms for rate limit capacity",
    "type": "rate_limit_error",
    "code": "QUEUE_TIMEOUT"
  }
}
```

---

## Docker

```bash
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
docker compose up -d --build
```

或手動：

```bash
docker build -t deepseek-rate-limiter .
docker run --rm -p 8787:8787 --env-file .env -e HOST=0.0.0.0 deepseek-rate-limiter
```

容器內以非 root 的 `node` 使用者執行，並附帶 healthcheck。

---

## 開發與測試

```bash
npm run typecheck   # TypeScript 嚴格模式
npm test            # 42 個單元 / 整合測試（vitest）
npm run build       # 編譯到 dist/
npm start           # 跑編譯後的版本
```

測試覆蓋：

- Token bucket 的補充、容量、debt
- RPM / TPM / 並行 / burst / 佇列上限 / 佇列逾時 / 冷卻 / abort / 每日配額重置
- SSE 解析（跨 chunk、CRLF、`[DONE]`）
- 429 重試、usage 結算、串流 usage、網路錯誤
- 代理的認證、非串流轉發、串流轉發、`/stats`、`/metrics`、`/v1/models`

CI 設定了 Node 20 / 22 / 24 三個版本（`.github/workflows/ci.yml`）。

---

## 設計取捨與注意事項

- **估算不是精確 tokenizer**：TPM 的預扣是啟發式估算，最終一定會用真實 `usage` 校正。若你很在意精度，可把 `DEEPSEEK_EXPECTED_COMPLETION_TOKENS` 調成貼近實際輸出的值。
- **429 重試會重新取得 lease**：失敗的嘗試仍然消耗 RPM/TPM 與每日 request 配額，這是偏保守的算法，可避免重試風暴。
- **配額狀態存在記憶體**：只適合單一實例。若要多副本共用配額，請把每日計數移到 Redis 等共享儲存，或只部署一個實例。
- **代理只實作 chat completions 與 models**：DeepSeek 的 FIM / beta 端點沒有轉發。
- **串流無法中途改狀態碼**：如果上游在串流中途出錯，客戶端只會看到串流結束。
- **金鑰安全**：`DEEPSEEK_API_KEY` 只放在代理伺服器；對外部署時務必設定 `PROXY_API_KEY`，並用 HTTPS 反向代理。預設綁 `127.0.0.1` 就是為了避免誤曝。
- **`deepseek-reasoner` 的 reasoning tokens** 也計入 completion usage，限流器會依據官方 usage 結算。

---

## 發佈到 GitHub

專案已包含 `.gitignore`、MIT `LICENSE` 與 CI。首次發佈：

```bash
cd deepseek-rate-limiter
git init -b main
git add .
git commit -m "feat: DeepSeek API rate limiter proxy"
```

使用 GitHub CLI 建立 repo 並推送（改成你要的名字與可見性）：

```bash
gh auth login
gh repo create deepseek-rate-limiter --public --source=. --remote=origin --push
```

或先手動在 GitHub 建 repo，再：

```bash
git remote add origin https://github.com/<你的帳號>/deepseek-rate-limiter.git
git push -u origin main
```

---

## License

[MIT](LICENSE)
