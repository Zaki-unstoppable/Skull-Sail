/**
 * placement.js — Anchor-based, cluster-driven asset placement system
 * Global namespace: window.PlacementSystem
 * Three.js r128 (THREE is global)
 *
 * Architecture:
 *   1. SeededRandom — deterministic PRNG
 *   2. PROP_CATALOG — every prop classified as hero / structural / filler
 *   3. DENSITY_BUDGETS — per-island-type and per-zone caps
 *   4. ANCHOR_TEMPLATES — named anchor points per island type
 *   5. CLUSTER_RECIPES — themed groups of props placed around anchors
 *   6. ExclusionMask — no-place zones (spawn, shop, chest, paths, steep slopes)
 *   7. IslandZoneMapper — maps island type → zones (simplified)
 *   8. AnchorPlacementService — the new core engine
 *   9. FallbackGeometry — procedural meshes (unchanged)
 */
(function(){
'use strict';

// ============================================================================
// 1. SeededRandom — Deterministic PRNG (mulberry32)
// ============================================================================
class SeededRandom {
  constructor(seed){ this._state = seed | 0; }
  next(){
    let t = (this._state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min, max){ return min + this.next() * (max - min); }
  int(min, max){ return Math.floor(this.range(min, max + 1)); }
  pick(arr){ return arr[this.int(0, arr.length - 1)]; }
  shuffle(arr){
    const a = arr.slice();
    for(let i = a.length - 1; i > 0; i--){
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  chance(probability){ return this.next() < probability; }
}

// ============================================================================
// 2. PROP_CATALOG — Every prop has a role
// ============================================================================
// Roles:
//   hero       — 1-2 per island, large landmark pieces, never scattered
//   structural — 3-8 per cluster, define the cluster's purpose
//   filler     — 1-4 per cluster, dressing that supports the scene

const PROP_ROLE = { HERO: 'hero', STRUCTURAL: 'structural', FILLER: 'filler' };

// Scale factors: fallback geometry is authored at small scale.
// These multipliers bring each prop to world-appropriate size.
// (Islands are radius 55–180; buildIsland palms are 10–18 tall.)
const FALLBACK_SCALE = {
  palm_tree: 3.0,
  barrel: 2.5,
  crate: 2.5,
  rock: 3.5,
  wall_section: 3.0,
  torch: 4.0,
  cannon: 2.5,
  dock_section: 3.0,
  fence_section: 2.5,
  hut: 3.0,
  workbench: 2.5,
  broken_column: 3.0,
  treasure_chest: 2.5,
  bush: 3.0,
  shipwreck_piece: 3.0,
  banner: 3.5,
  vine: 3.0,
};

const PROP_CATALOG = {
  // === HERO (large, unique, 1 per island max) ===
  // clearRadius values scaled to match FALLBACK_SCALE
  fort_tower:       { role: PROP_ROLE.HERO, fallback: 'wall_section', clearRadius: 24 },
  castle_ruin:      { role: PROP_ROLE.HERO, fallback: 'broken_column', clearRadius: 24 },
  shipwreck_hull:   { role: PROP_ROLE.HERO, fallback: 'shipwreck_piece', clearRadius: 30 },
  village_hall:     { role: PROP_ROLE.HERO, fallback: 'hut', clearRadius: 21 },
  lighthouse:       { role: PROP_ROLE.HERO, fallback: 'torch', clearRadius: 18 },
  dock_main:        { role: PROP_ROLE.HERO, fallback: 'dock_section', clearRadius: 24 },

  // === STRUCTURAL (medium, define clusters) ===
  wall_section:     { role: PROP_ROLE.STRUCTURAL, clearRadius: 9 },
  cannon:           { role: PROP_ROLE.STRUCTURAL, clearRadius: 6 },
  hut:              { role: PROP_ROLE.STRUCTURAL, clearRadius: 12 },
  dock_section:     { role: PROP_ROLE.STRUCTURAL, clearRadius: 9 },
  workbench:        { role: PROP_ROLE.STRUCTURAL, clearRadius: 5 },
  broken_column:    { role: PROP_ROLE.STRUCTURAL, clearRadius: 6 },
  fence_section:    { role: PROP_ROLE.STRUCTURAL, clearRadius: 5 },
  banner:           { role: PROP_ROLE.STRUCTURAL, clearRadius: 5 },
  treasure_chest:   { role: PROP_ROLE.STRUCTURAL, clearRadius: 5 },
  shipwreck_piece:  { role: PROP_ROLE.STRUCTURAL, clearRadius: 9 },

  // === FILLER (small, dressing) ===
  barrel:           { role: PROP_ROLE.FILLER, clearRadius: 2 },
  crate:            { role: PROP_ROLE.FILLER, clearRadius: 2 },
  rock:             { role: PROP_ROLE.FILLER, clearRadius: 4 },
  bush:             { role: PROP_ROLE.FILLER, clearRadius: 3 },
  torch:            { role: PROP_ROLE.FILLER, clearRadius: 2.5 },
  vine:             { role: PROP_ROLE.FILLER, clearRadius: 2 },
  palm_tree:        { role: PROP_ROLE.FILLER, clearRadius: 7.5 },
};

// ============================================================================
// 3. DENSITY_BUDGETS — Per-island-type total caps + per-zone caps
// ============================================================================
// These cap the PIPELINE-placed props. buildIsland() in game.js already places
// palms, rocks, bushes, grass, chests, shops, forts — so pipeline adds ONLY
// thematic extras that game.js doesn't already create.

const DENSITY_BUDGETS = {
  // island type → { total: max pipeline props, zones: { zoneTag: max props in that zone } }
  fort: {
    total: 28,
    zones: { fort_core: 10, gate_area: 5, cannon_line: 6, watch_post: 4, shoreline: 3 }
  },
  village: {
    total: 26,
    zones: { village_center: 8, dock_edge: 6, work_area: 5, storage_corner: 4, shoreline: 3 }
  },
  ruins: {
    total: 20,
    zones: { ruin_core: 8, clue_zone: 4, overgrown_area: 5, shoreline: 3 }
  },
  tropical: {
    total: 14,
    zones: { jungle_interior: 5, treasure_hint: 3, shoreline: 4, clearing: 2 }
  },
  outpost: {
    total: 22,
    zones: { outpost_core: 6, dock_edge: 5, guard_post: 4, storage_corner: 4, shoreline: 3 }
  },
  wild: {
    total: 12,
    zones: { jungle_interior: 4, hidden_spot: 3, shoreline: 3, clearing: 2 }
  },
  // Default fallback
  _default: {
    total: 14,
    zones: { shoreline: 4, interior: 6, clearing: 4 }
  }
};

// ============================================================================
// 4. ANCHOR_TEMPLATES — Named anchor points per island type
// ============================================================================
// Each anchor: { name, offsetAngle (radians from center), offsetDist (fraction of radius),
//                cluster, heroChance }
// offsetAngle: null = random, number = fixed relative angle
// offsetDist: 0 = center, 1 = edge

const ANCHOR_TEMPLATES = {
  fort: [
    { name: 'fort_core',   offsetDist: 0.0,  cluster: 'fort_center',     heroChance: 1.0 },
    { name: 'gate_area',   offsetDist: 0.4,  cluster: 'fort_gate',       heroChance: 0 },
    { name: 'cannon_line', offsetDist: 0.55, cluster: 'cannon_battery',  heroChance: 0 },
    { name: 'watch_post',  offsetDist: 0.7,  cluster: 'lookout',         heroChance: 0 },
    { name: 'shoreline',   offsetDist: 0.88, cluster: 'shore_scatter',   heroChance: 0 },
  ],
  village: [
    { name: 'village_center',  offsetDist: 0.05, cluster: 'village_hub',    heroChance: 0.8 },
    { name: 'dock_edge',       offsetDist: 0.7,  cluster: 'dock_cluster',   heroChance: 0 },
    { name: 'work_area',       offsetDist: 0.35, cluster: 'workshop',       heroChance: 0 },
    { name: 'storage_corner',  offsetDist: 0.45, cluster: 'storage_yard',   heroChance: 0 },
    { name: 'shoreline',       offsetDist: 0.88, cluster: 'shore_scatter',  heroChance: 0 },
  ],
  ruins: [
    { name: 'ruin_core',      offsetDist: 0.0,  cluster: 'ruin_center',    heroChance: 1.0 },
    { name: 'clue_zone',      offsetDist: 0.3,  cluster: 'treasure_clue',  heroChance: 0 },
    { name: 'overgrown_area', offsetDist: 0.5,  cluster: 'overgrown',      heroChance: 0 },
    { name: 'shoreline',      offsetDist: 0.88, cluster: 'shore_scatter',  heroChance: 0 },
  ],
  tropical: [
    { name: 'jungle_interior', offsetDist: 0.25, cluster: 'jungle_dense',   heroChance: 0 },
    { name: 'treasure_hint',   offsetDist: 0.4,  cluster: 'treasure_clue',  heroChance: 0 },
    { name: 'shoreline',       offsetDist: 0.88, cluster: 'shore_scatter',  heroChance: 0 },
    { name: 'clearing',        offsetDist: 0.15, cluster: 'small_clearing', heroChance: 0 },
  ],
  outpost: [
    { name: 'outpost_core', offsetDist: 0.0,  cluster: 'outpost_hub',    heroChance: 0.6 },
    { name: 'dock_edge',    offsetDist: 0.7,  cluster: 'dock_cluster',   heroChance: 0 },
    { name: 'guard_post',   offsetDist: 0.5,  cluster: 'lookout',        heroChance: 0 },
    { name: 'storage_corner',offsetDist: 0.4, cluster: 'storage_yard',   heroChance: 0 },
    { name: 'shoreline',    offsetDist: 0.88, cluster: 'shore_scatter',  heroChance: 0 },
  ],
  wild: [
    { name: 'jungle_interior', offsetDist: 0.2,  cluster: 'jungle_dense',   heroChance: 0 },
    { name: 'hidden_spot',     offsetDist: 0.45, cluster: 'hidden_cache',   heroChance: 0 },
    { name: 'shoreline',       offsetDist: 0.88, cluster: 'shore_scatter',  heroChance: 0 },
    { name: 'clearing',        offsetDist: 0.15, cluster: 'small_clearing', heroChance: 0 },
  ]
};

// ============================================================================
// 5. CLUSTER_RECIPES — Themed prop groups placed around each anchor
// ============================================================================
// Each recipe: { structural: [...], filler: [...], spread (radius around anchor),
//                facing: 'center'|'outward'|'random', minCount, maxCount }

const CLUSTER_RECIPES = {
  fort_center: {
    hero: ['fort_tower'],
    structural: ['wall_section', 'wall_section', 'banner'],
    filler: ['barrel', 'crate', 'torch'],
    spread: 16, facing: 'outward', minCount: 5, maxCount: 8
  },
  fort_gate: {
    structural: ['wall_section', 'cannon', 'banner'],
    filler: ['barrel', 'crate', 'torch'],
    spread: 12, facing: 'center', minCount: 3, maxCount: 5
  },
  cannon_battery: {
    structural: ['cannon', 'cannon', 'cannon'],
    filler: ['crate', 'barrel'],
    spread: 14, facing: 'outward', minCount: 4, maxCount: 6
  },
  lookout: {
    structural: ['wall_section', 'banner'],
    filler: ['torch', 'barrel', 'crate'],
    spread: 8, facing: 'outward', minCount: 2, maxCount: 4
  },

  village_hub: {
    hero: ['village_hall'],
    structural: ['fence_section', 'workbench'],
    filler: ['barrel', 'crate', 'torch'],
    spread: 14, facing: 'center', minCount: 4, maxCount: 7
  },
  dock_cluster: {
    hero: ['dock_main'],
    structural: ['dock_section'],
    filler: ['barrel', 'crate', 'barrel', 'torch'],
    spread: 14, facing: 'outward', minCount: 3, maxCount: 6
  },
  workshop: {
    structural: ['workbench', 'fence_section'],
    filler: ['barrel', 'crate', 'torch'],
    spread: 8, facing: 'random', minCount: 3, maxCount: 5
  },
  storage_yard: {
    structural: ['fence_section'],
    filler: ['barrel', 'barrel', 'crate', 'crate'],
    spread: 8, facing: 'random', minCount: 3, maxCount: 5
  },

  ruin_center: {
    hero: ['castle_ruin'],
    structural: ['broken_column', 'broken_column', 'wall_section'],
    filler: ['rock', 'vine', 'bush'],
    spread: 16, facing: 'random', minCount: 5, maxCount: 8
  },
  treasure_clue: {
    structural: ['treasure_chest'],
    filler: ['rock', 'vine', 'bush'],
    spread: 8, facing: 'random', minCount: 2, maxCount: 4
  },
  overgrown: {
    structural: ['broken_column', 'fence_section'],
    filler: ['vine', 'bush', 'rock'],
    spread: 12, facing: 'random', minCount: 3, maxCount: 5
  },

  jungle_dense: {
    filler: ['bush', 'vine', 'rock'],
    spread: 12, facing: 'random', minCount: 3, maxCount: 5
  },
  shore_scatter: {
    filler: ['rock', 'crate'],
    spread: 14, facing: 'random', minCount: 2, maxCount: 3
  },
  small_clearing: {
    filler: ['rock', 'bush'],
    spread: 8, facing: 'random', minCount: 1, maxCount: 2
  },

  hidden_cache: {
    structural: ['treasure_chest'],
    filler: ['rock', 'bush', 'vine'],
    spread: 8, facing: 'center', minCount: 2, maxCount: 3
  },

  outpost_hub: {
    hero: ['fort_tower'],
    structural: ['wall_section', 'cannon', 'banner'],
    filler: ['barrel', 'crate', 'torch'],
    spread: 14, facing: 'outward', minCount: 4, maxCount: 6
  },

  // Shipwreck-specific
  shipwreck_hull_area: {
    hero: ['shipwreck_hull'],
    structural: ['shipwreck_piece', 'shipwreck_piece'],
    filler: ['barrel', 'crate', 'rock'],
    spread: 20, facing: 'random', minCount: 4, maxCount: 7
  },
  debris_field: {
    structural: ['shipwreck_piece', 'shipwreck_piece'],
    filler: ['rock', 'barrel', 'crate'],
    spread: 14, facing: 'random', minCount: 3, maxCount: 5
  },
  loot_patch: {
    structural: ['treasure_chest'],
    filler: ['barrel', 'crate', 'rock'],
    spread: 8, facing: 'center', minCount: 2, maxCount: 4
  }
};

// ============================================================================
// 6. ExclusionMask — No-place zones
// ============================================================================
class ExclusionMask {
  constructor(island, rng) {
    this._zones = [];
    this._island = island;
    const ix = island.position.x;
    const iz = island.position.z;
    const ir = island.radius;

    // --- Player spawn / disembark: ring around island edge ---
    // Players approach from any direction, so exclude a band at the shore
    // where they board/leave ships
    this._zones.push({ x: ix, z: iz, r: ir, inner: ir * 0.9, type: 'ring', tag: 'disembark' });

    // --- Shop / interactable zones ---
    if (island.hasShop) {
      // Shop is placed at (0, isl.r*0.35) relative to island center in buildIsland
      this._zones.push({ x: ix, z: iz + ir * 0.4, r: 8, type: 'circle', tag: 'shop' });
    }

    // --- Treasure chest area ---
    if (island.hasTreasure) {
      this._zones.push({ x: ix, z: iz, r: 6, type: 'circle', tag: 'treasure' });
    }

    // --- Fort structure (already built by game.js) ---
    if (island.hasFort) {
      // Fort is at roughly (ir*-0.15, ir*-0.15) relative
      this._zones.push({ x: ix + ir * -0.15, z: iz + ir * -0.15, r: 12, type: 'circle', tag: 'fort_structure' });
    }

    // --- Castle (already built) ---
    if (island.hasCastle) {
      this._zones.push({ x: ix + ir * 0.1, z: iz + ir * -0.1, r: 14, type: 'circle', tag: 'castle_structure' });
    }

    // --- Upgrade center ---
    if (island.hasUpgrade) {
      this._zones.push({ x: ix + ir * 0.2, z: iz + ir * 0.3, r: 8, type: 'circle', tag: 'upgrade' });
    }

    // --- Hut areas (game.js places huts at random spots) ---
    if (island.hasHuts) {
      // Huts are scattered; add a general inner zone exclusion is too aggressive
      // Instead we rely on min-distance checks during placement
    }
  }

  /**
   * Check if a point is in an exclusion zone.
   * @param {number} x world X
   * @param {number} z world Z
   * @returns {boolean} true if placement is BLOCKED here
   */
  isExcluded(x, z) {
    for (const zone of this._zones) {
      if (zone.type === 'circle') {
        const dx = x - zone.x, dz = z - zone.z;
        if (Math.sqrt(dx * dx + dz * dz) < zone.r) return true;
      } else if (zone.type === 'ring') {
        const dx = x - zone.x, dz = z - zone.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > zone.inner && dist < zone.r) return true;
      }
    }
    return false;
  }

  /**
   * Check steep slope. Returns true if too steep for props.
   */
  isTooSteep(x, z, island, maxSlope) {
    const slope = ExclusionMask.getSlope(x, z, island);
    return slope > maxSlope;
  }

  static getTerrainHeight(x, z, island) {
    // Match the actual game terrain layers from buildIsland():
    // Layer scales: base=1.0, beach=0.82, dirt=0.62, grass=0.45, hill=0.25
    // Layer Y:      base=-3,  beach=0.5,  dirt=2.5,  grass=4,    hill=5.5
    // groundH = 7 at island center
    const dx = x - island.position.x;
    const dz = z - island.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    const nd = dist / island.radius; // 0=center, 1=edge

    if (nd > 1.0) return 0; // in water

    // Step through terrain layers from outside in
    if (nd > 0.82) return 0.5;   // beach edge
    if (nd > 0.62) return 2.5;   // beach/sand
    if (nd > 0.45) return 4.0;   // dirt
    if (nd > 0.25) return 5.5;   // grass
    return 7.0;                    // hilltop / groundH
  }

  static getSlope(x, z, island) {
    const d = 0.5;
    const hc = ExclusionMask.getTerrainHeight(x, z, island);
    const hx = ExclusionMask.getTerrainHeight(x + d, z, island);
    const hz = ExclusionMask.getTerrainHeight(x, z + d, island);
    const gx = (hx - hc) / d, gz = (hz - hc) / d;
    return Math.min(Math.sqrt(gx * gx + gz * gz) / 8, 1.0);
  }
}

// ============================================================================
// 7. IslandZoneMapper (simplified — just feeds anchor system)
// ============================================================================
class IslandZoneMapper {
  mapZones(island) {
    // Still returns zone objects for backward compat, but the new system
    // primarily uses ANCHOR_TEMPLATES directly.
    const type = island.type || 'wild';
    const ix = island.position.x;
    const iz = island.position.z;
    const ir = island.radius;
    const zones = [{ tag: type, center: { x: ix, z: iz }, radius: ir }];
    return zones;
  }
}

// ============================================================================
// 8. AnchorPlacementService — The New Core Engine
// ============================================================================
class AnchorPlacementService {
  /**
   * @param {Object} [services]
   * @param {Object} [services.assetSearchService]
   * @param {Object} [services.modelImportService]
   * @param {Object} [services.metadataRegistry]
   */
  constructor(services = {}) {
    this.assetSearchService = services.assetSearchService || null;
    this.modelImportService = services.modelImportService || null;
    this.metadataRegistry = services.metadataRegistry || null;
    /** @type {Map<string, THREE.Object3D>} */
    this._geoCache = new Map();
  }

  /**
   * Main entry: plan + place all props for one island.
   * Returns array of placed asset descriptors.
   */
  planAndPlace(island, scene, seed) {
    const rng = new SeededRandom(seed);
    const type = island.type || 'wild';
    const budget = DENSITY_BUDGETS[type] || DENSITY_BUDGETS._default;
    const anchors = ANCHOR_TEMPLATES[type] || ANCHOR_TEMPLATES.wild;
    const mask = new ExclusionMask(island, rng);

    const ix = island.position.x;
    const iz = island.position.z;
    const ir = island.radius;

    // Track all placed positions for min-distance checks
    const occupied = [];
    const placed = [];
    let totalPlaced = 0;

    // Assign each anchor a deterministic position
    const anchorPositions = this._resolveAnchorPositions(anchors, ix, iz, ir, rng);

    // For each anchor, build its cluster
    for (let ai = 0; ai < anchors.length; ai++) {
      const anchor = anchors[ai];
      const apos = anchorPositions[ai];
      const recipe = CLUSTER_RECIPES[anchor.cluster];
      if (!recipe) continue;

      // Zone budget
      const zoneCap = budget.zones[anchor.name] || 6;
      const totalCap = budget.total;

      // Decide count for this cluster
      const count = rng.int(recipe.minCount, Math.min(recipe.maxCount, zoneCap));
      if (totalPlaced + count > totalCap) continue; // island budget exceeded

      // Build prop list for this cluster: hero first, then structural, then filler
      const propList = [];

      // Hero prop (if recipe has one and anchor allows it)
      if (recipe.hero && anchor.heroChance > 0 && rng.chance(anchor.heroChance)) {
        propList.push({ key: rng.pick(recipe.hero), role: PROP_ROLE.HERO });
      }

      // Structural props
      if (recipe.structural) {
        const structs = rng.shuffle(recipe.structural);
        const structCount = Math.min(structs.length, Math.ceil(count * 0.5));
        for (let i = 0; i < structCount; i++) {
          propList.push({ key: structs[i], role: PROP_ROLE.STRUCTURAL });
        }
      }

      // Fill remaining slots with filler
      if (recipe.filler) {
        const remaining = count - propList.length;
        for (let i = 0; i < remaining; i++) {
          propList.push({ key: rng.pick(recipe.filler), role: PROP_ROLE.FILLER });
        }
      }

      // Place each prop in the cluster
      for (let pi = 0; pi < propList.length; pi++) {
        if (totalPlaced >= totalCap) break;

        const prop = propList[pi];
        const catalog = PROP_CATALOG[prop.key] || { role: prop.role, clearRadius: 1 };
        const clearR = catalog.clearRadius || 1;

        // Position: hero at anchor center, others spiral outward
        let px, pz;
        if (prop.role === PROP_ROLE.HERO) {
          px = apos.x;
          pz = apos.z;
        } else {
          // Place around anchor with increasing distance
          const attempts = 12;
          let found = false;
          for (let att = 0; att < attempts; att++) {
            const angle = rng.range(0, Math.PI * 2);
            const dist = rng.range(clearR, recipe.spread);
            const tx = apos.x + Math.cos(angle) * dist;
            const tz = apos.z + Math.sin(angle) * dist;

            // Check within island
            const dx = tx - ix, dz = tz - iz;
            if (Math.sqrt(dx * dx + dz * dz) > ir * 0.92) continue;

            // Check exclusion mask
            if (mask.isExcluded(tx, tz)) continue;

            // Check slope
            if (mask.isTooSteep(tx, tz, island, 0.3)) continue;

            // Check min distance to all occupied
            if (!this._checkMinDist(tx, tz, occupied, clearR)) continue;

            px = tx; pz = tz;
            found = true;
            break;
          }
          if (!found) continue; // skip this prop
        }

        // Get terrain height
        const py = ExclusionMask.getTerrainHeight(px, pz, island);

        // Create the mesh
        let obj = this._getOrCreateMesh(prop.key, catalog);
        if (!obj) continue;

        // Facing
        let rotY = rng.range(0, Math.PI * 2);
        if (recipe.facing === 'center') {
          rotY = Math.atan2(apos.z - pz, apos.x - px);
        } else if (recipe.facing === 'outward') {
          rotY = Math.atan2(pz - iz, px - ix);
        }

        // Slight scale variation for filler
        let scaleMul = 1.0;
        if (prop.role === PROP_ROLE.FILLER) scaleMul = rng.range(0.8, 1.15);
        else if (prop.role === PROP_ROLE.HERO) scaleMul = rng.range(1.0, 1.2);

        obj.position.set(px, py, pz);
        obj.rotation.set(0, rotY, 0);
        obj.scale.setScalar(scaleMul);
        obj.userData.zoneTag = anchor.name;
        obj.userData.assetKey = prop.key;
        obj.userData.role = prop.role;

        scene.add(obj);
        occupied.push({ x: px, z: pz, r: clearR });
        totalPlaced++;

        placed.push({
          zoneTag: anchor.name,
          assetKey: prop.key,
          object: obj,
          position: { x: px, y: py, z: pz },
          role: prop.role
        });

        // Register metadata
        if (this.metadataRegistry) {
          this.metadataRegistry.register({
            zoneTag: anchor.name,
            assetKey: prop.key,
            position: { x: px, y: py, z: pz },
            objectId: obj.id,
            role: prop.role
          });
        }
      }
    }

    return placed;
  }

  /**
   * Resolve anchor positions deterministically.
   * Spaces anchors around the island, avoiding overlap.
   */
  _resolveAnchorPositions(anchors, ix, iz, ir, rng) {
    const positions = [];
    // Distribute anchors evenly around the island + offset dist from center
    const baseAngle = rng.range(0, Math.PI * 2); // random start rotation
    const angleStep = (Math.PI * 2) / Math.max(anchors.length, 1);

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const angle = baseAngle + angleStep * i + rng.range(-0.2, 0.2);
      const dist = a.offsetDist * ir;
      positions.push({
        x: ix + Math.cos(angle) * dist,
        z: iz + Math.sin(angle) * dist
      });
    }
    return positions;
  }

  /**
   * Check minimum distance to all occupied points.
   */
  _checkMinDist(x, z, occupied, minR) {
    for (const o of occupied) {
      const dx = x - o.x, dz = z - o.z;
      if (Math.sqrt(dx * dx + dz * dz) < (minR + o.r) * 0.5) return false;
    }
    return true;
  }

  /**
   * Get or create a fallback mesh, using geometry cache.
   * Applies FALLBACK_SCALE by baking it into the geometry so Object3D.scale
   * remains at 1.0 — this avoids conflicts with role-based scaleMul.
   */
  _getOrCreateMesh(key, catalog) {
    const fallbackKey = catalog.fallback || key;
    if (this._geoCache.has(fallbackKey)) {
      return this._geoCache.get(fallbackKey).clone();
    }
    const obj = this._createFallback(fallbackKey);
    if (obj) {
      // Bake world scale into geometry so Object3D scale stays 1.0
      const scale = FALLBACK_SCALE[fallbackKey] || FALLBACK_SCALE[key] || 2.5;
      obj.traverse(c => {
        if (c.isMesh && c.geometry) {
          c.geometry.scale(scale, scale, scale);
        }
        // Scale positions of child objects (lights, etc.)
        if (c !== obj) {
          c.position.multiplyScalar(scale);
        }
        // Scale point light range to match
        if (c.isPointLight) {
          c.distance *= scale;
          c.intensity *= scale * 0.5;
        }
      });
      this._geoCache.set(fallbackKey, obj);
      return obj.clone();
    }
    return null;
  }

  /**
   * Create fallback procedural mesh.
   */
  _createFallback(key) {
    const k = key.toLowerCase().replace(/[^a-z_]/g, '');
    if (k.includes('palm') || k === 'palm_tree') return FallbackGeometry.palm_tree();
    if (k.includes('barrel')) return FallbackGeometry.barrel();
    if (k.includes('crate') || k.includes('cargo') || k.includes('storage')) return FallbackGeometry.crate();
    if (k.includes('rock') || k.includes('stone') || k.includes('cliff')) return FallbackGeometry.rock(1);
    if (k.includes('wall')) return FallbackGeometry.wall_section();
    if (k.includes('torch') || k.includes('lantern')) return FallbackGeometry.torch();
    if (k.includes('cannon')) return FallbackGeometry.cannon();
    if (k.includes('dock')) return FallbackGeometry.dock_section();
    if (k.includes('fence')) return FallbackGeometry.fence_section();
    if (k.includes('hut') || k.includes('hall')) return FallbackGeometry.hut();
    if (k.includes('workbench') || k.includes('table')) return FallbackGeometry.workbench();
    if (k.includes('column') || k.includes('pillar') || k.includes('castle_ruin')) return FallbackGeometry.broken_column();
    if (k.includes('chest') || k.includes('treasure') || k.includes('loot')) return FallbackGeometry.treasure_chest();
    if (k.includes('bush') || k.includes('foliage') || k.includes('grass') || k.includes('vegetation')) return FallbackGeometry.bush();
    if (k.includes('mast') || k.includes('plank') || k.includes('hull') || k.includes('sail') || k.includes('shipwreck')) return FallbackGeometry.shipwreck_piece();
    if (k.includes('banner') || k.includes('lighthouse')) return FallbackGeometry.banner();
    if (k.includes('root') || k.includes('vine')) return FallbackGeometry.vine();
    if (k.includes('tower') || k.includes('fort_tower')) return FallbackGeometry.wall_section();
    return FallbackGeometry.rock(0.5);
  }
}

// ============================================================================
// Backward-compatible wrapper: AssetPlacementService
// ============================================================================
// This wraps AnchorPlacementService but exposes the old API so game.js
// integration code doesn't need major changes.
class AssetPlacementService {
  constructor(services = {}) {
    this._anchor = new AnchorPlacementService(services);
  }

  /**
   * Old API: planPlacements returns plans array.
   * New: we return a lightweight array the execute step will use.
   */
  planPlacements(island, zones, seed) {
    // Return a single "plan" per island that the execute step will expand
    return [{ island, zones, seed, _useAnchorSystem: true }];
  }

  /**
   * Old API: executePlacements processes plans and adds to scene.
   */
  async executePlacements(plans, scene) {
    const allPlaced = [];
    for (const plan of plans) {
      if (plan._useAnchorSystem) {
        const placed = this._anchor.planAndPlace(plan.island, scene, plan.seed);
        allPlaced.push(...placed);
      }
    }
    return allPlaced;
  }

  // Expose terrain helpers for external use
  getTerrainHeight(x, z, island) { return ExclusionMask.getTerrainHeight(x, z, island); }
  checkSlope(x, z, island) { return ExclusionMask.getSlope(x, z, island); }
}

// ============================================================================
// 9. FallbackGeometry — Procedural meshes (unchanged from original)
// ============================================================================
class FallbackGeometry {
  static _enableShadows(mesh) {
    mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
  }
  static _enableGroupShadows(group) {
    group.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
    return group;
  }

  static palm_tree() {
    const g = new THREE.Group(); g.name = 'fallback_palm_tree';
    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.25, 6, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8B6914, roughness: 0.9 });
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 3; trunk.rotation.z = 0.05; g.add(trunk);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x228B22, roughness: 0.8 });
    const lps = [
      { x: 0, y: 6.2, z: 0 }, { x: 0.8, y: 5.8, z: 0.3 },
      { x: -0.6, y: 5.9, z: 0.7 }, { x: 0.3, y: 5.7, z: -0.8 },
      { x: -0.7, y: 5.6, z: -0.4 }
    ];
    for (const lp of lps) {
      const lg = new THREE.SphereGeometry(0.9, 6, 4); lg.scale(1, 0.5, 1.2);
      const l = new THREE.Mesh(lg, leafMat); l.position.set(lp.x, lp.y, lp.z); g.add(l);
    }
    return this._enableGroupShadows(g);
  }

  static barrel() {
    const g = new THREE.Group(); g.name = 'fallback_barrel';
    const bodyGeo = new THREE.CylinderGeometry(0.45, 0.45, 1.0, 12);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x8B4513, roughness: 0.85 });
    const body = new THREE.Mesh(bodyGeo, bodyMat); body.position.y = 0.5; g.add(body);
    const bandMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.4, metalness: 0.7 });
    for (const yo of [0.15, 0.5, 0.85]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.025, 4, 16), bandMat);
      band.position.y = yo; band.rotation.x = Math.PI / 2; g.add(band);
    }
    return this._enableGroupShadows(g);
  }

  static crate() {
    const g = new THREE.Group(); g.name = 'fallback_crate';
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xA0722A, roughness: 0.9 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), boxMat);
    box.position.y = 0.5; g.add(box);
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x7A5220, roughness: 0.95 });
    const trims = [
      { s: [1.05, 0.05, 0.05], p: [0, 0.25, 0.5] }, { s: [1.05, 0.05, 0.05], p: [0, 0.75, 0.5] },
      { s: [1.05, 0.05, 0.05], p: [0, 0.25, -0.5] }, { s: [1.05, 0.05, 0.05], p: [0, 0.75, -0.5] },
      { s: [0.05, 1.05, 0.05], p: [0.5, 0.5, 0.5] }, { s: [0.05, 1.05, 0.05], p: [-0.5, 0.5, 0.5] }
    ];
    for (const t of trims) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(t.s[0], t.s[1], t.s[2]), trimMat);
      m.position.set(t.p[0], t.p[1], t.p[2]); g.add(m);
    }
    return this._enableGroupShadows(g);
  }

  static rock(size = 1) {
    const g = new THREE.Group(); g.name = 'fallback_rock';
    const geo = new THREE.DodecahedronGeometry(size * 0.8, 1);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const nx = pos.getX(i), ny = pos.getY(i), nz = pos.getZ(i);
      const n = 1 + Math.sin(nx * 5) * Math.cos(nz * 3) * 0.15;
      pos.setXYZ(i, nx * n, ny * n, nz * n);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.95 });
    const m = new THREE.Mesh(geo, mat); m.position.y = size * 0.4; g.add(m);
    return this._enableGroupShadows(g);
  }

  static wall_section() {
    const g = new THREE.Group(); g.name = 'fallback_wall_section';
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x9A9A8A, roughness: 0.9 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.6), wallMat);
    wall.position.y = 1.5; g.add(wall);
    const lineMat = new THREE.MeshStandardMaterial({ color: 0x7A7A6A, roughness: 0.95 });
    for (let row = 0; row < 4; row++) {
      const line = new THREE.Mesh(new THREE.BoxGeometry(4.05, 0.02, 0.65), lineMat);
      line.position.y = 0.75 * row + 0.375; g.add(line);
    }
    return this._enableGroupShadows(g);
  }

  static torch() {
    const g = new THREE.Group(); g.name = 'fallback_torch';
    const handleMat = new THREE.MeshStandardMaterial({ color: 0x5C3A1E, roughness: 0.9 });
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.5, 6), handleMat);
    handle.position.y = 0.25; g.add(handle);
    const holderMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.5 });
    const holder = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.06, 0.1, 6), holderMat);
    holder.position.y = 0.55; g.add(holder);
    const flameMat = new THREE.MeshStandardMaterial({ color: 0xFF6600, emissive: 0xFF4400, emissiveIntensity: 2 });
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 6), flameMat);
    flame.position.y = 0.65; g.add(flame);
    const light = new THREE.PointLight(0xFF8833, 0.8, 6);
    light.position.y = 0.7; g.add(light);
    return this._enableGroupShadows(g);
  }

  static cannon() {
    const g = new THREE.Group(); g.name = 'fallback_cannon';
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x2A2A2A, roughness: 0.4, metalness: 0.8 });
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 1.8, 10), metalMat);
    barrel.rotation.z = Math.PI / 2; barrel.position.set(0.4, 0.6, 0); g.add(barrel);
    const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.04, 6, 10), metalMat);
    muzzle.rotation.y = Math.PI / 2; muzzle.position.set(1.3, 0.6, 0); g.add(muzzle);
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x6B4226, roughness: 0.9 });
    const carriage = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.15, 0.6), woodMat);
    carriage.position.set(0.2, 0.35, 0); g.add(carriage);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x4A3520, roughness: 0.9 });
    for (const wo of [{ x: -0.2, z: 0.35 }, { x: -0.2, z: -0.35 }, { x: 0.6, z: 0.35 }, { x: 0.6, z: -0.35 }]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.08, 10), wheelMat);
      wheel.rotation.x = Math.PI / 2; wheel.position.set(wo.x, 0.25, wo.z); g.add(wheel);
    }
    return this._enableGroupShadows(g);
  }

  static dock_section() {
    const g = new THREE.Group(); g.name = 'fallback_dock_section';
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x8B7355, roughness: 0.9 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x5C4030, roughness: 0.95 });
    const plat = new THREE.Mesh(new THREE.BoxGeometry(4, 0.15, 2), woodMat);
    plat.position.y = 1.5; g.add(plat);
    for (let i = -1.5; i <= 1.5; i += 0.5) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.16, 2), darkMat);
      l.position.set(i, 1.5, 0); g.add(l);
    }
    const stiltGeo = new THREE.CylinderGeometry(0.08, 0.08, 2.5, 6);
    for (const sp of [{ x: -1.8, z: -0.8 }, { x: -1.8, z: 0.8 }, { x: 0, z: -0.8 }, { x: 0, z: 0.8 }, { x: 1.8, z: -0.8 }, { x: 1.8, z: 0.8 }]) {
      const s = new THREE.Mesh(stiltGeo, darkMat); s.position.set(sp.x, 0.5, sp.z); g.add(s);
    }
    return this._enableGroupShadows(g);
  }

  static fence_section() {
    const g = new THREE.Group(); g.name = 'fallback_fence_section';
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x8B6C42, roughness: 0.9 });
    for (const y of [0.3, 0.7]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(2, 0.08, 0.05), woodMat);
      rail.position.y = y; g.add(rail);
    }
    for (const x of [-0.9, 0, 0.9]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.0, 0.08), woodMat);
      post.position.set(x, 0.5, 0); g.add(post);
    }
    return this._enableGroupShadows(g);
  }

  static hut() {
    const g = new THREE.Group(); g.name = 'fallback_hut';
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xA08050, roughness: 0.9 });
    const walls = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2, 2.5), wallMat);
    walls.position.y = 1.0; g.add(walls);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x8B6914, roughness: 0.95 });
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.0, 1.5, 4), roofMat);
    roof.position.y = 2.75; roof.rotation.y = Math.PI / 4; g.add(roof);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x2A1A0A, roughness: 0.95 });
    const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.2, 0.1), doorMat);
    door.position.set(0, 0.6, 1.26); g.add(door);
    return this._enableGroupShadows(g);
  }

  static workbench() {
    const g = new THREE.Group(); g.name = 'fallback_workbench';
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x8B6C42, roughness: 0.9 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 0.9), woodMat);
    top.position.y = 0.85; g.add(top);
    const legGeo = new THREE.BoxGeometry(0.08, 0.85, 0.08);
    for (const lx of [-0.8, 0.8]) for (const lz of [-0.35, 0.35]) {
      const leg = new THREE.Mesh(legGeo, woodMat); leg.position.set(lx, 0.425, lz); g.add(leg);
    }
    const toolMat = new THREE.MeshStandardMaterial({ color: 0x666666, metalness: 0.6, roughness: 0.5 });
    const hammer = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.06), toolMat);
    hammer.position.set(-0.4, 0.93, 0); g.add(hammer);
    const block = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.15), woodMat);
    block.position.set(0.5, 0.975, 0.2); g.add(block);
    return this._enableGroupShadows(g);
  }

  static broken_column() {
    const g = new THREE.Group(); g.name = 'fallback_broken_column';
    const geo = new THREE.CylinderGeometry(0.3, 0.4, 2.5, 8, 4);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > 1.0) pos.setY(i, y + Math.sin(i * 2.5) * 0.3 + Math.cos(i * 1.7) * 0.2);
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xB0A890, roughness: 0.85 });
    const col = new THREE.Mesh(geo, mat); col.position.y = 1.25; g.add(col);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.15, 8), mat);
    base.position.y = 0.075; g.add(base);
    return this._enableGroupShadows(g);
  }

  static treasure_chest() {
    const g = new THREE.Group(); g.name = 'fallback_treasure_chest';
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x6B3A1F, roughness: 0.8 });
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xDAA520, metalness: 0.8, roughness: 0.3 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.4, 0.5), woodMat);
    base.position.y = 0.2; g.add(base);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.8, 8, 1, false, 0, Math.PI), woodMat);
    lid.rotation.z = Math.PI / 2; lid.rotation.y = Math.PI; lid.position.set(0, 0.4, 0); g.add(lid);
    for (const y of [0.05, 0.35]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.04, 0.52), goldMat);
      band.position.y = y; g.add(band);
    }
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.06), goldMat);
    lock.position.set(0, 0.35, 0.28); g.add(lock);
    return this._enableGroupShadows(g);
  }

  static bush() {
    const g = new THREE.Group(); g.name = 'fallback_bush';
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2E8B20, roughness: 0.85 });
    for (const s of [{ r: 0.6, x: 0, y: 0.4, z: 0 }, { r: 0.45, x: 0.35, y: 0.35, z: 0.2 }, { r: 0.4, x: -0.3, y: 0.3, z: -0.2 }]) {
      const geo = new THREE.SphereGeometry(s.r, 6, 5); geo.scale(1, 0.7, 1);
      const m = new THREE.Mesh(geo, leafMat); m.position.set(s.x, s.y, s.z); g.add(m);
    }
    return this._enableGroupShadows(g);
  }

  static shipwreck_piece() {
    const g = new THREE.Group(); g.name = 'fallback_shipwreck_piece';
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x6B5030, roughness: 0.95 });
    const plank = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.1, 0.4), woodMat);
    plank.position.y = 0.1; plank.rotation.z = 0.15; g.add(plank);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2, 6), woodMat);
    mast.position.set(0.5, 0.5, 0.3); mast.rotation.z = 0.6; g.add(mast);
    return this._enableGroupShadows(g);
  }

  static banner() {
    const g = new THREE.Group(); g.name = 'fallback_banner';
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x5A3A1A, roughness: 0.8 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 3, 6), poleMat);
    pole.position.y = 1.5; g.add(pole);
    const clothMat = new THREE.MeshStandardMaterial({ color: 0x8B0000, roughness: 0.9, side: THREE.DoubleSide });
    const clothGeo = new THREE.PlaneGeometry(0.8, 1.0, 4, 4);
    const cPos = clothGeo.attributes.position;
    for (let i = 0; i < cPos.count; i++) cPos.setZ(i, Math.sin(cPos.getX(i) * 3) * 0.05);
    clothGeo.computeVertexNormals();
    const cloth = new THREE.Mesh(clothGeo, clothMat); cloth.position.set(0.4, 2.5, 0); g.add(cloth);
    return this._enableGroupShadows(g);
  }

  static vine() {
    const g = new THREE.Group(); g.name = 'fallback_vine';
    const vineMat = new THREE.MeshStandardMaterial({ color: 0x3A5A20, roughness: 0.9 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const v = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.02, 1.5, 4), vineMat);
      v.position.set(Math.cos(a) * 0.3, 0.75, Math.sin(a) * 0.3);
      v.rotation.x = Math.sin(i) * 0.4; v.rotation.z = Math.cos(i) * 0.3; g.add(v);
    }
    return this._enableGroupShadows(g);
  }
}

// ============================================================================
// populateIsland — backward-compatible orchestration function
// ============================================================================
async function populateIsland(island, scene, services = {}, seed) {
  const effectiveSeed = seed ?? island.seed ?? Math.abs(Math.round(island.position.x * 31 + island.position.z * 97));
  const mapper = new IslandZoneMapper();
  const zones = mapper.mapZones(island);
  const placer = new AssetPlacementService(services);
  const plans = placer.planPlacements(island, zones, effectiveSeed);
  const placed = await placer.executePlacements(plans, scene);
  console.log(`[populateIsland] "${island.type}" (${island.name||'?'}): ${placed.length} props placed`);
  return { zones, plans, placed };
}

// ============================================================================
// Exports
// ============================================================================
window.PlacementSystem = {
  SeededRandom,
  IslandZoneMapper,
  AssetPlacementService,
  AnchorPlacementService,
  ExclusionMask,
  FallbackGeometry,
  populateIsland,
  PROP_CATALOG,
  PROP_ROLE,
  DENSITY_BUDGETS,
  ANCHOR_TEMPLATES,
  CLUSTER_RECIPES,
};

})(); // end IIFE
