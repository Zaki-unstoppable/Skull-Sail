/**
 * Procedural Grass System for Babylon.js — 80k instances
 * Uses StandardMaterial + vertex deformation for wind (compatible with thin instances)
 * Collision-aware via parent-chain world position walk
 * Grass height: 0.15–0.35 (ankle-to-shin on 1.8m player)
 */
(function(){
'use strict';

var BLADE_WIDTH      = 0.08;
var BLADE_HEIGHT_MIN = 0.15;
var BLADE_HEIGHT_MAX = 0.35;

// Walk parent chain to get world position
function getWorldPos(node){
  var x = 0, y = 0, z = 0;
  var n = node;
  while(n){
    if(n.position){ x += n.position.x; y += n.position.y; z += n.position.z; }
    n = n.parent;
  }
  return { x: x, y: y, z: z };
}

function getParentScale(node){
  var sx = 1, sz = 1;
  var p = node.parent;
  while(p){
    if(p.scaling){ sx *= p.scaling.x; sz *= p.scaling.z; }
    p = p.parent;
  }
  return { x: sx, z: sz };
}

function buildExclusionZones(scene, groundY){
  var zones = [];

  // Names that are ground-level terrain (grass grows on these)
  var terrainNames = { grass:1, beach:1, water:1 };
  // Visual-only suffixes to skip (no physical footprint)
  var skipSuffixes = ['_VIS', '_INT'];
  // Mesh name patterns that are definitely structures (even without collision)
  var structurePatterns = [
    'floor','wall','roof','path','stair','step','plank','stilt',
    'fort','wh','templ','altar','col','fallen','shelter','cave',
    'boulder','rock','frame','door','barrel','chest','crate',
    'table','body','beam','post','rail','ceiling','brace',
    'timber','platform','plat','sill','shutter','riser','nosing'
  ];

  function isStructureName(name){
    var low = name.toLowerCase();
    for(var i = 0; i < structurePatterns.length; i++){
      if(low.indexOf(structurePatterns[i]) >= 0) return true;
    }
    return false;
  }

  function shouldExclude(m){
    var n = (m.name || '');
    var low = n.toLowerCase();
    // Skip terrain
    if(terrainNames[low]) return false;
    // Skip visual-only decorations
    for(var i = 0; i < skipSuffixes.length; i++){
      if(n.indexOf(skipSuffixes[i]) >= 0) return false;
    }
    // Skip grassBlade itself
    if(low === 'grassblade') return false;
    // Include if it has collision OR is a known structure name
    if(m.checkCollisions) return true;
    if(isStructureName(n)) return true;
    return false;
  }

  scene.meshes.forEach(function(m){
    if(!shouldExclude(m)) return;
    if(!m.isVisible && !m.checkCollisions) return;

    var bi;
    try { bi = m.getBoundingInfo(); } catch(e){ return; }
    if(!bi) return;
    var lmin = bi.boundingBox.minimum;
    var lmax = bi.boundingBox.maximum;
    var sizeX = lmax.x - lmin.x, sizeZ = lmax.z - lmin.z;
    if(sizeX < 0.05 && sizeZ < 0.05) return;

    var wp = getWorldPos(m);
    var worldTop = wp.y + lmax.y;
    // Skip if entirely below ground surface
    if(worldTop <= groundY - 0.1) return;

    var sc = getParentScale(m);
    var localCX = (lmin.x + lmax.x) / 2;
    var localCZ = (lmin.z + lmax.z) / 2;
    var worldCX = wp.x + localCX;
    var worldCZ = wp.z + localCZ;
    var halfX = sizeX * sc.x / 2 + 0.15;
    var halfZ = sizeZ * sc.z / 2 + 0.15;

    zones.push({
      minX: worldCX - halfX, maxX: worldCX + halfX,
      minZ: worldCZ - halfZ, maxZ: worldCZ + halfZ
    });
  });
  return zones;
}

window.createBabylonGrassField = function(scene, center, radius, groundY, count){
  count = count || 80000;
  var exclusionZones = buildExclusionZones(scene, groundY);

  function isBlocked(x, z){
    for(var i = 0; i < exclusionZones.length; i++){
      var b = exclusionZones[i];
      if(x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return true;
    }
    return false;
  }

  // ---- Blade geometry (5 vertices, tapered) ----
  var positions = [
    -BLADE_WIDTH/2, 0, 0,
     BLADE_WIDTH/2, 0, 0,
    -BLADE_WIDTH/4, 0.5, 0,
     BLADE_WIDTH/4, 0.5, 0,
     0, 1.0, 0
  ];
  var indices = [0,1,2, 1,3,2, 2,3,4];
  var normals = [];
  BABYLON.VertexData.ComputeNormals(positions, indices, normals);
  // Store vertex height (0..1) in UV.y for shader wind
  var uvs = [
    0, 0,  1, 0,
    0.25, 0.5,  0.75, 0.5,
    0.5, 1.0
  ];
  var colors = [
    0.10, 0.25, 0.05, 1,
    0.10, 0.25, 0.05, 1,
    0.20, 0.42, 0.12, 1,
    0.20, 0.42, 0.12, 1,
    0.35, 0.58, 0.20, 1
  ];

  var blade = new BABYLON.Mesh('grassBlade', scene);
  var vd = new BABYLON.VertexData();
  vd.positions = positions;
  vd.indices   = indices;
  vd.normals   = normals;
  vd.uvs       = uvs;
  vd.colors    = colors;
  vd.applyToMesh(blade);

  // ---- Material: StandardMaterial with custom vertex wind via plugin ----
  var grassMat = new BABYLON.StandardMaterial('grassMat', scene);
  grassMat.diffuseColor = new BABYLON.Color3(0.2, 0.42, 0.12);
  grassMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.02);
  grassMat.backFaceCulling = false;
  grassMat.disableLighting = true; // Use vertex colors only

  // Wind plugin — injects GPU wind into StandardMaterial vertex shader
  var _grassTime = { value: 0 };

  var GrassWindPlugin = (function(){
    function GrassWindPlugin(material){
      // Call parent constructor
      BABYLON.MaterialPluginBase.call(this, material, 'GrassWind', 200, { GRASS_WIND: false });
      this._enable(true);
      this.isEnabled = true;
    }
    // Inherit from MaterialPluginBase
    GrassWindPlugin.prototype = Object.create(BABYLON.MaterialPluginBase.prototype);
    GrassWindPlugin.prototype.constructor = GrassWindPlugin;

    GrassWindPlugin.prototype.getClassName = function(){ return 'GrassWindPlugin'; };

    GrassWindPlugin.prototype.isCompatible = function(){ return true; };

    GrassWindPlugin.prototype.prepareDefines = function(defines, scene, mesh){
      defines['GRASS_WIND'] = true;
    };

    GrassWindPlugin.prototype.getAttributes = function(attributes){
      attributes.push('color');
    };

    GrassWindPlugin.prototype.getUniforms = function(){
      return {
        ubo: [
          { name: 'grassTime', size: 1, type: 'float' }
        ],
        fragment: '',
        vertex: 'uniform float grassTime;'
      };
    };

    GrassWindPlugin.prototype.bindForSubMesh = function(uniformBuffer, effectiveMesh, subMesh){
      uniformBuffer.updateFloat('grassTime', _grassTime.value);
    };

    GrassWindPlugin.prototype.getCustomCode = function(shaderType){
      if(shaderType === 'vertex'){
        return {
          'CUSTOM_VERTEX_DEFINITIONS': [
            'varying vec4 vGrassColor;',
            'varying float vGrassHeight;'
          ].join('\n'),
          'CUSTOM_VERTEX_MAIN_END': [
            '// Use position.y as height factor (0 at base, 1 at tip in blade local space)',
            'float grassH = positionUpdated.y;',
            'vGrassHeight = grassH;',
            'vGrassColor = colorUpdated;',
            '',
            '// Quadratic bend — base stays fixed, tip moves most',
            'float bend = grassH * grassH;',
            'float px = worldPos.x;',
            'float pz = worldPos.z;',
            '',
            '// Primary slow sway (period ~4s)',
            'float wave1 = sin(px * 0.05 + pz * 0.03 + grassTime * 1.5) * 0.3;',
            '// Secondary gentle crosswind (period ~6s)',
            'float wave2 = sin(px * 0.03 - pz * 0.04 + grassTime * 1.0 + 2.0) * 0.15;',
            '// Slow gust variation (period ~10s)',
            'float gust = sin(px * 0.01 + pz * 0.015 + grassTime * 0.4) * 0.5 + 0.5;',
            '',
            'float windX = (wave1 + wave2) * (0.5 + gust * 0.5) * bend * 0.15;',
            'float windZ = (wave1 * 0.6 - wave2 * 0.4) * (0.5 + gust * 0.5) * bend * 0.1;',
            '',
            'gl_Position.x += windX;',
            'gl_Position.z += windZ;',
            'gl_Position.y -= abs(windX + windZ) * 0.1 * bend;'
          ].join('\n')
        };
      }
      if(shaderType === 'fragment'){
        return {
          'CUSTOM_FRAGMENT_DEFINITIONS': [
            'varying vec4 vGrassColor;',
            'varying float vGrassHeight;'
          ].join('\n'),
          'CUSTOM_FRAGMENT_MAIN_END': [
            '// Override with vertex colors + height-based AO',
            'vec3 grassCol = vGrassColor.rgb * (0.6 + vGrassHeight * 0.4);',
            'gl_FragColor = vec4(grassCol, 1.0);'
          ].join('\n')
        };
      }
      return null;
    };

    return GrassWindPlugin;
  })();

  // Register and attach plugin
  var plugin = new GrassWindPlugin(grassMat);

  blade.material = grassMat;
  blade.isVisible = true;

  // ---- Place blades, skipping blocked areas ----
  var bladeData = [];
  var attempts = 0;
  var maxAttempts = count * 3;

  while(bladeData.length < count && attempts < maxAttempts){
    attempts++;
    var angle = Math.random() * Math.PI * 2;
    var dist  = Math.sqrt(Math.random()) * radius;
    var x     = center.x + Math.cos(angle) * dist;
    var z     = center.z + Math.sin(angle) * dist;
    if(isBlocked(x, z)) continue;

    bladeData.push({
      x: x, z: z,
      scaleY: BLADE_HEIGHT_MIN + Math.random() * (BLADE_HEIGHT_MAX - BLADE_HEIGHT_MIN),
      rotY: Math.random() * Math.PI * 2,
      lean: (Math.random() - 0.5) * 0.1
    });
  }

  var actualCount = bladeData.length;
  var matricesData = new Float32Array(actualCount * 16);
  var tmpMat = BABYLON.Matrix.Identity();

  for(var i = 0; i < actualCount; i++){
    var bd = bladeData[i];
    BABYLON.Matrix.ComposeToRef(
      new BABYLON.Vector3(1, bd.scaleY, 1),
      BABYLON.Quaternion.FromEulerAngles(bd.lean, bd.rotY, 0),
      new BABYLON.Vector3(bd.x, groundY, bd.z),
      tmpMat
    );
    tmpMat.copyToArray(matricesData, i * 16);
  }

  blade.thinInstanceSetBuffer('matrix', matricesData, 16, false);
  blade.thinInstanceCount = actualCount;
  blade.doNotSyncBoundingInfo = true;

  // Set a large bounding box so frustum culling doesn't hide the grass
  blade.refreshBoundingInfo();
  try {
    var bi = blade.getBoundingInfo();
    bi.boundingBox.minimumWorld.set(center.x - radius - 2, groundY - 0.5, center.z - radius - 2);
    bi.boundingBox.maximumWorld.set(center.x + radius + 2, groundY + BLADE_HEIGHT_MAX + 1, center.z + radius + 2);
  } catch(e){}

  console.log('[Grass] Plugin-based wind material attached. Blades:', actualCount);

  return {
    rootMesh: blade,
    bladeCount: actualCount,
    exclusionCount: exclusionZones.length,
    skipped: attempts - actualCount,
    update: function(time){
      _grassTime.value = time;
    }
  };
};

})();
