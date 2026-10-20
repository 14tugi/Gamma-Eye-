#!/usr/bin/env node
// BTC option wall alerts -> your phone via ntfy. Node 18+, no dependencies.
// Same logic as the dashboard: gamma-weighted walls within 2% of price, state from public Deribit aggressor flow
// plus a local IV bump, confirmed by a 5-minute price reaction. Sends: approaching an active wall, a confirmed setup
// (entry / stop / take profit), and a stop or target hit on that setup.
//   node walls-alert.mjs --test    send a test notification
//   node walls-alert.mjs --once    one check, then exit (cron, GitHub Actions)
//   node walls-alert.mjs           check every POLL seconds, forever
import fs from "node:fs";
const E=process.env,N=(k,d)=>E[k]&&isFinite(+E[k])?+E[k]:d;
const C={topic:E.NTFY_TOPIC||"",server:(E.NTFY_SERVER||"https://ntfy.sh").replace(/\/$/,""),fmin:N("FMIN",10),bump:N("BUMP",.5),skip:N("SKIP",2),warm:N("WARM",1),
  thr:N("THR",.5),ksl:N("KSL",.1),hzH:N("HZ_HOURS",4),poll:N("POLL",30),file:E.STATE_FILE||"state.json",wb:.02,top:8};
const API="https://www.deribit.com/api/v2/public/",px=v=>"$"+Math.round(v).toLocaleString("en-US"),sg=(v,d=0)=>(v>=0?"+":"-")+Math.abs(v).toFixed(d),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const NAME={C:"Call wall",P:"Put wall"},ST={short:"short-gamma tilt",long:"long-gamma tilt"};
const api=async(m,p)=>{const r=await fetch(API+m+"?"+new URLSearchParams(p)),j=await r.json();if(j.error)throw new Error(m+": "+j.error.message);return j.result};
const load=()=>{try{return JSON.parse(fs.readFileSync(C.file,"utf8"))}catch{return{sent:{},trade:null}}},save=s=>fs.writeFileSync(C.file,JSON.stringify(s));

async function notify(title,msg,pri="default",tags=""){
  console.log("ALERT:",title,"|",msg);
  if(!C.topic){console.log("(NTFY_TOPIC not set, nothing sent)");return}
  try{const r=await fetch(`${C.server}/${encodeURIComponent(C.topic)}`,{method:"POST",body:msg,headers:{Title:title,Priority:pri,Tags:tags}});if(!r.ok)console.error("ntfy error",r.status)}catch(e){console.error("ntfy error",e.message)}}

async function getOptions(insts){const out=[];let n=0;
  await Promise.all(Array.from({length:6},async()=>{while(n<insts.length){const i=insts[n++];
    try{const t=await api("ticker",{instrument_name:i.instrument_name});if(t.greeks)out.push({strike:i.strike,type:i.option_type==="call"?"C":"P",gamma:t.greeks.gamma,markIv:t.mark_iv||0,oi:t.open_interest||0})}catch{}}}));
  return out}

// Net taker-side flow since the session start (expiry - 24h). Block, combo and liquidation trades are excluded.
async function getFlow(inst,expiry,now){
  const names=new Map(inst.filter(i=>i.expiration_timestamp===expiry).map(i=>[i.instrument_name,i])),seen=new Set(),m=new Map(),from=Math.max(expiry-864e5,now-2*864e5);let s=from;
  for(let p=0;p<15;p++){
    const r=await api("get_last_trades_by_currency_and_time",{currency:"BTC",kind:"option",start_timestamp:s,end_timestamp:now,count:1000,sorting:"asc"});let mx=s;
    for(const t of r.trades){mx=Math.max(mx,t.timestamp);if(seen.has(t.trade_id))continue;seen.add(t.trade_id);
      const i=names.get(t.instrument_name);if(!i||t.block_trade_id||t.combo_id||t.liquidation)continue;
      const k=i.strike+"|"+(i.option_type==="call"?"C":"P"),f=m.get(k)||{net:0,buy:0,sell:0};
      if(t.direction==="buy")f.buy+=t.amount;else f.sell+=t.amount;f.net=f.buy-f.sell;m.set(k,f)}
    if(!r.has_more)break;s=mx>s?mx:s+1}
  m.total=seen.size;return m}

