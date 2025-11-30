// ログレベル定義
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

// ロガー関数
function logger(env, level, ...args) {
  const currentLevel = LOG_LEVELS[env.LOG_LEVEL || "INFO"];
  if (LOG_LEVELS[level] >= currentLevel) {
    const timestamp = new Date().toISOString(); // ISO形式の日時 (UTC固定)
    const prefix = `[${timestamp}] [${level}]`;
    switch (level) {
      case "DEBUG": console.debug(prefix, ...args); break;
      case "INFO": console.info(prefix, ...args); break;
      case "WARN": console.warn(prefix, ...args); break;
      case "ERROR": console.error(prefix, ...args); break;
    }
  }
}

// JST基準でアメダス用タイムスタンプ生成
function getAmedasTimestamp(baseDate, offsetCycles = 0) {
  // JSTに変換
  const jst = new Date(baseDate.getTime() + 9 * 60 * 60 * 1000);

  // 10分単位に丸め
  const minutes = Math.floor(jst.getUTCMinutes() / 10) * 10;
  jst.setUTCMinutes(minutes, 0, 0);

  // フォールバック分だけ遡る
  jst.setTime(jst.getTime() - offsetCycles * 10 * 60 * 1000);

  // YYYYMMDDHHMM00 形式に整形
  const YYYY = jst.getUTCFullYear();
  const MM = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const DD = String(jst.getUTCDate()).padStart(2, "0");
  const HH = String(jst.getUTCHours()).padStart(2, "0");
  const MI = String(jst.getUTCMinutes()).padStart(2, "0");

  return `${YYYY}${MM}${DD}${HH}${MI}00`;
}

export default {
  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);

    const stationId = pathParts[0] || "46106";
    const metricName = pathParts[1]; // 新しいパスパラメータ: 観測項目名

    logger(env, "DEBUG", `START: station=${stationId}${metricName ? `, metric=${metricName}` : ""}`);

    // フォールバックサイクル数（10分単位で遡る最大回数）
    const MAX_FALLBACK_CYCLES = 5;

    // 現在時刻
    const now = new Date();

    let data = null;
    let usedTimestamp = null;

    // 最新から MAX_FALLBACK_CYCLES まで遡って試す
    for (let i = 0; i < MAX_FALLBACK_CYCLES; i++) {
      const timestamp = getAmedasTimestamp(now, i);
      const srcUrl = `https://www.jma.go.jp/bosai/amedas/data/map/${timestamp}.json`;
      const cacheKey = new Request(srcUrl);

      let cachedResp = await caches.default.match(cacheKey);

      if (cachedResp) {
        data = await cachedResp.json();
        usedTimestamp = timestamp;
        logger(env, "DEBUG", `CACHE HIT: station=${stationId}, timestamp=${timestamp}`);
        break;
      } else {
				if (i > 0) {
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
