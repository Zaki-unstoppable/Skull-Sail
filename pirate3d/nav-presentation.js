/**
 * Navigation & streaming presentation — tunable minimap, compass, loading intro,
 * streaming tiers, cluster reveal, and fallback cull. Persists to localStorage.
 * Toggle debug HUD: F10
 */
(function(){
'use strict';

const STORAGE_KEY = 'skullSailNavPresentation';

const defaults = {
  stream: {
    near: 800,
    mid: 1800,
    far: 3500,
    interval: 0.3
  },
  reveal: {
    hero: 2200,
    structural: 1000,
    filler: 500,
    proxyIn: 800,
    hysteresis: 80
  },
  minimap: {
    rangeShip: 2000,
    rangeFoot: 600,
    gridStepShip: 500,
    gridStepFoot: 150,
    gridAlpha: 0.12,
    borderAlpha: 0.35,
    priorityTreasure: 4,
    priorityShop: 3,
    priorityFortChest: 3,
    priorityNamed: 2,
    priorityDefault: 1
  },
  compass: {
    showOnFoot: false,
    showDegrees: true
  },
  loading: {
    progressMin: 0.004,
    progressMax: 0.006,
    tickMs: 100,
    playDelayMs: 800,
    fadeOutMs: 1200,
    hideDelayMs: 400,
    disposeDelayMs: 1300,
    safetyTimeoutMs: 10000
  },
  fallbackCull: {
    onShip: 600,
    onFoot: 250
  },
  wrap: {
    logWrapEvents: false
  }
};

function deepMerge(base, over){
  const out = {};
  for(const k in base){
    if(over && typeof over[k] === 'object' && over[k] !== null && !Array.isArray(over[k]) && typeof base[k] === 'object'){
      out[k] = deepMerge(base[k], over[k]);
    } else {
      out[k] = over && over[k] !== undefined ? over[k] : base[k];
    }
  }
  return out;
}

const tuning = deepMerge(defaults, {});

function load(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const parsed = JSON.parse(raw);
    Object.assign(tuning, deepMerge(defaults, parsed));
  } catch(e) {
    console.warn('[NavPresentation] load failed', e);
  }
}

function save(){
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
  } catch(e) {
    console.warn('[NavPresentation] save failed', e);
  }
}

function reset(){
  Object.assign(tuning, deepMerge(defaults, {}));
  localStorage.removeItem(STORAGE_KEY);
}

function islandPriority(isl){
  const m = tuning.minimap;
  let p = m.priorityDefault;
  if(isl.hasTreasure && !isl.treasureCollected) p = Math.max(p, m.priorityTreasure);
  if(isl.hasShop) p = Math.max(p, m.priorityShop);
  if(isl.hasFortChest && !isl.fortChestLooted) p = Math.max(p, m.priorityFortChest);
  if(isl.hasCastleChest && !isl.castleChestLooted) p = Math.max(p, m.priorityFortChest);
  return p;
}

function getSnapshot(islands, P, islandTiers, streamTimerAccum, islandAssetRegistry){
  const rows = [];
  const WORLD = (typeof window !== 'undefined' && window.GAME_WORLD) ? window.GAME_WORLD : 6000;
  const wrapD = (d) => d - WORLD * Math.round(d / WORLD);
  if(islands && P){
    const idx = [];
    for(let i = 0; i < islands.length; i++){
      const isl = islands[i];
      const dx = isl.x - P.x, dz = isl.y - P.z;
      const wdx = wrapD(dx), wdz = wrapD(dz);
      const dist = Math.hypot(wdx, wdz);
      idx.push({ i, dist, name: isl.name, tier: islandTiers && islandTiers[i] });
    }
    idx.sort((a,b) => a.dist - b.dist);
    for(let k = 0; k < Math.min(5, idx.length); k++){
      const e = idx[k];
      let rs = '';
      if(islandAssetRegistry && islandAssetRegistry[e.i]){
        const reg = islandAssetRegistry[e.i];
        const rev = reg.revealState;
        if(rev) rs = ` H:${rev.hero?'1':'0'} S:${rev.structural?'1':'0'} F:${rev.filler?'1':'0'} P:${rev.proxy?'1':'0'}`;
      }
      rows.push(`${e.name.slice(0,14)} | ${Math.floor(e.dist)}m | ${e.tier||'?'}${rs}`);
    }
  }
  return {
    streamTimer: streamTimerAccum != null ? streamTimerAccum.toFixed(3) : '—',
    nearest: rows,
    tuning: JSON.parse(JSON.stringify(tuning))
  };
}

load();

window.NavPresentation = {
  defaults,
  tuning,
  load,
  save,
  reset,
  islandPriority,
  getSnapshot,
  STORAGE_KEY
};
})();
