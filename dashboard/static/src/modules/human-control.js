// Pestaña "Control humano" (`data-view="human"`): el canvas isométrico.
//
// Extraído mecánicamente de app.js (nota "Plan de mejora", §18): mismo
// código, mismo comportamiento — solo cambia de dónde vienen sus nombres
// compartidos (antes globals de un único archivo, ahora imports explícitos).

import { activeArchitectureProviderNames, addEntityToGroup, removeEntityFromGroup, roleDef } from "./decision.js";
import { apiUrl, escapeHtml, state } from "./shared.js";

// ── ISO VIEW MODULE ───────────────────────────────────────────────────────────
/* ═══════════════════════════════════════════════════════════════════════════
   KARAJAN · GAME CONTROL v7 — NPC wandering, wide left panel, bigger grid,
   persistent decisions synced with bell, dynamic structures.
   ═══════════════════════════════════════════════════════════════════════════ */
(function isoViewModule(){
'use strict';

// ── AGENTS (dynamic roster derived from Decisión's state.entities) ────────────
// Phase 1: the diorama figures/towers are rebuilt from the real RoutingEntity
// architecture (state.entities + state.groups) instead of a hardcoded 5-provider
// list. rebuildRoster() (below) repopulates AGENTS + zoneLayout deterministically
// whenever the layout data is (re)loaded. See buildAgents()/layoutZones().
var AGENTS=[];          // per-figure shapes: {id,hx,hy,col,acc,name,role,level,skills,dataId,maxCap,ph}
var zoneLayout={};      // {entityId:{hx,hy}} — deterministic grid coords by primary group
var zoneRegions=[];     // Phase 2: [{id,name,color,x0,y0,x1,y1,count}] — one per HierarchyGroup + "Sin asignar"
var hubId=null;         // entity id used as the connection hub (parent / lowest-prio)
var NEUTRAL_COL='#7A8899'; // fallback color for entities with no hierarchy membership

// ── DEMO SCRIPT ──────────────────────────────────────────────────────────────
var DEMO=[
  {ms:0,    fn:'userTask', a:['Optimiza la API REST, analiza logs y documenta en 3 idiomas']},
  {ms:900,  fn:'mode',     a:['claude','thinking']},
  {ms:1100, fn:'card',     a:['claude','Analizando misión…','Evaluando componentes: endpoints, logs, cobertura y rendimiento.','analyzing']},
  {ms:2500, fn:'delegate', a:['claude','codex','Optimiza endpoints REST','Meta: latencia p95 < 100ms en /classify-task y /tasks.','working']},
  {ms:3300, fn:'delegate', a:['claude','deepseek','Analiza logs de errores','Revisa 24h. Identifica fallos de rate-limit y memory leaks.','working']},
  {ms:4100, fn:'delegate', a:['claude','mistral','Documenta API ES/EN/PT','Genera OpenAPI spec con 47 endpoints y ejemplos curl.','working']},
  {ms:4900, fn:'delegate', a:['claude','qwen','Responde queries frecuentes','Standby activo. Resuelve consultas durante las mejoras.','working']},
  {ms:5100, fn:'mode',     a:['claude','idle']},
  {ms:6200, fn:'decision', a:['¿Desplegar cambios a producción?','Codex propone actualizar dependencias en prod. Requiere aprobación humana para continuar.','codex']},
  {ms:9800, fn:'done',     a:['deepseek','Análisis completado ✓','3 bugs críticos: rate-limit 429 en /classify, 2 memory leaks en workers activos.','done']},
  {ms:11500,fn:'done',     a:['mistral','Docs generadas ✓','OpenAPI spec ES/EN/PT lista. 47 endpoints con ejemplos. Lista para deploy.','done']},
  {ms:13500,fn:'done',     a:['qwen','Standby completado','12 queries resueltas. 0 errores. En espera de nuevas instrucciones.','waiting']},
  {ms:15800,fn:'decision', a:['Memory leak activo en worker-qwen','DeepSeek detectó leak creciente. ¿Reiniciar proceso ahora o en ventana de mantenimiento?','deepseek']},
  {ms:18200,fn:'done',     a:['codex','Optimización lista ✓','Endpoints 43% más rápidos. p95=67ms. 12 tests verdes. Listo para deploy.','done']},
  {ms:19500,fn:'card',     a:['claude','Misión completada ✓','Todos los workers terminaron. Pendiente: aprobar deploy y decidir restart de worker.','done']},
  {ms:19800,fn:'mode',     a:['claude','celebrate']},
];

// ── STATE ────────────────────────────────────────────────────────────────────
var cvs=null,ctx2=null;
var W=800,H=600,TW=45,TH=22,OX=400,OY=60;
// Mouse-wheel zoom: mapZoom scales the base tile dims (TWbase) each resize/wheel;
// TW/TH always equal TWbase*mapZoom so BOTH drawing AND hit-testing (which project
// grid→screen via iso()) stay consistent at any zoom. Clamped so towers never
// shrink to slivers or balloon uncontrollably.
var mapZoom=1,TWbase=45,MAP_ZOOM_MIN=0.55,MAP_ZOOM_MAX=2.2;
var tick=0,running=false,lastFlow=0;
var nodeData=[],sparkles=[],links=[];
var selectedId=null,hoverAgentId=null,agentTasks={};
var BTNS=[],lastErr='';
var taskCards=[];
var decisions=[];     // persistent until resolved
var dataStacks={};
var agentModes={};
var agentPos={};      // {id:{x,y,tx,ty,timer,phase}}
var effTarget=0,effCur=0,effHistory=[];
var demoRunning=false,demoTimers=[];
var LW=262;           // left panel width
var panelStates={metrics:'open',spec:'open'}; // 'open'|'mini'|'closed'
// Manual pan offset (drag-to-scroll), added on top of the auto-centered
// origin — clamped so the tower cluster can't be dragged fully off-screen.
// Named mapPan* (not pan*) since drawLeftPanel() already has a local panY
// for its own panel y-position bookkeeping.
var mapPanX=0,mapPanY=0,isDraggingMap=false,dragMoved=false;
var dragStartClientX=0,dragStartClientY=0,dragStartPanX=0,dragStartPanY=0;
var PAN_RANGE_X=220,PAN_RANGE_Y=160;
// Phase 3: drag-a-figure-to-a-zone state. A pointerdown hit on a figure "arms" a
// potential drag (dragCandidateId) without yet committing to drag vs click; only
// once movement exceeds DRAG_THRESHOLD does it become an actual figure drag
// (isDraggingFigure) — reusing dragMoved to suppress the subsequent click-to-select,
// same mechanism the existing map-pan drag already relies on.
var dragCandidateId=null,isDraggingFigure=false,dragArmedClientX=0,dragArmedClientY=0;
var dragCurMX=0,dragCurMY=0,dragHoverZoneId=null;
var DRAG_THRESHOLD=6;
// ── DYNAMIC ROSTER (derived from Decisión architecture) ──────────────────────
// Deterministic string hash → stable per-entity spread (phase, workspot angle).
function hashId(s){s=String(s||'');var h=0;for(var i=0;i<s.length;i++){h=(h*31+s.charCodeAt(i))>>>0;}return h;}
// Lighten a #rrggbb hex toward white by amt∈[0,1] → the "acc" accent variant.
function lighten(hex,amt){
  if(!hex||hex.length<7)return hex||NEUTRAL_COL;
  var r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  r=Math.round(r+(255-r)*amt);g=Math.round(g+(255-g)*amt);b=Math.round(b+(255-b)*amt);
  return '#'+[r,g,b].map(function(v){return ('0'+Math.max(0,Math.min(255,v)).toString(16)).slice(-2);}).join('');
}
// Primary membership = the one with the LOWEST prio (mirrors server effective_tier()
// = min(prio); used here purely for visual identity/placement, never for dispatch).
function primaryMembership(ent){
  var ms=(ent&&ent.memberships)||[];var best=null;
  ms.forEach(function(m){if(best===null||Number(m.prio)<Number(best.prio))best=m;});
  return best;
}
function groupById(gid){
  var gs=(typeof state!=='undefined'&&Array.isArray(state.groups))?state.groups:[];
  for(var i=0;i<gs.length;i++)if(gs[i].id===gid)return gs[i];
  return null;
}
function memberPrio(ent,gid){
  if(!gid)return 0;
  var ms=(ent&&ent.memberships)||[];
  for(var i=0;i<ms.length;i++)if(ms[i].group_id===gid)return Number(ms[i].prio);
  return 999;
}
// Deterministic per-figure workstation offset (replaces the old 5-id WORKSPOTS/
// TOWER_OFFSETS lookup tables) so any entity id gets a stable spot near its home.
function workSpot(ag){
  var ang=(hashId(ag&&ag.id)%8)/8*Math.PI*2;
  return {dx:Math.cos(ang)*0.85,dy:Math.sin(ang)*0.7};
}
// Cluster entities by primary group into deterministic iso-grid regions and place
// members in a small ring ordered by their prio in that group. Empty "unassigned"
// region always reserved so the packing is stable regardless of orphan entities.
function layoutZones(){
  var groups=(typeof state!=='undefined'&&Array.isArray(state.groups))?state.groups:[];
  var entities=(typeof state!=='undefined'&&Array.isArray(state.entities))?state.entities:[];
  var buckets={},order=[];
  groups.forEach(function(g){buckets[g.id]=[];order.push(g.id);});
  buckets['']=[];order.push('');           // unassigned region
  entities.forEach(function(ent){
    var pm=primaryMembership(ent);
    var gid=(pm&&buckets[pm.group_id]!==undefined)?pm.group_id:'';
    buckets[gid].push(ent);
  });
  var lo=2,span=10;                          // usable grid band (clamp is 0.5..13.5)
  var cols=Math.max(1,Math.ceil(Math.sqrt(order.length)));
  var rows=Math.max(1,Math.ceil(order.length/cols));
  var cellW=span/cols,cellH=span/rows;
  var layout={},regions=[];
  order.forEach(function(gid,ri){
    var col=ri%cols,row=Math.floor(ri/cols);
    var cx=lo+cellW*(col+0.5),cy=lo+cellH*(row+0.5);
    var members=buckets[gid].slice().sort(function(a,b){
      return memberPrio(a,gid)-memberPrio(b,gid)||hashId(a.id)-hashId(b.id);
    });
    var n=members.length,radius=Math.min(cellW,cellH)*0.30;
    members.forEach(function(ent,i){
      var hx,hy;
      if(n===1){hx=cx;hy=cy;}
      else{var ang=(i/n)*Math.PI*2-Math.PI/2;hx=cx+Math.cos(ang)*radius;hy=cy+Math.sin(ang)*radius;}
      layout[ent.id]={hx:Math.round(hx*100)/100,hy:Math.round(hy*100)/100};
    });
    // Region rect for drawZones()/populateLegend() — margin (0.42 of cell) keeps a
    // visible gap between neighboring zones while comfortably containing the ring.
    var grp=gid?groupById(gid):null;
    var halfW=cellW*0.42,halfH=cellH*0.42;
    regions.push({
      id:gid,
      name:gid?(grp?grp.name:''):'Sin asignar',
      color:gid?((grp&&grp.color)||NEUTRAL_COL):NEUTRAL_COL,
      x0:cx-halfW,y0:cy-halfH,x1:cx+halfW,y1:cy+halfH,
      count:n,
    });
  });
  zoneLayout=layout;
  zoneRegions=regions;
  return layout;
}
// Draw a translucent colored platform per HierarchyGroup region (+ neutral
// "Sin asignar" region when it has members), with a name label. Renders before
// drawFloor()/drawWorkstations()/figures (see frame()) so it sits underneath them.
// Phase 3: a region with zero members is still drawn (as a temporary affordance)
// while a figure-drag is actively hovering over it, so "Sin asignar" is a valid
// visible drop target even when currently empty; and the hovered region is
// brightened so the user gets clear feedback of where a drop would land.
function drawZones(){
  zoneRegions.forEach(function(zn){
    var hovered=isDraggingFigure&&dragHoverZoneId===zn.id;
    if(!zn.count&&!hovered)return; // don't draw empty regions unless actively hovered
    var p0=iso(zn.x0,zn.y0),p1=iso(zn.x1,zn.y0),p2=iso(zn.x1,zn.y1),p3=iso(zn.x0,zn.y1);
    var maxX=Math.max(p0.x,p1.x,p2.x,p3.x),minX=Math.min(p0.x,p1.x,p2.x,p3.x);
    if(maxX<LW||minX>W)return; // cull off-screen
    ctx2.beginPath();
    ctx2.moveTo(p0.x,p0.y);ctx2.lineTo(p1.x,p1.y);ctx2.lineTo(p2.x,p2.y);ctx2.lineTo(p3.x,p3.y);ctx2.closePath();
    ctx2.fillStyle=c(zn.color,hovered?0.22:0.07);ctx2.fill();
    ctx2.strokeStyle=c(zn.color,hovered?0.8:0.3);ctx2.lineWidth=hovered?2:1;
    ctx2.setLineDash(hovered?[]:[6,5]);ctx2.stroke();ctx2.setLineDash([]);
    var topP=p0.y<=p1.y?p0:p1;                 // topmost of the two "front" corners
    ctx2.font='600 11px system-ui';ctx2.textAlign='center';ctx2.textBaseline='bottom';
    ctx2.fillStyle=c(zn.color,hovered?1:0.8);
    ctx2.fillText(zn.name,(p0.x+p2.x)/2,topP.y-6);
  });
}
// Point-in-polygon (ray casting) — used to test the drag cursor against the same
// iso-projected quadrilateral drawZones() renders for each region.
function pointInPoly(px,py,pts){
  var inside=false;
  for(var i=0,j=pts.length-1;i<pts.length;j=i++){
    var xi=pts[i].x,yi=pts[i].y,xj=pts[j].x,yj=pts[j].y;
    var hit=((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi);
    if(hit)inside=!inside;
  }
  return inside;
}
// Which zoneRegions entry (group id, or '' for "Sin asignar") the given canvas-space
// point falls inside, or null if it's outside every region (drop cancelled).
function zoneIdAtPoint(mx,my){
  for(var i=0;i<zoneRegions.length;i++){
    var zn=zoneRegions[i];
    var pts=[iso(zn.x0,zn.y0),iso(zn.x1,zn.y0),iso(zn.x1,zn.y1),iso(zn.x0,zn.y1)];
    if(pointInPoly(mx,my,pts))return zn.id;
  }
  return null;
}
// Fill #iso-legend with one item per non-empty zone region (color dot + name),
// reusing the existing .iso-legend-item/.iso-legend-dot CSS (index.html/styles.css).
function populateLegend(){
  var el=document.getElementById('iso-legend');
  if(!el)return;
  el.innerHTML=zoneRegions.filter(function(zn){return zn.count>0;}).map(function(zn){
    return '<div class="iso-legend-item"><span class="iso-legend-dot" style="background:'+zn.color+'"></span>'
      +escapeHtml(zn.name)+'</div>';
  }).join('');
}
// Map every state.entities[] entry to the per-figure shape the old AGENTS used.
function buildAgents(){
  var entities=(typeof state!=='undefined'&&Array.isArray(state.entities))?state.entities:[];
  var layout=zoneLayout||{};
  return entities.map(function(ent,idx){
    var pm=primaryMembership(ent);
    var grp=pm?groupById(pm.group_id):null;
    var col=(grp&&grp.color)?grp.color:NEUTRAL_COL;
    var pos=layout[ent.id]||{hx:7,hy:7};
    var skills=(ent.skills&&ent.skills.length)?ent.skills:(ent.capabilities||[]);
    var tier=Number(ent.tier)||3;
    return {
      id:ent.id,
      dataId:ent.id,                                   // fixes the /observability join (old dataIds were fake)
      hx:pos.hx,hy:pos.hy,
      col:col,
      acc:lighten(col,0.25),
      name:ent.name||roleDef(ent.role).label,
      role:roleDef(ent.role).label,                    // cosmetic HUD label
      level:'N'+Math.max(1,Math.min(5,6-tier)),        // lower tier → higher N (authority)
      skills:Array.isArray(skills)?skills:[],
      maxCap:Math.max(20,(Number(ent.max_concurrent)||1)*30), // relative capacity denominator
      ph:(idx*1.3)%(Math.PI*2),                         // deterministic phase spread
    };
  });
}
// Connection hub: prefer the parent-role entity, else lowest primary prio, else first.
function pickHubId(){
  var entities=(typeof state!=='undefined'&&Array.isArray(state.entities))?state.entities:[];
  if(!entities.length)return null;
  var parent=entities.find(function(e){return e.role==='parent'||(Array.isArray(e.role_tags)&&e.role_tags.indexOf('parent')>=0);});
  if(parent)return parent.id;
  var best=null,bestKey=Infinity;
  entities.forEach(function(e){var pm=primaryMembership(e);var k=pm?Number(pm.prio):999;if(k<bestKey){bestKey=k;best=e;}});
  return best?best.id:entities[0].id;
}
// (Re)build the whole roster from current state; deterministic, idempotent, safe to
// call repeatedly (view entry, initial load). Reseeds wander + recenters the view.
function rebuildRoster(){
  layoutZones();
  AGENTS=buildAgents();
  hubId=pickHubId();
  populateLegend();
  initWander();
  if(cvs)resize();
}

var DECISION_PROVIDER_ALIASES={
  claude: ['claude','anthropic','claude-cli'],
  codex: ['codex','openai'],
  qwen: ['ollama-qwen','qwen'],
  deepseek: ['ollama-deepseek','deepseek'],
  mistral: ['ollama-mistral-nemo','mistral'],
};

function agentUsesDecisionProvider(ag){
  if(typeof state==='undefined'||!state.entities)return false;
  var providers=activeArchitectureProviderNames();
  var aliases=DECISION_PROVIDER_ALIASES[ag.id]||[ag.id];
  return aliases.some(function(alias){
    alias=String(alias||'').toLowerCase();
    return Array.from(providers).some(function(provider){
      provider=String(provider||'').toLowerCase();
      return provider===alias||provider.indexOf(alias)>=0||alias.indexOf(provider)>=0;
    });
  });
}

function decisionTint(ag){
  return agentUsesDecisionProvider(ag)?'#F6C84F':ag.col;
}

// ── PROVIDER → ENTITY RESOLVER (Phase 2) ──────────────────────────────────────
// Single resolver replacing the 3 independent hardcoded provider/model→legacy-id
// switches that used to live in mapAgentNode(), poll(), and playTaskRecord's
// resolveNode(). Matches a free-form provider/model/backend string against the
// REAL state.entities[].provider field (substring either direction), plus the
// legacy DECISION_PROVIDER_ALIASES table as extra known short-name aliases (so a
// task record saying "claude" still resolves against an entity whose real
// provider is "claude-cli", or "openai" against a "codex" provider entity).
// Returns an array of matching entity ids — 0, 1, or many. Callers must treat an
// empty result as a graceful no-op (no fallback guess), same as the old code did
// for genuinely unmatched strings.
function entitiesForProviderName(str){
  var entities=(typeof state!=='undefined'&&Array.isArray(state.entities))?state.entities:[];
  str=String(str||'').toLowerCase();
  if(!str||!entities.length)return [];
  var candidates=[str];
  // Real task records store model_used as "backend:model" (e.g.
  // "ollama-qwen:qwen2.5:7b", "claude-cli:haiku") — the segment before the first
  // ':' is the actual backend/provider identifier, so try it as its own candidate.
  if(str.indexOf(':')>=0){var head=str.split(':')[0];if(candidates.indexOf(head)<0)candidates.push(head);}
  Object.keys(DECISION_PROVIDER_ALIASES).forEach(function(key){
    var arr=DECISION_PROVIDER_ALIASES[key]||[];
    var known=candidates.some(function(cand){return arr.indexOf(cand)>=0;});
    if(known){
      arr.forEach(function(a){if(candidates.indexOf(a)<0)candidates.push(a);});
      if(candidates.indexOf(key)<0)candidates.push(key);
    }
  });
  return entities.filter(function(ent){
    var provider=String(ent.provider||'').toLowerCase();
    if(!provider)return false;
    return candidates.some(function(cand){
      return provider===cand||provider.indexOf(cand)>=0||cand.indexOf(provider)>=0;
    });
  }).map(function(ent){return ent.id;});
}
// Pick a single entity id out of entitiesForProviderName()'s matches: the one
// holding its lowest Prio (mirrors primaryMembership()'s effective_tier() rule),
// falling back to the first match. Returns null for an empty/absent list.
function pickPrimaryEntityId(ids){
  if(!ids||!ids.length)return null;
  if(ids.length===1)return ids[0];
  var entities=(typeof state!=='undefined'&&Array.isArray(state.entities))?state.entities:[];
  var best=null,bestKey=Infinity;
  ids.forEach(function(id){
    var ent=entities.find(function(e){return e.id===id;});
    if(!ent)return;
    var pm=primaryMembership(ent);
    var k=pm?Number(pm.prio):999;
    if(k<bestKey){bestKey=k;best=id;}
  });
  return best||ids[0];
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function iso(gx,gy){return {x:OX+(gx-gy)*TW+mapPanX, y:OY+(gx+gy)*TH+mapPanY};}
function c(h,a){
  if(!h||h.length<7)return 'rgba(128,128,128,'+a+')';
  return 'rgba('+parseInt(h.slice(1,3),16)+','+parseInt(h.slice(3,5),16)+','+parseInt(h.slice(5,7),16)+','+a+')';
}
function agentLiftOffset(ag){
  var phase=(ag&&Number.isFinite(ag.ph))?ag.ph:0;
  return -(18*mapZoom)-Math.sin(tick*0.035+phase*3.1)*(3.5*mapZoom);
}
function agentBasePoint(ag){
  var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};
  var p=iso(pos.x,pos.y);
  return {x:p.x,y:p.y+TH};
}
function agentFloatPoint(ag,raise){
  var p=agentBasePoint(ag);
  return {x:p.x,y:p.y+agentLiftOffset(ag)-(raise||0)};
}
function rr(x,y,w,h,r){
  if(w<=0||h<=0)return;
  r=Math.min(Math.abs(r||0),Math.abs(w/2),Math.abs(h/2));
  ctx2.moveTo(x+r,y);ctx2.arcTo(x+w,y,x+w,y+h,r);ctx2.arcTo(x+w,y+h,x,y+h,r);
  ctx2.arcTo(x,y+h,x,y,r);ctx2.arcTo(x,y,x+w,y,r);ctx2.closePath();
}
function wrap(txt,maxW,maxL){
  var words=txt.split(' '),lines=[],cur='';
  words.forEach(function(w){var t=cur?cur+' '+w:w;if(ctx2.measureText(t).width>maxW&&cur){lines.push(cur);cur=w;}else cur=t;});
  if(cur)lines.push(cur);return maxL?lines.slice(0,maxL):lines;
}

// ── RESIZE ───────────────────────────────────────────────────────────────────
function resize(){
  if(!cvs)return;
  var rect=cvs.parentElement.getBoundingClientRect();
  W=Math.max(400,rect.width||800);H=Math.max(300,rect.height||600);
  TWbase=Math.min(42,Math.max(22,W*0.030));TW=TWbase*mapZoom;TH=TW*0.5;
  // Center the actual bounding box of the agent towers (not a fixed formula)
  // within the viewport band that's free of the header/footer HUD chrome —
  // the towers aren't symmetric around (0,0) in iso-space, so a fixed
  // formula left them visibly off-center.
  var minGX=Infinity,maxGX=-Infinity,minGY=Infinity,maxGY=-Infinity;
  AGENTS.forEach(function(ag){
    minGX=Math.min(minGX,ag.hx);maxGX=Math.max(maxGX,ag.hx);
    minGY=Math.min(minGY,ag.hy);maxGY=Math.max(maxGY,ag.hy);
  });
  if(!isFinite(minGX)){minGX=maxGX=7;minGY=maxGY=7;} // empty roster → center on grid
  var isoMinX=(minGX-maxGY)*TW,isoMaxX=(maxGX-minGY)*TW;
  var isoMinY=(minGX+minGY)*TH,isoMaxY=(maxGX+maxGY)*TH;
  var boxCx=(isoMinX+isoMaxX)/2,boxCy=(isoMinY+isoMaxY)/2;
  var topMargin=40,bottomMargin=52;
  var viewportCx=LW+(W-LW)*0.5,viewportCy=topMargin+(H-topMargin-bottomMargin)*0.5;
  OX=viewportCx-boxCx;
  OY=viewportCy-boxCy;
  var dpr=window.devicePixelRatio||1;
  cvs.width=Math.round(W*dpr);cvs.height=Math.round(H*dpr);
  ctx2.setTransform(dpr,0,0,dpr,0,0);
}

// ── NPC WANDER SYSTEM ────────────────────────────────────────────────────────
function initWander(){
  AGENTS.forEach(function(ag){
    if(!agentPos[ag.id])agentPos[ag.id]={x:ag.hx,y:ag.hy,tx:ag.hx,ty:ag.hy,timer:Math.round(ag.ph*80+60),phase:ag.ph};
  });
}
function setAgentTarget(id,tx,ty){
  var pos=agentPos[id];if(!pos)return;
  pos.tx=Math.max(0.5,Math.min(13.5,tx));
  pos.ty=Math.max(0.5,Math.min(13.5,ty));
}
function updateWander(){
  AGENTS.forEach(function(ag){
    var pos=agentPos[ag.id];if(!pos)return;
    var mode=(agentModes[ag.id]||{mode:'idle'}).mode;
    var dx=pos.tx-pos.x,dy=pos.ty-pos.y;
    var dist=Math.sqrt(dx*dx+dy*dy);
    if(dist>0.04){
      // walk toward target at mode-dependent speed
      var spd=mode==='working'?0.025:mode==='celebrate'?0.025:mode==='thinking'?0.009:0.012;
      var step=Math.min(dist,spd);
      pos.x+=dx/dist*step;pos.y+=dy/dist*step;
    } else {
      // arrived: snap and STAY — no jitter, no new targets
      pos.x=pos.tx;pos.y=pos.ty;
      // idle: micro breathing drift (very small, stays near home)
      if(mode==='idle'){
        if(--pos.timer<=0){
          pos.tx=ag.hx+(Math.random()-0.5)*0.15;
          pos.ty=ag.hy+(Math.random()-0.5)*0.15;
          pos.timer=180+Math.round(Math.random()*120);
        }
      }
      // working / celebrate: completely frozen at workspot, no new targets
    }
  });
}

// ── WORKSTATION BUILDINGS ─────────────────────────────────────────────────────
function drawWorkstations(){
  AGENTS.forEach(function(ag){
    var ws=workSpot(ag);
    var wx=ag.hx+ws.dx,wy=ag.hy+ws.dy;
    var p=iso(wx,wy);
    if(p.x+TW<LW||p.x-TW>W||p.y+TH>H+TH)return;
    var mode=(agentModes[ag.id]||{mode:'idle'}).mode;
    var active=mode==='working'||mode==='celebrate';
    var pulse=active?0.5+0.5*Math.abs(Math.sin(tick*0.07+ag.ph)):0;
    var bF=0.48,bTW=TW*bF,bTH=TH*bF,bH=TH*3.2;

    // platform (floor tile for this workstation)
    ctx2.beginPath();
    ctx2.moveTo(p.x,p.y);ctx2.lineTo(p.x+bTW,p.y+bTH);
    ctx2.lineTo(p.x,p.y+2*bTH);ctx2.lineTo(p.x-bTW,p.y+bTH);ctx2.closePath();
    ctx2.fillStyle=c(ag.col,active?0.18+0.12*pulse:0.07);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,active?0.5+0.25*pulse:0.18);ctx2.lineWidth=active?1.1:0.5;ctx2.stroke();

    // building left face
    ctx2.beginPath();
    ctx2.moveTo(p.x-bTW,p.y+bTH);ctx2.lineTo(p.x,p.y+2*bTH);
    ctx2.lineTo(p.x,p.y+2*bTH-bH);ctx2.lineTo(p.x-bTW,p.y+bTH-bH);ctx2.closePath();
    ctx2.fillStyle=c(ag.col,active?0.3+0.1*pulse:0.14);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,active?0.5:0.22);ctx2.lineWidth=0.7;ctx2.stroke();

    // building right face
    ctx2.beginPath();
    ctx2.moveTo(p.x,p.y+2*bTH);ctx2.lineTo(p.x+bTW,p.y+bTH);
    ctx2.lineTo(p.x+bTW,p.y+bTH-bH);ctx2.lineTo(p.x,p.y+2*bTH-bH);ctx2.closePath();
    ctx2.fillStyle=c(ag.col,active?0.2+0.08*pulse:0.08);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,active?0.4:0.18);ctx2.lineWidth=0.7;ctx2.stroke();

    // roof
    ctx2.beginPath();
    ctx2.moveTo(p.x,p.y-bH);ctx2.lineTo(p.x+bTW,p.y+bTH-bH);
    ctx2.lineTo(p.x,p.y+2*bTH-bH);ctx2.lineTo(p.x-bTW,p.y+bTH-bH);ctx2.closePath();
    ctx2.fillStyle=c(ag.col,active?0.45+0.2*pulse:0.22);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,active?0.62:0.28);ctx2.lineWidth=0.7;ctx2.stroke();

    // windows (right face) — glow when active
    var wY=p.y+bTH-bH*0.52;
    var w1X=p.x+bTW*0.1,w2X=p.x+bTW*0.55;
    ctx2.fillStyle=c(ag.acc,active?0.7+0.25*pulse:0.22);
    ctx2.fillRect(w1X,wY,bTW*0.32,bH*0.21);
    ctx2.fillRect(w2X,wY,bTW*0.28,bH*0.21);
    if(active){
      var gl=ctx2.createRadialGradient(w1X+bTW*0.16,wY+bH*0.1,0,w1X+bTW*0.16,wY+bH*0.1,bTW*0.5);
      gl.addColorStop(0,c(ag.acc,0.25*pulse));gl.addColorStop(1,c(ag.acc,0));
      ctx2.fillStyle=gl;ctx2.fillRect(w1X-8,wY-8,bTW*0.7,bH*0.4);
    }

    // door (left face, bottom-center)
    var dX=p.x-bTW*0.35,dY=p.y+2*bTH-bH*0.35;
    ctx2.fillStyle=c(ag.col,active?0.55:0.3);ctx2.fillRect(dX,dY,bTW*0.32,bH*0.32);
    ctx2.strokeStyle=c(ag.col,0.4);ctx2.lineWidth=0.5;ctx2.strokeRect(dX,dY,bTW*0.32,bH*0.32);

    // antenna
    ctx2.strokeStyle=c(ag.col,0.6);ctx2.lineWidth=1;
    ctx2.beginPath();ctx2.moveTo(p.x,p.y-bH);ctx2.lineTo(p.x,p.y-bH-7);ctx2.stroke();
    ctx2.fillStyle=c(ag.acc,active?0.9+0.1*pulse:0.35);
    ctx2.beginPath();ctx2.arc(p.x,p.y-bH-7,active?2.2:1.5,0,Math.PI*2);ctx2.fill();

    // agent name tag above building
    ctx2.fillStyle=c(ag.col,active?0.88:0.38);
    ctx2.font=(active?'bold ':'')+(TH*0.65)+'px system-ui';
    ctx2.textAlign='center';ctx2.textBaseline='bottom';
    ctx2.fillText(ag.name.split(' ')[0].substring(0,5),p.x,p.y-bH-10);
  });
}

