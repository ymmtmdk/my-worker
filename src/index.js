// ログレベル定義
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// ロガー関数
function logger(env, level, ...args) {
  const currentLevel = LOG_LEVELS[env.LOG_LEVEL || "INFO"];
  if (LOG_LEVELS[level] >= currentLevel) {
    const timestamp = new Date().toISOString(); // ISO形式の日時
    const prefix = `[${timestamp}] [${level}]`;
    switch (level) {
      case "DEBUG": console.debug(prefix, ...args); break;
      case "INFO": console.info(prefix, ...args); break;
      case "WARN": console.warn(prefix, ...args); break;
      case "ERROR": console.error(prefix, ...args); break;
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    const stationId = pathParts[0] || "46106";

    // フォールバックサイクル数（10分単位で遡る最大回数）
    const MAX_FALLBACK_CYCLES = 3;

    // 現在時刻を10分単位に丸める
    const now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / 10) * 10, 0, 0);

    let data = null;
    let usedTimestamp = null;

    // 最新から MAX_FALLBACK_CYCLES まで遡って試す
    for (let i = 0; i < MAX_FALLBACK_CYCLES; i++) {
      const ts = new Date(now.getTime() - i * 10 * 60 * 1000);
      const timestamp = ts.toISOString().replace(/[-:T.Z]/g, "").slice(0, 12) + "00";
      const srcUrl = `https://www.jma.go.jp/bosai/amedas/data/map/${timestamp}.json`;
      const cacheKey = new Request(srcUrl);

      let cachedResp = await caches.default.match(cacheKey);

      if (cachedResp) {
        data = await cachedResp.json();
        usedTimestamp = timestamp;
        logger(env, "DEBUG", `CACHE HIT: station=${stationId}, timestamp=${timestamp}`);
        break;
      } else {
        const resp = await fetch(srcUrl);
        if (resp.ok) {
          data = await resp.json();
          usedTimestamp = timestamp;
          ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(data), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=10"
            }
          })));
          logger(env, "INFO", `FETCH: station=${stationId}, timestamp=${timestamp}`);
          break;
        } else {
          logger(env, "WARN", `MISS: station=${stationId}, timestamp=${timestamp}, status=${resp.status}`);
        }
      }
    }

    // データが取得できなかった場合はエラー
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

    logger(env, "INFO", `SUCCESS: station=${stationId}, timestamp=${usedTimestamp}`);

    return new Response(JSON.stringify(station), {
      headers: { "Content-Type": "application/json" }
    });
  }
};
