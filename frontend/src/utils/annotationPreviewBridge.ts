// Runs inside the sandboxed preview. The host validates event.source before accepting anchors.
export const annotationPreviewBridge = String.raw`<script>(function(){
let active=false, annotations=[], layer, theme={accent:'#262626',surface:'#ffffff',text:'#ffffff',focus:'#2563eb'};
const send=(data)=>parent.postMessage({type:'canvas-annotation',...data},'*');
const selector=(el)=>{ const parts=[]; while(el && el!==document.body){
 const tag=el.tagName.toLowerCase();
 if(el.id){parts.unshift('#'+CSS.escape(el.id));break;}
 let n=1,s=el; while((s=s.previousElementSibling))if(s.tagName===el.tagName)n++;
 parts.unshift(tag+':nth-of-type('+n+')');el=el.parentElement;
}return parts.join(' > ')||'body';};
const style=document.createElement('style');style.textContent='[data-annotation-hover]{outline:2px solid var(--annotation-focus,#2563eb)!important;cursor:crosshair!important}';document.head.appendChild(style);
const clearHover=()=>document.querySelectorAll('[data-annotation-hover]').forEach(el=>el.removeAttribute('data-annotation-hover'));
document.addEventListener('pointerover',e=>{if(!active||e.target.closest('[data-annotation-layer]'))return;clearHover();e.target.setAttribute('data-annotation-hover','');},true);
document.addEventListener('click',e=>{
 if(!active||e.target.closest('[data-annotation-layer]'))return;
 e.preventDefault();e.stopImmediatePropagation();
 const el=e.target; const selected=window.getSelection();
 const quote=selected&&!selected.isCollapsed?selected.toString():el.innerText||el.getAttribute('aria-label')||el.tagName.toLowerCase();
 const blockId=selector(el); if(blockId.length>255){send({error:'Select a larger containing element to attach this comment.'});return;}
 const r=el.getBoundingClientRect();
 send({anchor:{blockId,anchorText:quote.slice(0,4000),anchorFingerprint:JSON.stringify({x:Math.max(0,Math.min(1,(e.clientX-r.left)/Math.max(1,r.width))),y:Math.max(0,Math.min(1,(e.clientY-r.top)/Math.max(1,r.height)))})}});
},true);
function paint(){
 if(!layer){layer=document.createElement('div');layer.setAttribute('data-annotation-layer','');layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483647';document.body.appendChild(layer);}
 layer.replaceChildren();
 annotations.forEach((a,i)=>{if(!a.blockId)return;let el;try{el=document.querySelector(a.blockId)}catch{return;}if(!el)return;
 // Do not move a pin onto different text after an HTML edit.
 if(a.anchorText&&el.innerText&&!el.innerText.includes(a.anchorText))return;
 let pos={x:0.5,y:0.5};try{const p=JSON.parse(a.anchorFingerprint);if(Number.isFinite(p.x)&&Number.isFinite(p.y))pos=p;}catch{}
 const r=el.getBoundingClientRect();if(!r.width||!r.height)return;
 const pin=document.createElement('button');pin.type='button';pin.textContent=String(i+1);pin.setAttribute('aria-label','Open annotation '+(i+1));
 pin.style.cssText='position:absolute;width:24px;height:24px;border:2px solid white;border-radius:50%;background:#2563eb;color:white;font:600 12px sans-serif;pointer-events:auto;box-shadow:0 1px 5px #0005;transform:translate(-50%,-50%)';
 pin.style.background=theme.accent;pin.style.color=theme.text;pin.style.borderColor=theme.surface;
 pin.style.left=(r.left+r.width*Math.max(0,Math.min(1,pos.x)))+'px';pin.style.top=(r.top+r.height*Math.max(0,Math.min(1,pos.y)))+'px';
 pin.onclick=e=>{e.preventDefault();e.stopPropagation();send({id:a.id})};layer.appendChild(pin);
 });
}
window.addEventListener('message',e=>{if(e.source!==parent||e.data?.type!=='canvas-annotation-state')return;if(e.data.theme){for(const key of ['accent','surface','text','focus'])if(typeof e.data.theme[key]==='string')theme[key]=e.data.theme[key];document.documentElement.style.setProperty('--annotation-focus',theme.focus);}active=!!e.data.active;annotations=Array.isArray(e.data.annotations)?e.data.annotations:[];if(!active)clearHover();paint();});
window.addEventListener('scroll',paint,true);window.addEventListener('resize',paint);setInterval(paint,1000);
send({ready:true});
})();</script>`;