// ── FLOOR (15×15) ────────────────────────────────────────────────────────────
function drawFloor(){
  var agHome={};AGENTS.forEach(function(a){agHome[a.hx+','+a.hy]=a;});
  var cells=[];
  for(var gx=0;gx<=14;gx++)for(var gy=0;gy<=14;gy++)cells.push({gx:gx,gy:gy,s:gx+gy});
  cells.sort(function(a,b){return a.s-b.s||a.gx-b.gx;});
  cells.forEach(function(cl){
    var p=iso(cl.gx,cl.gy);
    if(p.x+TW<LW||p.x-TW>W||p.y>H+TH)return; // cull
    var ag=agHome[cl.gx+','+cl.gy];
    // highlight tiles near active NPCs
    var nearCard=false;
    AGENTS.forEach(function(a){
      var pos=agentPos[a.id];
      if(!pos)return;
      var cards=taskCards.filter(function(cr){return cr.agentId===a.id&&cr.status!=='done'&&cr.status!=='waiting';});
      if(cards.length>0){
        var dx=pos.x-cl.gx,dy=pos.y-cl.gy;
        if(dx*dx+dy*dy<2.5)nearCard=true;
      }
    });
    ctx2.beginPath();
    ctx2.moveTo(p.x,p.y);ctx2.lineTo(p.x+TW,p.y+TH);
    ctx2.lineTo(p.x,p.y+2*TH);ctx2.lineTo(p.x-TW,p.y+TH);ctx2.closePath();
    var inDecision=ag&&agentUsesDecisionProvider(ag);
    var tileCol=inDecision?decisionTint(ag):(ag&&ag.col);
    ctx2.fillStyle=ag?c(tileCol,inDecision?0.24:0.14):nearCard?'rgba(100,160,255,0.04)':'rgba(255,255,255,0.018)';
    ctx2.strokeStyle=ag?c(tileCol,inDecision?0.72:0.4):nearCard?'rgba(100,160,255,0.06)':'rgba(255,255,255,0.045)';
    ctx2.lineWidth=0.6;ctx2.fill();ctx2.stroke();
  });
}

