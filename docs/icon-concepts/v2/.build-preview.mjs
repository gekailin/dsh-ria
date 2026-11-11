import fs from "node:fs";
const dir="/home/gkl/Desktop/vibe_proj/dsh-ria/docs/icon-concepts/v2";
const names={"v1":"卷浪梢","v2":"回旋环流","v3":"三滴错落","v4":"水花迸溅","v5":"液态 R"};
const ids=["v1","v2","v3","v4","v5"];
function inner(file){const raw=fs.readFileSync(dir+"/"+file,"utf8");return raw.slice(raw.indexOf(">")+1,raw.lastIndexOf("</svg>")).replace(/<title>[\s\S]*?<\/title>/g,"").trim();}
function icon(file,size,color){return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner(file)}</svg>`;}
const card=(id,size,color)=>`<div class="card"><div class="art">${icon(id+".svg",size,color)}</div><div class="label">${id.toUpperCase()}</div><div class="sub">${names[id]}</div></div>`;
const html=`<!doctype html>
<html lang="zh"><meta charset="utf-8">
<title>Ria 水元素候选 v2</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #ffffff; }
  body { font: 14px/1.45 "Noto Sans CJK SC", "Noto Sans CJK TC", "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
  section { width: 1120px; padding: 30px 34px 28px; }
  .light { background: #ffffff; color: #111111; }
  .dark { background: #1e1e1e; color: #ededed; }
  h2 { margin: 0 0 22px; font-size: 18px; font-weight: 650; letter-spacing: .01em; }
  h2 span { font-weight: 400; opacity: .48; font-size: 13px; margin-left: 10px; }
  .row { display: flex; gap: 18px; }
  .card { width: 196px; text-align: center; }
  .art { height: 190px; display: flex; align-items: center; justify-content: center; }
  .label { margin-top: 2px; font-size: 13px; font-weight: 650; letter-spacing: .06em; }
  .sub { margin-top: 1px; font-size: 12px; opacity: .55; }
  .smallrow { display: flex; align-items: center; height: 62px; border-top: 1px solid rgba(128,128,128,.16); }
  .name { width: 150px; font-weight: 600; }
  .name em { display: block; font-style: normal; font-weight: 400; font-size: 11px; opacity: .5; margin-top: 1px; }
  .cell { width: 92px; display: flex; align-items: center; justify-content: center; }
  .head { display: flex; padding-left: 150px; margin-bottom: 4px; opacity: .42; font-size: 11px; letter-spacing: .08em; }
  .head span { width: 92px; text-align: center; }
</style>
<section class="light">
  <h2>水元素候选 · 160px<span>浅底 #ffffff · currentColor #111111</span></h2>
  <div class="row">${ids.map(id=>card(id,160,"#111111")).join("")}</div>
</section>
<section class="dark">
  <h2>水元素候选 · 160px<span>深底 #1e1e1e · currentColor #ededed</span></h2>
  <div class="row">${ids.map(id=>card(id,160,"#ededed")).join("")}</div>
</section>
<section class="light">
  <h2>小尺寸检查<span>16 / 18 / 24 / 48px · 浅底</span></h2>
  <div class="head"><span>16px</span><span>18px</span><span>24px</span><span>48px</span></div>
  ${ids.map(id=>`<div class="smallrow"><div class="name">${id.toUpperCase()}<em>${names[id]}</em></div>${[16,18,24,48].map(s=>`<div class="cell">${icon(id+".svg",s,"#111111")}</div>`).join("")}</div>`).join("")}
</section>
<section class="dark">
  <h2>小尺寸检查<span>16 / 18 / 24 / 48px · 深底</span></h2>
  <div class="head"><span>16px</span><span>18px</span><span>24px</span><span>48px</span></div>
  ${ids.map(id=>`<div class="smallrow"><div class="name">${id.toUpperCase()}<em>${names[id]}</em></div>${[16,18,24,48].map(s=>`<div class="cell">${icon(id+".svg",s,"#ededed")}</div>`).join("")}</div>`).join("")}
</section>
</html>`;
fs.writeFileSync(dir+"/preview.html",html);

const small=`<!doctype html>
<html lang="zh"><meta charset="utf-8">
<title>Ria 水元素候选 v2 · 小尺寸</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #ffffff; }
  body { font: 14px/1.45 "Noto Sans CJK SC", "Noto Sans CJK TC", "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
  section { width: 720px; padding: 28px 30px 26px; }
  .light { background: #ffffff; color: #111111; }
  .dark { background: #1e1e1e; color: #ededed; }
  h2 { margin: 0 0 16px; font-size: 17px; font-weight: 650; }
  h2 span { font-weight: 400; opacity: .48; font-size: 12px; margin-left: 10px; }
  .smallrow { display: flex; align-items: center; height: 58px; border-top: 1px solid rgba(128,128,128,.16); }
  .name { width: 150px; font-weight: 600; }
  .name em { display: block; font-style: normal; font-weight: 400; font-size: 11px; opacity: .5; margin-top: 1px; }
  .cell { width: 92px; display: flex; align-items: center; justify-content: center; }
  .head { display: flex; padding-left: 150px; margin-bottom: 4px; opacity: .42; font-size: 11px; letter-spacing: .08em; }
  .head span { width: 92px; text-align: center; }
</style>
<section class="light">
  <h2>小尺寸检查<span>16 / 18 / 24 / 48px · 浅底</span></h2>
  <div class="head"><span>16px</span><span>18px</span><span>24px</span><span>48px</span></div>
  ${ids.map(id=>`<div class="smallrow"><div class="name">${id.toUpperCase()}<em>${names[id]}</em></div>${[16,18,24,48].map(s=>`<div class="cell">${icon(id+".svg",s,"#111111")}</div>`).join("")}</div>`).join("")}
</section>
<section class="dark">
  <h2>小尺寸检查<span>16 / 18 / 24 / 48px · 深底</span></h2>
  <div class="head"><span>16px</span><span>18px</span><span>24px</span><span>48px</span></div>
  ${ids.map(id=>`<div class="smallrow"><div class="name">${id.toUpperCase()}<em>${names[id]}</em></div>${[16,18,24,48].map(s=>`<div class="cell">${icon(id+".svg",s,"#ededed")}</div>`).join("")}</div>`).join("")}
</section>
</html>`;
fs.writeFileSync(dir+"/preview-small.html",small);

const wet=`<!doctype html>
<html lang="zh"><meta charset="utf-8">
<title>Ria 水元素候选 v2 · wet-chat</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #ffffff; }
  body { font: 14px/1.45 "Noto Sans CJK SC", "Noto Sans CJK TC", "PingFang SC", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
  .wet { background: #ffffff; color: #111111; padding: 26px 22px 16px; width: 1092px; height: 292px; overflow: hidden; }
  .wethead { font-size: 16px; font-weight: 650; margin: 0 0 12px 8px; letter-spacing: .01em; }
  .wethead span { font-weight: 400; opacity: .46; font-size: 12px; margin-left: 8px; }
  .wetrow { display: flex; gap: 12px; }
  .card { width: 200px; text-align: center; }
  .art { height: 180px; display: flex; align-items: center; justify-content: center; }
  .label { margin-top: 2px; font-size: 13px; font-weight: 650; letter-spacing: .06em; }
  .sub { margin-top: 1px; font-size: 12px; opacity: .55; }
</style>
<div class="wet">
  <div class="wethead">Ria 水元素 · 五版候选<span>180px · 浅底</span></div>
  <div class="wetrow">${ids.map(id=>`<div class="card"><div class="art">${icon(id+".svg",180,"#111111")}</div><div class="label">${id.toUpperCase()}</div><div class="sub">${names[id]}</div></div>`).join("")}</div>
</div>
</html>`;
fs.writeFileSync(dir+"/wet-chat.html",wet);
console.log("built");
