export default {
  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);

    // パスを分割して観測所IDを取得
    // 例: https://<worker>.workers.dev/46106
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    const stationId = pathParts[0] || "46106"; // デフォルトは46106

    // 気象庁アメダスの最新データを取得
    const srcUrl = "https://www.jma.go.jp/bosai/amedas/data/map/20251130134000.json";
    const resp = await fetch(srcUrl);
    const data = await resp.json();

    // 指定された観測所IDのデータを抽出
    const station = data[stationId];

    if (!station) {
      return new Response(JSON.stringify({ error: "Station ID not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify(station), {
      headers: { "Content-Type": "application/json" }
    });
  }
};