// ── DATA STACKS ──────────────────────────────────────────────────────────────
function tickDataStacks(){
  var now=Date.now();
  taskCards.forEach(function(card){
    if(card.status==='done'||card.status==='waiting')return;
    if(!dataStacks[card.agentId])dataStacks[card.agentId]={level:1,born:now};
    else dataStacks[card.agentId].level=Math.min(10,1+Math.floor((now-dataStacks[card.agentId].born)/1500));
  });
}
function drawDataStacks(){
  var now=Date.now();
  AGENTS.forEach(function(ag){
    var ds=dataStacks[ag.id];if(!ds)return;
    var card=taskCards.find(function(cr){return cr.agentId===ag.id;});
    var isDone=!card||(card.status==='done'||card.status==='waiting');
    if(isDone&&!ds.celebrating){ds.celebrating=true;ds.celebAt=now;}
    var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};
    var p=iso(pos.x,pos.y);
    var stX=p.x+TW*1.1,stY=p.y+TH*2.1;
    var tw2=TW*0.28,th2=TH*0.28;
    var levels=ds.level;
    if(ds.celebrating){
      var age=(now-ds.celebAt)/1000;
      if(age>1.8){delete dataStacks[ag.id];return;}
      levels=Math.max(0,Math.round(ds.level*(1-age/1.4)));
      stY-=age*25;
    }
    for(var lv=0;lv<levels;lv++){
      var ty=stY-lv*th2*2;
      var fc=ds.celebrating?'#60EE80':ag.col;
      var al=Math.min(0.9,0.45+lv*0.08);
      ctx2.beginPath();ctx2.moveTo(stX,ty);ctx2.lineTo(stX+tw2,ty+th2);
      ctx2.lineTo(stX,ty+2*th2);ctx2.lineTo(stX-tw2,ty+th2);ctx2.closePath();
      ctx2.fillStyle=c(fc,al*0.88);ctx2.fill();
      ctx2.strokeStyle=c(fc,al*0.45);ctx2.lineWidth=0.5;ctx2.stroke();
      if(lv===0){
        ctx2.beginPath();ctx2.moveTo(stX+tw2,ty+th2);ctx2.lineTo(stX+tw2,ty+th2*2);
        ctx2.lineTo(stX,ty+th2*3);ctx2.lineTo(stX,ty+th2*2);ctx2.closePath();
        ctx2.fillStyle=c(fc,al*0.45);ctx2.fill();
      }
    }
    if(!ds.celebrating&&levels>0){
      var ga=0.28+0.2*Math.sin(tick*0.12+ag.ph);
      ctx2.fillStyle=c(ag.acc,ga);ctx2.beginPath();ctx2.arc(stX,stY-levels*th2*2,3,0,Math.PI*2);ctx2.fill();
    }
  });
}

