/**
 * models.js — GLB/glTF Asset Loader + High-Fidelity Procedural Fallbacks
 *
 * Architecture:
 *   - AssetLibrary.load(key) returns a Promise<TransformNode>
 *   - If a GLB exists in assets/, it loads that
 *   - Otherwise it generates a detailed procedural fallback
 *   - All models: 1 unit = 1 meter, Y-up, pivots at base center
 *   - Shadow casters auto-registered
 *   - Collision meshes auto-tagged
 *
 * To replace a procedural model with a real GLB:
 *   1. Export the model as GLB with correct scale (1 unit = 1 meter)
 *   2. Place it in assets/<key>.glb (e.g., assets/tavern_shell.glb)
 *   3. The loader will automatically use it instead of the fallback
 *
 * ══════════════════════════════════════════════════════════════
 * AUTHORED-ASSET CONVENTION (Pack 1 — Physical Asset Workflow)
 * ══════════════════════════════════════════════════════════════
 *
 * GLB Node-Naming Conventions:
 *   Suffix-based classification — the runtime reads the LAST tag after
 *   the final underscore (case-insensitive) to decide how each child
 *   mesh behaves at gameplay level.
 *
 *   _COL   → Collision-only mesh: invisible (alpha=0), checkCollisions=true.
 *            Use for simplified blocking volumes inside complex visual meshes.
 *
 *   _VIS   → Visual-only / decorative: rendered but never blocks the player.
 *            Good for hanging signs, cobwebs, drapes, decals, foliage overlays.
 *
 *   _INT   → Interaction marker: invisible trigger volume.  Position/extents
 *            define the interact-zone; the runtime auto-creates an interactable
 *            entry from this mesh.  Attach metadata via glTF extras:
 *              { "interactType": "chest", "promptOpen": "Open Chest" }
 *
 *   _PIV   → Pivot-point marker: an empty/mesh whose LOCAL origin marks
 *            the hinge/pivot for animated parts (doors, lids).  The loader
 *            records its position so the door system can call setPivotPoint().
 *
 *   _NAV   → Navigation hint: invisible mesh that marks walkable surfaces.
 *            Reserved for future nav-mesh baking; currently just tagged.
 *
 *   (none) → Default: visible + collision decided by asset role.
 *            Structural/interactable assets get collision; decorative do not.
 *
 * Asset Roles (CATALOG.role):
 *   'structural'   — Walls, floors, roofs, pillars. Always block the player.
 *   'interactable' — Doors, chests, barrels. Collision on body, interaction markers.
 *   'decorative'   — Bottles, mugs, rugs, hanging lanterns. No collision.
 *   'furniture'    — Tables, chairs, benches, shelves. Collision on body only.
 *   'character'    — NPCs. Simple capsule collision; special shadow handling.
 *   'environment'  — Trees, rocks, docks. Collision on body/base meshes.
 *
 * Scale Validation:
 *   Each CATALOG entry may specify { scaleMin, scaleMax } in meters.
 *   On GLB load, the bounding-box height is checked against this range.
 *   A console warning fires if the asset is outside ±50% of expected size,
 *   preventing silently broken imports from reaching gameplay.
 *
 * Pivot Convention:
 *   All assets: pivot at world-space BASE-CENTER (feet of character,
 *   bottom-center of furniture, hinge-edge of doors).
 *   GLBs should be exported with the origin at this point.
 *   If a _PIV child exists, the loader uses it to override the pivot.
 */

