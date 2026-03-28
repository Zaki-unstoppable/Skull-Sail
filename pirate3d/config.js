// ─── Pirate 3D Asset Pipeline Configuration ───
// Exposed as window.PipelineConfig

(function(){
'use strict';

const Config = {
  // ── API Endpoints ──
  API_ENDPOINTS: {
    ambientcg: 'https://ambientcg.com/api/v2/full_json',
    polyhaven: 'https://api.polyhaven.com',
    sketchfab: 'https://api.sketchfab.com/v3',
    meshy: 'https://api.meshy.ai/v2',
  },

  // ── Proxy base (local dev) ──
  PROXY_BASE: 'http://localhost:3001/api',

  // ── Source Priority Order ──
  SOURCE_PRIORITY: ['local_cache','sketchfab','ambientcg','polyhaven','meshy'],

  // ── Asset Category Triangle Budgets ──
  CATEGORY_BUDGETS: {
    terrain:2000, prop:5000, structure:15000, character:8000,
    npc:6000, vegetation:3000, disaster:10000, inventory:1000,
  },

  // ── Zone Type Definitions ──
  ZONE_TYPES: {
    shoreline:    {label:'Shoreline',    allowedCategories:['terrain','prop','vegetation']},
    deep_water:   {label:'Deep Water',   allowedCategories:['prop','disaster']},
    port:         {label:'Port',         allowedCategories:['structure','prop','npc','vegetation']},
    fort_zone:    {label:'Fort',         allowedCategories:['structure','prop','npc','inventory']},
    castle_zone:  {label:'Castle',       allowedCategories:['structure','prop','npc','inventory']},
    village_zone: {label:'Village',      allowedCategories:['structure','prop','npc','vegetation','inventory']},
    jungle_zone:  {label:'Jungle',       allowedCategories:['terrain','vegetation','prop']},
    ruins_zone:   {label:'Ruins',        allowedCategories:['structure','prop','npc','inventory']},
    mountain_zone:{label:'Mountain',     allowedCategories:['terrain','vegetation','prop']},
    shipwreck_zone:{label:'Shipwreck',   allowedCategories:['prop','inventory']},
    treasure_zone:{label:'Treasure',     allowedCategories:['prop','inventory']},
    npc_spawn_zone:{label:'NPC Spawn',   allowedCategories:['npc','character']},
    player_spawn_zone:{label:'Player Spawn',allowedCategories:['character']},
    storm_zone:   {label:'Storm',        allowedCategories:['disaster']},
    whirlpool_zone:{label:'Whirlpool',   allowedCategories:['disaster']},
    tornado_zone: {label:'Tornado',      allowedCategories:['disaster']},
    typhoon_zone: {label:'Typhoon',      allowedCategories:['disaster']},
    rain_cloud_zone:{label:'Rain Cloud', allowedCategories:['disaster']},
    dark_cloud_zone:{label:'Dark Cloud', allowedCategories:['disaster']},
  },

  // ── Style Filter Keywords ──
  STYLE_FILTERS: {
    include: [
      'pirate','nautical','sailing','ship','galleon','brigantine','sloop',
      'anchor','cannon','treasure','barrel','crate','rope','wooden','colonial',
      'medieval','rustic','old','weathered','rum','compass','map','skull',
      'crossbones','cutlass','sword','musket','lantern','torch','dock','wharf',
      'palm','tropical','island','ocean','sea','coast','lighthouse','flagpole',
      'sail','mast','helm','wheel','plank','parrot','skeleton','gold','coin',
      'chest','tavern','cobblestone','thatched','sandstone','stone','wood',
      'rope','metal','rusted','worn','wet','sand','foliage','vine',
    ],
    exclude: [
      'modern','futuristic','sci-fi','scifi','cyberpunk','neon','plastic',
      'electronic','digital','car','vehicle','automobile','airplane','spaceship',
      'robot','mech','skyscraper','concrete','asphalt','laptop','phone',
      'computer','television','factory','industrial','highway','traffic',
      'subway','railroad','electricity','solar','nuclear',
    ],
  },

  // ── Sketchfab search filters ──
  SKETCHFAB_DEFAULTS: {
    downloadable: true,
    sort_by: '-likeCount',
    max_results: 8,
    file_format: 'glb',
  },

  // ── ambientCG defaults ──
  AMBIENTCG_DEFAULTS: {
    resolution: '1K', // prefer 1K textures for performance
    sort: 'Popular',
    limit: 10,
  },

  // ── Meshy defaults ──
  MESHY_DEFAULTS: {
    art_style: 'realistic',
    topology: 'quad',
    target_polycount: 5000,
  },
};

window.PipelineConfig = Config;
})();