// ── AGENT CHARACTER ──────────────────────────────────────────────────────────
function drawAgent(ag){
  var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};
  var mode=(agentModes[ag.id]||{mode:'idle'}).mode;
  var sc=TW/50;
  var p=iso(pos.x,pos.y),cx=p.x,groundBase=p.y+TH,base=groundBase+agentLiftOffset(ag);
  var nd=nodeData.find(function(n){return n.id===ag.dataId;});
  var tc=(nd&&nd.task_count)||0;
  var cards=taskCards.filter(function(cr){return cr.agentId===ag.id&&cr.status!=='done';});
  if(cards.length>tc)tc=cards.length;
  var hp=Math.max(0.05,Math.min(1,1-tc/Math.max(1,ag.maxCap)));
  var inDecision=agentUsesDecisionProvider(ag);
  var mapAccent=decisionTint(ag);

  // movement direction tilt
  var pos2=agentPos[ag.id]||{};
  var tiltX=((pos2.tx||ag.hx)-(pos2.x||ag.hx))*3;
  tiltX=Math.max(-0.25,Math.min(0.25,tiltX));

  var breathSpd=mode==='working'?0.07:mode==='thinking'?0.04:0.022;
  var breathAmp=(mode==='working'?2.2:(tc>0?1.6:0.6))*sc;
  var breathe=Math.sin(tick*breathSpd+ag.ph)*breathAmp;
  if(mode==='celebrate')breathe+=Math.abs(Math.sin(tick*0.28+ag.ph))*7*sc;

  var bw=12*sc,bh=18*sc;
  var bodyBot=base-2*sc+breathe,bodyTop=bodyBot-bh,headCY=bodyTop-8*sc;
  // horizontal tilt for walking
  var cx2=cx+tiltX*TW*0.25;

  // working glow
  if(mode==='working'||mode==='thinking'){
    var ga=0.07+0.06*Math.sin(tick*0.09+ag.ph);
    ctx2.fillStyle=c(ag.col,ga);ctx2.beginPath();ctx2.arc(cx2,headCY,22*sc,0,Math.PI*2);ctx2.fill();
  }
  // shadow
  ctx2.globalAlpha=0.2;ctx2.fillStyle='#000';
  ctx2.beginPath();ctx2.ellipse(cx,groundBase,TW*0.58,TH*0.35,0,0,Math.PI*2);ctx2.fill();
  ctx2.globalAlpha=1;
  if(inDecision){
    ctx2.strokeStyle=c(mapAccent,0.86);ctx2.lineWidth=Math.max(1,1.5*sc);
    ctx2.beginPath();ctx2.ellipse(cx,groundBase,TW*0.72,TH*0.48,0,0,Math.PI*2);ctx2.stroke();
  }
  ctx2.strokeStyle=c(mapAccent,0.22);
  ctx2.lineWidth=Math.max(1,0.8*sc);
  ctx2.setLineDash([2.5*sc,3*sc]);
  ctx2.beginPath();ctx2.moveTo(cx,groundBase-TH*0.12);ctx2.lineTo(cx,base+2*sc);ctx2.stroke();ctx2.setLineDash([]);

  // body
  if(ag.id==='claude'){
    ctx2.fillStyle=ag.col;
    ctx2.beginPath();ctx2.moveTo(cx2-bw*0.4,bodyTop);ctx2.lineTo(cx2+bw*0.4,bodyTop);ctx2.lineTo(cx2+bw*0.7,bodyBot);ctx2.lineTo(cx2-bw*0.7,bodyBot);ctx2.closePath();ctx2.fill();
    ctx2.fillStyle=ag.acc;ctx2.beginPath();ctx2.moveTo(cx2-bw*0.16,bodyTop);ctx2.lineTo(cx2+bw*0.16,bodyTop);ctx2.lineTo(cx2,bodyTop+bh*0.42);ctx2.closePath();ctx2.fill();
    ctx2.strokeStyle='#C8A050';ctx2.lineWidth=2*sc;
    ctx2.beginPath();ctx2.moveTo(cx2+bw*0.82,bodyBot);ctx2.lineTo(cx2+bw*0.82,headCY-12*sc);ctx2.stroke();
    ctx2.fillStyle=ag.acc;ctx2.beginPath();ctx2.arc(cx2+bw*0.82,headCY-13*sc,3*sc,0,Math.PI*2);ctx2.fill();
  } else if(ag.id==='codex'){
    ctx2.fillStyle='#7040A8';ctx2.beginPath();ctx2.rect(cx2-bw*0.42,bodyTop,bw*0.84,bh);ctx2.fill();
    ctx2.fillStyle='#9060D8';ctx2.beginPath();ctx2.rect(cx2-bw*0.35,bodyTop+bh*0.15,bw*0.7,bh*0.25);ctx2.fill();
    ctx2.strokeStyle='#C090FF';ctx2.lineWidth=1.4*sc;
    ctx2.beginPath();ctx2.moveTo(cx2,bodyTop);ctx2.lineTo(cx2,bodyTop-10*sc);ctx2.stroke();
    ctx2.fillStyle='#FF60FF';ctx2.beginPath();ctx2.arc(cx2,bodyTop-11*sc,2.4*sc,0,Math.PI*2);ctx2.fill();
    // typing arm animation when working
    if(mode==='working'){
      var armA=Math.sin(tick*0.25)*0.5;
      ctx2.strokeStyle=c(ag.col,0.7);ctx2.lineWidth=1.5*sc;
      ctx2.beginPath();ctx2.moveTo(cx2+bw*0.4,bodyTop+bh*0.5);ctx2.lineTo(cx2+bw*0.8+armA*bw,bodyTop+bh*0.7);ctx2.stroke();
    }
  } else if(ag.id==='qwen'){
    ctx2.fillStyle='#2A7848';ctx2.beginPath();ctx2.ellipse(cx2,bodyTop+bh*0.5,bw*0.5,bh*0.5,0,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle='#48C878';ctx2.beginPath();ctx2.ellipse(cx2,bodyTop+bh*0.4,bw*0.42,bh*0.42,0,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle='#48C878';
    ctx2.beginPath();ctx2.ellipse(cx2-bw*0.62,headCY-2*sc,3*sc,5.5*sc,-0.4,0,Math.PI*2);ctx2.fill();
    ctx2.beginPath();ctx2.ellipse(cx2+bw*0.62,headCY-2*sc,3*sc,5.5*sc,0.4,0,Math.PI*2);ctx2.fill();
  } else if(ag.id==='deepseek'){
    ctx2.fillStyle='#A05020';ctx2.beginPath();ctx2.moveTo(cx2-bw*0.4,bodyTop);ctx2.lineTo(cx2+bw*0.4,bodyTop);ctx2.lineTo(cx2+bw*0.65,bodyBot);ctx2.lineTo(cx2-bw*0.65,bodyBot);ctx2.closePath();ctx2.fill();
    ctx2.fillStyle='rgba(255,200,140,0.38)';
    ctx2.beginPath();ctx2.moveTo(cx2,bodyTop);ctx2.lineTo(cx2-bw*0.15,bodyTop+bh*0.32);ctx2.lineTo(cx2,bodyTop+bh*0.37);ctx2.closePath();ctx2.fill();
    ctx2.beginPath();ctx2.moveTo(cx2,bodyTop);ctx2.lineTo(cx2+bw*0.15,bodyTop+bh*0.32);ctx2.lineTo(cx2,bodyTop+bh*0.37);ctx2.closePath();ctx2.fill();
    // magnifier swings when working
    var mAng=mode==='working'?Math.sin(tick*0.12+ag.ph)*0.4:0;
    ctx2.strokeStyle='#E89040';ctx2.lineWidth=2*sc;
    ctx2.beginPath();ctx2.arc(cx2+bw*0.92+mAng*bw,bodyBot-4*sc,4.5*sc,0,Math.PI*2);ctx2.stroke();
    ctx2.beginPath();ctx2.moveTo(cx2+bw*0.92+bw*0.06+mAng*bw,bodyBot-0.5*sc);ctx2.lineTo(cx2+bw*1.12+mAng*bw,bodyBot+4*sc);ctx2.stroke();
  } else {
    ctx2.fillStyle='#2060A0';ctx2.beginPath();ctx2.moveTo(cx2-bw*0.38,bodyTop);ctx2.lineTo(cx2+bw*0.38,bodyTop);ctx2.lineTo(cx2+bw*0.8,bodyBot+4*sc);ctx2.lineTo(cx2-bw*0.8,bodyBot+4*sc);ctx2.closePath();ctx2.fill();
    ctx2.fillStyle='#4898D0';ctx2.beginPath();ctx2.moveTo(cx2-bw*0.28,bodyTop);ctx2.lineTo(cx2+bw*0.28,bodyTop);ctx2.lineTo(cx2+bw*0.55,bodyBot);ctx2.lineTo(cx2-bw*0.55,bodyBot);ctx2.closePath();ctx2.fill();
    ctx2.fillStyle='#3070B8';ctx2.beginPath();ctx2.arc(cx2,headCY,8.5*sc,Math.PI,0);ctx2.closePath();ctx2.fill();
    // book/scroll when working
    if(mode==='working'){
      var bkA=Math.sin(tick*0.05+ag.ph)*0.2;
      ctx2.fillStyle=c(ag.col,0.6);ctx2.fillRect(cx2-bw*0.8-bkA*bw,bodyBot-bh*0.4,bw*0.5,bh*0.35);
    }
  }

  // head
  ctx2.fillStyle=ag.id==='codex'?'#8050C0':'#C89858';
  ctx2.beginPath();ctx2.arc(cx2,headCY,7*sc,0,Math.PI*2);ctx2.fill();
  if(ag.id==='claude'){
    ctx2.fillStyle=ag.col;ctx2.beginPath();ctx2.moveTo(cx2-9*sc,headCY-2*sc);ctx2.lineTo(cx2+9*sc,headCY-2*sc);ctx2.lineTo(cx2,headCY-19*sc);ctx2.closePath();ctx2.fill();
  } else if(ag.id==='codex'){
    ctx2.fillStyle='rgba(64,255,255,0.52)';ctx2.beginPath();ctx2.rect(cx2-5.5*sc,headCY-2.2*sc,11*sc,4*sc);ctx2.fill();
  }

  // eyes — sleeping/awake/working logic
  var eyeOff=tiltX*6*sc;
  var sleeping=mode==='idle';
  // sleeping: eyes almost always shut, rare drowsy half-open
  var eyeH=sleeping
    ?(((tick+Math.round(ag.ph*90))%260<10)?0.55:0.08)
    :(((tick+Math.round(ag.ph*90))%220>216)?0.1:1);
  ctx2.fillStyle='#1A2030';
  ctx2.beginPath();ctx2.ellipse(cx2-4*sc+eyeOff,headCY-1*sc,1.8*sc,2.2*sc*eyeH,0,0,Math.PI*2);ctx2.fill();
  ctx2.beginPath();ctx2.ellipse(cx2+4*sc+eyeOff,headCY-1*sc,1.8*sc,2.2*sc*eyeH,0,0,Math.PI*2);ctx2.fill();
  if(!sleeping&&(tc>0||mode==='working')){
    ctx2.fillStyle=c(ag.col,0.9);
    ctx2.beginPath();ctx2.arc(cx2-4*sc+eyeOff,headCY-1*sc,1.1*sc,0,Math.PI*2);ctx2.fill();
    ctx2.beginPath();ctx2.arc(cx2+4*sc+eyeOff,headCY-1*sc,1.1*sc,0,Math.PI*2);ctx2.fill();
  }
  // closed-eye line overlay when sleeping
  if(sleeping&&eyeH<0.2){
    ctx2.strokeStyle='rgba(160,120,80,0.7)';ctx2.lineWidth=1.4*sc;
    ctx2.beginPath();ctx2.moveTo(cx2-6.5*sc+eyeOff,headCY-1*sc);ctx2.lineTo(cx2-1.5*sc+eyeOff,headCY-1*sc);ctx2.stroke();
    ctx2.beginPath();ctx2.moveTo(cx2+1.5*sc+eyeOff,headCY-1*sc);ctx2.lineTo(cx2+6.5*sc+eyeOff,headCY-1*sc);ctx2.stroke();
  }
  // mouth
  ctx2.strokeStyle=sleeping?'rgba(100,80,60,0.5)':(tc>0||mode==='working'||mode==='celebrate')?ag.col:'#4A5A6A';
  ctx2.lineWidth=sc*0.85;ctx2.beginPath();
  if(sleeping){ctx2.arc(cx2,headCY+5*sc,2.2*sc,Math.PI+0.3,Math.PI*2-0.3);}  // tiny sleep frown
  else if(tc>0||mode==='celebrate'){ctx2.arc(cx2,headCY+3*sc,3.2*sc,0.2,Math.PI-0.2);}
  else{ctx2.moveTo(cx2-3*sc,headCY+3*sc);ctx2.lineTo(cx2+3*sc,headCY+3*sc);}
  ctx2.stroke();

  // thinking dots
  if(mode==='thinking'){
    var dp=Math.floor(tick/18)%3;
    for(var di=0;di<3;di++){ctx2.fillStyle=c(ag.col,di<=dp?0.9:0.18);ctx2.beginPath();ctx2.arc(cx2+(di-1)*6*sc,headCY-22*sc,2*sc,0,Math.PI*2);ctx2.fill();}
  }
  // sleeping Zzz
  if(sleeping){
    var zt=(tick+Math.round(ag.ph*120))%180;
    var zSizes=[9,11,13];
    var zOffs=[{x:6,y:20},{x:9,y:28},{x:13,y:37}];
    for(var zi=0;zi<3;zi++){
      var zStart=zi*45,zLen=55;
      if(zt>=zStart&&zt<zStart+zLen){
        var zAge=(zt-zStart)/zLen;
        ctx2.globalAlpha=(zAge<0.25?zAge*4:(zAge>0.75?(1-zAge)*4:1))*0.7;
        ctx2.fillStyle='rgba(160,200,255,0.9)';
        ctx2.font='bold '+zSizes[zi]+'px system-ui';ctx2.textAlign='center';ctx2.textBaseline='bottom';
        ctx2.fillText('z',cx2+zOffs[zi].x*sc,headCY-zOffs[zi].y*sc);
        ctx2.globalAlpha=1;
      }
    }
  }
  // working particles
  if(mode==='working'&&tick%20===Math.round(ag.ph*10)%20){
    sparkles.push({x:cx2+(Math.random()-0.5)*10*sc,y:headCY-8*sc,vx:(Math.random()-0.5)*1.2,vy:-0.9-Math.random(),life:1,col:ag.acc,sz:1+Math.random()*1.5});
  }
  // celebrate burst
  if(mode==='celebrate'&&tick%7===0){
    for(var si=0;si<3;si++)sparkles.push({x:cx2+(Math.random()-0.5)*18*sc,y:headCY+(Math.random()-0.5)*18*sc,vx:(Math.random()-0.5)*3,vy:-2-Math.random()*2,life:1,col:ag.acc,sz:2+Math.random()*2});
  }

  // HP bar
  var barW=bw*2.4,barH=3*sc,barX=cx-barW/2,barY=headCY-14*sc;
  ctx2.fillStyle='rgba(6,10,16,0.85)';ctx2.beginPath();rr(barX-1,barY-1,barW+2,barH+2,2);ctx2.fill();
  var hpCol=hp>0.6?'#48C878':hp>0.3?'#D4A828':'#E05050';
  ctx2.fillStyle=hpCol;ctx2.beginPath();rr(barX,barY,Math.max(2,barW*hp),barH,2);ctx2.fill();
  ctx2.fillStyle=c(hpCol,0.75);ctx2.font=Math.round(TW*0.13)+'px monospace';ctx2.textAlign='right';ctx2.textBaseline='middle';
  ctx2.fillText(Math.round(hp*100)+'%',barX+barW,barY-2.5*sc);

  // name
  var nameY=barY-6.5*sc;
  ctx2.font='bold '+Math.round(TW*0.2)+'px system-ui,sans-serif';
  if(inDecision){
    ctx2.fillStyle=c(mapAccent,0.95);
    ctx2.font='800 '+Math.round(TW*0.12)+'px system-ui,sans-serif';
    ctx2.textAlign='center';ctx2.textBaseline='bottom';ctx2.fillText('EN DECISIÓN',cx,nameY-12*sc);
    ctx2.font='bold '+Math.round(TW*0.2)+'px system-ui,sans-serif';
  }
  ctx2.fillStyle=selectedId===ag.id?'#FFF':mapAccent;ctx2.textAlign='center';ctx2.textBaseline='bottom';ctx2.fillText(ag.name,cx,nameY);
  ctx2.font='600 '+Math.round(TW*0.135)+'px system-ui';
  var lw=ctx2.measureText(ag.level).width,lx=cx+ctx2.measureText(ag.name).width/2+3.5*sc;
  ctx2.fillStyle=c(mapAccent,inDecision?0.28:0.2);ctx2.beginPath();rr(lx,nameY-9*sc,lw+5*sc,8*sc,2);ctx2.fill();
  ctx2.strokeStyle=c(mapAccent,inDecision?0.58:0.4);ctx2.lineWidth=0.5;ctx2.beginPath();rr(lx,nameY-9*sc,lw+5*sc,8*sc,2);ctx2.stroke();
  ctx2.fillStyle=mapAccent;ctx2.textAlign='center';ctx2.fillText(ag.level,lx+lw/2+2.5*sc,nameY-1*sc);

  // skill chips
  ctx2.font=Math.round(TW*0.12)+'px system-ui';
  var chipH=7.5*sc,chipGap=2*sc;
  var cws=ag.skills.map(function(s){return ctx2.measureText(s).width+8*sc;});
  var totalCW=cws.reduce(function(a,b){return a+b;},0)+(ag.skills.length-1)*chipGap;
  var chipX=cx-totalCW/2,skillY=nameY-13*sc;
  ag.skills.forEach(function(skill,i){
    var cw=cws[i];
    ctx2.fillStyle=c(ag.col,0.14);ctx2.beginPath();rr(chipX,skillY-chipH,cw,chipH,3);ctx2.fill();
    ctx2.strokeStyle=c(ag.col,0.36);ctx2.lineWidth=0.5;ctx2.beginPath();rr(chipX,skillY-chipH,cw,chipH,3);ctx2.stroke();
    ctx2.fillStyle=c(ag.col,0.88);ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText(skill,chipX+cw/2,skillY-chipH/2);chipX+=cw+chipGap;
  });

  // task bubble
  if(tc>0){
    var pls=1+Math.sin(tick*0.09+ag.ph)*0.18;
    ctx2.fillStyle=ag.col;ctx2.beginPath();ctx2.arc(cx+bw*0.8,headCY-7*sc,6.5*sc*pls,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle='rgba(0,0,0,0.8)';ctx2.font='bold '+Math.round(TW*0.16)+'px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText(tc,cx+bw*0.8,headCY-7*sc);
  }
  // orbit
  var orR=9*sc+Math.sin(tick*0.03)*1.3;
  ctx2.strokeStyle=c(ag.col,0.12);ctx2.lineWidth=sc;ctx2.beginPath();ctx2.arc(cx,headCY,orR,0,Math.PI*2);ctx2.stroke();
  var ang=tick*0.04+ag.ph;
  ctx2.fillStyle=ag.acc;ctx2.beginPath();ctx2.arc(cx+Math.cos(ang)*orR,headCY+Math.sin(ang)*orR,1.6*sc,0,Math.PI*2);ctx2.fill();
  // selection
  if(selectedId===ag.id){
    ctx2.strokeStyle=c(ag.col,0.7);ctx2.lineWidth=2*sc;ctx2.setLineDash([4*sc,3*sc]);ctx2.lineDashOffset=-(tick*1.4)%18;
    ctx2.beginPath();ctx2.ellipse(cx,groundBase,TW*0.8,TH*0.55,0,0,Math.PI*2);ctx2.stroke();ctx2.setLineDash([]);
  }
  ctx2.font=Math.round(TW*0.11)+'px system-ui';ctx2.fillStyle=c(ag.col,0.38);ctx2.textAlign='center';ctx2.textBaseline='top';ctx2.fillText(ag.role,cx,groundBase+1.5*sc);
}

// ── TASK CARDS ───────────────────────────────────────────────────────────────
function drawTaskCards(){
  var now=Date.now();
  taskCards.forEach(function(card){
    var ag=AGENTS.find(function(a){return a.id===card.agentId;});if(!ag)return;
    var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};
    var p=iso(pos.x,pos.y);
    var cW=155,cH=72;
    var offX=ag.hx>=7?-(cW+TW*0.5):TW*0.5;
    var cx2=p.x+offX,cy2=p.y-TH*1.2-cH;
    var rightBound=selectedId?(W-cW-212):(W-cW-4);
    cy2=Math.max(8,Math.min(H-cH-8,cy2));cx2=Math.max(LW+4,Math.min(rightBound,cx2));
    var age=(now-card.born)/1000;
    var alpha=Math.min(1,age*3);
    if(card.lifeMs&&(now-card.born)>card.lifeMs-500)alpha=Math.max(0,(card.lifeMs-(now-card.born))/500);
    ctx2.globalAlpha=alpha;
    var sc2=card.status==='done'?'#48C878':card.status==='waiting'?'#D4A828':card.status==='analyzing'?'#9060D8':ag.col;
    ctx2.fillStyle='rgba(8,12,20,0.93)';ctx2.beginPath();rr(cx2,cy2,cW,cH,6);ctx2.fill();
    ctx2.strokeStyle=c(sc2,0.58);ctx2.lineWidth=1;ctx2.beginPath();rr(cx2,cy2,cW,cH,6);ctx2.stroke();
    ctx2.fillStyle=sc2;ctx2.beginPath();ctx2.arc(cx2+9,cy2+9,3,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle=ag.col;ctx2.font='bold 9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText(ag.name,cx2+16,cy2+5);
    var sl=card.status==='done'?'HECHO':card.status==='waiting'?'ESPERA':card.status==='analyzing'?'ANÁLISIS':'ACTIVO';
    ctx2.fillStyle=sc2;ctx2.font='bold 7.5px system-ui';ctx2.textAlign='right';ctx2.fillText(sl,cx2+cW-5,cy2+5);
    ctx2.fillStyle='#DDE8F0';ctx2.font='bold 10px system-ui';ctx2.textAlign='left';
    ctx2.fillText((card.title||'').substring(0,23)+(card.title.length>23?'…':''),cx2+5,cy2+20);
    ctx2.fillStyle='rgba(165,192,212,0.72)';ctx2.font='8.5px system-ui';
    var ls=wrap(card.desc,cW-10,2);ls.forEach(function(l,i){ctx2.fillText(l,cx2+5,cy2+33+i*10);});
    if(card.status==='working'||card.status==='analyzing'){
      var pr=((now-card.born)/5500)%1;
      ctx2.fillStyle='rgba(255,255,255,0.07)';ctx2.beginPath();rr(cx2+5,cy2+cH-9,cW-10,4,2);ctx2.fill();
      ctx2.fillStyle=sc2;ctx2.beginPath();rr(cx2+5,cy2+cH-9,Math.max(3,(cW-10)*pr),4,2);ctx2.fill();
    }
    ctx2.strokeStyle=c(sc2,0.25);ctx2.lineWidth=0.7;ctx2.setLineDash([3,4]);
    ctx2.beginPath();ctx2.moveTo(cx2+cW/2,cy2+cH);ctx2.lineTo(p.x,p.y+TH);ctx2.stroke();ctx2.setLineDash([]);
    ctx2.globalAlpha=1;
  });
  var now2=Date.now();
  taskCards=taskCards.filter(function(cr){return !cr.lifeMs||(now2-cr.born)<cr.lifeMs;});
}

// ── DECISION NOTIFICATIONS (persistent, non-blocking) ────────────────────────
// The canvas no longer writes the notification bell (#notificationBadge/
// #notificationSummary). The real renderNotifications() (driven by state.tasks)
// is the single writer; canvas-scripted decisions live on the canvas only.
function escHtml(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function drawDecisions(){
  var now=Date.now();
  var active=decisions.filter(function(d){return !d.resolved;});
  var specH=selectedId?Math.min(195,H-100):0;
  var ny=70+specH+(specH>0?10:0); // below agent spec panel when open
  active.slice(0,3).forEach(function(d){
    var nW=255,nH=110,nX=W-nW-8;
    var age=(now-d.born)/1000,slide=Math.max(0,1-age*5);
    var drawX=nX+slide*(nW+20);
    ctx2.globalAlpha=Math.min(1,age*5);
    var gp=0.65+0.35*Math.abs(Math.sin(tick*0.06));
    // shadow
    ctx2.fillStyle='rgba(0,0,0,0.38)';ctx2.beginPath();rr(drawX+3,ny+4,nW,nH-2,9);ctx2.fill();
    // body
    ctx2.fillStyle='rgba(16,20,30,0.96)';ctx2.beginPath();rr(drawX,ny,nW,nH,8);ctx2.fill();
    // titlebar
    ctx2.fillStyle='rgba(120,70,10,0.85)';ctx2.beginPath();rr(drawX,ny,nW,24,6);ctx2.fill();
    ctx2.strokeStyle='rgba(255,155,30,'+gp+')';ctx2.lineWidth=1.5;ctx2.beginPath();rr(drawX,ny,nW,nH,8);ctx2.stroke();
    // dismiss X in titlebar
    ctx2.globalAlpha=ctx2.globalAlpha; // keep current
    winBtn(drawX+nW-20,ny+4,16,16,'255,80,80','×','dismiss_decision');
    BTNS[BTNS.length-1].d=d; // attach decision ref
    ctx2.globalAlpha=Math.min(1,age*5); // restore
    ctx2.fillStyle='#FFB020';ctx2.font='14px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';ctx2.fillText('⚠ DECISIÓN REQUERIDA',drawX+8,ny+12);
    if(d.agentId){ctx2.fillStyle='rgba(255,200,100,0.6)';ctx2.font='8.5px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('['+d.agentId.toUpperCase()+']',drawX+8,ny+25);}
    ctx2.fillStyle='#E8EEF6';ctx2.font='bold 11px system-ui';
    ctx2.fillText((d.title||'').substring(0,34),drawX+7,ny+37);
    ctx2.fillStyle='rgba(165,192,212,0.8)';ctx2.font='9.5px system-ui';
    var dl=wrap(d.desc,nW-14,2);dl.forEach(function(l,i){ctx2.fillText(l,drawX+7,ny+50+i*11);});
    var bY=ny+nH-23,bH2=18,aW=Math.round((nW-18)/2),aX=drawX+6,rX=aX+aW+6;
    ctx2.fillStyle='rgba(72,200,120,0.2)';ctx2.beginPath();rr(aX,bY,aW,bH2,4);ctx2.fill();
    ctx2.strokeStyle='rgba(72,200,120,0.65)';ctx2.lineWidth=0.8;ctx2.beginPath();rr(aX,bY,aW,bH2,4);ctx2.stroke();
    ctx2.fillStyle='#48C878';ctx2.font='bold 10px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('Aprobar',aX+aW/2,bY+bH2/2);
    ctx2.fillStyle='rgba(220,80,80,0.2)';ctx2.beginPath();rr(rX,bY,aW,bH2,4);ctx2.fill();
    ctx2.strokeStyle='rgba(220,80,80,0.65)';ctx2.lineWidth=0.8;ctx2.beginPath();rr(rX,bY,aW,bH2,4);ctx2.stroke();
    ctx2.fillStyle='#E05858';ctx2.font='bold 10px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('Rechazar',rX+aW/2,bY+bH2/2);
    BTNS.push({x:aX,y:bY,w:aW,h:bH2,action:'approve',d:d});
    BTNS.push({x:rX,y:bY,w:aW,h:bH2,action:'reject', d:d});
    ctx2.globalAlpha=1;ny+=nH+4;
  });
  // remove old resolved ones after 4s
  decisions=decisions.filter(function(d){return !d.resolved||(Date.now()-d.resolvedAt)<4000;});
}

// ── LEFT PANEL ───────────────────────────────────────────────────────────────
function winBtn(x,y,w,h,col,label,action){
  ctx2.fillStyle='rgba('+col+',0.18)';ctx2.beginPath();rr(x,y,w,h,3);ctx2.fill();
  ctx2.strokeStyle='rgba('+col+',0.55)';ctx2.lineWidth=0.8;ctx2.beginPath();rr(x,y,w,h,3);ctx2.stroke();
  ctx2.fillStyle='rgba('+col+',0.9)';ctx2.font='bold 11px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText(label,x+w/2,y+h/2);
  BTNS.push({x:x,y:y,w:w,h:h,action:action});
}
function drawLeftPanel(){
  effCur+=(effTarget-effCur)*0.025;
  var st=panelStates.metrics;
  var panH=st==='mini'?26:(H-62);
  var panY=50;
  // closed: show tiny floating tab to reopen
  if(st==='closed'){
    ctx2.fillStyle='rgba(50,90,170,0.85)';ctx2.beginPath();rr(0,panY,24,46,4);ctx2.fill();
    ctx2.fillStyle='rgba(160,200,255,0.9)';ctx2.font='bold 9px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('M',12,panY+23);
    BTNS.push({x:0,y:panY,w:24,h:46,action:'open_metrics'});
    return;
  }
  // shadow
  ctx2.fillStyle='rgba(0,0,0,0.4)';ctx2.beginPath();rr(11,panY+4,LW-16,panH-2,12);ctx2.fill();
  // window body
  ctx2.fillStyle='rgba(8,12,22,0.95)';ctx2.beginPath();rr(8,panY,LW-16,panH,10);ctx2.fill();
  // titlebar stripe (26px)
  ctx2.fillStyle='rgba(35,70,150,0.88)';ctx2.beginPath();rr(8,panY,LW-16,26,6);ctx2.fill();
  // border
  ctx2.strokeStyle='rgba(55,95,165,0.4)';ctx2.lineWidth=1;ctx2.beginPath();rr(8,panY,LW-16,panH,10);ctx2.stroke();
  // title
  ctx2.fillStyle='rgba(190,215,255,0.95)';ctx2.font='bold 10px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';ctx2.fillText('MÉTRICAS DEL SISTEMA',16,panY+13);
  // window buttons — only minimize (no close). Inset from LW-25 to LW-30 so
  // the button doesn't sit flush against the panel's own right border.
  winBtn(LW-30,panY+5,17,17,'255,190,30',st==='mini'?'▪':'─',st==='mini'?'open_metrics':'mini_metrics');

  if(st==='mini')return;
  var px=16,py=panY+32;
  ctx2.fillStyle='rgba(60,90,150,0.3)';ctx2.beginPath();ctx2.rect(px,py,LW-30,0.5);ctx2.fill();py+=8;

  // efficiency gauge — number drawn inside the arc
  ctx2.fillStyle='rgba(130,170,230,0.6)';ctx2.font='9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';
  ctx2.fillText('Ahorro de Claude',px,py);py+=14;
  var effPct=Math.round(effCur);
  var eCol=effPct>70?'#48C878':effPct>35?'#D4A828':'#E05050';
  var gR=46,gCx=px+(LW-30)/2,gCy=py+gR+6;
  // track
  ctx2.strokeStyle='rgba(255,255,255,0.07)';ctx2.lineWidth=9;
  ctx2.beginPath();ctx2.arc(gCx,gCy,gR,Math.PI*0.75,Math.PI*2.25);ctx2.stroke();
  // fill arc
  if(effCur>0){
    ctx2.strokeStyle=eCol;ctx2.lineWidth=9;
    ctx2.beginPath();ctx2.arc(gCx,gCy,gR,Math.PI*0.75,Math.PI*0.75+Math.PI*1.5*(Math.min(effCur,100)/100));ctx2.stroke();
  }
  // soft inner glow
  ctx2.fillStyle=c(eCol,0.07);ctx2.beginPath();ctx2.arc(gCx,gCy,gR-5,0,Math.PI*2);ctx2.fill();
  // large % number
  ctx2.fillStyle=eCol;ctx2.font='bold 34px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';
  ctx2.fillText(effPct+'%',gCx,gCy-5);
  ctx2.fillStyle='rgba(140,175,215,0.65)';ctx2.font='8.5px system-ui';
  ctx2.fillText('delegado a workers',gCx,gCy+16);
  py=gCy+gR+14;

  // sparkline
  if(effHistory.length>1){
    ctx2.fillStyle='rgba(130,170,230,0.55)';ctx2.font='9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('Progreso',px,py);py+=11;
    var slW=LW-26,slH=28;
    ctx2.fillStyle='rgba(0,0,0,0.32)';ctx2.beginPath();rr(px,py,slW,slH,3);ctx2.fill();
    var hist=effHistory.slice(-22);
    var step2=slW/Math.max(hist.length-1,1);
    // fill
    ctx2.fillStyle='rgba(72,152,208,0.09)';ctx2.beginPath();
    hist.forEach(function(v,i){var hx=px+i*step2,hy=py+slH-(v/100)*slH;if(i===0)ctx2.moveTo(hx,hy);else ctx2.lineTo(hx,hy);});
    ctx2.lineTo(px+(hist.length-1)*step2,py+slH);ctx2.lineTo(px,py+slH);ctx2.closePath();ctx2.fill();
    ctx2.strokeStyle='#4898D0';ctx2.lineWidth=1.2;ctx2.beginPath();
    hist.forEach(function(v,i){var hx=px+i*step2,hy=py+slH-(v/100)*slH;if(i===0)ctx2.moveTo(hx,hy);else ctx2.lineTo(hx,hy);});ctx2.stroke();
    // dot at end
    var lastH=hist[hist.length-1];
    ctx2.fillStyle='#60B0FF';ctx2.beginPath();ctx2.arc(px+(hist.length-1)*step2,py+slH-(lastH/100)*slH,2.5,0,Math.PI*2);ctx2.fill();
    py+=slH+10;
  } else py+=8;

  ctx2.fillStyle='rgba(60,90,150,0.25)';ctx2.beginPath();ctx2.rect(px,py,LW-24,0.5);ctx2.fill();py+=8;
  ctx2.fillStyle='rgba(130,170,230,0.6)';ctx2.font='9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('Carga por agente',px,py);py+=12;

  AGENTS.forEach(function(ag){
    var nd=nodeData.find(function(n){return n.id===ag.dataId;});
    var tc=(nd&&nd.task_count)||0;
    var cards=taskCards.filter(function(cr){return cr.agentId===ag.id&&cr.status!=='done';});
    if(cards.length>tc)tc=cards.length;
    var load=Math.min(1,tc/Math.max(1,ag.maxCap));
    var alive=tc>0;
    // status indicator
    if(alive){var mp=0.6+0.4*Math.abs(Math.sin(tick*0.08+ag.ph));ctx2.fillStyle=c(ag.col,mp);ctx2.beginPath();ctx2.arc(px+3,py+6,3,0,Math.PI*2);ctx2.fill();}
    else{ctx2.fillStyle='rgba(80,100,130,0.4)';ctx2.beginPath();ctx2.arc(px+3,py+6,2.5,0,Math.PI*2);ctx2.fill();}
    ctx2.fillStyle=alive?ag.col:'rgba(90,110,140,0.5)';
    ctx2.font=(alive?'bold ':'')+'8.5px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';
    ctx2.fillText(ag.name.substring(0,10),px+9,py+6);
    // thicker bar with breathing room from the panel's right edge and a
    // reserved slot for the percentage label so it never touches the bar.
    var numX=LW-16,bW=LW-24-68-34,bX2=px+68;
    ctx2.fillStyle='rgba(255,255,255,0.06)';ctx2.beginPath();rr(bX2,py+1,bW,10,3);ctx2.fill();
    if(load>0){ctx2.fillStyle=ag.col;ctx2.beginPath();rr(bX2,py+1,Math.max(4,bW*load),10,3);ctx2.fill();}
    ctx2.fillStyle=alive?ag.col:'rgba(90,110,140,0.5)';ctx2.font='7.5px monospace';ctx2.textAlign='right';
    ctx2.fillText(Math.round(load*100)+'%',numX,py+6);py+=18;
  });

  py+=5;ctx2.fillStyle='rgba(60,90,150,0.25)';ctx2.beginPath();ctx2.rect(px,py,LW-24,0.5);ctx2.fill();py+=8;

  // decisions count
  var pend=decisions.filter(function(d){return !d.resolved;}).length;
  if(pend>0){
    var dp2=0.7+0.3*Math.abs(Math.sin(tick*0.07));
    ctx2.fillStyle='rgba(255,155,30,'+dp2+')';ctx2.font='bold 9.5px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';
    ctx2.fillText('⚠ '+pend+' decisión'+(pend>1?'es':'')+' pendiente'+(pend>1?'s':''),px,py);py+=14;
  }
  var wAct=AGENTS.filter(function(ag){return taskCards.some(function(cr){return cr.agentId===ag.id&&cr.status!=='done';});}).length;
  ctx2.fillStyle='rgba(110,150,190,0.65)';ctx2.font='8.5px system-ui';ctx2.textAlign='left';ctx2.textBaseline='top';
  ctx2.fillText('Workers activos: '+wAct+'/'+AGENTS.length,px,py);py+=12;
  if(demoRunning){
    var dmp=0.55+0.45*Math.abs(Math.sin(tick*0.09));ctx2.fillStyle='rgba(80,220,120,'+dmp+')';ctx2.font='bold 8.5px system-ui';
    ctx2.fillText('◉ DEMO EN CURSO',px,py);
  }
}

// ── CONNECTIONS ───────────────────────────────────────────────────────────────
// Mirror Decisión's focused relationship flow on the iso map: structural links
// are curved and lifted above the floor, and only the hovered/selected agent's
// neighborhood is drawn so dense architectures do not turn into a knot.
function drawFloatingCurve(src,dst,color,dashed){
  var sp=agentFloatPoint(src,18*mapZoom),dp=agentFloatPoint(dst,18*mapZoom);
  var midX=(sp.x+dp.x)/2,midY=Math.min(sp.y,dp.y)-Math.max(38,62*mapZoom);
  ctx2.save();
  ctx2.strokeStyle=color;ctx2.lineWidth=Math.max(1.2,1.75*mapZoom);
  ctx2.shadowColor=color;ctx2.shadowBlur=8*mapZoom;
  if(dashed){ctx2.setLineDash([6*mapZoom,5*mapZoom]);ctx2.lineDashOffset=-(tick*0.7)%22;}
  else ctx2.setLineDash([]);
  ctx2.beginPath();ctx2.moveTo(sp.x,sp.y);ctx2.quadraticCurveTo(midX,midY,dp.x,dp.y);ctx2.stroke();
  ctx2.setLineDash([]);
  ctx2.shadowBlur=0;
  ctx2.fillStyle=color;
  ctx2.beginPath();ctx2.arc(sp.x,sp.y,2.6*mapZoom,0,Math.PI*2);ctx2.fill();
  ctx2.beginPath();ctx2.arc(dp.x,dp.y,2.6*mapZoom,0,Math.PI*2);ctx2.fill();
  ctx2.restore();
}
function drawConnections(){
  if(!AGENTS.length)return; // dynamic roster may be empty before layout loads
  var entities=(typeof state!=='undefined'&&Array.isArray(state.entities))?state.entities:[];
  var focusId=hoverAgentId||selectedId;
  if(!focusId)return;
  var byId={};AGENTS.forEach(function(a){byId[a.id]=a;});
  var hub=AGENTS.find(function(a){return a.id===hubId;})||AGENTS[0];
  var hasAny=false;
  // Hierarchy: hub -> each entity with a parentId (gold, solid, focused).
  entities.forEach(function(ent){
    if(!ent.parentId)return;
    var ag=byId[ent.id];if(!ag||ag.id===hub.id)return;
    if(focusId!==hub.id&&focusId!==ag.id)return;
    hasAny=true;
    drawFloatingCurve(hub,ag,'rgba(249,199,79,0.82)',false);
  });
  // Supervision: guardian/validator entities -> their target_ids (dashed, focused).
  entities.forEach(function(ent){
    var tids=Array.isArray(ent.target_ids)?ent.target_ids:[];
    if(!tids.length)return;
    var tags=Array.isArray(ent.role_tags)?ent.role_tags:[];
    var isG=tags.indexOf('guardian')>=0,isV=tags.indexOf('validator')>=0;
    if(!isG&&!isV)return;
    var src=byId[ent.id];if(!src)return;
    tids.forEach(function(tid){
      var dst=byId[tid];if(!dst)return;
      if(focusId!==src.id&&focusId!==dst.id)return;
      hasAny=true;
      drawFloatingCurve(src,dst,isG?'rgba(185,167,255,0.84)':'rgba(91,188,255,0.86)',true);
    });
  });
  if(hasAny&&byId[focusId]){
    var fp=agentFloatPoint(byId[focusId],18*mapZoom);
    ctx2.save();
    ctx2.strokeStyle='rgba(255,255,255,0.22)';ctx2.lineWidth=1.2*mapZoom;
    ctx2.beginPath();ctx2.arc(fp.x,fp.y,9*mapZoom,0,Math.PI*2);ctx2.stroke();
    ctx2.restore();
  }
  ctx2.setLineDash([]);
}
function spawnSpark(ag){
  if(!ag)return; // dynamic roster: guard against undefined (e.g. AGENTS[0] on empty roster)
  var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};var p=iso(pos.x,pos.y);
  for(var i=0;i<6;i++)sparkles.push({x:p.x+(Math.random()-0.5)*TW,y:p.y+TH*0.8,vx:(Math.random()-0.5)*2,vy:-1.5-Math.random()*2.5,life:1,col:ag.col,sz:1.5+Math.random()*2.5});
}
function drawSparkles(){
  ctx2.save();
  for(var i=0;i<sparkles.length;i++){var s=sparkles[i];s.x+=s.vx;s.y+=s.vy;s.vy*=0.96;s.life-=0.022;ctx2.globalAlpha=Math.max(0,s.life)*0.85;ctx2.fillStyle=s.col;ctx2.beginPath();ctx2.arc(s.x,s.y,Math.max(0.1,s.sz*s.life),0,Math.PI*2);ctx2.fill();}
  ctx2.restore();
  for(var j=sparkles.length-1;j>=0;j--)if(sparkles[j].life<=0)sparkles.splice(j,1);
}
function drawLinks(){
  for(var k=0;k<links.length;k++){
    var lk=links[k];var src=AGENTS.find(function(a){return a.id===lk.from;}),dst=AGENTS.find(function(a){return a.id===lk.to;});
    if(!src||!dst){lk.prog=2;continue;}
    var sp=iso(src.hx,src.hy),dp2=iso(dst.hx,dst.hy);
    var sx=sp.x,sy=sp.y+TH,dx=dp2.x,dy=dp2.y+TH,cpY=Math.min(sy,dy)-55;
    ctx2.save();ctx2.strokeStyle=c(src.col,0.35);ctx2.lineWidth=1.8;ctx2.setLineDash([5,4]);ctx2.lineDashOffset=-(tick*1.6)%18;
    ctx2.beginPath();ctx2.moveTo(sx,sy);ctx2.quadraticCurveTo((sx+dx)/2,cpY,dx,dy);ctx2.stroke();ctx2.restore();
    var t=Math.min(lk.prog,1),mt=1-t;
    var ox=mt*mt*sx+2*mt*t*(sx+dx)/2+t*t*dx,oy=mt*mt*sy+2*mt*t*cpY+t*t*dy;
    ctx2.fillStyle=src.col;ctx2.beginPath();ctx2.arc(ox,oy,4.5,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle=c(src.col,0.28);ctx2.beginPath();ctx2.arc(ox,oy,8,0,Math.PI*2);ctx2.fill();
    lk.prog+=0.009;
  }
  links=links.filter(function(l){return l.prog<=1.05;});
}

// ── HUD ──────────────────────────────────────────────────────────────────────
function drawInfoPanel(){
  var ag=AGENTS.find(function(a){return a.id===selectedId;});if(!ag)return;
  var PW=255,PH=Math.min(195,H-100),PX=W-PW-8;
  var PY=70; // always anchored at top-right
  var panH=PH;
  // shadow
  ctx2.fillStyle='rgba(0,0,0,0.4)';ctx2.beginPath();rr(PX+3,PY+4,PW,panH-2,12);ctx2.fill();
  // body
  ctx2.fillStyle='rgba(10,14,22,0.95)';ctx2.beginPath();rr(PX,PY,PW,panH,9);ctx2.fill();
  // titlebar
  ctx2.fillStyle=c(ag.col,0.55);ctx2.beginPath();rr(PX,PY,PW,26,6);ctx2.fill();
  ctx2.strokeStyle=c(ag.col,0.45);ctx2.lineWidth=1.2;ctx2.beginPath();rr(PX,PY,PW,panH,9);ctx2.stroke();
  // title text
  ctx2.font='bold 11px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';
  var titleText=ag.name+' '+ag.level;
  var titleWidth=ctx2.measureText(titleText).width; // measure BEFORE switching font below, or this reads the wrong metrics
  ctx2.fillStyle='rgba(255,255,255,0.92)';ctx2.fillText(titleText,PX+10,PY+13);
  ctx2.fillStyle='rgba(255,255,255,0.55)';ctx2.font='9px system-ui';ctx2.fillText(ag.role,PX+10+titleWidth+8,PY+13);
  // only close button (no minimize)
  winBtn(PX+PW-22,PY+5,17,17,'255,70,70','×','close_panel');
  var y2=PY+30,pad=PX+9;
  var nd=nodeData.find(function(n){return n.id===ag.dataId;});
  var tc=(nd&&nd.task_count)||0;
  var cards=taskCards.filter(function(cr){return cr.agentId===ag.id;});if(cards.length>tc)tc=cards.length;
  var hp=Math.max(0.05,Math.min(1,1-tc/Math.max(1,ag.maxCap)));
  ctx2.fillStyle=ag.col;ctx2.font='bold 14px system-ui';ctx2.textAlign='left';ctx2.fillText(ag.name+' '+ag.level,pad,y2);y2+=17;
  ctx2.fillStyle='#7A9AAA';ctx2.font='10px system-ui';ctx2.fillText(ag.role,pad,y2);y2+=14;
  ctx2.fillStyle='rgba(0,0,0,0.5)';ctx2.beginPath();ctx2.rect(pad,y2,PW-18,4);ctx2.fill();
  ctx2.fillStyle=hp>0.6?'#48C878':hp>0.3?'#D4A828':'#E05050';ctx2.beginPath();ctx2.rect(pad,y2,(PW-18)*hp,4);ctx2.fill();
  ctx2.fillStyle='#7A9AAA';ctx2.font='8.5px monospace';ctx2.textAlign='right';ctx2.fillText('HP '+Math.round(hp*100)+'%',PX+PW-9,y2+1);y2+=13;
  ag.skills.forEach(function(s){ctx2.fillStyle=c(ag.col,0.14);ctx2.beginPath();ctx2.rect(pad,y2,PW-18,10);ctx2.fill();ctx2.fillStyle=c(ag.col,0.78);ctx2.font='9px system-ui';ctx2.textAlign='left';ctx2.fillText('▸ '+s,pad+3,y2);y2+=12;});
  y2+=3;
  cards.forEach(function(cr){ctx2.fillStyle='rgba(195,218,238,0.65)';ctx2.font='8.5px system-ui';ctx2.fillText('• '+(cr.title||'').substring(0,26),pad,y2);y2+=11;});
}

function drawHUD(){
  // beacon (BTNS[] already cleared at frame start)
  var bp=0.55+0.45*Math.abs(Math.sin(tick*0.05));
  ctx2.fillStyle='rgba(80,140,220,'+bp+')';ctx2.beginPath();ctx2.arc(W/2,17,7,0,Math.PI*2);ctx2.fill();
  ctx2.fillStyle='#CDE';ctx2.font='bold 10.5px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('KARAJAN · Sistema de IA',W/2+14,17);
  // bottom strip
  var sx=LW+6,sy=H-11;
  ctx2.fillStyle='rgba(8,12,20,0.7)';ctx2.beginPath();rr(sx-4,sy-11,AGENTS.length*78+10,16,3);ctx2.fill();
  AGENTS.forEach(function(ag){
    var nd=nodeData.find(function(n){return n.id===ag.dataId;});
    var tc=(nd&&nd.task_count)||0;
    var cards=taskCards.filter(function(cr){return cr.agentId===ag.id&&cr.status!=='done';});
    if(cards.length>tc)tc=cards.length;
    var alive=tc>0;
    ctx2.fillStyle=alive?ag.col:'#2A3A4A';ctx2.beginPath();ctx2.arc(sx,sy,4,0,Math.PI*2);ctx2.fill();
    ctx2.fillStyle=alive?'#EEE':'#4A5A6A';ctx2.font=(alive?'bold ':'')+'9px system-ui';ctx2.textAlign='left';ctx2.textBaseline='middle';
    ctx2.fillText(ag.name,sx+7,sy);sx+=78;
  });
  // buttons
  var BW2=128,BH2=27,BX=W-BW2-8,BY=H-BH2-8;
  ctx2.fillStyle='rgba(80,140,220,0.22)';ctx2.beginPath();rr(BX,BY,BW2,BH2,5);ctx2.fill();
  ctx2.strokeStyle='rgba(80,140,220,0.65)';ctx2.lineWidth=1;ctx2.beginPath();rr(BX,BY,BW2,BH2,5);ctx2.stroke();
  ctx2.fillStyle='#8BC8FF';ctx2.font='bold 11.5px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';ctx2.fillText('+ Nueva misión',BX+BW2/2,BY+BH2/2);
  BTNS.push({x:BX,y:BY,w:BW2,h:BH2,action:'new_task'});
  var DW=98,DH=27,DX=BX-DW-6,DY=BY;
  ctx2.fillStyle=demoRunning?'rgba(80,220,120,0.25)':'rgba(220,180,40,0.18)';ctx2.beginPath();rr(DX,DY,DW,DH,5);ctx2.fill();
  ctx2.strokeStyle=demoRunning?'rgba(80,220,120,0.7)':'rgba(220,180,40,0.55)';ctx2.lineWidth=1;ctx2.beginPath();rr(DX,DY,DW,DH,5);ctx2.stroke();
  ctx2.fillStyle=demoRunning?'#80EE80':'#F0D860';ctx2.font='bold 11.5px system-ui';ctx2.textAlign='center';ctx2.textBaseline='middle';
  ctx2.fillText(demoRunning?'Detener':'Demostrar',DX+DW/2,DY+DH/2);
  BTNS.push({x:DX,y:DY,w:DW,h:DH,action:'demo'});
  if(lastErr){ctx2.fillStyle='rgba(180,20,20,0.8)';ctx2.font='10px monospace';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('ERR:'+lastErr.substring(0,80),LW+6,6);}
  if(selectedId)drawInfoPanel();
  drawDecisions();
}

// ── DEMO RUNNER ───────────────────────────────────────────────────────────────
var DACT={
  userTask:function(t){spawnSpark(AGENTS[0]);spawnSpark(AGENTS[0]);taskCards.push({agentId:'claude',title:'Misión recibida',desc:t,status:'analyzing',born:Date.now(),lifeMs:28000});},
  mode:function(id,m){
    agentModes[id]={mode:m,since:Date.now()};
    var ag=AGENTS.find(function(a){return a.id===id;});
    var pos=agentPos[id];
    if(!ag||!pos)return;
    if(m==='working'||m==='thinking'){
      var ws=workSpot(ag);
      setAgentTarget(id,ag.hx+ws.dx,ag.hy+ws.dy);
    } else if(m==='idle'){
      setAgentTarget(id,ag.hx,ag.hy); // return home to sleep
    } else if(m==='celebrate'){
      pos.timer=12;
      if(ag)spawnSpark(ag);
    }
  },
  card:function(id,title,desc,status){
    taskCards=taskCards.filter(function(cr){return cr.agentId!==id||cr.status==='working';});
    taskCards.push({agentId:id,title:title,desc:desc,status:status,born:Date.now(),lifeMs:26000});
    if(status==='done'){DACT.mode(id,'celebrate');}
  },
  delegate:function(from,to,title,desc,status){
    var dst=AGENTS.find(function(a){return a.id===to;});if(dst){links.push({from:from,to:to,prog:0});spawnSpark(dst);}
    DACT.mode(to,'working');
    taskCards.push({agentId:to,title:title,desc:desc,status:status,born:Date.now(),lifeMs:24000});
    effTarget=Math.min(98,effTarget+17);effHistory.push(effTarget);if(effHistory.length>30)effHistory.shift();
  },
  done:function(id,title,desc,status){
    taskCards=taskCards.filter(function(cr){return cr.agentId!==id;});
    taskCards.push({agentId:id,title:title,desc:desc,status:status,born:Date.now(),lifeMs:8000});
    DACT.mode(id,'celebrate');
    var ds=dataStacks[id];if(ds){ds.celebrating=true;ds.celebAt=Date.now();}
    setTimeout(function(){DACT.mode(id,'idle');},3800); // return home → sleep
  },
  decision:function(title,desc,agentId){
    decisions.push({title:title,desc:desc,agentId:agentId,born:Date.now(),resolved:false});
  }
};
function startDemo(){
  if(demoRunning)return;stopDemo();stopReal();demoRunning=true;
  taskCards=[];links=[];sparkles=[];dataStacks={};
  // keep existing unresolved decisions, only clear resolved ones
  decisions=decisions.filter(function(d){return !d.resolved;});
  effTarget=0;effCur=0;effHistory=[];
  AGENTS.forEach(function(ag){agentModes[ag.id]={mode:'idle',since:Date.now()};});
  DEMO.forEach(function(step){demoTimers.push(setTimeout(function(){if(DACT[step.fn])DACT[step.fn].apply(null,step.a);},step.ms));});
  demoTimers.push(setTimeout(function(){demoRunning=false;},23000));
}
function stopDemo(){demoTimers.forEach(clearTimeout);demoTimers=[];demoRunning=false;}

// ── REAL TASK ANIMATION ───────────────────────────────────────────────────────
// Drives the same canvas primitives (DACT) from real backend task records
// (GET /tasks, GET /tasks/{id}) instead of the scripted DEMO. The demo stays as
// the empty-state showcase (no task history). Live task_changed SSE events call
// karajanCanvas.onTaskChanged(id) to re-animate a task as it advances.
var realRunning=false,realTimers=[],pendingTaskId=null,bootstrapped=false,lastPlayedSig='';
function stopReal(){realTimers.forEach(clearTimeout);realTimers=[];realRunning=false;}
function realSched(ms,fn){realTimers.push(setTimeout(fn,ms));}
function tierLabelES(t){
  t=(t||'').toLowerCase();
  if(t.indexOf('cheap')>=0)return 'económico';
  if(t.indexOf('medium')>=0)return 'intermedio';
  if(t.indexOf('strong')>=0)return 'potente';
  return t;
}
function snip(s,n){s=(s||'').replace(/\s+/g,' ').trim();return s.length>n?s.slice(0,n)+'…':s;}
function fetchTaskRecord(id){
  return fetch(apiUrl('/tasks/'+encodeURIComponent(id))).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;});
}
// Signature so we don't replay the identical state twice in a row (e.g. an
// enterView bootstrap right after a live event for the same task).
function taskSig(task){
  var d=task.delegation;
  return (task.task_id||'')+'|'+(task.status||'')+'|'+((d&&d.executions&&d.executions.length)||0)
    +'|'+((d&&d.executions&&d.executions.filter(function(e){return e.status;}).map(function(e){return e.status;}).join(','))||'');
}
function playTaskRecord(task){
  if(!task||!task.classification)return;
  var sig=taskSig(task);
  if(sig===lastPlayedSig&&realRunning)return;
  lastPlayedSig=sig;
  stopDemo();stopReal();
  realRunning=true;
  // reset transient canvas state (mirrors startDemo; leaves nodeData/poll data)
  taskCards=[];links=[];sparkles=[];dataStacks={};
  decisions=decisions.filter(function(d){return !d.resolved;});
  effTarget=0;effCur=0;effHistory=[];
  AGENTS.forEach(function(ag){agentModes[ag.id]={mode:'idle',since:Date.now()};});

  var cls=task.classification;
  var prompt=task.prompt||cls.original_prompt||cls.prompt||'Tarea';
  var domain=(cls.domain||[]).slice(0,2).join(', ')||'general';
  var summary='Dominio: '+domain+(cls.intent?(' · Intención: '+cls.intent):'')+(cls.complexity_level?(' · Nivel: '+cls.complexity_level):'');
  realSched(0,function(){DACT.userTask(prompt);});
  realSched(700,function(){DACT.mode('claude','thinking');});
  realSched(1000,function(){DACT.card('claude','Clasificando…',summary,'analyzing');});

  var del=task.delegation;
  var execs=(del&&del.executions)||[];
  if(execs.length){
    var subMap={};(cls.subtasks||[]).forEach(function(s){subMap[s.id]=s;});
    // Resolve the real entity id this execution actually ran on, via the single
    // provider→entity resolver (Phase 2) — no more hardcoded rotation fallback:
    // an execution whose model_used/backend matches no known entity provider
    // simply isn't animated (more correct than guessing a wrong figure).
    var resolveNode=function(ex){
      var ids=entitiesForProviderName(ex.model_used).concat(entitiesForProviderName(ex.backend));
      var uniq=[];ids.forEach(function(id){if(uniq.indexOf(id)<0)uniq.push(id);});
      return pickPrimaryEntityId(uniq);
    };
    var delBase=2400;
    execs.forEach(function(ex,i){
      var node=resolveNode(ex);ex._node=node;
      if(!node)return; // no matching entity — skip animating this execution
      var sub=subMap[ex.subtask_id]||{};
      var subName=sub.name||ex.subtask_id||'Subtarea';
      var tgt=ex.model_used||sub.recommended_model||cls.recommended_model||'';
      var tier=tierLabelES(sub.recommended_model||cls.recommended_model);
      var meta='Modelo: '+(tgt||'—')+(tier?(' ('+tier+')'):'');
      realSched(delBase+i*750,function(){DACT.delegate('claude',node,snip(subName,40),meta,'working');});
    });
    realSched(delBase+200,function(){DACT.mode('claude','idle');});
    var doneBase=delBase+execs.length*750+1600;
    execs.forEach(function(ex,i){
      var node=ex._node;
      if(!node)return; // no matching entity — nothing to mark done
      var ok=!ex.error&&['success','completed','ok','done'].indexOf((ex.status||'').toLowerCase())>=0;
      var cost=ex.estimated_cost_usd!=null?('$'+Number(ex.estimated_cost_usd).toFixed(4)):'';
      var lat=ex.latency_ms!=null?(Math.round(ex.latency_ms)+'ms'):'';
      var costLat=[cost,lat].filter(Boolean).join(' · ');
      realSched(doneBase+i*900,function(){
        if(ok){
          var meta=[snip(ex.output,80),costLat].filter(Boolean).join(' — ')||'Ejecutado';
          DACT.done(node,'✓ Completado',meta,'done');
        } else {
          var err=snip(ex.error||ex.output,90)||'Fallo en ejecución';
          DACT.done(node,'✗ Error',[err,costLat].filter(Boolean).join(' — '),'waiting');
        }
      });
    });
    var endT=doneBase+execs.length*900+1600;
    var totCost=del.total_estimated_cost_usd!=null?('$'+Number(del.total_estimated_cost_usd).toFixed(4)):'';
    var totLat=del.total_latency_ms!=null?(Math.round(del.total_latency_ms)+'ms'):'';
    realSched(endT,function(){DACT.card('claude','Misión completada ✓','Agentes: '+execs.length+([totCost,totLat].filter(Boolean).length?(' · '+[totCost,totLat].filter(Boolean).join(' · ')):''),'done');DACT.mode('claude','celebrate');});
    realSched(endT+500,realDone);
  } else {
    // classification only, delegation pending
    if(cls.requires_human_review){
      realSched(1900,function(){DACT.decision('Revisión humana requerida',snip(cls.reason,120)||'Esta tarea requiere aprobación antes de delegar.','claude');});
    }
    realSched(4200,function(){DACT.mode('claude','idle');realDone();});
  }
}
function realDone(){
  realRunning=false;
  var p=pendingTaskId;pendingTaskId=null;
  if(p)onTaskChangedReal(p);
}
// Called from the outer SSE dispatcher on a task_changed event (human view only).
function onTaskChangedReal(taskId){
  if(!taskId)return;
  if(realRunning){pendingTaskId=taskId;return;} // queue latest; play after current
  fetchTaskRecord(taskId).then(function(task){
    if(task&&task.classification)playTaskRecord(task);
  });
}
// Called on entering / activating the human view: real history → animate the
// newest task; empty → play the scripted demo so the view is never dead.
function bootstrapCanvas(){
  rebuildRoster(); // refresh figures from current Decisión data on every (re)entry
  if(bootstrapped||demoRunning||realRunning)return;
  bootstrapped=true;
  fetch(apiUrl('/tasks?limit=1')).then(function(r){return r.ok?r.json():null;}).then(function(list){
    if(list&&list.length&&list[0]&&list[0].classification){playTaskRecord(list[0]);}
    else{startDemo();}
  }).catch(function(){if(!demoRunning&&!realRunning)startDemo();});
}
// Expose the hooks the outer app scope needs (SSE + view switching). refreshNodes
// lets the shared initLiveEvents() dispatcher refresh the left-panel per-agent
// metrics (nodeData) on run events, replacing this module's old private 5s poll.
window.karajanCanvas={onTaskChanged:onTaskChangedReal,bootstrap:bootstrapCanvas,playTaskRecord:playTaskRecord,refreshNodes:poll,rebuildRoster:rebuildRoster};
window.__isoTest={ // TEMP test-only hook (removed after verification)
  zoom:function(){return mapZoom;},
  cvs:function(){var r=cvs.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,W:W,H:H};},
  agentScreen:function(id){var ag=AGENTS.find(function(a){return a.id===id;});if(!ag)return null;var pos=agentPos[ag.id]||{x:ag.hx,y:ag.hy};var p=iso(pos.x,pos.y);return {x:p.x,y:p.y+TH};},
  zoneCenter:function(id){var zn=zoneRegions.find(function(z){return z.id===id;});if(!zn)return null;var a=iso(zn.x0,zn.y0),b=iso(zn.x1,zn.y1);return {x:(a.x+b.x)/2,y:(a.y+b.y)/2};},
  zones:function(){return zoneRegions.map(function(z){return {id:z.id,name:z.name,count:z.count};});},
  agents:function(){return AGENTS.map(function(a){return a.id;});}
};

// ── MISSION INPUT ─────────────────────────────────────────────────────────────
function showMissionInput(){
  if(document.getElementById('k-ov'))return;
  var ov=document.createElement('div');ov.id='k-ov';
  ov.style.cssText='position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);z-index:9999;font-family:system-ui,sans-serif;';
  ov.innerHTML='<div style="background:#0E1520;border:1.5px solid #4898D0;border-radius:11px;padding:20px;width:360px;max-width:90vw;">'
    +'<div style="color:#4898D0;font-weight:bold;font-size:14px;margin-bottom:5px;">+ Nueva misión para Karajan</div>'
    +'<div style="color:#8AB0C8;font-size:11px;margin-bottom:11px;">Claude analizará y delegará a los agentes adecuados.</div>'
    +'<textarea id="k-tx" placeholder="Ej: Analiza el rendimiento de la API..." style="width:100%;box-sizing:border-box;height:68px;background:#060C14;border:1px solid #2A4060;border-radius:5px;color:#CDE;padding:7px;font-size:12px;resize:none;outline:none;"></textarea>'
    +'<div style="display:flex;gap:7px;margin-top:11px;">'
    +'<button id="k-cn" style="flex:1;padding:7px;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.3);border-radius:5px;color:#FF8080;cursor:pointer;font-size:11px;">Cancelar</button>'
    +'<button id="k-sn" style="flex:2;padding:7px;background:rgba(72,152,208,0.2);border:1px solid rgba(72,152,208,0.5);border-radius:5px;color:#8BC8FF;cursor:pointer;font-weight:bold;font-size:11px;">Enviar misión</button>'
    +'</div></div>';
  document.body.appendChild(ov);
  var txt=document.getElementById('k-tx');txt.focus();
  document.getElementById('k-cn').onclick=function(){ov.remove();};
  document.getElementById('k-sn').onclick=function(){
    var val=txt.value.trim();if(!val)return;ov.remove();
    DACT.userTask(val);DACT.mode('claude','thinking');
    setTimeout(function(){DACT.mode('claude','idle');},5000);
    fetch(apiUrl('/classify-task'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:val})}).then(function(){poll();}).catch(function(){});
  };
  ov.addEventListener('keydown',function(e){if(e.key==='Escape')ov.remove();});
}