function analyze(opts,S,flow,hrs){
  const kk=S*S*.01,ser=t=>opts.filter(o=>o.type===t&&o.markIv>0).sort((a,b)=>a.strike-b.strike),sC=ser("C"),sP=ser("P");
  const bumpOf=o=>{const a=o.type==="C"?sC:sP,i=a.findIndex(x=>x.strike===o.strike);return i<1||i>=a.length-1?null:o.markIv-(a[i-1].markIv+a[i+1].markIv)/2};
  const walls=type=>opts.filter(o=>o.type===type&&(type==="C"?o.strike>S:o.strike<S)&&Math.abs(o.strike/S-1)<=C.wb&&o.oi>0&&o.gamma>0).map(o=>{
    const f=(flow&&flow.get(o.strike+"|"+o.type))||{net:0},share=f.net/o.oi*100,b=bumpOf(o);let state="none";
    if(flow&&hrs>=C.skip&&hrs<=24-C.warm&&b!=null){if(share>=C.fmin&&b>=C.bump)state="short";else if(share<=-C.fmin&&b<C.bump)state="long"}
    return{...o,gex:o.gamma*o.oi*kk,bump:b,share,state}}).sort((a,b)=>b.gex-a.gex).slice(0,C.top);
  return{cw:walls("C"),pw:walls("P")}}