(function(){
'use strict';

// Will be set by game.js after scene creation
let _scene = null;
let _shadowGen = null;
let _materials = null;

// Cache for loaded/generated models (clone from these)
const _cache = new Map();

// Source tracking — records whether each key loaded from GLB or fallback
const _sourceLog = {};

// ============================================================
// ASSET CATALOG — every loadable asset
// ============================================================
const CATALOG = {
  // ── Building shells ──────────────────────────────────────
  tavern_shell:     { glb: 'tavern_shell.glb',     fallback: 'buildTavernShell',
                      role: 'structural', scaleMin: 5, scaleMax: 12 },
  tavern_roof:      { glb: 'tavern_roof.glb',       fallback: 'buildTavernRoof',
                      role: 'structural', scaleMin: 3, scaleMax: 8 },

  // ── Furniture ────────────────────────────────────────────
  table_tavern:     { glb: 'table_tavern.glb',      fallback: 'buildTable',
                      role: 'furniture', scaleMin: 0.6, scaleMax: 1.2 },
  bench_long:       { glb: 'bench_long.glb',         fallback: 'buildBench',
                      role: 'furniture', scaleMin: 0.3, scaleMax: 0.7 },
  shelf_wall:       { glb: 'shelf_wall.glb',         fallback: 'buildShelf',
                      role: 'furniture', scaleMin: 0.3, scaleMax: 1.0 },
  chair_simple:     { glb: 'chair_simple.glb',       fallback: 'buildChair',
                      role: 'furniture', scaleMin: 0.6, scaleMax: 1.2 },

  // ── Props (interactable) ─────────────────────────────────
  barrel:           { glb: 'barrel.glb',             fallback: 'buildBarrel',
                      role: 'interactable', scaleMin: 0.7, scaleMax: 1.3 },
  crate_small:      { glb: 'crate_small.glb',        fallback: 'buildCrate',
                      role: 'interactable', scaleMin: 0.4, scaleMax: 0.8 },
  crate_large:      { glb: 'crate_large.glb',        fallback: 'buildCrateLarge',
                      role: 'interactable', scaleMin: 0.6, scaleMax: 1.2 },
  chest:            { glb: 'chest.glb',              fallback: 'buildChest',
                      role: 'interactable', scaleMin: 0.3, scaleMax: 0.7 },

  // ── Props (decorative) ──────────────────────────────────
  lantern_table:    { glb: 'lantern_table.glb',      fallback: 'buildLantern',
                      role: 'decorative', scaleMin: 0.15, scaleMax: 0.5 },
  lantern_hanging:  { glb: 'lantern_hanging.glb',    fallback: 'buildHangingLantern',
                      role: 'decorative', scaleMin: 0.2, scaleMax: 0.7 },
  bottle:           { glb: 'bottle.glb',             fallback: 'buildBottle',
                      role: 'decorative', scaleMin: 0.15, scaleMax: 0.4 },
  mug:              { glb: 'mug.glb',                fallback: 'buildMug',
                      role: 'decorative', scaleMin: 0.08, scaleMax: 0.2 },
  rug_rectangle:    { glb: 'rug_rectangle.glb',      fallback: 'buildRug',
                      role: 'decorative', scaleMin: 0.01, scaleMax: 0.05 },

  // ── Exterior / interactable ─────────────────────────────
  door_wood:        { glb: 'door_wood.glb',          fallback: 'buildDoor',
                      role: 'interactable', scaleMin: 1.8, scaleMax: 2.5 },
  palm_tree:        { glb: 'palm_tree.glb',          fallback: 'buildPalmTree',
                      role: 'environment', scaleMin: 4, scaleMax: 10 },
  rock_large:       { glb: 'rock_large.glb',         fallback: 'buildRock',
                      role: 'environment', scaleMin: 0.4, scaleMax: 3.0 },
  dock_section:     { glb: 'dock_section.glb',       fallback: 'buildDockSection',
                      role: 'structural', scaleMin: 0.5, scaleMax: 2.0 },
  mooring_post:     { glb: 'mooring_post.glb',       fallback: 'buildMooringPost',
                      role: 'environment', scaleMin: 0.8, scaleMax: 2.0 },
  sign_hanging:     { glb: 'sign_hanging.glb',       fallback: 'buildSign',
                      role: 'decorative', scaleMin: 1.5, scaleMax: 3.5 },

  // ── Modular building kit ────────────────────────────────
  wall_module:      { glb: 'wall_module.glb',         fallback: 'buildWallModule',
                      role: 'structural', scaleMin: 2.5, scaleMax: 4.5 },
  roof_module:      { glb: 'roof_module.glb',         fallback: 'buildRoofModule',
                      role: 'structural', scaleMin: 1.5, scaleMax: 4.0 },
  floor_module:     { glb: 'floor_module.glb',        fallback: 'buildFloorModule',
                      role: 'structural', scaleMin: 0.1, scaleMax: 0.5 },
  ceiling_beam:     { glb: 'ceiling_beam.glb',        fallback: 'buildCeilingBeamModule',
                      role: 'structural', scaleMin: 0.1, scaleMax: 0.4 },
  stair_step:       { glb: 'stair_step.glb',          fallback: 'buildStairStep',
                      role: 'structural', scaleMin: 0.2, scaleMax: 0.6 },
  railing_module:   { glb: 'railing_module.glb',      fallback: 'buildRailingModule',
                      role: 'structural', scaleMin: 0.5, scaleMax: 1.5 },
  window_frame:     { glb: 'window_frame.glb',        fallback: 'buildWindowFrame',
                      role: 'structural', scaleMin: 0.6, scaleMax: 1.8 },

  // ── Characters ──────────────────────────────────────────
  npc_villager:     { glb: 'npc_villager.glb',       fallback: 'buildNPCVillager',
                      role: 'character', scaleMin: 1.5, scaleMax: 2.0 },
  npc_guard:        { glb: 'npc_guard.glb',          fallback: 'buildNPCGuard',
                      role: 'character', scaleMin: 1.5, scaleMax: 2.1 },
  npc_merchant:     { glb: 'npc_merchant.glb',       fallback: 'buildNPCMerchant',
                      role: 'character', scaleMin: 1.5, scaleMax: 2.0 },
};

// ============================================================
// PUBLIC API
// ============================================================
const AssetLibrary = {
  /** Initialize with scene references */
  init(scene, shadowGenerator, materials){
    _scene = scene;
    _shadowGen = shadowGenerator;
    _materials = materials || {};
  },

  /** Load or generate an asset by key. Returns a clone each time. */
  async load(key){
    if(_cache.has(key)){
      return _cache.get(key).clone(key + '_clone', null);
    }

    const entry = CATALOG[key];
    if(!entry){
      console.warn(`[AssetLibrary] Unknown asset key: ${key}`);
      return null;
    }

    // Try GLB first (convention-aware loader)
    let model = await tryLoadGLB(entry.glb, key);
    if(model){
      _sourceLog[key] = 'GLB';
    } else {
      // Use procedural fallback
      const builder = Fallbacks[entry.fallback];
      if(builder){
        model = builder();
        _sourceLog[key] = 'FALLBACK';
      } else {
        console.warn(`[AssetLibrary] No fallback for: ${key}`);
        _sourceLog[key] = 'MISSING';
        return null;
      }
    }

    // Setup: shadows, collision tags
    setupModel(model, key);
    _cache.set(key, model);
    model.setEnabled(false); // template is hidden; clones are visible

    const clone = model.clone(key + '_clone', null);
    clone.setEnabled(true);
    return clone;
  },

  /** Check if a GLB file exists for a given key */
  hasGLB(key){
    const entry = CATALOG[key];
    return entry ? !!entry.glb : false;
  },

  /** Get all catalog keys */
  keys(){ return Object.keys(CATALOG); },

  /** Get catalog entry */
  getEntry(key){ return CATALOG[key]; },

  /** Get source log — shows GLB vs FALLBACK vs MISSING for each loaded key */
  getSources(){ return { ..._sourceLog }; },

  /** Get role for a catalog key */
  getRole(key){
    const entry = CATALOG[key];
    return entry ? (entry.role || 'unknown') : 'unknown';
  },

  /** Inspect convention data for a loaded asset (by its root node) */
  getConvention(node){
    return (node && node.metadata && node.metadata._convention) || null;
  },

  /** Get all catalog entries grouped by role */
  getCatalogByRole(){
    const groups = {};
    for(const [key, entry] of Object.entries(CATALOG)){
      const role = entry.role || 'unknown';
      if(!groups[role]) groups[role] = [];
      groups[role].push(key);
    }
    return groups;
  },

  /** Run convention compliance check on all loaded assets. Returns report. */
  auditConventions(){
    const report = { total: 0, glb: 0, fallback: 0, conventionTagged: 0, warnings: [] };
    for(const [key, source] of Object.entries(_sourceLog)){
      report.total++;
      if(source === 'GLB'){
        report.glb++;
        const cached = _cache.get(key);
        if(cached){
          const conv = cached.metadata && cached.metadata._convention;
          if(conv){
            const tagged = conv.report.col + conv.report.vis + conv.report.int + conv.report.piv + conv.report.nav;
            if(tagged > 0) report.conventionTagged++;
          }
        }
      } else {
        report.fallback++;
      }
    }
    return report;
  },

  /** Convention tag reference (for debug overlay) */
  CONVENTION_TAGS: ['COL', 'VIS', 'INT', 'PIV', 'NAV'],
  ROLES: ['structural', 'interactable', 'decorative', 'furniture', 'character', 'environment'],
};

// ============================================================
// CONVENTION SUFFIX PARSER
// ============================================================
// Reads the last _TAG from a mesh name (case-insensitive).
// Returns: { baseName, tag } where tag is one of:
//   'COL', 'VIS', 'INT', 'PIV', 'NAV', or null (no convention suffix).
const CONVENTION_TAGS = new Set(['COL', 'VIS', 'INT', 'PIV', 'NAV']);

function parseConventionTag(meshName){
  const parts = meshName.split('_');
  if(parts.length < 2) return { baseName: meshName, tag: null };
  const last = parts[parts.length - 1].toUpperCase();
  if(CONVENTION_TAGS.has(last)){
    return { baseName: parts.slice(0, -1).join('_'), tag: last };
  }
  return { baseName: meshName, tag: null };
}

// ============================================================
// GLB LOADER — convention-aware
// ============================================================
async function tryLoadGLB(filename, catalogKey){
  if(!filename) return null;
  try {
    const result = await BABYLON.SceneLoader.ImportMeshAsync(
      '', 'assets/', filename, _scene
    );
    if(result.meshes.length === 0) return null;

    const root = new BABYLON.TransformNode(filename.replace('.glb',''), _scene);
    const conventionReport = { col: 0, vis: 0, int: 0, piv: 0, nav: 0, default: 0 };
    const interactionMarkers = [];
    let pivotPoint = null;

    for(const m of result.meshes){
      if(m.name === '__root__') continue;
      m.parent = root;

      // Parse convention suffix
      const { baseName, tag } = parseConventionTag(m.name);

      if(tag === 'COL'){
        // Collision-only: invisible blocking volume
        m.isVisible = false;
        m.checkCollisions = true;
        m.isPickable = false;
        conventionReport.col++;
      } else if(tag === 'VIS'){
        // Visual-only: decorative, no collision
        m.checkCollisions = false;
        m.isPickable = false;
        conventionReport.vis++;
      } else if(tag === 'INT'){
        // Interaction marker: invisible trigger
        m.isVisible = false;
        m.checkCollisions = false;
        m.isPickable = true;
        // Pull metadata from glTF extras if present
        const extras = m.metadata && m.metadata.gltf && m.metadata.gltf.extras;
        interactionMarkers.push({
          mesh: m,
          baseName: baseName,
          extras: extras || {}
        });
        conventionReport.int++;
      } else if(tag === 'PIV'){
        // Pivot marker: record position, then hide
        pivotPoint = m.position.clone();
        m.isVisible = false;
        m.checkCollisions = false;
        m.isPickable = false;
        conventionReport.piv++;
      } else if(tag === 'NAV'){
        // Navigation hint: invisible, reserved for future nav-mesh
        m.isVisible = false;
        m.checkCollisions = false;
        m.isPickable = false;
        conventionReport.nav++;
      } else {
        conventionReport.default++;
      }
    }

    // Attach convention data to the root for downstream use
    root.metadata = root.metadata || {};
    root.metadata._convention = {
      report: conventionReport,
      interactionMarkers: interactionMarkers,
      pivotPoint: pivotPoint,
      source: 'GLB',
      catalogKey: catalogKey || null
    };

    // Log convention usage for authored GLBs
    const tagged = conventionReport.col + conventionReport.vis + conventionReport.int + conventionReport.piv + conventionReport.nav;
    if(tagged > 0){
      console.log(`[AssetConvention] ${filename}: ${tagged} convention-tagged nodes ` +
        `(COL:${conventionReport.col} VIS:${conventionReport.vis} INT:${conventionReport.int} ` +
        `PIV:${conventionReport.piv} NAV:${conventionReport.nav})`);
    }

    return root;
  } catch(e){
    // GLB not found — expected, use fallback
    return null;
  }
}

// ============================================================
// ROLE-BASED COLLISION RULES
// ============================================================
// Determines default collision behavior when no convention suffix is present.
const ROLE_COLLISION = {
  structural:   true,   // walls, floors, roofs — always block
  interactable: true,   // barrels, chests — block on body meshes
  furniture:    true,   // tables, chairs — block on body meshes
  environment:  true,   // rocks, trees — block on body/base meshes
  decorative:   false,  // bottles, mugs, rugs — never block
  character:    false,  // NPCs — collision handled separately by capsule
};

// Names that identify the primary "body" mesh for collision (legacy compat)
const BODY_MESH_NAMES = new Set(['body', 'base', 'collision', 'wall', 'floor', 'panel', 'hull']);

function isBodyMesh(meshName){
  const lower = meshName.toLowerCase();
  for(const name of BODY_MESH_NAMES){
    if(lower.includes(name)) return true;
  }
  return false;
}

// ============================================================
// SCALE VALIDATION
// ============================================================
function validateScale(node, key){
  const entry = CATALOG[key];
  if(!entry || entry.scaleMin == null || entry.scaleMax == null) return;

  // Compute world-space bounding box height
  const childMeshes = node.getChildMeshes(false);
  if(childMeshes.length === 0) return;

  let minY = Infinity, maxY = -Infinity;
  for(const m of childMeshes){
    if(!m.isVisible && !m.getBoundingInfo) continue;
    try {
      const bi = m.getBoundingInfo();
      const worldMin = bi.boundingBox.minimumWorld;
      const worldMax = bi.boundingBox.maximumWorld;
      if(worldMin.y < minY) minY = worldMin.y;
      if(worldMax.y > maxY) maxY = worldMax.y;
    } catch(e){ /* skip meshes without valid bounds */ }
  }

  const height = maxY - minY;
  if(height <= 0) return;

  const tolerance = 0.5; // ±50%
  const expectedMin = entry.scaleMin * (1 - tolerance);
  const expectedMax = entry.scaleMax * (1 + tolerance);

  if(height < expectedMin || height > expectedMax){
    console.warn(
      `[AssetConvention] SCALE WARNING: "${key}" GLB height is ${height.toFixed(2)}m ` +
      `(expected ${entry.scaleMin}–${entry.scaleMax}m). ` +
      `Check export scale — convention is 1 unit = 1 meter.`
    );
  }
}

// ============================================================
// MODEL SETUP — convention-aware shadows, collisions, pivots
// ============================================================
function setupModel(node, key){
  const entry = CATALOG[key] || {};
  const role = entry.role || 'decorative';
  const defaultCollision = ROLE_COLLISION[role] !== false;
  const convention = (node.metadata && node.metadata._convention) || null;

  node.getChildMeshes().forEach(m => {
    // Skip convention-tagged meshes — they were already configured by tryLoadGLB
    const { tag } = parseConventionTag(m.name);
    if(tag) return;

    // Shadows for all visible meshes
    if(m.isVisible !== false){
      if(_shadowGen) _shadowGen.addShadowCaster(m);
      m.receiveShadows = true;
    }

    // Collision: role-based default, refined by mesh name
    if(defaultCollision){
      // For roles that collide, only body-like meshes block by default
      // (structural role: everything blocks; others: only 'body' meshes)
      if(role === 'structural'){
        m.checkCollisions = true;
      } else {
        m.checkCollisions = isBodyMesh(m.name);
      }
    } else {
      m.checkCollisions = false;
    }
  });

  // Apply pivot from _PIV marker if present
  if(convention && convention.pivotPoint){
    // For interactable assets (doors, chests), set the pivot so
    // animation code can rely on it
    node.metadata = node.metadata || {};
    node.metadata.pivotOffset = convention.pivotPoint.clone();
  }

  // Propagate interaction markers so game.js can use them
  if(convention && convention.interactionMarkers.length > 0){
    node.metadata = node.metadata || {};
    node.metadata.interactionMarkers = convention.interactionMarkers;
  }

  // Scale validation (GLB-sourced assets only)
  if(convention && convention.source === 'GLB'){
    validateScale(node, key);
  }
}

// ============================================================
// HELPER — PBR material shorthand
// ============================================================
function mat(name, hex, rough, metal){
  const existing = _scene.getMaterialByName(name);
  if(existing) return existing;
  const m = new BABYLON.PBRMaterial(name, _scene);
  m.albedoColor = BABYLON.Color3.FromHexString(hex);
  m.roughness = rough !== undefined ? rough : 0.85;
  m.metallic = metal !== undefined ? metal : 0;
  m.environmentIntensity = 0.3;
  return m;
}

// Helper: enable shadows + collisions on a group (convention-aware)
// Pass collisionMeshNames for legacy compat, OR let the convention parser
// handle _COL/_VIS suffixed mesh names automatically.
function finalize(group, collisionMeshNames){
  group.getChildMeshes().forEach(m => {
    const { tag } = parseConventionTag(m.name);

    // Convention-tagged meshes: handle explicitly
    if(tag === 'COL'){
      m.isVisible = false;
      m.checkCollisions = true;
      m.isPickable = false;
      return;
    }
    if(tag === 'VIS'){
      m.checkCollisions = false;
      m.isPickable = false;
      if(_shadowGen) _shadowGen.addShadowCaster(m);
      m.receiveShadows = true;
      return;
    }
    if(tag === 'INT'){
      m.isVisible = false;
      m.checkCollisions = false;
      m.isPickable = true;
      return;
    }

    // Default: shadows for all, collision by name list
    if(_shadowGen) _shadowGen.addShadowCaster(m);
    m.receiveShadows = true;
    if(collisionMeshNames && collisionMeshNames.includes(m.name)){
      m.checkCollisions = true;
    }
  });
  return group;
}

// ============================================================
// PROCEDURAL FALLBACKS — High-fidelity replacements
// ============================================================
const Fallbacks = {};

// ---- TABLE (convention-named) ----
Fallbacks.buildTable = function(){
  const g = new BABYLON.TransformNode('table', _scene);
  const woodMat = mat('tbl_wood', '#8b6c42', 0.88, 0);
  const darkMat = mat('tbl_dark', '#5c3a1e', 0.92, 0);

  // Tabletop — collision body (furniture: only this blocks)
  const top = BABYLON.MeshBuilder.CreateBox('table_body_COL', { width: 1.6, height: 0.07, depth: 0.9 }, _scene);
  top.material = woodMat;
  top.position.y = 0.76;
  top.parent = g;

  // Apron (under-table rail, decorative)
  for(const side of [{w:1.5,d:0.04,x:0,z:0.4},{w:1.5,d:0.04,x:0,z:-0.4},{w:0.04,d:0.76,x:0.73,z:0},{w:0.04,d:0.76,x:-0.73,z:0}]){
    const apron = BABYLON.MeshBuilder.CreateBox('table_apron_VIS', {width:side.w,height:0.08,depth:side.d}, _scene);
    apron.material = darkMat;
    apron.position.set(side.x, 0.68, side.z);
    apron.parent = g;
  }

  // Legs with slight taper (decorative)
  for(const lp of [{x:-0.68,z:-0.38},{x:0.68,z:-0.38},{x:-0.68,z:0.38},{x:0.68,z:0.38}]){
    const leg = BABYLON.MeshBuilder.CreateCylinder('table_leg_VIS', {
      height: 0.72, diameterTop: 0.05, diameterBottom: 0.07, tessellation: 8
    }, _scene);
    leg.material = darkMat;
    leg.position.set(lp.x, 0.36, lp.z);
    leg.parent = g;
  }

  // Cross braces (H-stretcher, decorative)
  const brace = BABYLON.MeshBuilder.CreateBox('table_brace_VIS', {width:1.3,height:0.03,depth:0.03}, _scene);
  brace.material = darkMat; brace.position.set(0, 0.25, 0); brace.parent = g;
  const braceZ = BABYLON.MeshBuilder.CreateBox('table_braceZ_VIS', {width:0.03,height:0.03,depth:0.7}, _scene);
  braceZ.material = darkMat; braceZ.position.set(0, 0.25, 0); braceZ.parent = g;

  return finalize(g);
};

// ---- BENCH ----
Fallbacks.buildBench = function(){
  const g = new BABYLON.TransformNode('bench', _scene);
  const woodMat = mat('bench_wood', '#9a7a52', 0.88, 0);

  const seat = BABYLON.MeshBuilder.CreateBox('body', {width:1.2,height:0.05,depth:0.35}, _scene);
  seat.material = woodMat; seat.position.y = 0.45; seat.parent = g;

  for(const x of [-0.5, 0.5]){
    const leg = BABYLON.MeshBuilder.CreateBox('leg', {width:0.06,height:0.44,depth:0.3}, _scene);
    leg.material = woodMat; leg.position.set(x, 0.22, 0); leg.parent = g;
  }

  return finalize(g, ['body']);
};

// ---- CHAIR ----
Fallbacks.buildChair = function(){
  const g = new BABYLON.TransformNode('chair', _scene);
  const woodMat = mat('chair_wood', '#8a6a3a', 0.88, 0);

  // Seat
  const seat = BABYLON.MeshBuilder.CreateBox('body', {width:0.42,height:0.04,depth:0.42}, _scene);
  seat.material = woodMat; seat.position.y = 0.46; seat.parent = g;

  // Legs
  for(const p of [{x:-0.17,z:-0.17},{x:0.17,z:-0.17},{x:-0.17,z:0.17},{x:0.17,z:0.17}]){
    const leg = BABYLON.MeshBuilder.CreateCylinder('leg', {height:0.46,diameter:0.04,tessellation:6}, _scene);
    leg.material = woodMat; leg.position.set(p.x, 0.23, p.z); leg.parent = g;
  }

  // Backrest
  const back = BABYLON.MeshBuilder.CreateBox('back', {width:0.42,height:0.45,depth:0.03}, _scene);
  back.material = woodMat; back.position.set(0, 0.71, -0.19); back.parent = g;

  // Back slats
  for(const x of [-0.12, 0.12]){
    const slat = BABYLON.MeshBuilder.CreateBox('slat', {width:0.04,height:0.35,depth:0.02}, _scene);
    slat.material = woodMat; slat.position.set(x, 0.66, -0.18); slat.parent = g;
  }

  return finalize(g, ['body']);
};

// ---- SHELF ----
Fallbacks.buildShelf = function(){
  const g = new BABYLON.TransformNode('shelf', _scene);
  const woodMat = mat('shelf_wood', '#7a5a32', 0.9, 0);

  // Two planks
  for(const y of [0, 0.45]){
    const plank = BABYLON.MeshBuilder.CreateBox('plank', {width:2.0,height:0.04,depth:0.35}, _scene);
    plank.material = woodMat; plank.position.y = y; plank.parent = g;
  }

  // Brackets
  for(const x of [-0.8, 0, 0.8]){
    const bracket = BABYLON.MeshBuilder.CreateBox('bracket', {width:0.04,height:0.44,depth:0.04}, _scene);
    bracket.material = woodMat; bracket.position.set(x, 0.22, -0.14); bracket.parent = g;
    const brace = BABYLON.MeshBuilder.CreateBox('brace', {width:0.04,height:0.04,depth:0.28}, _scene);
    brace.material = woodMat; brace.position.set(x, 0.02, 0); brace.parent = g;
  }

  return finalize(g);
};

// ---- BARREL (high detail, convention-named) ----
Fallbacks.buildBarrel = function(){
  const g = new BABYLON.TransformNode('barrel', _scene);
  const woodMat = mat('barrel_wood', '#8B4513', 0.85, 0);
  const bandMat = mat('barrel_band', '#444444', 0.4, 0.7);

  // Staves body — use lathe for proper barrel curve (collision body)
  const bodyShape = [];
  for(let i = 0; i <= 20; i++){
    const t = i / 20;
    const y = t - 0.5;
    const bulge = 1 + 0.08 * Math.sin(t * Math.PI);
    bodyShape.push(new BABYLON.Vector3(0.28 * bulge, y, 0));
  }
  const body = BABYLON.MeshBuilder.CreateLathe('barrel_body_COL', {
    shape: bodyShape, tessellation: 16, sideOrientation: BABYLON.Mesh.DOUBLESIDE
  }, _scene);
  body.material = woodMat;
  body.position.y = 0.5;
  body.parent = g;

  // Visible stave lines (decorative vertical grooves)
  const grooveMat = mat('barrel_groove', '#6B3310', 0.92, 0);
  for(let i = 0; i < 8; i++){
    const angle = (i / 8) * Math.PI * 2;
    const groove = BABYLON.MeshBuilder.CreateBox('barrel_groove_VIS', {
      width: 0.008, height: 0.9, depth: 0.005
    }, _scene);
    groove.material = grooveMat;
    groove.position.set(Math.cos(angle) * 0.29, 0.5, Math.sin(angle) * 0.29);
    groove.rotation.y = -angle;
    groove.parent = g;
  }

  // Metal bands (decorative)
  for(const yOff of [-0.35, -0.1, 0.1, 0.35]){
    const band = BABYLON.MeshBuilder.CreateTorus('barrel_band_VIS', {
      diameter: 0.6, thickness: 0.02, tessellation: 24
    }, _scene);
    band.material = bandMat;
    band.position.y = 0.5 + yOff;
    band.parent = g;
  }

  // Lid circle
  const lid = BABYLON.MeshBuilder.CreateCylinder('barrel_lid_VIS', {
    height: 0.02, diameter: 0.52, tessellation: 16
  }, _scene);
  lid.material = woodMat; lid.position.y = 1.0; lid.parent = g;

  // Bung hole on the side (decorative detail)
  const bung = BABYLON.MeshBuilder.CreateCylinder('barrel_bung_VIS', {
    height: 0.01, diameter: 0.06, tessellation: 8
  }, _scene);
  bung.material = bandMat;
  bung.rotation.z = Math.PI / 2;
  bung.position.set(0.29, 0.5, 0);
  bung.parent = g;

  return finalize(g);
};

// ---- CRATE (small, convention-named) ----
Fallbacks.buildCrate = function(){
  const g = new BABYLON.TransformNode('crate', _scene);
  const woodMat = mat('crate_wood', '#A0722A', 0.9, 0);
  const trimMat = mat('crate_trim', '#7A5220', 0.95, 0);

  // Main body — collision
  const box = BABYLON.MeshBuilder.CreateBox('crate_body_COL', {width:0.55,height:0.55,depth:0.55}, _scene);
  box.material = woodMat; box.position.y = 0.275; box.parent = g;

  // Plank lines on front + back faces (decorative)
  for(const zSide of [0.28, -0.28]){
    for(let i = -0.2; i <= 0.2; i += 0.1){
      const line = BABYLON.MeshBuilder.CreateBox('crate_plank_VIS', {width:0.54,height:0.01,depth:0.005}, _scene);
      line.material = trimMat; line.position.set(0, 0.275 + i, zSide); line.parent = g;
    }
  }

  // Corner braces (decorative)
  for(const c of [{x:-0.28,z:0.28},{x:0.28,z:0.28},{x:-0.28,z:-0.28},{x:0.28,z:-0.28}]){
    const brace = BABYLON.MeshBuilder.CreateBox('crate_brace_VIS', {width:0.03,height:0.56,depth:0.03}, _scene);
    brace.material = trimMat; brace.position.set(c.x, 0.28, c.z); brace.parent = g;
  }

  // Top cross brace
  const topBrace = BABYLON.MeshBuilder.CreateBox('crate_topbrace_VIS', {width:0.56,height:0.03,depth:0.03}, _scene);
  topBrace.material = trimMat; topBrace.position.set(0, 0.555, 0); topBrace.parent = g;

  return finalize(g);
};

// ---- CRATE (large, convention-named) ----
Fallbacks.buildCrateLarge = function(){
  const g = new BABYLON.TransformNode('crateLg', _scene);
  const woodMat = mat('crate_wood', '#A0722A', 0.9, 0);
  const trimMat = mat('crate_trim', '#7A5220', 0.95, 0);

  // Main body — collision
  const box = BABYLON.MeshBuilder.CreateBox('crate_body_COL', {width:0.8,height:0.8,depth:0.8}, _scene);
  box.material = woodMat; box.position.y = 0.4; box.parent = g;

  // Cross braces on front + back (decorative)
  for(const face of [0.41, -0.41]){
    const h = BABYLON.MeshBuilder.CreateBox('crate_hbrace_VIS', {width:0.82,height:0.04,depth:0.04}, _scene);
    h.material = trimMat; h.position.set(0, 0.4, face); h.parent = g;
    const v = BABYLON.MeshBuilder.CreateBox('crate_vbrace_VIS', {width:0.04,height:0.82,depth:0.04}, _scene);
    v.material = trimMat; v.position.set(0, 0.4, face); v.parent = g;
  }

  // Side braces (decorative)
  for(const face of [0.41, -0.41]){
    const sb = BABYLON.MeshBuilder.CreateBox('crate_sidebrace_VIS', {width:0.04,height:0.82,depth:0.04}, _scene);
    sb.material = trimMat; sb.position.set(face, 0.4, 0); sb.parent = g;
  }

  // Rope handle on one side (decorative)
  const rope = BABYLON.MeshBuilder.CreateTorus('crate_rope_VIS', {
    diameter: 0.15, thickness: 0.012, tessellation: 12
  }, _scene);
  rope.material = mat('rope_tan', '#c8b888', 0.95, 0);
  rope.rotation.z = Math.PI / 2;
  rope.position.set(0.42, 0.5, 0);
  rope.parent = g;

  return finalize(g);
};

// ---- LANTERN (table) ----
Fallbacks.buildLantern = function(){
  const g = new BABYLON.TransformNode('lantern', _scene);
  const metalMat = mat('lantern_metal', '#3a3a3a', 0.4, 0.8);
  const flameMat = mat('lantern_flame', '#ff6600', 0.5, 0);
  flameMat.emissiveColor = BABYLON.Color3.FromHexString('#ff4400');

  // Base
  const base = BABYLON.MeshBuilder.CreateCylinder('base', {height:0.04,diameter:0.14,tessellation:8}, _scene);
  base.material = metalMat; base.position.y = 0.02; base.parent = g;

  // Glass cage (wireframe-style using thin boxes)
  for(let i = 0; i < 4; i++){
    const angle = (i / 4) * Math.PI * 2;
    const bar = BABYLON.MeshBuilder.CreateBox('bar', {width:0.01,height:0.2,depth:0.01}, _scene);
    bar.material = metalMat;
    bar.position.set(Math.cos(angle)*0.05, 0.14, Math.sin(angle)*0.05);
    bar.parent = g;
  }

  // Top cap
  const cap = BABYLON.MeshBuilder.CreateCylinder('cap', {height:0.03,diameter:0.12,tessellation:8}, _scene);
  cap.material = metalMat; cap.position.y = 0.25; cap.parent = g;

  // Handle
  const handle = BABYLON.MeshBuilder.CreateTorus('handle', {diameter:0.08,thickness:0.01,tessellation:12}, _scene);
  handle.material = metalMat; handle.position.y = 0.28; handle.rotation.x = Math.PI/6; handle.parent = g;

  // Flame
  const flame = BABYLON.MeshBuilder.CreateSphere('flame', {diameter:0.06,segments:6}, _scene);
  flame.material = flameMat; flame.position.y = 0.14; flame.parent = g;

  return finalize(g);
};

// ---- HANGING LANTERN ----
Fallbacks.buildHangingLantern = function(){
  const g = new BABYLON.TransformNode('hangLantern', _scene);
  const metalMat = mat('lantern_metal', '#3a3a3a', 0.4, 0.8);
  const flameMat = mat('lantern_flame', '#ff6600', 0.5, 0);
  flameMat.emissiveColor = BABYLON.Color3.FromHexString('#ff4400');

  // Chain
  const chain = BABYLON.MeshBuilder.CreateCylinder('chain', {height:0.5,diameter:0.015,tessellation:6}, _scene);
  chain.material = metalMat; chain.position.y = 0.25; chain.parent = g;

  // Lamp body
  const body = BABYLON.MeshBuilder.CreateCylinder('body', {
    height:0.22, diameterTop:0.06, diameterBottom:0.12, tessellation:6
  }, _scene);
  body.material = metalMat; body.position.y = -0.11; body.parent = g;

  // Flame
  const flame = BABYLON.MeshBuilder.CreateSphere('flame', {diameter:0.08,segments:6}, _scene);
  flame.material = flameMat; flame.position.y = -0.05; flame.parent = g;

  return finalize(g);
};

// ---- BOTTLE ----
Fallbacks.buildBottle = function(){
  const g = new BABYLON.TransformNode('bottle', _scene);
  const glassMat = mat('bottle_glass', '#2a6a4a', 0.15, 0.05);
  glassMat.alpha = 0.7;

  const shape = [];
  const pts = [[0,0,0.035],[0.04,0,0.035],[0.08,0,0.04],[0.18,0,0.04],[0.22,0,0.02],[0.26,0,0.015],[0.28,0,0.018]];
  for(const p of pts) shape.push(new BABYLON.Vector3(p[2], p[0], 0));

  const body = BABYLON.MeshBuilder.CreateLathe('body', {shape, tessellation:10}, _scene);
  body.material = glassMat; body.parent = g;

  return finalize(g);
};

// ---- MUG ----
Fallbacks.buildMug = function(){
  const g = new BABYLON.TransformNode('mug', _scene);
  const woodMat = mat('mug_wood', '#6a4a2a', 0.88, 0);

  const body = BABYLON.MeshBuilder.CreateCylinder('body', {
    height:0.12, diameterTop:0.07, diameterBottom:0.06, tessellation:10
  }, _scene);
  body.material = woodMat; body.position.y = 0.06; body.parent = g;

  // Handle
  const handle = BABYLON.MeshBuilder.CreateTorus('handle', {diameter:0.06,thickness:0.008,tessellation:10}, _scene);
  handle.material = woodMat; handle.position.set(0.04, 0.06, 0); handle.rotation.z = Math.PI/2; handle.parent = g;

  return finalize(g);
};

// ---- RUG ----
Fallbacks.buildRug = function(){
  const g = new BABYLON.TransformNode('rug', _scene);
  const rugMat = mat('rug_main', '#8a3030', 0.95, 0);
  const borderMat = mat('rug_border', '#2a1a1a', 0.95, 0);

  const border = BABYLON.MeshBuilder.CreateBox('border', {width:2.7,height:0.005,depth:1.7}, _scene);
  border.material = borderMat; border.position.y = 0.002; border.parent = g;

  const main = BABYLON.MeshBuilder.CreateBox('body', {width:2.5,height:0.008,depth:1.5}, _scene);
  main.material = rugMat; main.position.y = 0.006; main.parent = g;

  // Center pattern
  const pattern = BABYLON.MeshBuilder.CreateBox('pattern', {width:1.0,height:0.009,depth:0.6}, _scene);
  pattern.material = mat('rug_accent', '#c8a44e', 0.9, 0);
  pattern.position.y = 0.009; pattern.parent = g;

  return finalize(g);
};

// ---- DOOR (convention-named) ----
Fallbacks.buildDoor = function(){
  const g = new BABYLON.TransformNode('door', _scene);
  const woodMat = mat('door_wood', '#6a4a2a', 0.88, 0);
  const metalMat = mat('door_metal', '#3a3a3a', 0.4, 0.7);
  const plankMat = mat('door_plank', '#5a3a1a', 0.92, 0);

  // Main panel — collision body
  const panel = BABYLON.MeshBuilder.CreateBox('door_panel_COL', {width:0.95,height:2.1,depth:0.06}, _scene);
  panel.material = woodMat; panel.position.y = 1.05; panel.parent = g;

  // Vertical stiles (decorative)
  for(const x of [-0.38, 0, 0.38]){
    const stile = BABYLON.MeshBuilder.CreateBox('door_stile_VIS', {width:0.04,height:2.0,depth:0.065}, _scene);
    stile.material = plankMat; stile.position.set(x, 1.05, 0.001); stile.parent = g;
  }

  // Horizontal rails (decorative)
  for(const y of [0.25, 1.05, 1.85]){
    const rail = BABYLON.MeshBuilder.CreateBox('door_rail_VIS', {width:0.93,height:0.04,depth:0.065}, _scene);
    rail.material = plankMat; rail.position.set(0, y, 0.001); rail.parent = g;
  }

  // Handle plate + grip
  const handlePlate = BABYLON.MeshBuilder.CreateBox('door_handlePlate_VIS', {width:0.04,height:0.14,depth:0.01}, _scene);
  handlePlate.material = metalMat; handlePlate.position.set(0.33, 1.0, 0.035); handlePlate.parent = g;
  const handle = BABYLON.MeshBuilder.CreateCylinder('door_handle_VIS', {height:0.12,diameter:0.025,tessellation:8}, _scene);
  handle.material = metalMat; handle.rotation.x = Math.PI/2;
  handle.position.set(0.33, 1.0, 0.055); handle.parent = g;

  // Hinge plates + pins
  for(const y of [0.3, 1.8]){
    const hinge = BABYLON.MeshBuilder.CreateBox('door_hinge_VIS', {width:0.06,height:0.08,depth:0.015}, _scene);
    hinge.material = metalMat; hinge.position.set(-0.46, y, 0.035); hinge.parent = g;
    const pin = BABYLON.MeshBuilder.CreateCylinder('door_pin_VIS', {height:0.1,diameter:0.015,tessellation:6}, _scene);
    pin.material = metalMat; pin.position.set(-0.475, y, 0.0); pin.parent = g;
  }

  // Pivot marker (hinge edge)
  const pivMarker = BABYLON.MeshBuilder.CreateBox('door_hinge_PIV', {width:0.01,height:0.01,depth:0.01}, _scene);
  pivMarker.position.set(-0.475, 0, 0); pivMarker.parent = g;

  return finalize(g);
};

// ---- PALM TREE ----
Fallbacks.buildPalmTree = function(){
  const g = new BABYLON.TransformNode('palm', _scene);
  const trunkMat = mat('palm_trunk', '#8B6914', 0.9, 0);
  const leafMat = mat('palm_leaf', '#228B22', 0.8, 0);

  // Segmented trunk with slight curve
  const segments = 8;
  for(let i = 0; i < segments; i++){
    const t = i / segments;
    const h = 0.8;
    const dTop = 0.12 - t * 0.05;
    const dBot = 0.15 - t * 0.05;
    const seg = BABYLON.MeshBuilder.CreateCylinder('trunk', {
      height: h, diameterTop: dTop, diameterBottom: dBot, tessellation: 8
    }, _scene);
    seg.material = trunkMat;
    seg.position.set(Math.sin(t * 0.3) * 0.3, t * (h * segments) + h/2, 0);
    seg.parent = g;
  }

  // Fronds
  for(let i = 0; i < 7; i++){
    const angle = (i / 7) * Math.PI * 2;
    const frond = BABYLON.MeshBuilder.CreateBox('frond', {width:0.4,height:0.04,depth:2.8}, _scene);
    frond.material = leafMat;
    frond.position.set(Math.cos(angle)*0.6, 6.2, Math.sin(angle)*0.6);
    frond.rotation.set(0.6, angle, 0);
    frond.parent = g;

    // Frond tip droops
    const tip = BABYLON.MeshBuilder.CreateBox('tip', {width:0.3,height:0.03,depth:1.2}, _scene);
    tip.material = leafMat;
    tip.position.set(0, -0.15, 1.5);
    tip.rotation.x = 0.4;
    tip.parent = frond;
  }

  return finalize(g);
};

// ---- ROCK ----
Fallbacks.buildRock = function(){
  const g = new BABYLON.TransformNode('rock', _scene);
  const rockMat = mat('rock_grey', '#707068', 0.95, 0);

  const rock = BABYLON.MeshBuilder.CreateSphere('body', {diameter:1.8,segments:8}, _scene);
  rock.material = rockMat;
  rock.scaling.set(1.2, 0.6, 1.0);
  rock.position.y = 0.3;
  rock.parent = g;

  // Smaller accent rock
  const small = BABYLON.MeshBuilder.CreateSphere('accent', {diameter:0.8,segments:6}, _scene);
  small.material = rockMat;
  small.scaling.set(1, 0.5, 0.8);
  small.position.set(0.7, 0.15, 0.3);
  small.parent = g;

  return finalize(g, ['body']);
};

// ---- DOCK SECTION ----
Fallbacks.buildDockSection = function(){
  const g = new BABYLON.TransformNode('dock', _scene);
  const plankMat = mat('dock_plank', '#8b7355', 0.9, 0);
  const darkMat = mat('dock_dark', '#5C4030', 0.95, 0);

  // Platform with plank gaps
  for(let i = -4; i <= 4; i++){
    const plank = BABYLON.MeshBuilder.CreateBox('plank', {width:0.48,height:0.08,depth:3}, _scene);
    plank.material = i % 2 === 0 ? plankMat : darkMat;
    plank.position.set(i * 0.52, 0.6, 0);
    plank.parent = g;
  }

  // Stilts
  for(const sp of [{x:-2,z:-1},{x:-2,z:1},{x:0,z:-1},{x:0,z:1},{x:2,z:-1},{x:2,z:1}]){
    const stilt = BABYLON.MeshBuilder.CreateCylinder('stilt', {height:1.5,diameter:0.12,tessellation:6}, _scene);
    stilt.material = darkMat; stilt.position.set(sp.x, -0.1, sp.z); stilt.parent = g;
  }

  return finalize(g);
};

// ---- MOORING POST ----
Fallbacks.buildMooringPost = function(){
  const g = new BABYLON.TransformNode('post', _scene);
  const woodMat = mat('post_wood', '#5C4030', 0.9, 0);

  const post = BABYLON.MeshBuilder.CreateCylinder('body', {height:1.2,diameterTop:0.1,diameterBottom:0.15,tessellation:8}, _scene);
  post.material = woodMat; post.position.y = 0.6; post.parent = g;

  const cap = BABYLON.MeshBuilder.CreateSphere('cap', {diameter:0.18,segments:6}, _scene);
  cap.material = woodMat; cap.position.y = 1.25; cap.parent = g;

  // Rope coil
  const rope = BABYLON.MeshBuilder.CreateTorus('rope', {diameter:0.2,thickness:0.015,tessellation:16}, _scene);
  rope.material = mat('rope', '#c8b888', 0.95, 0);
  rope.position.y = 0.9; rope.parent = g;

  return finalize(g, ['body']);
};

// ---- SIGN ----
Fallbacks.buildSign = function(){
  const g = new BABYLON.TransformNode('sign', _scene);
  const woodMat = mat('sign_wood', '#6a4a2a', 0.88, 0);
  const metalMat = mat('sign_metal', '#444', 0.4, 0.7);

  // Post
  const post = BABYLON.MeshBuilder.CreateCylinder('post', {height:2.5,diameter:0.08,tessellation:6}, _scene);
  post.material = woodMat; post.position.y = 1.25; post.parent = g;

  // Arm
  const arm = BABYLON.MeshBuilder.CreateBox('arm', {width:1.2,height:0.06,depth:0.06}, _scene);
  arm.material = metalMat; arm.position.set(0.5, 2.3, 0); arm.parent = g;

  // Sign board
  const board = BABYLON.MeshBuilder.CreateBox('board', {width:0.8,height:0.5,depth:0.03}, _scene);
  board.material = woodMat; board.position.set(0.5, 1.95, 0); board.parent = g;

  return finalize(g);
};

// ---- NPC PLACEHOLDERS ----
Fallbacks.buildNPCVillager = function(){ return buildNPCBase('#8a6a4a', '#5a8a5a'); };
Fallbacks.buildNPCGuard = function(){ return buildNPCBase('#4a4a5a', '#8a3030'); };
Fallbacks.buildNPCMerchant = function(){ return buildNPCBase('#6a5a3a', '#c8a44e'); };

function buildNPCBase(bodyColor, accentColor){
  const g = new BABYLON.TransformNode('npc', _scene);
  const bodyMat = mat('npc_body_'+bodyColor, bodyColor, 0.85, 0);
  const accentMat = mat('npc_accent_'+accentColor, accentColor, 0.85, 0);
  const skinMat = mat('npc_skin', '#d4a574', 0.9, 0);

  // Torso
  const torso = BABYLON.MeshBuilder.CreateBox('body', {width:0.4,height:0.55,depth:0.25}, _scene);
  torso.material = bodyMat; torso.position.y = 1.1; torso.parent = g;

  // Belt
  const belt = BABYLON.MeshBuilder.CreateBox('belt', {width:0.42,height:0.06,depth:0.27}, _scene);
  belt.material = accentMat; belt.position.y = 0.85; belt.parent = g;

  // Head
  const head = BABYLON.MeshBuilder.CreateSphere('head', {diameter:0.24,segments:8}, _scene);
  head.material = skinMat; head.position.y = 1.55; head.parent = g;

  // Legs
  for(const x of [-0.1, 0.1]){
    const leg = BABYLON.MeshBuilder.CreateBox('leg', {width:0.15,height:0.6,depth:0.18}, _scene);
    leg.material = bodyMat; leg.position.set(x, 0.5, 0); leg.parent = g;
  }

  // Arms
  for(const x of [-0.28, 0.28]){
    const arm = BABYLON.MeshBuilder.CreateBox('arm', {width:0.1,height:0.5,depth:0.12}, _scene);
    arm.material = bodyMat; arm.position.set(x, 1.05, 0); arm.parent = g;

    const hand = BABYLON.MeshBuilder.CreateSphere('hand', {diameter:0.08,segments:6}, _scene);
    hand.material = skinMat; hand.position.set(x, 0.75, 0); hand.parent = g;
  }

  // Boots
  for(const x of [-0.1, 0.1]){
    const boot = BABYLON.MeshBuilder.CreateBox('boot', {width:0.16,height:0.2,depth:0.24}, _scene);
    boot.material = mat('npc_boot', '#2a1a0a', 0.9, 0);
    boot.position.set(x, 0.1, 0.02); boot.parent = g;
  }

  return finalize(g, ['body']);
}

// ---- WALL MODULE (half-timber panel, 2m wide x 3.5m tall) ----
Fallbacks.buildWallModule = function(){
  const g = new BABYLON.TransformNode('wallMod', _scene);
  const plasterMat = mat('wall_plaster', '#c8b898', 0.92, 0);
  const timberMat = mat('wall_timber', '#5c3a1e', 0.9, 0);
  const W = 2.0, H = 3.5, D = 0.3;

  // Plaster infill panel (recessed slightly from timbers)
  const panel = BABYLON.MeshBuilder.CreateBox('wall', {width:W-0.12, height:H-0.12, depth:D-0.06}, _scene);
  panel.material = plasterMat; panel.position.set(0, H/2, 0); panel.parent = g;

  // Vertical timbers (left + right edges)
  for(const x of [-W/2+0.03, W/2-0.03]){
    const post = BABYLON.MeshBuilder.CreateBox('timber', {width:0.1, height:H, depth:D}, _scene);
    post.material = timberMat; post.position.set(x, H/2, 0); post.parent = g;
  }
  // Horizontal timbers (bottom, mid, top)
  for(const y of [0.05, H/2, H-0.05]){
    const rail = BABYLON.MeshBuilder.CreateBox('timber', {width:W, height:0.1, depth:D}, _scene);
    rail.material = timberMat; rail.position.set(0, y, 0); rail.parent = g;
  }
  // Diagonal brace (X pattern in upper half)
  const braceLen = Math.sqrt((W-0.2)*(W-0.2) + (H/2-0.2)*(H/2-0.2));
  const braceAngle = Math.atan2(H/2-0.2, W-0.2);
  const brace = BABYLON.MeshBuilder.CreateBox('brace', {width:braceLen, height:0.06, depth:0.08}, _scene);
  brace.material = timberMat;
  brace.position.set(0, H*0.75, 0.02);
  brace.rotation.z = braceAngle;
  brace.parent = g;

  return finalize(g, ['wall']);
};

// ---- ROOF MODULE (pitched section, 2m wide) ----
Fallbacks.buildRoofModule = function(){
  const g = new BABYLON.TransformNode('roofMod', _scene);
  const tileMat = mat('roof_tile', '#6b4226', 0.92, 0);
  const beamMat = mat('roof_beam', '#5c3a1e', 0.9, 0);
  const W = 2.0, D = 3.5;

  // Main roof slab with thickness
  const slab = BABYLON.MeshBuilder.CreateBox('body', {width:W, height:0.15, depth:D}, _scene);
  slab.material = tileMat; slab.position.y = 0; slab.parent = g;

  // Fascia board (front edge trim)
  const fascia = BABYLON.MeshBuilder.CreateBox('fascia', {width:W+0.1, height:0.12, depth:0.04}, _scene);
  fascia.material = beamMat; fascia.position.set(0, -0.02, D/2+0.02); fascia.parent = g;

  // Ridge beam (runs along the top edge)
  const ridge = BABYLON.MeshBuilder.CreateBox('ridge', {width:W+0.05, height:0.08, depth:0.08}, _scene);
  ridge.material = beamMat; ridge.position.set(0, 0.1, -D/2); ridge.parent = g;

  // Rafter ends (protruding below roof every 0.5m)
  for(let z = -D/2 + 0.3; z <= D/2; z += 0.6){
    const rafter = BABYLON.MeshBuilder.CreateBox('rafter', {width:W+0.15, height:0.06, depth:0.05}, _scene);
    rafter.material = beamMat; rafter.position.set(0, -0.1, z); rafter.parent = g;
  }

  return finalize(g, ['body']);
};

// ---- FLOOR PLANK MODULE (2m x 2m plank section) ----
Fallbacks.buildFloorModule = function(){
  const g = new BABYLON.TransformNode('floorMod', _scene);
  const plankMat = mat('floor_plank', '#a08060', 0.88, 0);
  const gapMat = mat('floor_gap', '#3a2a1a', 0.95, 0);

  // Individual planks with gaps between
  const plankW = 0.18;
  const gap = 0.02;
  const count = Math.floor(2.0 / (plankW + gap));
  for(let i = 0; i < count; i++){
    const plank = BABYLON.MeshBuilder.CreateBox('plank', {
      width: plankW, height: 0.04, depth: 2.0
    }, _scene);
    plank.material = plankMat;
    plank.position.set(-1.0 + i*(plankW+gap) + plankW/2, 0, 0);
    plank.parent = g;
  }

  // Joist underneath (crossbeam)
  const joist = BABYLON.MeshBuilder.CreateBox('joist', {width:2.0, height:0.08, depth:0.06}, _scene);
  joist.material = gapMat; joist.position.set(0, -0.06, 0); joist.parent = g;

  return finalize(g);
};

// ---- CEILING BEAM MODULE (exposed beam + plank infill, 2m section) ----
Fallbacks.buildCeilingBeamModule = function(){
  const g = new BABYLON.TransformNode('ceilMod', _scene);
  const beamMat = mat('ceil_beam', '#5c3a1e', 0.9, 0);
  const plankMat = mat('ceil_plank', '#7a5a3a', 0.92, 0);

  // Main beam (runs across the room)
  const beam = BABYLON.MeshBuilder.CreateBox('beam', {width:2.0, height:0.16, depth:0.14}, _scene);
  beam.material = beamMat; beam.position.y = 0; beam.parent = g;

  // Plank infill between beams (runs perpendicular)
  for(let x = -0.9; x <= 0.9; x += 0.2){
    const plank = BABYLON.MeshBuilder.CreateBox('plank', {width:0.18, height:0.03, depth:1.2}, _scene);
    plank.material = plankMat; plank.position.set(x, 0.09, 0); plank.parent = g;
  }

  return finalize(g);
};

// ---- STAIR STEP (single step with riser face) ----
Fallbacks.buildStairStep = function(){
  const g = new BABYLON.TransformNode('step', _scene);
  const woodMat = mat('stair_wood', '#8b6c42', 0.88, 0);
  const darkMat = mat('stair_dark', '#5c3a1e', 0.92, 0);

  // Tread (top surface you walk on)
  const tread = BABYLON.MeshBuilder.CreateBox('body', {width:1.3, height:0.04, depth:0.3}, _scene);
  tread.material = woodMat; tread.position.set(0, 0.35, 0); tread.parent = g;

  // Riser (front face)
  const riser = BABYLON.MeshBuilder.CreateBox('riser', {width:1.3, height:0.35, depth:0.03}, _scene);
  riser.material = darkMat; riser.position.set(0, 0.175, 0.135); riser.parent = g;

  // Nosing (slight overhang on tread front)
  const nosing = BABYLON.MeshBuilder.CreateBox('nosing', {width:1.32, height:0.02, depth:0.04}, _scene);
  nosing.material = woodMat; nosing.position.set(0, 0.36, 0.16); nosing.parent = g;

  return finalize(g, ['body']);
};

// ---- RAILING MODULE (post + rail + balusters, 1m section) ----
Fallbacks.buildRailingModule = function(){
  const g = new BABYLON.TransformNode('railing', _scene);
  const woodMat = mat('rail_wood', '#5c3a1e', 0.9, 0);

  // Post
  const post = BABYLON.MeshBuilder.CreateBox('post', {width:0.06, height:1.0, depth:0.06}, _scene);
  post.material = woodMat; post.position.set(0, 0.5, 0); post.parent = g;

  // Top rail
  const rail = BABYLON.MeshBuilder.CreateBox('body', {width:1.0, height:0.05, depth:0.06}, _scene);
  rail.material = woodMat; rail.position.set(0.5, 1.0, 0); rail.parent = g;

  // Balusters (4 per 1m section)
  for(let i = 1; i <= 4; i++){
    const bal = BABYLON.MeshBuilder.CreateCylinder('bal', {height:0.85, diameter:0.025, tessellation:6}, _scene);
    bal.material = woodMat; bal.position.set(i*0.2, 0.52, 0); bal.parent = g;
  }

  // Mid rail
  const midRail = BABYLON.MeshBuilder.CreateBox('mid', {width:1.0, height:0.03, depth:0.04}, _scene);
  midRail.material = woodMat; midRail.position.set(0.5, 0.5, 0); midRail.parent = g;

  return finalize(g, ['body']);
};

// ---- WINDOW FRAME (shuttered window, 0.8m x 1.0m) ----
Fallbacks.buildWindowFrame = function(){
  const g = new BABYLON.TransformNode('window', _scene);
  const frameMat = mat('win_frame', '#5c3a1e', 0.9, 0);
  const glassMat = mat('win_glass', '#6090b0', 0.15, 0.05);
  glassMat.alpha = 0.35;
  const shutterMat = mat('win_shutter', '#6a4a2a', 0.88, 0);

  // Frame (outer border)
  for(const side of [
    {w:0.08, h:1.0, d:0.15, x:-0.4, y:0.5},  // left
    {w:0.08, h:1.0, d:0.15, x:0.4, y:0.5},   // right
    {w:0.88, h:0.08, d:0.15, x:0, y:0},       // bottom
    {w:0.88, h:0.08, d:0.15, x:0, y:1.0},     // top
  ]){
    const f = BABYLON.MeshBuilder.CreateBox('frame', {width:side.w, height:side.h, depth:side.d}, _scene);
    f.material = frameMat; f.position.set(side.x, side.y, 0); f.parent = g;
  }

  // Glass pane
  const glass = BABYLON.MeshBuilder.CreateBox('glass', {width:0.72, height:0.84, depth:0.01}, _scene);
  glass.material = glassMat; glass.position.set(0, 0.5, 0); glass.parent = g;

  // Cross mullion
  const mullH = BABYLON.MeshBuilder.CreateBox('mullH', {width:0.72, height:0.03, depth:0.04}, _scene);
  mullH.material = frameMat; mullH.position.set(0, 0.5, 0.01); mullH.parent = g;
  const mullV = BABYLON.MeshBuilder.CreateBox('mullV', {width:0.03, height:0.84, depth:0.04}, _scene);
  mullV.material = frameMat; mullV.position.set(0, 0.5, 0.01); mullV.parent = g;

  // Left shutter (open at angle)
  const shutterL = BABYLON.MeshBuilder.CreateBox('shutter', {width:0.35, height:0.9, depth:0.03}, _scene);
  shutterL.material = shutterMat;
  shutterL.position.set(-0.55, 0.5, 0.06);
  shutterL.rotation.y = 0.4;
  shutterL.parent = g;

  // Right shutter (open at angle)
  const shutterR = BABYLON.MeshBuilder.CreateBox('shutter', {width:0.35, height:0.9, depth:0.03}, _scene);
  shutterR.material = shutterMat;
  shutterR.position.set(0.55, 0.5, 0.06);
  shutterR.rotation.y = -0.4;
  shutterR.parent = g;

  // Sill
  const sill = BABYLON.MeshBuilder.CreateBox('sill', {width:0.96, height:0.04, depth:0.2}, _scene);
  sill.material = frameMat; sill.position.set(0, -0.02, 0.06); sill.parent = g;

  return finalize(g);
};

// ---- CHEST (production fallback with curved lid) ----
Fallbacks.buildChest = function(){
  const g = new BABYLON.TransformNode('chest', _scene);
  const woodMat = mat('chest_wood', '#5c3a1e', 0.88, 0);
  const bandMat = mat('chest_band', '#3a3a3a', 0.4, 0.7);
  const goldMat = mat('chest_gold', '#c8a44e', 0.3, 0.7);

  // Base box with slight taper
  const base = BABYLON.MeshBuilder.CreateBox('body', {width:0.7, height:0.38, depth:0.45}, _scene);
  base.material = woodMat; base.position.y = 0.19; base.parent = g;

  // Plank lines on front
  for(let y = 0.08; y <= 0.32; y += 0.08){
    const line = BABYLON.MeshBuilder.CreateBox('line', {width:0.71, height:0.01, depth:0.01}, _scene);
    line.material = bandMat; line.position.set(0, y, 0.23); line.parent = g;
  }

  // Iron strapping bands (3 bands wrapping around)
  for(const y of [0.06, 0.2, 0.34]){
    const band = BABYLON.MeshBuilder.CreateBox('band', {width:0.72, height:0.025, depth:0.47}, _scene);
    band.material = bandMat; band.position.y = y; band.parent = g;
  }

  // Corner reinforcements
  for(const cx of [-0.35, 0.35]){
    for(const cz of [-0.225, 0.225]){
      const corner = BABYLON.MeshBuilder.CreateBox('corner', {width:0.04, height:0.4, depth:0.04}, _scene);
      corner.material = bandMat; corner.position.set(cx, 0.2, cz); corner.parent = g;
    }
  }

  // Lid (slightly curved using a lathe shape)
  const lidShape = [];
  for(let i = 0; i <= 10; i++){
    const t = i / 10;
    const x = (t - 0.5) * 0.7;
    const y = 0.06 * Math.cos(t * Math.PI);
    lidShape.push(new BABYLON.Vector3(Math.abs(x), y, 0));
  }
  const lid = BABYLON.MeshBuilder.CreateLathe('lid', {
    shape: lidShape, tessellation: 16, sideOrientation: BABYLON.Mesh.DOUBLESIDE
  }, _scene);
  lid.material = woodMat;
  lid.scaling.set(1, 1, 0.64);
  lid.position.set(0, 0.38, 0);
  lid.parent = g;

  // Latch (front center)
  const latch = BABYLON.MeshBuilder.CreateBox('latch', {width:0.08, height:0.1, depth:0.02}, _scene);
  latch.material = goldMat; latch.position.set(0, 0.36, 0.24); latch.parent = g;

  // Keyhole
  const keyhole = BABYLON.MeshBuilder.CreateCylinder('keyhole', {height:0.02, diameter:0.02, tessellation:6}, _scene);
  keyhole.material = bandMat; keyhole.rotation.x = Math.PI/2;
  keyhole.position.set(0, 0.32, 0.24); keyhole.parent = g;

  return finalize(g, ['body']);
};

// ---- TAVERN SHELL (placeholder — complex, game.js builds parametrically) ----
Fallbacks.buildTavernShell = function(){
  return new BABYLON.TransformNode('tavernShell_stub', _scene);
};
Fallbacks.buildTavernRoof = function(){
  return new BABYLON.TransformNode('tavernRoof_stub', _scene);
};

// ============================================================
// EXPOSE GLOBALLY
// ============================================================
window.AssetLibrary = AssetLibrary;
window.AssetCatalog = CATALOG;

})();