// ── POLL ─────────────────────────────────────────────────────────────────────
function poll(){
  Promise.all([
    fetch(apiUrl('/observability')).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;}),
    fetch(apiUrl('/tasks?limit=30')).then(function(r){return r.ok?r.json():null;}).catch(function(){return null;})
  ]).then(function(res){
    var obs=res[0];
    if(obs){
      if(obs.nodes)nodeData=obs.nodes;
      var flow=obs.execution_flow||[];
      flow.slice(lastFlow).forEach(function(ev){
        if((ev.event_type||'')!=='task_delegated')return;
        var toId=pickPrimaryEntityId(entitiesForProviderName(ev.target_node));
        if(toId){links.push({from:hubId,to:toId,prog:0});var dst=AGENTS.find(function(a){return a.id===toId;});if(dst)spawnSpark(dst);}
      });
      lastFlow=flow.length;
    }
    if(res[1]){agentTasks={};res[1].forEach(function(t){
      var tgt=(t.delegation&&t.delegation.target_node)||'';
      var id=pickPrimaryEntityId(entitiesForProviderName(tgt))||hubId;
      if(!id)return;
      if(!agentTasks[id])agentTasks[id]=[];if(agentTasks[id].length<5)agentTasks[id].push({prompt:t.classification&&t.classification.prompt});
    });}
  }).catch(function(){});
}

