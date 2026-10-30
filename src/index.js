const sources = ["NexDeal","B-Stock","Liquidation.com","Direct Liquidation","Via Trading","Quicklotz","BULQ","888 Lots","Doba","CJdropshipping","Spocket","Syncee","Custom Manifest"];
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ ok:true, service:"SourceMatch", mode:"Cloudflare Worker" });
    if (url.pathname === "/api/sources") return json({ sources });
    if (url.pathname === "/api/rank" && request.method === "POST") {
      const data = await request.json();
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const ranked = rows.map(r => rank(r, data.sellPrice || 0)).sort((a,b)=>b.score-a.score);
      const valid = ranked.filter(r=>r.confidence>=90 && r.margin>=15 && !["returns","salvage","damaged"].includes(String(r.condition).toLowerCase()));
      ranked.forEach(r=>{
        if (valid[0] === r) { r.color="green"; r.decision="Best choice"; }
        else if (valid[1] === r) { r.color="yellow"; r.decision="Moderate / 2nd choice"; }
        else { r.color="red"; r.decision="Not right choice"; }
      });
      return json({ rows: ranked });
    }
    return env.ASSETS.fetch(request);
  }
};
function n(v){ const x=Number(String(v??0).replace(/[$,]/g,"")); return Number.isFinite(x)?x:0; }
function rank(r,sell){
  const cost=n(r.cost), shipping=n(r.shipping), landed=cost+shipping, price=n(sell), margin=price?((price-landed)/price*100):0;
  const confidence=n(r.confidence)||100, moq=Math.max(1,n(r.moq)||1), condition=r.condition||"Unknown";
  const score=Math.max(0,Math.min(100,confidence*.55+Math.min(35,Math.max(0,margin))*.7-Math.min(12,moq/60)+(["new","overstock","new / overstock"].includes(condition.toLowerCase())?8:0)));
  return {...r,landed:+landed.toFixed(2),margin:+margin.toFixed(1),score:Math.round(score),confidence,moq,condition};
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json;charset=UTF-8"}})}