async function candles(from){
  const j=await (await fetch(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=1000&start=${Math.floor(from/1000)}`)).json(),now=Date.now();
  return((j.data&&j.data.ohlc)||[]).map(c=>({t:+c.timestamp*1000,h:+c.high,l:+c.low,c:+c.close,v:+c.volume})).filter(c=>c.t+6e4<=now).sort((a,b)=>a.t-b.t)}
const bars5=cs=>{const o=[];let k=null;for(const c of cs){const b=Math.floor(c.t/3e5)*3e5;if(!k||k.t!==b){k={t:b,h:c.h,l:c.l,c:c.c,v:c.v||0};o.push(k)}else{k.h=Math.max(k.h,c.h);k.l=Math.min(k.l,c.l);k.c=c.c;k.v+=c.v||0}}return o};
function reaction(L,side,bs){
  const P=side==="P",out=c=>P?c<L:c>L,tol=L*.0005,w=bs.slice(-18);if(w.length<4)return null;
  const last=w[w.length-1],f=w.findIndex(b=>out(b.c));
  if(f>=0&&out(last.c)){const rt=w.slice(f+1).some(b=>(P?b.h>=L-tol:b.l<=L+tol)&&out(b.c));return{kind:rt?"breakout":"through"}}
  for(let j=Math.max(3,w.length-6);j<w.length;j++){const b=w[j];if(!(P?b.l<=L+tol:b.h>=L-tol)||out(b.c))continue;
    if(b.v<(w[j-1].v+w[j-2].v+w[j-3].v)/3)return{kind:"reject"}}
  return null}

async function cycle(S){
  const now=Date.now(),inst=(await api("get_instruments",{currency:"BTC",kind:"option",expired:"false"})).filter(i=>Number.isFinite(i.expiration_timestamp)&&Number.isFinite(i.strike));
  const expiry=Math.min(...inst.map(i=>i.expiration_timestamp)),idx=(await api("get_index_price",{index_name:"btc_usd"})).index_price;
  let fx=idx;try{const t=await (await fetch("https://www.bitstamp.net/api/v2/ticker/btcusd/")).json();if(+t.last>0)fx=+t.last}catch{}
  const lvl=k=>k+(fx-idx),hrs=Math.max(0,(expiry-now)/36e5);
  const opts=await getOptions(inst.filter(i=>i.expiration_timestamp===expiry&&Math.abs(i.strike/idx-1)<=.03));if(!opts.length)throw new Error("no option data");
  const nk=opts.reduce((b,o)=>Math.abs(o.strike-idx)<Math.abs(b-idx)?o.strike:b,opts[0].strike),av=opts.filter(o=>o.strike===nk&&o.markIv>0).map(o=>o.markIv),atm=av.length?av.reduce((a,b)=>a+b)/av.length:0,em=fx*(atm/100)*Math.sqrt(C.hzH/8760);
  const flow=await getFlow(inst,expiry,now).catch(e=>{console.error("flow:",e.message);return null});
  const an=analyze(opts,idx,flow,hrs),walls=[...an.cw.map(w=>({...w,side:"C"})),...an.pw.map(w=>({...w,side:"P"}))];
  const cs=await candles(Math.max(now-16*36e5,Math.min(now-130*6e4,S.trade?S.trade.t:now))).catch(e=>{console.error("candles:",e.message);return[]}),bs=bars5(cs).filter(b=>b.t+3e5<=now);
  const react=new Map();walls.forEach(w=>{const r=reaction(lvl(w.strike),w.side,bs);if(r)react.set(w.side+"|"+w.strike,r)});
  console.log(`${new Date(now).toISOString()} BTCUSD ${px(fx)} · expiry in ${hrs.toFixed(1)}h · ${walls.filter(w=>w.state!=="none").length} active walls · flow ${flow?flow.total+" trades":"n/a"}`);

  function setup(w){
    if(w.state==="none"||!(em>0))return null;
    const r=react.get(w.side+"|"+w.strike),kind=r?r.kind:null,mode=w.state==="short"?"break":"fade",ok=mode==="break"?kind==="breakout":kind==="reject";
    const dir=(w.side==="C")===(mode==="break")?"long":"short",s1=dir==="long"?1:-1,Lw=lvl(w.strike),entry=Math.round(ok?fx:Lw),sl=Math.round(Lw-s1*C.ksl*em),R=Math.abs(entry-sl);
    if(!(R>0)||(entry-sl)*s1<=0)return null;
    const tpSide=mode==="fade"?(w.side==="C"?"P":"C"):w.side,tw=walls.filter(x=>x.side===tpSide&&(lvl(x.strike)-entry)*s1>0).sort((a,b)=>Math.abs(lvl(a.strike)-entry)-Math.abs(lvl(b.strike)-entry))[0];
    return{mode,dir,ok,entry,R,sl,tp:tw?Math.round(lvl(tw.strike)):null}}

  // 1) follow the setup we last alerted on: stop first if one candle touches both
  if(S.trade){const t=S.trade,s=t.dir==="long"?1:-1;let done=null;
    for(const c of cs){if(c.t<Math.ceil(t.t/6e4)*6e4||c.t<=(t.lastC||0))continue;t.lastC=c.t;
      if(s>0?c.l<=t.sl:c.h>=t.sl){done=["SL",t.sl];break}if(t.tp!=null&&(s>0?c.h>=t.tp:c.l<=t.tp)){done=["TP",t.tp];break}}
    if(!done&&now>t.expiry)done=["EXPIRED",fx];
    if(done){const pnl=(done[1]-t.entry)*s;
      await notify(done[0]==="TP"?"Take profit hit":done[0]==="SL"?"Stop hit":"Setup expired",`${t.dir.toUpperCase()} BTCUSD from ${px(t.entry)}: exit ${px(done[1])}, ${sg(pnl)} USD (${sg(pnl/t.R,2)}R)`,done[0]==="SL"?"high":"default",done[0]==="TP"?"white_check_mark":"x");S.trade=null}}

  // 2) alerts for walls near price (cooldowns: 30 min for "approaching", 2 h for a setup on the same wall)
  const sent=S.sent;for(const k in sent)if(now-sent[k]>108e5)delete sent[k];
  const once=(k,ms)=>{if(sent[k]&&now-sent[k]<ms)return false;sent[k]=now;return true};
  for(const w of walls.slice().sort((a,b)=>b.gex-a.gex)){
    const L=lvl(w.strike),dist=(L/fx-1)*100;if(Math.abs(dist)>C.thr)continue;const p=setup(w);
    if(p&&p.ok&&!S.trade&&once(`setup|${expiry}|${w.side}|${w.strike}|${p.mode}`,72e5)){
      S.trade={t:now,expiry,side:w.side,strike:w.strike,mode:p.mode,dir:p.dir,entry:p.entry,sl:p.sl,tp:p.tp,R:p.R};
      await notify(`SETUP - ${p.dir.toUpperCase()} BTCUSD`,`${p.mode==="break"?"Follow-through":"Reversal"} confirmed at the ${NAME[w.side].toLowerCase()} ${px(L)}. ${p.dir.toUpperCase()} near ${px(p.entry)}, stop ${px(p.sl)}, take profit ${p.tp!=null?px(p.tp):"none yet"}. ${ST[w.state]}, flow ${sg(w.share,1)}% of OI, IV bump ${w.bump==null?"n/a":sg(w.bump,1)}. ${hrs.toFixed(1)}h to expiry.`,"high","rotating_light");continue}
    if(w.state!=="none"&&!(p&&p.ok)&&once(`near|${expiry}|${w.side}|${w.strike}`,18e5))
      await notify("Approaching active wall",`${NAME[w.side]} ${px(L)} is ${Math.abs(dist).toFixed(2)}% ${dist>0?"above":"below"} price. ${ST[w.state]}: watching for ${w.state==="short"?"a close through the wall and a failed retest (follow-through)":"a rejection on fading volume (reversal)"}.`,"default","eyes")}
}

const arg=process.argv.slice(2);
if(arg.includes("--test")){await notify("Wall alerts connected","If you can read this on your phone, alerts are working.","default","white_check_mark");process.exit(0)}
const S=load();
if(arg.includes("--once")){try{await cycle(S)}catch(e){console.error(e.message);save(S);process.exit(1)}save(S)}
else for(;;){try{await cycle(S)}catch(e){console.error(new Date().toISOString(),e.message)}save(S);await sleep(C.poll*1000)}