// ── FRAME ────────────────────────────────────────────────────────────────────
function frame(){
  if(running&&cvs)requestAnimationFrame(frame);
  tick++;
  try{
    BTNS=[];
    ctx2.globalAlpha=1;ctx2.clearRect(0,0,W,H);
    ctx2.fillStyle='#0C0F14';ctx2.fillRect(0,0,W,H);
    var bg=ctx2.createRadialGradient(OX,OY+80,40,OX,OY+80,Math.max(W,H)*0.85);
    bg.addColorStop(0,'rgba(18,28,48,0.85)');bg.addColorStop(1,'rgba(0,0,0,0)');
    ctx2.fillStyle=bg;ctx2.fillRect(0,0,W,H);
    updateWander();tickDataStacks();
    drawZones();drawFloor();drawWorkstations();drawConnections();
    var sorted=AGENTS.slice().sort(function(a,b){var pa=agentPos[a.id]||{y:a.hy},pb=agentPos[b.id]||{y:b.hy};return (pa.x+pa.y)-(pb.x+pb.y);});
    for(var i=0;i<sorted.length;i++){try{drawAgent(sorted[i]);}catch(ae){lastErr=sorted[i].id+':'+ae.message;}}
    drawDragGhost();
    drawDataStacks();drawLinks();drawSparkles();ctx2.globalAlpha=1;
    drawTaskCards();drawLeftPanel();drawHUD();
    AGENTS.forEach(function(ag){var nd=nodeData.find(function(n){return n.id===ag.dataId;});if(nd&&(nd.task_count||0)>0&&Math.random()<0.014)spawnSpark(ag);});
    lastErr='';
  }catch(e){lastErr='FRAME:'+e.message;ctx2.globalAlpha=1;ctx2.fillStyle='rgba(180,20,20,0.8)';ctx2.font='12px monospace';ctx2.textAlign='left';ctx2.textBaseline='top';ctx2.fillText('Err:'+e.message,LW+6,6);}
}

