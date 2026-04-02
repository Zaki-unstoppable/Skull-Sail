/**
 * Procedural Grass System for Babylon.js
 * Thin instances with StandardMaterial + vertex colors
 * Wind via per-frame matrix updates on rotating subsets
 * Player height ~1.8 units → grass min 0.6 (1/3 player)
 */
(function(){
'use strict';

const BLADE_WIDTH      = 0.12;
const BLADE_HEIGHT_MIN = 0.6;
const BLADE_HEIGHT_MAX = 1.4;
const WIND_BATCH       = 800;  // blades updated per frame for wind

/**
 * @param {BABYLON.Scene} scene
 * @param {BABYLON.Vector3} center
 * @param {number} radius
 * @param {number} groundY
 * @param {number} [count=8000]
 */
window.createBabylonGrassField = function(scene, center, radius, groundY, count){
  count = count || 8000;

  // ---- Blade geometry: 5 verts, tapered, with vertex colors ----
  const positions = [
    -BLADE_WIDTH/2, 0, 0,
     BLADE_WIDTH/2, 0, 0,
    -BLADE_WIDTH/4, 0.5, 0,
     BLADE_WIDTH/4, 0.5, 0,
     0, 1.0, 0
  ];
  const indices = [0,1,2, 1,3,2, 2,3,4];
  const normals = [];
  BABYLON.VertexData.ComputeNormals(positions, indices, normals);
  // Vertex colors: dark green at base, lighter at tip
  const colors = [
    0.08, 0.22, 0.04, 1,  // base left
    0.08, 0.22, 0.04, 1,  // base right
    0.18, 0.40, 0.10, 1,  // mid left
    0.18, 0.40, 0.10, 1,  // mid right
    0.30, 0.55, 0.18, 1   // tip
  ];

  const blade = new BABYLON.Mesh('grassBlade', scene);
  const vd = new BABYLON.VertexData();
  vd.positions = positions;
  vd.indices   = indices;
  vd.normals   = normals;
  vd.colors    = colors;
  vd.applyToMesh(blade);

  // Material — simple, uses vertex colors
  const mat = new BABYLON.StandardMaterial('grassMat', scene);
  mat.diffuseColor  = new BABYLON.Color3(1, 1, 1);  // let vertex colors drive it
  mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
  mat.emissiveColor = new BABYLON.Color3(0.05, 0.12, 0.02);
  mat.backFaceCulling = false;
  mat.disableLighting = false;

  blade.material   = blade.material = mat;
  blade.isVisible  = true;
  blade.receiveShadows = true;

  // ---- Per-instance data: store base transforms for wind animation ----
  const bladeData = [];  // { x, z, scaleY, rotY, lean }
  const matricesData = new Float32Array(count * 16);
  const tmpMat = BABYLON.Matrix.Identity();

  for(let i = 0; i < count; i++){
    const angle = Math.random() * Math.PI * 2;
    const dist  = Math.sqrt(Math.random()) * radius;
    const x     = center.x + Math.cos(angle) * dist;
    const z     = center.z + Math.sin(angle) * dist;
    const scaleY = BLADE_HEIGHT_MIN + Math.random() * (BLADE_HEIGHT_MAX - BLADE_HEIGHT_MIN);
    const rotY  = Math.random() * Math.PI * 2;
    const lean  = (Math.random() - 0.5) * 0.2;

    bladeData.push({ x, z, scaleY, rotY, lean, phase: Math.random() * 6.28 });

    BABYLON.Matrix.ComposeToRef(
      new BABYLON.Vector3(1, scaleY, 1),
      BABYLON.Quaternion.FromEulerAngles(lean, rotY, 0),
      new BABYLON.Vector3(x, groundY, z),
      tmpMat
    );
    tmpMat.copyToArray(matricesData, i * 16);
  }

  blade.thinInstanceSetBuffer('matrix', matricesData, 16, false);
  blade.thinInstanceCount = count;
  blade.doNotSyncBoundingInfo = true;

  // Force large bounding box so it doesn't get culled
  blade.refreshBoundingInfo();
  const bi = blade.getBoundingInfo();
  bi.boundingBox.minimumWorld.set(center.x - radius - 5, groundY - 1, center.z - radius - 5);
  bi.boundingBox.maximumWorld.set(center.x + radius + 5, groundY + BLADE_HEIGHT_MAX + 2, center.z + radius + 5);

  // ---- Wind animation: rotate batches each frame ----
  let batchOffset = 0;
  const windStrength = 0.8;
  const windDirX = 0.8, windDirZ = 0.6;

  function updateWind(time){
    const end = Math.min(batchOffset + WIND_BATCH, count);
    for(let i = batchOffset; i < end; i++){
      const bd = bladeData[i];
      const phase = bd.x * 0.08 + bd.z * 0.06 + time * 1.2 + bd.phase;
      const sway  = Math.sin(phase) * 0.35 + Math.sin(phase * 2.1 + 1.3) * 0.15;
      const gust  = Math.max(0, Math.sin(bd.x * 0.02 + bd.z * 0.03 + time * 0.3)) * 0.2;
      const windBend = (sway + gust) * windStrength;

      // Lean toward wind
      const leanX = bd.lean + windBend * 0.3 * windDirX;
      const leanZ = windBend * 0.3 * windDirZ;

      BABYLON.Matrix.ComposeToRef(
        new BABYLON.Vector3(1, bd.scaleY, 1),
        BABYLON.Quaternion.FromEulerAngles(leanX, bd.rotY, leanZ),
        new BABYLON.Vector3(bd.x, groundY, bd.z),
        tmpMat
      );
      tmpMat.copyToArray(matricesData, i * 16);
    }
    batchOffset = end >= count ? 0 : end;
    blade.thinInstanceBufferUpdated('matrix');
  }

  return {
    rootMesh: blade,
    update: function(time){
      updateWind(time);
    }
  };
};

})();
