// ===== 定数定義 =====
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// タイムゾーン・時間関連
const JST_OFFSET_HOURS = 9;
const MINUTES_PER_CYCLE = 10;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

// フォールバック関連
const MAX_FALLBACK_CYCLES = 5;

// キャッシュ寿命
const CACHE_TTL_NORMAL = 60;   // 正常データキャッシュ寿命（秒）
const CACHE_TTL_NEGATIVE = 10; // ネガティブキャッシュ寿命（秒）

// ===== ロガー関数 =====
function logger(env, level, ...args) {
  const currentLevel = LOG_LEVELS[env.LOG_LEVEL || "INFO"];
  if (LOG_LEVELS[level] >= currentLevel) {
    const timestamp = new Date().toISOString(); // UTC固定
    const prefix = `[${timestamp}] [${level}]`;
    switch (level) {
      case "DEBUG": console.debug(prefix, ...args); break;
      case "INFO": console.info(prefix, ...args); break;
      case "WARN": console.warn(prefix, ...args); break;
      case "ERROR": console.error(prefix, ...args); break;
    }
  }
}

// ===== JST基準でアメダス用タイムスタンプ生成 =====
function getAmedasTimestamp(baseDate, offsetCycles = 0) {
  // JSTに変換（UTCミリ秒に +9時間）
  const jst = new Date(baseDate.getTime() + JST_OFFSET_HOURS * MS_PER_HOUR);

  // 10分単位に丸め（UTCメソッドで一貫）
  const minutes = Math.floor(jst.getUTCMinutes() / MINUTES_PER_CYCLE) * MINUTES_PER_CYCLE;
  jst.setUTCMinutes(minutes, 0, 0);

  // フォールバック分だけ遡る
  jst.setTime(jst.getTime() - offsetCycles * MINUTES_PER_CYCLE * MS_PER_MINUTE);

  // YYYYMMDDHHMM00 形式に整形
  const YYYY = jst.getUTCFullYear();
  const MM = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(jst.getUTCDate()).padStart(2, "0");
  const HH = String(jst.getUTCHours()).padStart(2, "0");
  const MI = String(jst.getUTCMinutes()).padStart(2, "0");

  return `${YYYY}${MM}${DD}${HH}${MI}00`;
}

// ===== キャッシュ層インタフェース =====
async function getAmedasData(timestamp, ctx, env) {
  const srcUrl = `https://www.jma.go.jp/bosai/amedas/data/map/${timestamp}.json`;
  const cacheKey = new Request(srcUrl);

  let cachedResp = await caches.default.match(cacheKey);
  if (cachedResp) {
    const cachedData = await cachedResp.json();
    if (cachedData.__negative_cache) {
      logger(env, "DEBUG", `NEGATIVE CACHE HIT: timestamp=${timestamp}`);
      return null; // ネガティブキャッシュは null を返す
    }
    logger(env, "DEBUG", `CACHE HIT: timestamp=${timestamp}`);
    return cachedData;
  }

  // キャッシュミス → フェッチ
  const resp = await fetch(srcUrl);
  if (resp.ok) {
    const data = await resp.json();
    ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL_NORMAL}` }
    })));
    logger(env, "INFO", `FETCH SUCCESS: timestamp=${timestamp}`);
    return data;
  } else if (resp.status === 404) {
    // ネガティブキャッシュ保存
    const negativeData = { __negative_cache: true };
    ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(negativeData), {
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL_NEGATIVE}` }
    })));
    logger(env, "WARN", `NEGATIVE CACHE SET: timestamp=${timestamp}`);
    return null;
  } else {
    logger(env, "WARN", `FETCH FAIL: timestamp=${timestamp}, status=${resp.status}`);
    return null;
  }
}

// ===== メイン処理 =====
export default {
  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);

    const stationId = pathParts[0] || "46106";
    const metricName = pathParts[1];

    logger(env, "DEBUG", `START: station=${stationId}${metricName ? `, metric=${metricName}` : ""}`);

    const now = new Date();
    let data = null;
    let usedTimestamp = null;

    // 最新から遡って試す
    for (let i = 0; i < MAX_FALLBACK_CYCLES; i++) {
      const timestamp = getAmedasTimestamp(now, i);
      data = await getAmedasData(timestamp, ctx, env);
      if (data) {
        usedTimestamp = timestamp;
        break;
      }
    }

    if (!data) {
      logger(env, "ERROR", `ERROR: No data available after ${MAX_FALLBACK_CYCLES} cycles`);
      return new Response(JSON.stringify({ error: "No data available after fallback" }), {
        status: 502,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 指定された観測所IDのデータを抽出
    const station = data[stationId];
    if (!station) {
      logger(env, "WARN", `NOT FOUND: station=${stationId}, timestamp=${usedTimestamp}`);
      return new Response(JSON.stringify({ error: "Station ID not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    let responseData = station;
    if (metricName) {
      const metric = station[metricName];
      if (metric === undefined) {
        logger(env, "WARN", `METRIC NOT FOUND: station=${stationId}, metric=${metricName}, timestamp=${usedTimestamp}`);
        return new Response(JSON.stringify({ error: `Metric '${metricName}' not found for station '${stationId}'` }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
      responseData = metric;
    }

    logger(env, "INFO", `SUCCESS: station=${stationId}${metricName ? `, metric=${metricName}` : ""}, timestamp=${usedTimestamp}`);

    return new Response(JSON.stringify(responseData), {
      headers: { "Content-Type": "application/json" }
    });
  }
};