// ── MAP PAN (drag to scroll within a clamped range) ──────────────────────────
function clampMapPan(){
  // Scale the allowed pan range with zoom so that when zoomed in (larger content)
  // the user can still explore edges, and zoom-toward-cursor isn't fought by the clamp.
  var rx=PAN_RANGE_X*Math.max(1,mapZoom),ry=PAN_RANGE_Y*Math.max(1,mapZoom);
  mapPanX=Math.max(-rx,Math.min(rx,mapPanX));
  mapPanY=Math.max(-ry,Math.min(ry,mapPanY));
}
// Scroll-wheel zoom, centered on the cursor: keep whatever scene point sits under
// the pointer fixed while zooming (same "zoom toward pointer" pattern Decisión's
// diagram wheel handler uses). Recompute TW/TH from the new zoom, then adjust
// mapPan so the pre-zoom world point stays under the cursor.
function onMapWheel(e){
  if(!cvs)return;
  var xy=canvasXY(e),cx=xy.mx,cy=xy.my;
  if(cx<LW)return; // ignore wheel over the left metrics panel
  e.preventDefault();
  var oldZoom=mapZoom;
  var dir=e.deltaY<0?1:-1;
  var newZoom=Math.min(MAP_ZOOM_MAX,Math.max(MAP_ZOOM_MIN,oldZoom*(1+dir*0.12)));
  if(newZoom===oldZoom)return;
  mapZoom=newZoom;
  TW=TWbase*mapZoom;TH=TW*0.5;
  var ratio=mapZoom/oldZoom;
  mapPanX=cx-OX-(cx-OX-mapPanX)*ratio;
  mapPanY=cy-OY-(cy-OY-mapPanY)*ratio;
  clampMapPan();
}
// Convert a pointer event's client coords into the same canvas-space (mx,my)
// handleClick already uses, so hit-testing stays consistent everywhere.
function canvasXY(e){
  var rect=cvs.getBoundingClientRect();
  return {mx:(e.clientX-rect.left)*(W/rect.width),my:(e.clientY-rect.top)*(H/rect.height)};
}
// Same figure hit-test handleClick's tower loop performs (squared-distance circle
// test against each figure's projected base point) — factored out so pointerdown
// can "arm" a potential drag without duplicating/altering handleClick's own logic.
function hitTestAgent(mx,my){
  for(var i=0;i<AGENTS.length;i++){
    var ag=AGENTS[i];var p=agentFloatPoint(ag,8*mapZoom);
    var dxx=mx-p.x,dyy=my-p.y;
    if(dxx*dxx+dyy*dyy<(TW*1.4)*(TW*1.4))return ag;
  }
  return null;
}
function onMapPointerDown(e){
  if(!cvs)return;
  var xy=canvasXY(e),mx=xy.mx,my=xy.my;
  if(mx<LW)return; // don't hijack drags starting over the left metrics panel
  // A figure is under the cursor: arm a potential drag instead of map-panning.
  // Whether it ends up being a drag or a plain click is decided in pointermove/up.
  var hit=hitTestAgent(mx,my);
  if(hit){
    dragCandidateId=hit.id;isDraggingFigure=false;
    dragArmedClientX=e.clientX;dragArmedClientY=e.clientY;
    dragCurMX=mx;dragCurMY=my;dragHoverZoneId=null;
    return;
  }
  isDraggingMap=true;dragMoved=false;
  dragStartClientX=e.clientX;dragStartClientY=e.clientY;
  dragStartPanX=mapPanX;dragStartPanY=mapPanY;
  cvs.style.cursor='grabbing';
}
function onMapPointerMove(e){
  if(dragCandidateId){
    var xy=canvasXY(e);
    dragCurMX=xy.mx;dragCurMY=xy.my;
    if(!isDraggingFigure){
      var ddx=e.clientX-dragArmedClientX,ddy=e.clientY-dragArmedClientY;
      if(Math.abs(ddx)<=DRAG_THRESHOLD&&Math.abs(ddy)<=DRAG_THRESHOLD)return; // still just a potential click
      isDraggingFigure=true;dragMoved=true; // suppress the click-to-select that follows pointerup
      if(cvs)cvs.style.cursor='grabbing';
    }
    dragHoverZoneId=zoneIdAtPoint(dragCurMX,dragCurMY);
    return;
  }
  if(!isDraggingMap){
    var hxy=canvasXY(e);
    var hover=hitTestAgent(hxy.mx,hxy.my);
    hoverAgentId=hover?hover.id:null;
    if(cvs)cvs.style.cursor=hover?'pointer':'';
    return;
  }
  hoverAgentId=null;
  var ddx2=e.clientX-dragStartClientX,ddy2=e.clientY-dragStartClientY;
  if(Math.abs(ddx2)>3||Math.abs(ddy2)>3)dragMoved=true;
  mapPanX=dragStartPanX+ddx2;mapPanY=dragStartPanY+ddy2;
  clampMapPan();
}
function onMapPointerUp(e){
  if(dragCandidateId){
    var id=dragCandidateId,wasDragging=isDraggingFigure;
    dragCandidateId=null;isDraggingFigure=false;
    if(cvs)cvs.style.cursor='';
    if(wasDragging){
      var xy=e?canvasXY(e):null;
      var zoneId=zoneIdAtPoint(xy?xy.mx:dragCurMX,xy?xy.my:dragCurMY);
      dragHoverZoneId=null;
      applyZoneDrop(id,zoneId);
    }
    return;
  }
  if(!isDraggingMap)return;
  isDraggingMap=false;
  if(cvs)cvs.style.cursor='';
}
// Reassign entityId's PRIMARY hierarchy membership (lowest-prio one, per
// primaryMembership()) to zoneId's group — reusing the existing Decisión
// mutators (addEntityToGroup/removeEntityFromGroup) so persistence/validation
// stays identical to editing the diagram directly. zoneId==='' means the
// neutral "Sin asignar" region (remove primary membership, add nothing). Any
// OTHER non-primary membership the entity holds in a different group is left
// untouched. No-ops cleanly if dropped outside every region, or back onto the
// same zone the entity was already primarily in.
function applyZoneDrop(entityId,zoneId){
  if(zoneId===null||zoneId===undefined)return; // dropped outside every region
  var entities=(typeof state!=='undefined'&&Array.isArray(state.entities))?state.entities:[];
  var ent=entities.find(function(e){return e.id===entityId;});
  if(!ent)return;
  var pm=primaryMembership(ent);
  var curGid=pm?pm.group_id:'';
  if(curGid===zoneId)return; // same zone it's already primarily in — no-op
  if(pm)removeEntityFromGroup(pm.group_id,entityId);
  if(zoneId)addEntityToGroup(zoneId,entityId);
  rebuildRoster();
}
// Drag-in-progress visual: a glow following the cursor (the dragged figure's own
// tower/position isn't moved — wander/animation state stays untouched — this is
// purely an overlay so the user can see what they're carrying and where it'll land).
function drawDragGhost(){
  if(!isDraggingFigure||!dragCandidateId)return;
  var ag=AGENTS.find(function(a){return a.id===dragCandidateId;});
  if(!ag)return;
  ctx2.save();
  ctx2.beginPath();ctx2.arc(dragCurMX,dragCurMY,14,0,Math.PI*2);
  ctx2.fillStyle=c(ag.col,0.35);ctx2.fill();
  ctx2.strokeStyle=c(ag.col,0.9);ctx2.lineWidth=2;ctx2.stroke();
  ctx2.font='bold 11px system-ui';ctx2.textAlign='center';ctx2.textBaseline='bottom';
  ctx2.fillStyle=c(ag.col,0.95);ctx2.fillText(ag.name,dragCurMX,dragCurMY-16);
  ctx2.restore();
}

