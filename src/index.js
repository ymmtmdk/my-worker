/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
export default {
  async fetch(request, env, ctx) {
    // 気象庁アメダスの最新データを取得
    const url = "https://www.jma.go.jp/bosai/amedas/data/map/20251130134000.json";
    const resp = await fetch(url);
    const data = await resp.json();

    // 観測所ID 46106 のデータを抽出
    const station = data["46106"];

    // 必要な情報だけ返す（例：気温と降水量）
    const filtered = {
      temperature: station.temp ? station.temp[0] : null,
      precipitation: station.precipitation1h ? station.precipitation1h[0] : null
    };

    return new Response(JSON.stringify(station), {
      headers: { "Content-Type": "application/json" }
    });
  }
};