// ── CLICK ─────────────────────────────────────────────────────────────────────
function handleClick(e){
  if(!cvs)return;
  if(dragMoved){dragMoved=false;return;} // a drag just ended — don't also (de)select a tower
  var rect=cvs.getBoundingClientRect();
  var mx=(e.clientX-rect.left)*(W/rect.width),my=(e.clientY-rect.top)*(H/rect.height);
  for(var bi=0;bi<BTNS.length;bi++){
    var btn=BTNS[bi];
    if(mx>=btn.x&&mx<=btn.x+btn.w&&my>=btn.y&&my<=btn.y+btn.h){
      if(btn.action==='close_panel'){selectedId=null;panelStates.spec='open';return;}
      if(btn.action==='mini_spec'){panelStates.spec='mini';return;}
      if(btn.action==='open_spec'){panelStates.spec='open';return;}
      if(btn.action==='close_metrics'){panelStates.metrics='closed';return;}
      if(btn.action==='mini_metrics'){panelStates.metrics='mini';return;}
      if(btn.action==='open_metrics'){panelStates.metrics='open';return;}
      if(btn.action==='dismiss_decision'){if(btn.d){btn.d.resolved=true;btn.d.resolvedAt=Date.now();}return;}
      if(btn.action==='new_task'){showMissionInput();return;}
      if(btn.action==='demo'){if(demoRunning)stopDemo();else startDemo();return;}
      if(btn.action==='approve'){if(btn.d){btn.d.resolved=true;btn.d.resolvedAt=Date.now();var ag2=AGENTS.find(function(a){return a.id===btn.d.agentId;});if(ag2)spawnSpark(ag2);}return;}
      if(btn.action==='reject'){if(btn.d){btn.d.resolved=true;btn.d.resolvedAt=Date.now();}return;}
    }
  }
  for(var ai=0;ai<AGENTS.length;ai++){
    var ag3=AGENTS[ai];var p=agentFloatPoint(ag3,8*mapZoom);
    var dxx=mx-p.x,dyy=my-p.y;
    if(dxx*dxx+dyy*dyy<(TW*1.4)*(TW*1.4)){selectedId=(selectedId===ag3.id)?null:ag3.id;return;}
  }
  selectedId=null;
}

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
function activate(){
  cvs=document.getElementById('iso-cvs');if(!cvs)return;
  if(!cvs._isoReady){
    ctx2=cvs.getContext('2d');cvs._isoReady=true;
    new ResizeObserver(resize).observe(cvs.parentElement);
    cvs.addEventListener('click',handleClick);
    cvs.addEventListener('pointerdown',onMapPointerDown);
    cvs.addEventListener('pointerleave',function(){hoverAgentId=null;if(cvs)cvs.style.cursor='';});
    cvs.addEventListener('wheel',onMapWheel,{passive:false});
    document.addEventListener('pointermove',onMapPointerMove);
    document.addEventListener('pointerup',onMapPointerUp);
  }
  rebuildRoster();resize();
  if(!running){running=true;requestAnimationFrame(frame);}
  // Live task/run animation is driven by the shared SSE dispatcher (initLiveEvents
  // → onTaskChanged/refreshNodes); this poll only seeds nodeData once and acts as
  // a slow 60s resilience fallback for the left-panel metrics (which SSE events
  // don't carry) in case the EventSource drops silently between run events.
  poll();clearInterval(cvs._pollInt);cvs._pollInt=setInterval(poll,60000);
  bootstrapCanvas(); // real task history → animate it; empty → play demo
}

setTimeout(activate,400);
})();
