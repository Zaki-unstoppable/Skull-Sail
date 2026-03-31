/**
 * Skull & Sail — Babylon.js Vertical Slice
 * Purpose: Prove player-scale buildings, interiors, interactables, and authored spaces.
 * Scale: 1 unit = 1 meter
 *
 * Architecture:
 *   1. Engine + Scene setup
 *   2. Materials library
 *   3. Ground + Island base
 *   4. Tavern building (authored shell)
 *   5. Door system (animated open/close)
 *   6. Chest system (open animation + loot)
 *   7. AssetLibrary-driven props (barrels, furniture, exterior)
 *   8. Player controller (first-person, collision)
 *   9. Interaction system (data-driven, proximity + facing)
 *  10. HUD + Debug overlay
 *  11. Render loop
 */

(function(){
'use strict';

// ============================================================
// 0. URL PARAMS — Island type routing
// ============================================================
const _urlParams = new URLSearchParams(window.location.search);
const ISLAND_TYPE = _urlParams.get('type') || 'village';   // default to village (tavern)
const ISLAND_NAME = _urlParams.get('name') || 'Unknown Isle';
console.log(`[Island] type="${ISLAND_TYPE}" name="${ISLAND_NAME}"`);

// ============================================================
// 1. ENGINE + SCENE SETUP
// ============================================================
const canvas = document.getElementById('renderCanvas');
const engine = new BABYLON.Engine(canvas, true, { stencil: true, antialias: true });
const scene = new BABYLON.Scene(engine);

// Loading UI
const loadFill = document.getElementById('load-fill');
const loadStatus = document.getElementById('load-status');
const loadingDiv = document.getElementById('loading');
function setLoad(pct, msg){
  loadFill.style.width = pct + '%';
  loadStatus.textContent = msg;
  if(pct >= 100) setTimeout(() => loadingDiv.classList.add('done'), 400);
}
// Safety: force-dismiss loading screen after 10s even if async loading stalls
setTimeout(() => {
  if(!loadingDiv.classList.contains('done')){
    console.warn('[Loading] Safety timeout — forcing loading screen dismiss');
    setLoad(100, 'Welcome to ' + ISLAND_NAME + ' — click to explore');
  }
}, 10000);

// Physics — using built-in collision engine
scene.gravity = new BABYLON.Vector3(0, -9.81 / 60, 0);
scene.collisionsEnabled = true;

// Background / fog — varies by island type
const ATMOSPHERE = {
  village:  { sky:[0.4,0.6,0.85],  fog:[0.55,0.7,0.85],  fogD:0.008, sunTint:'#fff0d8', sunI:1.2 },
  tropical: { sky:[0.3,0.7,0.95],  fog:[0.5,0.78,0.92],  fogD:0.006, sunTint:'#fff8e0', sunI:1.4 },
  fort:     { sky:[0.35,0.4,0.5],  fog:[0.4,0.45,0.5],   fogD:0.012, sunTint:'#d8d0c0', sunI:0.9 },
  ruins:    { sky:[0.3,0.35,0.45], fog:[0.35,0.4,0.5],   fogD:0.015, sunTint:'#c8c0b0', sunI:0.8 },
  outpost:  { sky:[0.45,0.55,0.7], fog:[0.5,0.6,0.72],   fogD:0.009, sunTint:'#f0e8d0', sunI:1.1 },
  wild:     { sky:[0.2,0.3,0.2],   fog:[0.25,0.35,0.25],  fogD:0.018, sunTint:'#b0c8a0', sunI:0.7 },
};
const atm = ATMOSPHERE[ISLAND_TYPE] || ATMOSPHERE.village;
scene.clearColor = new BABYLON.Color4(atm.sky[0], atm.sky[1], atm.sky[2], 1);
scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
scene.fogDensity = atm.fogD;
scene.fogColor = new BABYLON.Color3(atm.fog[0], atm.fog[1], atm.fog[2]);

// Ambient + directional light
const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
hemi.intensity = 0.5;
hemi.groundColor = new BABYLON.Color3(0.3, 0.25, 0.2);

const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.5, -1, -0.3).normalize(), scene);
sun.intensity = atm.sunI;
sun.diffuse = BABYLON.Color3.FromHexString(atm.sunTint);
// Shadows
const shadowGen = new BABYLON.ShadowGenerator(2048, sun);
shadowGen.useBlurExponentialShadowMap = true;
shadowGen.blurKernel = 16;
shadowGen.setDarkness(0.3);

setLoad(10, 'Building scene...');

// ============================================================
// 2. MATERIALS LIBRARY
// ============================================================
const MAT = {};

function makeMat(name, color, rough, metal){
  const m = new BABYLON.PBRMaterial(name, scene);
  m.albedoColor = BABYLON.Color3.FromHexString(color);
  m.roughness = rough !== undefined ? rough : 0.85;
  m.metallic = metal !== undefined ? metal : 0;
  m.environmentIntensity = 0.3;
  return m;
}

MAT.stone      = makeMat('stone',     '#8a8878', 0.95, 0);
MAT.stoneDark  = makeMat('stoneDark', '#5a5848', 0.95, 0);
MAT.wood       = makeMat('wood',      '#8b6c42', 0.9, 0);
MAT.woodDark   = makeMat('woodDark',  '#5c3a1e', 0.92, 0);
MAT.woodFloor  = makeMat('woodFloor', '#a08060', 0.88, 0);
MAT.woodDock   = makeMat('woodDock',  '#8b7355', 0.9, 0);
MAT.roof       = makeMat('roof',      '#6b4226', 0.92, 0);
MAT.metal      = makeMat('metal',     '#3a3a3a', 0.4, 0.8);
MAT.metalGold  = makeMat('metalGold', '#c8a44e', 0.3, 0.7);
MAT.ground     = makeMat('ground',    '#6a8a4a', 0.95, 0);
MAT.sand       = makeMat('sand',      '#c8b888', 0.95, 0);
MAT.dirt       = makeMat('dirt',      '#8a7050', 0.95, 0);
MAT.water      = makeMat('water',     '#2a5a8a', 0.2, 0.1);
MAT.water.alpha = 0.7;
MAT.fabric     = makeMat('fabric',    '#8a3030', 0.95, 0);
MAT.fabricDark = makeMat('fabricDark', '#2a1a1a', 0.95, 0);
MAT.glass      = makeMat('glass',     '#a0c0d0', 0.1, 0.05);
MAT.glass.alpha = 0.3;
MAT.plaster    = makeMat('plaster',   '#c8b898', 0.92, 0);
MAT.flame      = makeMat('flame',     '#ff6600', 0.5, 0);
MAT.flame.emissiveColor = BABYLON.Color3.FromHexString('#ff4400');
MAT.flame.emissiveIntensity = 2;

// ============================================================
// 3. GROUND + ISLAND BASE
// ============================================================
// Water plane
const waterPlane = BABYLON.MeshBuilder.CreateGround('water', { width: 200, height: 200 }, scene);
waterPlane.material = MAT.water;
waterPlane.position.y = -0.1;
waterPlane.receiveShadows = true;

// Island ground — layered terrain: sand beach ring + dirt + grass center
function createIslandGround(){
  const group = new BABYLON.TransformNode('island', scene);

  // Main grass area — slightly raised disc
  const grass = BABYLON.MeshBuilder.CreateCylinder('grass', {
    height: 0.5, diameter: 40, tessellation: 48
  }, scene);
  grass.material = MAT.ground;
  grass.position.y = 0.25;
  grass.receiveShadows = true;
  grass.checkCollisions = true;
  grass.parent = group;

  // Sand beach ring
  const beach = BABYLON.MeshBuilder.CreateCylinder('beach', {
    height: 0.3, diameter: 48, tessellation: 48
  }, scene);
  beach.material = MAT.sand;
  beach.position.y = 0.1;
  beach.receiveShadows = true;
  beach.checkCollisions = true;
  beach.parent = group;

  // Dirt path from shore to building
  const path = BABYLON.MeshBuilder.CreateBox('path', { width: 3, height: 0.05, depth: 18 }, scene);
  path.material = MAT.dirt;
  path.position.set(0, 0.52, 5);
  path.receiveShadows = true;
  path.parent = group;

  return group;
}

setLoad(20, 'Building island...');
const island = createIslandGround();

// ============================================================
// 4. AUTHORED BUILDING — EXTERIOR + INTERIOR
// ============================================================
// The tavern: ~8m x 6m footprint, ~4m walls, pitched roof
// Real scale: doors 2.1m tall, 0.9m wide; ceilings ~3.5m; walls 0.3m thick

function createTavern(){
  const building = new BABYLON.TransformNode('tavern', scene);
  building.position.set(0, 0.5, -2); // centered on island

  const W = 0.3;  // wall thickness
  const FW = 8;   // floor width (x)
  const FD = 6;   // floor depth (z)
  const WH = 3.5; // wall height
  const DW = 1.0; // door width
  const DH = 2.2; // door height

  // -- Floor --
  const floor = BABYLON.MeshBuilder.CreateBox('floor', { width: FW, height: 0.15, depth: FD }, scene);
  floor.material = MAT.woodFloor;
  floor.position.y = 0.075;
  floor.receiveShadows = true;
  floor.checkCollisions = true;
  floor.parent = building;

  // -- Walls (with door openings) --
  // Back wall — split around interior doorway to back room
  const backDoorW = 0.9;
  const backDoorH = 2.1;
  const backDoorX = -1.5; // offset left of center

  // Back wall left of doorway
  const bwLeftW = (FW/2 + backDoorX - backDoorW/2);
  const bwLeft = BABYLON.MeshBuilder.CreateBox('backWallL', { width: bwLeftW, height: WH, depth: W }, scene);
  bwLeft.material = MAT.plaster;
  bwLeft.position.set(-FW/2 + bwLeftW/2, WH/2, -FD/2 + W/2);
  bwLeft.checkCollisions = true;
  bwLeft.receiveShadows = true;
  shadowGen.addShadowCaster(bwLeft);
  bwLeft.parent = building;

  // Back wall right of doorway
  const bwRightW = FW - bwLeftW - backDoorW;
  const bwRight = BABYLON.MeshBuilder.CreateBox('backWallR', { width: bwRightW, height: WH, depth: W }, scene);
  bwRight.material = MAT.plaster;
  bwRight.position.set(FW/2 - bwRightW/2, WH/2, -FD/2 + W/2);
  bwRight.checkCollisions = true;
  bwRight.receiveShadows = true;
  shadowGen.addShadowCaster(bwRight);
  bwRight.parent = building;

  // Back wall lintel above doorway
  const bwLintelH = WH - backDoorH;
  const bwLintel = BABYLON.MeshBuilder.CreateBox('backLintel', {
    width: backDoorW + 0.2, height: bwLintelH, depth: W
  }, scene);
  bwLintel.material = MAT.plaster;
  bwLintel.position.set(backDoorX, backDoorH + bwLintelH/2, -FD/2 + W/2);
  bwLintel.checkCollisions = true;
  bwLintel.parent = building;

  // Back doorway frame trim
  const bFrameL = BABYLON.MeshBuilder.CreateBox('bFrameL', { width: 0.06, height: backDoorH, depth: W+0.02 }, scene);
  bFrameL.material = MAT.woodDark;
  bFrameL.position.set(backDoorX - backDoorW/2 - 0.03, backDoorH/2, -FD/2 + W/2);
  bFrameL.parent = building;
  const bFrameR = bFrameL.clone('bFrameR');
  bFrameR.position.x = backDoorX + backDoorW/2 + 0.03;
  bFrameR.parent = building;
  const bFrameTop = BABYLON.MeshBuilder.CreateBox('bFrameTop', { width: backDoorW + 0.16, height: 0.06, depth: W+0.02 }, scene);
  bFrameTop.material = MAT.woodDark;
  bFrameTop.position.set(backDoorX, backDoorH + 0.03, -FD/2 + W/2);
  bFrameTop.parent = building;

  // Left wall (full)
  const leftWall = BABYLON.MeshBuilder.CreateBox('leftWall', { width: W, height: WH, depth: FD }, scene);
  leftWall.material = MAT.plaster;
  leftWall.position.set(-FW/2 + W/2, WH/2, 0);
  leftWall.checkCollisions = true;
  leftWall.receiveShadows = true;
  shadowGen.addShadowCaster(leftWall);
  leftWall.parent = building;

  // Right wall (full)
  const rightWall = BABYLON.MeshBuilder.CreateBox('rightWall', { width: W, height: WH, depth: FD }, scene);
  rightWall.material = MAT.plaster;
  rightWall.position.set(FW/2 - W/2, WH/2, 0);
  rightWall.checkCollisions = true;
  rightWall.receiveShadows = true;
  shadowGen.addShadowCaster(rightWall);
  rightWall.parent = building;

  // Front wall — split into 3 pieces around door opening
  const frontLeftW = (FW - DW) / 2 - 0.5;
  const doorCenterX = 0.5;
  const flX = -FW/2 + W/2 + frontLeftW/2;
  const frontLeft = BABYLON.MeshBuilder.CreateBox('frontWallL', {
    width: frontLeftW, height: WH, depth: W
  }, scene);
  frontLeft.material = MAT.plaster;
  frontLeft.position.set(flX, WH/2, FD/2 - W/2);
  frontLeft.checkCollisions = true;
  frontLeft.receiveShadows = true;
  shadowGen.addShadowCaster(frontLeft);
  frontLeft.parent = building;

  const frW = FW - frontLeftW - DW;
  const frX = FW/2 - W/2 - frW/2 + W;
  const frontRight = BABYLON.MeshBuilder.CreateBox('frontWallR', {
    width: frW, height: WH, depth: W
  }, scene);
  frontRight.material = MAT.plaster;
  frontRight.position.set(frX, WH/2, FD/2 - W/2);
  frontRight.checkCollisions = true;
  frontRight.receiveShadows = true;
  shadowGen.addShadowCaster(frontRight);
  frontRight.parent = building;

  // Above door (lintel)
  const lintelH = WH - DH;
  const lintel = BABYLON.MeshBuilder.CreateBox('lintel', {
    width: DW + 0.2, height: lintelH, depth: W
  }, scene);
  lintel.material = MAT.plaster;
  lintel.position.set(doorCenterX, DH + lintelH/2, FD/2 - W/2);
  lintel.checkCollisions = true;
  lintel.parent = building;

  // Door frame trim
  const frameMat = MAT.woodDark;
  const frameL = BABYLON.MeshBuilder.CreateBox('frameL', { width: 0.08, height: DH, depth: W+0.02 }, scene);
  frameL.material = frameMat;
  frameL.position.set(doorCenterX - DW/2 - 0.04, DH/2, FD/2 - W/2);
  frameL.parent = building;
  const frameR = frameL.clone('frameR');
  frameR.position.x = doorCenterX + DW/2 + 0.04;
  frameR.parent = building;
  const frameTop = BABYLON.MeshBuilder.CreateBox('frameTop', { width: DW + 0.2, height: 0.08, depth: W+0.02 }, scene);
  frameTop.material = frameMat;
  frameTop.position.set(doorCenterX, DH + 0.04, FD/2 - W/2);
  frameTop.parent = building;

  // -- Roof (pitched) -- sits on top of second floor
  const SF_WH_R = 2.8; // second floor wall height (must match later)
  const roofBaseY = WH + SF_WH_R; // top of second floor walls
  const roofAngle = Math.PI * 0.2;
  const roofW = FW + 0.8;
  const roofLen = (FD/2) / Math.cos(roofAngle) + 0.6;
  const roofThick = 0.12;

  const roofL = BABYLON.MeshBuilder.CreateBox('roofL', { width: roofW, height: roofThick, depth: roofLen }, scene);
  roofL.material = MAT.roof;
  roofL.rotation.x = -roofAngle;
  roofL.position.set(0, roofBaseY + Math.sin(roofAngle) * FD/4 + 0.3, -FD/4 * Math.cos(roofAngle) * 0.3);
  roofL.receiveShadows = true;
  shadowGen.addShadowCaster(roofL);
  roofL.parent = building;

  const roofR = BABYLON.MeshBuilder.CreateBox('roofR', { width: roofW, height: roofThick, depth: roofLen }, scene);
  roofR.material = MAT.roof;
  roofR.rotation.x = roofAngle;
  roofR.position.set(0, roofBaseY + Math.sin(roofAngle) * FD/4 + 0.3, FD/4 * Math.cos(roofAngle) * 0.3);
  roofR.receiveShadows = true;
  shadowGen.addShadowCaster(roofR);
  roofR.parent = building;

  // Ground floor ceiling (also second floor's floor structure — handled separately below)

  // -- Exterior trim: base molding --
  const baseBoard = BABYLON.MeshBuilder.CreateBox('baseBoard', { width: FW + 0.1, height: 0.15, depth: FD + 0.1 }, scene);
  baseBoard.material = MAT.stoneDark;
  baseBoard.position.y = 0.075;
  baseBoard.parent = building;

  // ==========================================================
  // BACK ROOM — 5m wide x 4m deep, attached behind back wall
  // ==========================================================
  const BRW = 5;   // back room width
  const BRD = 4;   // back room depth
  const brZ = -FD/2 - BRD/2 + W/2; // center Z of back room in local space

  // Back room floor
  const brFloor = BABYLON.MeshBuilder.CreateBox('brFloor', { width: BRW, height: 0.15, depth: BRD }, scene);
  brFloor.material = MAT.stone;
  brFloor.position.set(backDoorX, 0.075, brZ);
  brFloor.receiveShadows = true;
  brFloor.checkCollisions = true;
  brFloor.parent = building;

  // Back room walls
  // Far back wall
  const brBack = BABYLON.MeshBuilder.CreateBox('brBack', { width: BRW, height: WH, depth: W }, scene);
  brBack.material = MAT.plaster;
  brBack.position.set(backDoorX, WH/2, brZ - BRD/2 + W/2);
  brBack.checkCollisions = true;
  brBack.receiveShadows = true;
  shadowGen.addShadowCaster(brBack);
  brBack.parent = building;

  // Back room left wall
  const brLeft = BABYLON.MeshBuilder.CreateBox('brLeft', { width: W, height: WH, depth: BRD }, scene);
  brLeft.material = MAT.plaster;
  brLeft.position.set(backDoorX - BRW/2 + W/2, WH/2, brZ);
  brLeft.checkCollisions = true;
  brLeft.receiveShadows = true;
  shadowGen.addShadowCaster(brLeft);
  brLeft.parent = building;

  // Back room right wall
  const brRight = BABYLON.MeshBuilder.CreateBox('brRight', { width: W, height: WH, depth: BRD }, scene);
  brRight.material = MAT.plaster;
  brRight.position.set(backDoorX + BRW/2 - W/2, WH/2, brZ);
  brRight.checkCollisions = true;
  brRight.receiveShadows = true;
  shadowGen.addShadowCaster(brRight);
  brRight.parent = building;

  // Back room ceiling
  const brCeiling = BABYLON.MeshBuilder.CreateBox('brCeiling', { width: BRW - W*2, height: 0.1, depth: BRD - W*2 }, scene);
  brCeiling.material = MAT.woodDark;
  brCeiling.position.set(backDoorX, WH - 0.05, brZ);
  brCeiling.parent = building;

  // Back room roof (flat lean-to, lower than main roof)
  const brRoof = BABYLON.MeshBuilder.CreateBox('brRoof', { width: BRW + 0.4, height: 0.1, depth: BRD + 0.4 }, scene);
  brRoof.material = MAT.roof;
  brRoof.position.set(backDoorX, WH + 0.15, brZ);
  brRoof.rotation.x = -0.05; // slight slope
  brRoof.receiveShadows = true;
  shadowGen.addShadowCaster(brRoof);
  brRoof.parent = building;

  // Fill the gap: small wall sections connecting back room to main building sides
  // Left connecting wall (from main left wall to back room left wall)
  const connLeftW = Math.abs((-FW/2 + W) - (backDoorX - BRW/2));
  if(connLeftW > 0.05){
    const connLeft = BABYLON.MeshBuilder.CreateBox('connLeft', { width: connLeftW, height: WH, depth: W }, scene);
    connLeft.material = MAT.plaster;
    connLeft.position.set(-FW/2 + W/2 + connLeftW/2, WH/2, -FD/2 + W/2);
    connLeft.checkCollisions = true;
    shadowGen.addShadowCaster(connLeft);
    connLeft.parent = building;
  }

  // ==========================================================
  // SECOND FLOOR — loft above main tavern area
  // ==========================================================
  const SF_H = WH; // second floor starts at wall height (3.5m)
  const SF_WH = 2.8; // second floor wall height (lower ceiling)

  // Second floor platform (covers most of the tavern footprint)
  const sfFloor = BABYLON.MeshBuilder.CreateBox('sfFloor', { width: FW - W*2, height: 0.15, depth: FD - W*2 }, scene);
  sfFloor.material = MAT.woodFloor;
  sfFloor.position.set(0, SF_H + 0.075, 0);
  sfFloor.receiveShadows = true;
  sfFloor.checkCollisions = true;
  sfFloor.parent = building;

  // Stairwell opening in the second floor (2m x 1.2m cutout on the right side)
  // We remove the full floor and replace with floor-minus-hole
  // Simpler approach: place floor as two pieces with gap
  sfFloor.dispose();
  const stairX = 2.5; // stair opening center X
  const stairOpenW = 1.5;
  const stairOpenD = 2.5;

  // Floor piece left of stair opening
  const sfFloorLeftW = (FW - W*2)/2 + stairX - stairOpenW/2;
  const sfFloorL = BABYLON.MeshBuilder.CreateBox('sfFloorL', {
    width: sfFloorLeftW, height: 0.15, depth: FD - W*2
  }, scene);
  sfFloorL.material = MAT.woodFloor;
  sfFloorL.position.set(-FW/2 + W + sfFloorLeftW/2, SF_H + 0.075, 0);
  sfFloorL.receiveShadows = true;
  sfFloorL.checkCollisions = true;
  sfFloorL.parent = building;

  // Floor piece right of stair opening
  const sfFloorRightW = (FW - W*2) - sfFloorLeftW - stairOpenW;
  if(sfFloorRightW > 0.1){
    const sfFloorR = BABYLON.MeshBuilder.CreateBox('sfFloorR', {
      width: sfFloorRightW, height: 0.15, depth: FD - W*2
    }, scene);
    sfFloorR.material = MAT.woodFloor;
    sfFloorR.position.set(FW/2 - W - sfFloorRightW/2, SF_H + 0.075, 0);
    sfFloorR.receiveShadows = true;
    sfFloorR.checkCollisions = true;
    sfFloorR.parent = building;
  }

  // Floor piece behind stair opening (back strip)
  const sfFloorBackD = (FD - W*2)/2 - stairOpenD/2;
  const sfFloorBack = BABYLON.MeshBuilder.CreateBox('sfFloorBack', {
    width: stairOpenW, height: 0.15, depth: sfFloorBackD
  }, scene);
  sfFloorBack.material = MAT.woodFloor;
  sfFloorBack.position.set(stairX, SF_H + 0.075, -(FD - W*2)/2 + sfFloorBackD/2);
  sfFloorBack.receiveShadows = true;
  sfFloorBack.checkCollisions = true;
  sfFloorBack.parent = building;

  // Floor piece in front of stair opening (front strip)
  const sfFloorFrontD = (FD - W*2) - sfFloorBackD - stairOpenD;
  if(sfFloorFrontD > 0.1){
    const sfFloorFront = BABYLON.MeshBuilder.CreateBox('sfFloorFront', {
      width: stairOpenW, height: 0.15, depth: sfFloorFrontD
    }, scene);
    sfFloorFront.material = MAT.woodFloor;
    sfFloorFront.position.set(stairX, SF_H + 0.075, (FD - W*2)/2 - sfFloorFrontD/2);
    sfFloorFront.receiveShadows = true;
    sfFloorFront.checkCollisions = true;
    sfFloorFront.parent = building;
  }

  // STAIRS — 8 steps from ground to second floor
  const stairSteps = 10;
  const stepH = SF_H / stairSteps;
  const stepD = stairOpenD / stairSteps;
  for(let i = 0; i < stairSteps; i++){
    const step = BABYLON.MeshBuilder.CreateBox('step'+i, {
      width: stairOpenW - 0.1, height: stepH, depth: stepD
    }, scene);
    step.material = MAT.woodDark;
    step.position.set(stairX, stepH/2 + i * stepH, -FD/2 + W + sfFloorBackD + i * stepD + stepD/2);
    step.checkCollisions = true;
    step.receiveShadows = true;
    shadowGen.addShadowCaster(step);
    step.parent = building;
  }

  // Stair railing (banister on the open side)
  const railH = 1.0;
  const railLen = Math.sqrt(stairOpenD * stairOpenD + SF_H * SF_H);
  const railAngle = Math.atan2(SF_H, stairOpenD);
  const stairRail = BABYLON.MeshBuilder.CreateBox('stairRail', {
    width: 0.04, height: railH, depth: railLen
  }, scene);
  stairRail.material = MAT.woodDark;
  stairRail.position.set(stairX - stairOpenW/2 + 0.02, SF_H/2 + railH/2,
    -FD/2 + W + sfFloorBackD + stairOpenD/2);
  stairRail.rotation.x = -railAngle;
  shadowGen.addShadowCaster(stairRail);
  stairRail.parent = building;

  // Loft railing along stair opening edge (safety rail on second floor)
  const loftRail = BABYLON.MeshBuilder.CreateBox('loftRail', {
    width: 0.04, height: railH, depth: stairOpenD
  }, scene);
  loftRail.material = MAT.woodDark;
  loftRail.position.set(stairX - stairOpenW/2 + 0.02, SF_H + railH/2, 0);
  loftRail.parent = building;

  // Loft railing front edge
  const loftRailFront = BABYLON.MeshBuilder.CreateBox('loftRailFront', {
    width: stairOpenW, height: railH, depth: 0.04
  }, scene);
  loftRailFront.material = MAT.woodDark;
  loftRailFront.position.set(stairX, SF_H + railH/2, stairOpenD/2);
  loftRailFront.parent = building;

  // Second floor walls — extend main walls upward
  // Back wall upper
  const sfBackWall = BABYLON.MeshBuilder.CreateBox('sfBackWall', { width: FW, height: SF_WH, depth: W }, scene);
  sfBackWall.material = MAT.plaster;
  sfBackWall.position.set(0, SF_H + SF_WH/2, -FD/2 + W/2);
  sfBackWall.checkCollisions = true;
  shadowGen.addShadowCaster(sfBackWall);
  sfBackWall.parent = building;

  // Left wall upper
  const sfLeftWall = BABYLON.MeshBuilder.CreateBox('sfLeftWall', { width: W, height: SF_WH, depth: FD }, scene);
  sfLeftWall.material = MAT.plaster;
  sfLeftWall.position.set(-FW/2 + W/2, SF_H + SF_WH/2, 0);
  sfLeftWall.checkCollisions = true;
  shadowGen.addShadowCaster(sfLeftWall);
  sfLeftWall.parent = building;

  // Right wall upper
  const sfRightWall = BABYLON.MeshBuilder.CreateBox('sfRightWall', { width: W, height: SF_WH, depth: FD }, scene);
  sfRightWall.material = MAT.plaster;
  sfRightWall.position.set(FW/2 - W/2, SF_H + SF_WH/2, 0);
  sfRightWall.checkCollisions = true;
  shadowGen.addShadowCaster(sfRightWall);
  sfRightWall.parent = building;

  // Front wall upper
  const sfFrontWall = BABYLON.MeshBuilder.CreateBox('sfFrontWall', { width: FW, height: SF_WH, depth: W }, scene);
  sfFrontWall.material = MAT.plaster;
  sfFrontWall.position.set(0, SF_H + SF_WH/2, FD/2 - W/2);
  sfFrontWall.checkCollisions = true;
  shadowGen.addShadowCaster(sfFrontWall);
  sfFrontWall.parent = building;

  // Second floor ceiling
  const sfCeiling = BABYLON.MeshBuilder.CreateBox('sfCeiling', { width: FW - W*2, height: 0.1, depth: FD - W*2 }, scene);
  sfCeiling.material = MAT.woodDark;
  sfCeiling.position.set(0, SF_H + SF_WH - 0.05, 0);
  sfCeiling.parent = building;

  // Store door info for interaction system
  building.metadata = {
    doorCenterX: doorCenterX,
    doorCenterZ: FD/2 - W/2,
    doorWidth: DW,
    doorHeight: DH,
    floorWidth: FW,
    floorDepth: FD,
    wallHeight: WH,
    wallThick: W,
    backDoorX: backDoorX,
    backDoorW: backDoorW,
    backDoorH: backDoorH,
    backRoomWidth: BRW,
    backRoomDepth: BRD,
    backRoomCenterZ: brZ,
    secondFloorHeight: SF_H,
    secondFloorWallHeight: SF_WH,
    stairX: stairX,
    stairOpenW: stairOpenW,
    stairOpenD: stairOpenD
  };

  return building;
}

// ============================================================
// 4b. TROPICAL — Beach camp / pirate hideout
// ============================================================
function buildTropicalCamp(pos){
  const g = new BABYLON.TransformNode('tropicalCamp', scene);
  g.position = pos.clone();

  // Sandy clearing
  const clearing = BABYLON.MeshBuilder.CreateCylinder('clearing', {
    height:0.15, diameter:12, tessellation:24
  }, scene);
  clearing.material = MAT.sand; clearing.position.y = 0.07;
  clearing.receiveShadows = true; clearing.checkCollisions = true; clearing.parent = g;

  // Central firepit
  const pit = BABYLON.MeshBuilder.CreateCylinder('firepit', {
    height:0.25, diameter:1.8, tessellation:12
  }, scene);
  pit.material = MAT.stoneDark; pit.position.y = 0.12;
  pit.checkCollisions = true; pit.parent = g;

  // Firelight
  const firePt = new BABYLON.PointLight('campfire', new BABYLON.Vector3(0, 1.0, 0), scene);
  firePt.diffuse = new BABYLON.Color3(1, 0.6, 0.2);
  firePt.intensity = 1.5; firePt.range = 8; firePt.parent = g;

  // Fire flame (simple emissive cone)
  const flame = BABYLON.MeshBuilder.CreateCylinder('flame', {
    height:0.8, diameterTop:0, diameterBottom:0.4, tessellation:8
  }, scene);
  flame.material = MAT.flame; flame.position.y = 0.5; flame.parent = g;

  // Palm tree trunks (3 around camp)
  for(let i = 0; i < 3; i++){
    const a = (i/3) * Math.PI * 2 + 0.3;
    const r = 4.5;
    const trunk = BABYLON.MeshBuilder.CreateCylinder('palm'+i, {
      height:6, diameterTop:0.2, diameterBottom:0.35, tessellation:8
    }, scene);
    trunk.material = MAT.wood;
    trunk.position.set(Math.cos(a)*r, 3, Math.sin(a)*r);
    trunk.rotation.z = (Math.random()-0.5)*0.15;
    shadowGen.addShadowCaster(trunk); trunk.parent = g;

    // Fronds (flat green discs at top)
    for(let f = 0; f < 4; f++){
      const frond = BABYLON.MeshBuilder.CreateDisc('frond', {radius:1.5, tessellation:6}, scene);
      frond.material = MAT.ground;
      frond.position.set(Math.cos(a)*r + (Math.random()-0.5), 6.2, Math.sin(a)*r + (Math.random()-0.5));
      frond.rotation.x = Math.PI/2 + (Math.random()-0.5)*0.6;
      frond.rotation.z = f * Math.PI/2;
      frond.parent = g;
    }
  }

  // Lean-to shelter (simple A-frame)
  const shelterPost1 = BABYLON.MeshBuilder.CreateCylinder('sp1', {height:2.5,diameter:0.12,tessellation:6}, scene);
  shelterPost1.material = MAT.wood; shelterPost1.position.set(-2, 1.25, -3);
  shelterPost1.checkCollisions = true; shadowGen.addShadowCaster(shelterPost1); shelterPost1.parent = g;

  const shelterPost2 = BABYLON.MeshBuilder.CreateCylinder('sp2', {height:2.5,diameter:0.12,tessellation:6}, scene);
  shelterPost2.material = MAT.wood; shelterPost2.position.set(2, 1.25, -3);
  shelterPost2.checkCollisions = true; shadowGen.addShadowCaster(shelterPost2); shelterPost2.parent = g;

  const shelterRoof = BABYLON.MeshBuilder.CreateBox('shelterRoof', {width:4.5,height:0.06,depth:3}, scene);
  shelterRoof.material = MAT.fabric; shelterRoof.position.set(0, 2.5, -3);
  shelterRoof.rotation.x = -0.15;
  shadowGen.addShadowCaster(shelterRoof); shelterRoof.parent = g;

  // Hammock frame
  const hPost1 = BABYLON.MeshBuilder.CreateCylinder('hp1', {height:2,diameter:0.1,tessellation:6}, scene);
  hPost1.material = MAT.wood; hPost1.position.set(3, 1, -1);
  hPost1.checkCollisions = true; hPost1.parent = g;

  const hPost2 = BABYLON.MeshBuilder.CreateCylinder('hp2', {height:2,diameter:0.1,tessellation:6}, scene);
  hPost2.material = MAT.wood; hPost2.position.set(3, 1, 2);
  hPost2.checkCollisions = true; hPost2.parent = g;

  const hammock = BABYLON.MeshBuilder.CreateBox('hammock', {width:0.8,height:0.04,depth:2.8}, scene);
  hammock.material = MAT.fabric; hammock.position.set(3, 1.3, 0.5);
  hammock.parent = g;

  return g;
}

// ============================================================
// 4c. WILD — Wilderness cave entrance
// ============================================================
function buildWilderness(pos){
  const g = new BABYLON.TransformNode('wilderness', scene);
  g.position = pos.clone();

  // Rocky terrain base
  const rockBase = BABYLON.MeshBuilder.CreateCylinder('rockBase', {
    height:0.6, diameter:18, tessellation:8
  }, scene);
  rockBase.material = MAT.stoneDark; rockBase.position.y = 0.3;
  rockBase.receiveShadows = true; rockBase.checkCollisions = true; rockBase.parent = g;

  // Cave entrance (arch made of boulders)
  const caveBack = BABYLON.MeshBuilder.CreateBox('caveBack', {width:5,height:4,depth:0.5}, scene);
  caveBack.material = MAT.stoneDark; caveBack.position.set(0, 2, -4);
  caveBack.checkCollisions = true; shadowGen.addShadowCaster(caveBack); caveBack.parent = g;

  const caveLeft = BABYLON.MeshBuilder.CreateBox('caveLeft', {width:0.8,height:4,depth:4}, scene);
  caveLeft.material = MAT.stone; caveLeft.position.set(-2.5, 2, -2);
  caveLeft.checkCollisions = true; shadowGen.addShadowCaster(caveLeft); caveLeft.parent = g;

  const caveRight = BABYLON.MeshBuilder.CreateBox('caveRight', {width:0.8,height:4,depth:4}, scene);
  caveRight.material = MAT.stone; caveRight.position.set(2.5, 2, -2);
  caveRight.checkCollisions = true; shadowGen.addShadowCaster(caveRight); caveRight.parent = g;

  // Cave arch (lintel)
  const arch = BABYLON.MeshBuilder.CreateBox('caveArch', {width:5.6,height:0.8,depth:4.2}, scene);
  arch.material = MAT.stoneDark; arch.position.set(0, 3.8, -2);
  shadowGen.addShadowCaster(arch); arch.parent = g;

  // Cave interior darkness (dark plane)
  const caveDark = BABYLON.MeshBuilder.CreatePlane('caveDark', {width:4.2,height:3.5}, scene);
  const darkMat = new BABYLON.StandardMaterial('caveDarkMat', scene);
  darkMat.diffuseColor = new BABYLON.Color3(0.05, 0.03, 0.02);
  darkMat.emissiveColor = new BABYLON.Color3(0.02, 0.01, 0.005);
  caveDark.material = darkMat;
  caveDark.position.set(0, 1.75, -3.7);
  caveDark.parent = g;

  // Glow from cave interior (faint warm light)
  const caveGlow = new BABYLON.PointLight('caveGlow', new BABYLON.Vector3(0, 2, -3), scene);
  caveGlow.diffuse = new BABYLON.Color3(1, 0.5, 0.2);
  caveGlow.intensity = 0.4; caveGlow.range = 5; caveGlow.parent = g;

  // Scattered boulders
  for(let i = 0; i < 8; i++){
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * 5;
    const sz = 0.5 + Math.random() * 1.2;
    const boulder = BABYLON.MeshBuilder.CreateBox('boulder'+i, {
      width:sz, height:sz*0.7, depth:sz
    }, scene);
    boulder.material = (i % 2 === 0) ? MAT.stone : MAT.stoneDark;
    boulder.position.set(Math.cos(a)*r, sz*0.35, Math.sin(a)*r);
    boulder.rotation.y = Math.random() * Math.PI;
    boulder.checkCollisions = true;
    boulder.receiveShadows = true;
    shadowGen.addShadowCaster(boulder); boulder.parent = g;
  }

  // Dead/twisted trees
  for(let i = 0; i < 4; i++){
    const a = (i/4) * Math.PI * 2 + 0.5;
    const r = 5 + Math.random() * 3;
    const trunk = BABYLON.MeshBuilder.CreateCylinder('deadTree'+i, {
      height: 3 + Math.random()*2, diameterTop:0.05, diameterBottom:0.2, tessellation:6
    }, scene);
    trunk.material = MAT.woodDark;
    trunk.position.set(Math.cos(a)*r, (3+Math.random()*2)/2, Math.sin(a)*r);
    trunk.rotation.z = (Math.random()-0.5)*0.3;
    shadowGen.addShadowCaster(trunk); trunk.parent = g;
  }

  // Moss patches (green ground spots)
  for(let i = 0; i < 5; i++){
    const moss = BABYLON.MeshBuilder.CreateDisc('moss'+i, {radius:0.5+Math.random()*0.8, tessellation:8}, scene);
    moss.material = MAT.ground;
    moss.position.set((Math.random()-0.5)*10, 0.62, (Math.random()-0.5)*8);
    moss.rotation.x = Math.PI/2;
    moss.parent = g;
  }

  return g;
}

// ============================================================
// 4d. ISLAND ENVIRONMENT FACTORY
// ============================================================
setLoad(30, 'Building ' + ISLAND_TYPE + ' environment...');

// The main building — tavern for village, or type-specific
let tavern = null;    // will be non-null only for 'village'
let mainBuilding = null;

if(ISLAND_TYPE === 'village'){
  tavern = createTavern();
  mainBuilding = tavern;
} else {
  // For non-village types, build a placeholder node so references to `tavern` don't crash
  // (door/chest code is guarded by tavern !== null)
  mainBuilding = new BABYLON.TransformNode('mainBuilding', scene);
  mainBuilding.position.set(0, 0.5, -2);
}

// ============================================================
// 5. DOOR SYSTEM — Authored-asset workflow (Pack 1 MP2)
// ============================================================
// Proper separation: FRAME (static, always blocks) vs LEAF (animated, hinged).
// Frame stays in place and always blocks the player. The leaf swings on a
// hinge pivot placed at the frame edge. Collision on the leaf updates with
// the swing so the player can walk through when open and is blocked when closed.
// ============================================================

function createDoorFrame(building){
  // Frame is purely structural — always blocks, never animates
  const meta = building.metadata;
  const DW = meta.doorWidth;
  const DH = meta.doorHeight;
  const WT = meta.wallThick || 0.3;
  const bx = building.position.x;
  const by = building.position.y;
  const bz = building.position.z;
  const cx = meta.doorCenterX;
  const cz = meta.doorCenterZ;

  const frame = new BABYLON.TransformNode('doorFrame', scene);
  frame.position.set(bx, by, bz);

  const frameMat = MAT.woodDark;
  const frameDepth = WT + 0.04;  // slightly deeper than wall
  const frameW = 0.09;           // frame member width

  // Left jamb
  const jamb_L = BABYLON.MeshBuilder.CreateBox('frame_jamb_L', {
    width: frameW, height: DH + 0.04, depth: frameDepth
  }, scene);
  jamb_L.material = frameMat;
  jamb_L.position.set(cx - DW/2 - frameW/2, DH/2 + 0.15, cz);
  jamb_L.checkCollisions = true;
  jamb_L.receiveShadows = true;
  shadowGen.addShadowCaster(jamb_L);
  jamb_L.parent = frame;

  // Right jamb
  const jamb_R = BABYLON.MeshBuilder.CreateBox('frame_jamb_R', {
    width: frameW, height: DH + 0.04, depth: frameDepth
  }, scene);
  jamb_R.material = frameMat;
  jamb_R.position.set(cx + DW/2 + frameW/2, DH/2 + 0.15, cz);
  jamb_R.checkCollisions = true;
  jamb_R.receiveShadows = true;
  shadowGen.addShadowCaster(jamb_R);
  jamb_R.parent = frame;

  // Head (lintel trim)
  const head = BABYLON.MeshBuilder.CreateBox('frame_head', {
    width: DW + frameW * 2 + 0.04, height: frameW, depth: frameDepth
  }, scene);
  head.material = frameMat;
  head.position.set(cx, DH + frameW/2 + 0.15, cz);
  head.checkCollisions = true;
  head.receiveShadows = true;
  shadowGen.addShadowCaster(head);
  head.parent = frame;

  // Threshold (bottom trim)
  const threshold = BABYLON.MeshBuilder.CreateBox('frame_threshold', {
    width: DW + frameW * 2 + 0.04, height: 0.03, depth: frameDepth
  }, scene);
  threshold.material = frameMat;
  threshold.position.set(cx, 0.165, cz);
  threshold.receiveShadows = true;
  threshold.parent = frame;

  // Decorative chamfer strips on inner edges of jambs
  for(const side of [-1, 1]){
    const chamfer = BABYLON.MeshBuilder.CreateBox('frame_chamfer', {
      width: 0.02, height: DH, depth: 0.02
    }, scene);
    chamfer.material = MAT.wood;
    chamfer.position.set(cx + side * (DW/2 + 0.005), DH/2 + 0.15, cz + frameDepth/2 - 0.01);
    chamfer.parent = frame;
  }

  return frame;
}

function createDoorLeaf(building){
  // Leaf is the swinging part — hinged at left jamb edge
  const meta = building.metadata;
  const DW = meta.doorWidth;
  const DH = meta.doorHeight;
  const bx = building.position.x;
  const by = building.position.y;
  const bz = building.position.z;
  const cx = meta.doorCenterX;
  const cz = meta.doorCenterZ;

  // The leaf is a TransformNode so the pivot is at the hinge edge
  const leafRoot = new BABYLON.TransformNode('doorLeaf', scene);
  // Position at hinge point: left jamb inner edge, base of door
  leafRoot.position.set(bx + cx - DW/2, by + 0.15, bz + cz);

  // Door panel — offset so the hinge edge is at local X=0
  const panel = BABYLON.MeshBuilder.CreateBox('door_panel_COL', {
    width: DW, height: DH, depth: 0.06
  }, scene);
  panel.material = MAT.wood;
  panel.position.set(DW/2, DH/2, 0);  // centered on leaf, hinge at left edge
  panel.checkCollisions = true;
  panel.receiveShadows = true;
  shadowGen.addShadowCaster(panel);
  panel.parent = leafRoot;

  // Plank detail — 5 vertical stiles for a proper paneled door look
  const plankMat = MAT.woodDark;
  const stileW = 0.04;
  for(let i = 0; i < 5; i++){
    const x = 0.06 + i * (DW - 0.12) / 4;
    const stile = BABYLON.MeshBuilder.CreateBox('door_stile_VIS', {
      width: stileW, height: DH - 0.08, depth: 0.065
    }, scene);
    stile.material = plankMat;
    stile.position.set(x, DH/2, 0.001);
    stile.parent = leafRoot;
  }
  // 3 horizontal rails
  for(const yFrac of [0.15, 0.5, 0.85]){
    const rail = BABYLON.MeshBuilder.CreateBox('door_rail_VIS', {
      width: DW - 0.06, height: 0.05, depth: 0.065
    }, scene);
    rail.material = plankMat;
    rail.position.set(DW/2, DH * yFrac, 0.001);
    rail.parent = leafRoot;
  }

  // Handle (exterior side)
  const handlePlate = BABYLON.MeshBuilder.CreateBox('door_handlePlate_VIS', {
    width: 0.04, height: 0.14, depth: 0.01
  }, scene);
  handlePlate.material = MAT.metal;
  handlePlate.position.set(DW - 0.15, DH * 0.48, 0.035);
  handlePlate.parent = leafRoot;

  const handleGrip = BABYLON.MeshBuilder.CreateCylinder('door_handle_VIS', {
    height: 0.12, diameter: 0.025, tessellation: 8
  }, scene);
  handleGrip.material = MAT.metal;
  handleGrip.rotation.x = Math.PI/2;
  handleGrip.position.set(DW - 0.15, DH * 0.48, 0.055);
  handleGrip.parent = leafRoot;

  // Handle (interior side)
  const handleGripInt = handleGrip.clone('door_handleInt_VIS');
  handleGripInt.position.z = -0.055;
  handleGripInt.parent = leafRoot;

  // Hinge plates (2 visible hinges on hinge side)
  for(const yFrac of [0.2, 0.8]){
    const hinge = BABYLON.MeshBuilder.CreateBox('door_hinge_VIS', {
      width: 0.06, height: 0.08, depth: 0.015
    }, scene);
    hinge.material = MAT.metal;
    hinge.position.set(0.03, DH * yFrac, 0.035);
    hinge.parent = leafRoot;

    // Hinge pin (cylinder on the edge)
    const pin = BABYLON.MeshBuilder.CreateCylinder('door_pin_VIS', {
      height: 0.1, diameter: 0.015, tessellation: 6
    }, scene);
    pin.material = MAT.metal;
    pin.position.set(0.0, DH * yFrac, 0.0);
    pin.parent = leafRoot;
  }

  leafRoot.metadata = {
    interactType: 'door',
    isOpen: false,
    animating: false,
    openAngle: -Math.PI * 0.45,
    closedAngle: 0,
    promptOpen: 'Open Door',
    promptClose: 'Close Door'
  };

  return leafRoot;
}

setLoad(35, 'Adding door...');
let doorFrame = null;
let door = null;
if(tavern){
  doorFrame = createDoorFrame(tavern);
  door = createDoorLeaf(tavern);
}

// Door animation — animates the leaf TransformNode, collision follows
function toggleDoor(doorNode){
  const meta = doorNode.metadata;
  if(meta.animating) return;
  meta.animating = true;

  const targetAngle = meta.isOpen ? meta.closedAngle : meta.openAngle;
  const startAngle = doorNode.rotation.y;
  const duration = 500;
  const startTime = performance.now();

  function animStep(){
    const elapsed = performance.now() - startTime;
    const t = Math.min(1, elapsed / duration);
    // Smooth ease-out-cubic
    const eased = 1 - Math.pow(1 - t, 3);
    doorNode.rotation.y = startAngle + (targetAngle - startAngle) * eased;

    if(t < 1){
      requestAnimationFrame(animStep);
    } else {
      doorNode.rotation.y = targetAngle;
      meta.isOpen = !meta.isOpen;
      meta.animating = false;
    }
  }
  requestAnimationFrame(animStep);
}

// ============================================================
// 6. CHEST SYSTEM — Authored-asset workflow (Pack 1 MP2)
// ============================================================
// Proper separation: BASE (static, always blocks) vs LID (animated, hinged at back).
// Interaction targeting uses a dedicated invisible trigger volume (_INT convention)
// so the player doesn't have to aim at a tiny mesh. Gold glow ramps on open.
// ============================================================

function createChest(pos, name){
  const chest = new BABYLON.TransformNode(name || 'chest', scene);
  chest.position = pos.clone();

  const CW = 0.7, CH = 0.4, CD = 0.45;

  // ── BASE (static, collision) ──
  const base = BABYLON.MeshBuilder.CreateBox('chest_base_COL', {
    width: CW, height: CH, depth: CD
  }, scene);
  base.material = MAT.woodDark;
  base.position.y = CH/2;
  base.checkCollisions = true;
  base.receiveShadows = true;
  shadowGen.addShadowCaster(base);
  base.parent = chest;

  // Plank detail on front face
  const plankMat = makeMat('chest_plank', '#4a2a10', 0.92, 0);
  for(let i = 0; i < 3; i++){
    const plank = BABYLON.MeshBuilder.CreateBox('chest_plank_VIS', {
      width: CW - 0.04, height: 0.015, depth: 0.005
    }, scene);
    plank.material = plankMat;
    plank.position.set(0, 0.1 + i * 0.12, CD/2 + 0.003);
    plank.parent = chest;
  }

  // Side plank detail
  for(const side of [-1, 1]){
    for(let i = 0; i < 2; i++){
      const sp = BABYLON.MeshBuilder.CreateBox('chest_sideplank_VIS', {
        width: 0.005, height: CH - 0.06, depth: CD - 0.04
      }, scene);
      sp.material = plankMat;
      sp.position.set(side * (CW/2 + 0.003), CH/2, 0);
      sp.parent = chest;
    }
  }

  // Metal bands (3 bands)
  const bandMat = MAT.metal;
  for(const yo of [0.06, CH/2, CH - 0.04]){
    const band = BABYLON.MeshBuilder.CreateBox('chest_band_VIS', {
      width: CW + 0.02, height: 0.025, depth: CD + 0.02
    }, scene);
    band.material = bandMat;
    band.position.y = yo;
    band.parent = chest;
  }

  // Corner brackets (8 corners)
  for(const x of [-1, 1]){
    for(const z of [-1, 1]){
      const bracket = BABYLON.MeshBuilder.CreateBox('chest_bracket_VIS', {
        width: 0.04, height: CH + 0.01, depth: 0.04
      }, scene);
      bracket.material = bandMat;
      bracket.position.set(x * CW/2, CH/2, z * CD/2);
      bracket.parent = chest;
    }
  }

  // ── LID (animated, hinged at back edge) ──
  const lidRoot = new BABYLON.TransformNode('chest_lidRoot', scene);
  // Pivot at the back-top edge of the base
  lidRoot.position.set(0, CH, -CD/2);
  lidRoot.parent = chest;

  const lid = BABYLON.MeshBuilder.CreateBox('chest_lid_VIS', {
    width: CW + 0.01, height: 0.08, depth: CD
  }, scene);
  lid.material = MAT.wood;
  // Offset so the hinge edge is at local Z=0 (back edge)
  lid.position.set(0, 0.04, CD/2);
  lid.receiveShadows = true;
  shadowGen.addShadowCaster(lid);
  lid.parent = lidRoot;

  // Lid metal band
  const lidBand = BABYLON.MeshBuilder.CreateBox('chest_lidband_VIS', {
    width: CW + 0.03, height: 0.02, depth: CD + 0.02
  }, scene);
  lidBand.material = bandMat;
  lidBand.position.set(0, 0.06, CD/2);
  lidBand.parent = lidRoot;

  // Lid arch (slight rounded top — a flattened cylinder slice)
  const lidArch = BABYLON.MeshBuilder.CreateCylinder('chest_arch_VIS', {
    height: CW + 0.01, diameter: CD * 0.6, tessellation: 8,
    arc: 0.5  // half-cylinder
  }, scene);
  lidArch.material = MAT.wood;
  lidArch.rotation.z = Math.PI/2;
  lidArch.rotation.y = Math.PI;
  lidArch.position.set(0, 0.08, CD/2);
  lidArch.scaling.y = 0.3;
  lidArch.parent = lidRoot;

  // Latch (front face)
  const latchPlate = BABYLON.MeshBuilder.CreateBox('chest_latchPlate_VIS', {
    width: 0.06, height: 0.04, depth: 0.01
  }, scene);
  latchPlate.material = MAT.metalGold;
  latchPlate.position.set(0, 0.0, CD + 0.005);
  latchPlate.parent = lidRoot;

  const latchHasp = BABYLON.MeshBuilder.CreateBox('chest_latchHasp_VIS', {
    width: 0.04, height: 0.06, depth: 0.008
  }, scene);
  latchHasp.material = MAT.metalGold;
  latchHasp.position.set(0, -0.04, CD + 0.005);
  latchHasp.parent = lidRoot;

  // ── INTERACTION TRIGGER (invisible, generous volume) ──
  const trigger = BABYLON.MeshBuilder.CreateBox('chest_trigger_INT', {
    width: CW + 0.6, height: CH + 0.5, depth: CD + 0.6
  }, scene);
  trigger.isVisible = false;
  trigger.isPickable = true;
  trigger.checkCollisions = false;
  trigger.position.y = CH/2;
  trigger.parent = chest;

  // Gold interior glow (visible when open)
  const goldGlow = new BABYLON.PointLight('chestGlow_' + (name||''),
    new BABYLON.Vector3(0, CH * 0.6, 0), scene);
  goldGlow.diffuse = new BABYLON.Color3(1, 0.85, 0.4);
  goldGlow.intensity = 0;
  goldGlow.range = 3;
  goldGlow.parent = chest;

  // Gold coins visible inside (when open)
  const goldPile = BABYLON.MeshBuilder.CreateCylinder('chest_gold_VIS', {
    height: 0.08, diameter: 0.35, tessellation: 8
  }, scene);
  goldPile.material = MAT.metalGold;
  goldPile.position.set(0, 0.06, 0);
  goldPile.isVisible = false;  // shown on open
  goldPile.parent = chest;

  chest.metadata = {
    interactType: 'chest',
    isOpen: false,
    animating: false,
    lidRoot: lidRoot,
    goldGlow: goldGlow,
    goldPile: goldPile,
    promptOpen: 'Open Chest',
    promptInspect: 'Inspect Chest',
    lootCollected: false
  };

  return chest;
}

function toggleChest(chestNode){
  const meta = chestNode.metadata;
  if(meta.animating) return;
  if(meta.isOpen) return;
  meta.animating = true;

  const lidRoot = meta.lidRoot;
  const startAngle = 0;
  const targetAngle = -Math.PI * 0.55;
  const duration = 700;
  const startTime = performance.now();

  // Show gold pile when lid starts opening
  if(meta.goldPile) meta.goldPile.isVisible = true;

  function animStep(){
    const elapsed = performance.now() - startTime;
    const t = Math.min(1, elapsed / duration);
    // Smooth ease-out with slight bounce at the end
    let eased;
    if(t < 0.85){
      eased = 1 - Math.pow(1 - (t / 0.85), 3);
    } else {
      // Tiny settle bounce
      const bt = (t - 0.85) / 0.15;
      eased = 1.0 + Math.sin(bt * Math.PI) * 0.03;
    }
    lidRoot.rotation.x = startAngle + (targetAngle - startAngle) * Math.min(eased, 1.02);
    meta.goldGlow.intensity = Math.min(eased, 1.0) * 1.8;

    if(t < 1){
      requestAnimationFrame(animStep);
    } else {
      lidRoot.rotation.x = targetAngle;
      meta.isOpen = true;
      meta.animating = false;
    }
  }
  requestAnimationFrame(animStep);
}

setLoad(40, 'Adding chests...');
const interiorChest = tavern ? createChest(
  new BABYLON.Vector3(tavern.position.x + 2.8, tavern.position.y + 0.15, tavern.position.z - 1.5),
  'interiorChest'
) : null;
const exteriorChest = createChest(
  new BABYLON.Vector3(5, 0.5, 10),
  'exteriorChest'
);

// ============================================================
// 7. ASSET-LIBRARY DRIVEN PROPS (async)
// ============================================================
// Initialize the asset library with scene references
if(window.AssetLibrary){
  window.AssetLibrary.init(scene, shadowGen, MAT);
}

// Interactables array — populated as props are created
const interactables = [];
function registerInteractable(meshOrNode, metadata){
  if(metadata) meshOrNode.metadata = { ...meshOrNode.metadata, ...metadata };
  interactables.push(meshOrNode);
}

// Register chests and door immediately
if(door) registerInteractable(door);
if(interiorChest){ registerInteractable(interiorChest); assignChestLoot(interiorChest, 'common'); }
registerInteractable(exteriorChest);
assignChestLoot(exteriorChest, 'rare');

// NPC list — populated in buildAssetProps
const npcs = [];

// NPC AI update — called each frame
function updateNPCs(dt){
  for(const npc of npcs){
    const ai = npc.metadata && npc.metadata.ai;
    if(!ai) continue;

    ai.stateTimer -= dt;

    switch(ai.state){
      case 'idle':
        if(ai.stateTimer <= 0){
          // Pick a new walk target within patrol radius
          const angle = Math.random() * Math.PI * 2;
          const dist = Math.random() * ai.patrolRadius;
          ai.targetPos = new BABYLON.Vector3(
            ai.patrolCenter.x + Math.cos(angle) * dist,
            ai.patrolCenter.y,
            ai.patrolCenter.z + Math.sin(angle) * dist
          );
          // Face target
          const dx = ai.targetPos.x - npc.position.x;
          const dz = ai.targetPos.z - npc.position.z;
          ai.targetAngle = Math.atan2(dx, dz);
          ai.state = 'turning';
          ai.stateTimer = 0.5;
        }
        break;

      case 'turning': {
        // Smoothly rotate toward target angle
        let diff = ai.targetAngle - npc.rotation.y;
        // Normalize to [-PI, PI]
        while(diff > Math.PI) diff -= Math.PI * 2;
        while(diff < -Math.PI) diff += Math.PI * 2;
        const step = ai.turnSpeed * dt;
        if(Math.abs(diff) < step){
          npc.rotation.y = ai.targetAngle;
          ai.state = 'walking';
          const walkDist = BABYLON.Vector3.Distance(npc.position, ai.targetPos);
          ai.stateTimer = walkDist / ai.walkSpeed;
        } else {
          npc.rotation.y += Math.sign(diff) * step;
        }
        break;
      }

      case 'walking': {
        if(!ai.targetPos || ai.stateTimer <= 0){
          ai.state = 'idle';
          ai.stateTimer = 2 + Math.random() * 4;
          break;
        }
        const dir = ai.targetPos.subtract(npc.position);
        dir.y = 0;
        const dist = dir.length();
        if(dist < 0.2){
          ai.state = 'idle';
          ai.stateTimer = 2 + Math.random() * 4;
        } else {
          dir.normalize();
          const move = dir.scale(ai.walkSpeed * dt);
          npc.position.addInPlace(move);
        }
        break;
      }
    }
  }
}

// Barrel helper — loads from AssetLibrary, applies position + metadata
async function placeBarrel(pos, tilt){
  const barrel = await window.AssetLibrary.load('barrel');
  barrel.position = pos.clone();
  if(tilt){
    barrel.rotation.x = tilt.x || 0;
    barrel.rotation.z = tilt.z || 0;
  }
  barrel.metadata = {
    interactType: 'barrel',
    promptInspect: 'Inspect Barrel',
    searched: false
  };
  registerInteractable(barrel);
  return barrel;
}

// ============================================================
// BUILDING CONSTRUCTORS
// ============================================================

function buildFort(pos){
  const g = new BABYLON.TransformNode('fort', scene);
  g.position = pos.clone();
  const W = 0.4; const FW = 6; const FD = 5; const WH = 4;

  // Floor (stone)
  const floor = BABYLON.MeshBuilder.CreateBox('fortFloor', {width:FW,height:0.2,depth:FD}, scene);
  floor.material = MAT.stoneDark; floor.position.y = 0.1;
  floor.receiveShadows = true; floor.checkCollisions = true; floor.parent = g;

  // Walls — thick stone, no windows, one doorway
  const back = BABYLON.MeshBuilder.CreateBox('fBack', {width:FW,height:WH,depth:W}, scene);
  back.material = MAT.stone; back.position.set(0,WH/2,-FD/2+W/2);
  back.checkCollisions = true; shadowGen.addShadowCaster(back); back.parent = g;

  const left = BABYLON.MeshBuilder.CreateBox('fLeft', {width:W,height:WH,depth:FD}, scene);
  left.material = MAT.stone; left.position.set(-FW/2+W/2,WH/2,0);
  left.checkCollisions = true; shadowGen.addShadowCaster(left); left.parent = g;

  const right = BABYLON.MeshBuilder.CreateBox('fRight', {width:W,height:WH,depth:FD}, scene);
  right.material = MAT.stone; right.position.set(FW/2-W/2,WH/2,0);
  right.checkCollisions = true; shadowGen.addShadowCaster(right); right.parent = g;

  // Front wall with doorway
  const dw = 1.2; const dh = 2.4;
  const fwL = (FW-dw)/2;
  const fl = BABYLON.MeshBuilder.CreateBox('fFL', {width:fwL,height:WH,depth:W}, scene);
  fl.material = MAT.stone; fl.position.set(-FW/2+fwL/2,WH/2,FD/2-W/2);
  fl.checkCollisions = true; shadowGen.addShadowCaster(fl); fl.parent = g;

  const fr = BABYLON.MeshBuilder.CreateBox('fFR', {width:fwL,height:WH,depth:W}, scene);
  fr.material = MAT.stone; fr.position.set(FW/2-fwL/2,WH/2,FD/2-W/2);
  fr.checkCollisions = true; shadowGen.addShadowCaster(fr); fr.parent = g;

  const lintel = BABYLON.MeshBuilder.CreateBox('fLintel', {width:dw+0.3,height:WH-dh,depth:W}, scene);
  lintel.material = MAT.stone; lintel.position.set(0,dh+(WH-dh)/2,FD/2-W/2);
  lintel.checkCollisions = true; lintel.parent = g;

  // Flat stone roof
  const roof = BABYLON.MeshBuilder.CreateBox('fRoof', {width:FW+0.3,height:0.2,depth:FD+0.3}, scene);
  roof.material = MAT.stoneDark; roof.position.y = WH + 0.1;
  roof.receiveShadows = true; shadowGen.addShadowCaster(roof); roof.parent = g;

  // Crenellations (battlements)
  for(let i = -2; i <= 2; i++){
    for(const z of [-FD/2-0.15, FD/2+0.15]){
      const merlon = BABYLON.MeshBuilder.CreateBox('merlon', {width:0.5,height:0.6,depth:0.3}, scene);
      merlon.material = MAT.stone; merlon.position.set(i*1.3, WH+0.5, z);
      shadowGen.addShadowCaster(merlon); merlon.parent = g;
    }
  }
  for(let i = -1; i <= 1; i++){
    for(const x of [-FW/2-0.15, FW/2+0.15]){
      const merlon = BABYLON.MeshBuilder.CreateBox('merlon', {width:0.3,height:0.6,depth:0.5}, scene);
      merlon.material = MAT.stone; merlon.position.set(x, WH+0.5, i*1.3);
      shadowGen.addShadowCaster(merlon); merlon.parent = g;
    }
  }

  // Interior ceiling
  const ceil = BABYLON.MeshBuilder.CreateBox('fCeil', {width:FW-W*2,height:0.1,depth:FD-W*2}, scene);
  ceil.material = MAT.stoneDark; ceil.position.y = WH-0.05; ceil.parent = g;

  return g;
}

function buildWarehouse(pos){
  const g = new BABYLON.TransformNode('warehouse', scene);
  g.position = pos.clone();
  const W = 0.25; const FW = 7; const FD = 5; const WH = 3;

  // Floor
  const floor = BABYLON.MeshBuilder.CreateBox('whFloor', {width:FW,height:0.12,depth:FD}, scene);
  floor.material = MAT.woodFloor; floor.position.y = 0.06;
  floor.receiveShadows = true; floor.checkCollisions = true; floor.parent = g;

  // Walls — wooden planks
  const back = BABYLON.MeshBuilder.CreateBox('whBack', {width:FW,height:WH,depth:W}, scene);
  back.material = MAT.woodDark; back.position.set(0,WH/2,-FD/2+W/2);
  back.checkCollisions = true; shadowGen.addShadowCaster(back); back.parent = g;

  const left = BABYLON.MeshBuilder.CreateBox('whLeft', {width:W,height:WH,depth:FD}, scene);
  left.material = MAT.woodDark; left.position.set(-FW/2+W/2,WH/2,0);
  left.checkCollisions = true; shadowGen.addShadowCaster(left); left.parent = g;

  const right = BABYLON.MeshBuilder.CreateBox('whRight', {width:W,height:WH,depth:FD}, scene);
  right.material = MAT.woodDark; right.position.set(FW/2-W/2,WH/2,0);
  right.checkCollisions = true; shadowGen.addShadowCaster(right); right.parent = g;

  // Front wall with wide double-door opening
  const dw = 2.0; const dh = 2.5;
  const swW = (FW-dw)/2;
  const fwl = BABYLON.MeshBuilder.CreateBox('whFL', {width:swW,height:WH,depth:W}, scene);
  fwl.material = MAT.woodDark; fwl.position.set(-FW/2+swW/2,WH/2,FD/2-W/2);
  fwl.checkCollisions = true; shadowGen.addShadowCaster(fwl); fwl.parent = g;

  const fwr = BABYLON.MeshBuilder.CreateBox('whFR', {width:swW,height:WH,depth:W}, scene);
  fwr.material = MAT.woodDark; fwr.position.set(FW/2-swW/2,WH/2,FD/2-W/2);
  fwr.checkCollisions = true; shadowGen.addShadowCaster(fwr); fwr.parent = g;

  const wLintel = BABYLON.MeshBuilder.CreateBox('whLintel', {width:dw+0.2,height:WH-dh,depth:W}, scene);
  wLintel.material = MAT.woodDark; wLintel.position.set(0,dh+(WH-dh)/2,FD/2-W/2);
  wLintel.parent = g;

  // Lean-to roof
  const roofSlope = BABYLON.MeshBuilder.CreateBox('whRoof', {width:FW+0.5,height:0.1,depth:FD+0.8}, scene);
  roofSlope.material = MAT.roof; roofSlope.position.set(0, WH + 0.3, 0);
  roofSlope.rotation.x = -0.08;
  roofSlope.receiveShadows = true; shadowGen.addShadowCaster(roofSlope); roofSlope.parent = g;

  // Ceiling
  const whCeil = BABYLON.MeshBuilder.CreateBox('whCeil', {width:FW-W*2,height:0.08,depth:FD-W*2}, scene);
  whCeil.material = MAT.woodDark; whCeil.position.y = WH-0.05; whCeil.parent = g;

  // Plank detail on front wall
  for(let i = -2; i <= 2; i++){
    const trim = BABYLON.MeshBuilder.CreateBox('trim', {width:0.04,height:WH,depth:0.02}, scene);
    trim.material = MAT.wood; trim.position.set(i*1.5, WH/2, FD/2-W/2+0.02);
    trim.parent = g;
  }

  return g;
}

function buildRuinsTemple(pos){
  const g = new BABYLON.TransformNode('temple', scene);
  g.position = pos.clone();

  // Raised stone platform
  const platform = BABYLON.MeshBuilder.CreateCylinder('templePlat', {
    height:0.4, diameter:8, tessellation:6
  }, scene);
  platform.material = MAT.stoneDark; platform.position.y = 0.2;
  platform.receiveShadows = true; platform.checkCollisions = true; platform.parent = g;

  // Steps (front)
  for(let i = 0; i < 3; i++){
    const step = BABYLON.MeshBuilder.CreateBox('tStep'+i, {
      width: 3 - i*0.3, height: 0.15, depth: 0.5
    }, scene);
    step.material = MAT.stone;
    step.position.set(0, i * 0.15 + 0.07, 3.5 - i*0.5);
    step.checkCollisions = true; step.receiveShadows = true;
    shadowGen.addShadowCaster(step); step.parent = g;
  }

  // Columns (6 around the platform, some broken)
  const colH = [3.5, 2.0, 3.5, 1.5, 3.5, 3.0]; // varied heights for ruins
  for(let i = 0; i < 6; i++){
    const angle = (i/6) * Math.PI * 2 + Math.PI/6;
    const r = 3.2;
    const col = BABYLON.MeshBuilder.CreateCylinder('col'+i, {
      height: colH[i], diameterTop: 0.35, diameterBottom: 0.4, tessellation: 8
    }, scene);
    col.material = MAT.stone;
    col.position.set(Math.cos(angle)*r, 0.4 + colH[i]/2, Math.sin(angle)*r);
    col.checkCollisions = true;
    shadowGen.addShadowCaster(col); col.parent = g;

    // Column capital (square top piece)
    if(colH[i] > 2.5){
      const cap = BABYLON.MeshBuilder.CreateBox('cap'+i, {width:0.6,height:0.15,depth:0.6}, scene);
      cap.material = MAT.stoneDark;
      cap.position.set(Math.cos(angle)*r, 0.4 + colH[i] + 0.075, Math.sin(angle)*r);
      cap.parent = g;
    }
  }

  // Central altar stone
  const altar = BABYLON.MeshBuilder.CreateBox('altar', {width:1.2,height:0.8,depth:0.8}, scene);
  altar.material = MAT.stoneDark; altar.position.set(0, 0.8, 0);
  altar.checkCollisions = true; altar.receiveShadows = true;
  shadowGen.addShadowCaster(altar); altar.parent = g;

  // Altar top slab
  const slab = BABYLON.MeshBuilder.CreateBox('slab', {width:1.4,height:0.08,depth:1.0}, scene);
  slab.material = MAT.stone; slab.position.set(0, 1.24, 0);
  slab.receiveShadows = true; slab.parent = g;

  // Fallen column (debris)
  const fallen = BABYLON.MeshBuilder.CreateCylinder('fallen', {
    height:2.5, diameterTop:0.3, diameterBottom:0.35, tessellation:8
  }, scene);
  fallen.material = MAT.stone;
  fallen.rotation.z = Math.PI/2;
  fallen.position.set(2, 0.55, -1.5);
  fallen.checkCollisions = true;
  shadowGen.addShadowCaster(fallen); fallen.parent = g;

  // Rubble pieces
  for(let i = 0; i < 5; i++){
    const rubble = BABYLON.MeshBuilder.CreateBox('rubble'+i, {
      width: 0.3+Math.random()*0.4,
      height: 0.2+Math.random()*0.3,
      depth: 0.3+Math.random()*0.4
    }, scene);
    rubble.material = MAT.stoneDark;
    rubble.position.set(
      -2 + Math.random()*4,
      0.4 + (0.1+Math.random()*0.15),
      -2 + Math.random()*4
    );
    rubble.rotation.y = Math.random() * Math.PI;
    rubble.receiveShadows = true;
    shadowGen.addShadowCaster(rubble); rubble.parent = g;
  }

  return g;
}

// Build all AssetLibrary-based props
async function buildAssetProps(){
  setLoad(45, 'Loading props via AssetLibrary...');

  // --- COMMON: Exterior barrel cluster near dock (all island types) ---
  await placeBarrel(new BABYLON.Vector3(4, 0.5, 8.5));
  await placeBarrel(new BABYLON.Vector3(4.7, 0.5, 8.8));
  await placeBarrel(new BABYLON.Vector3(3.5, 0.5, 9.2));

  // ============================================================
  // TYPE-SPECIFIC ENVIRONMENT
  // ============================================================
  if(ISLAND_TYPE === 'village' && tavern){
  // --- VILLAGE: Tavern barrels + modular kit + NPCs ---
  const bx = tavern.position.x;
  const by = tavern.position.y;
  const bz = tavern.position.z;

  // Interior barrel cluster (storage corner)
  await placeBarrel(new BABYLON.Vector3(bx - 2.8, by + 0.15, bz - 1.8));
  await placeBarrel(new BABYLON.Vector3(bx - 2.3, by + 0.15, bz - 2.2));
  await placeBarrel(new BABYLON.Vector3(bx - 2.6, by + 1.15, bz - 2.0));
  // Exterior barrel cluster near dock
  await placeBarrel(new BABYLON.Vector3(4, 0.5, 8.5));
  await placeBarrel(new BABYLON.Vector3(4.7, 0.5, 8.8));
  await placeBarrel(new BABYLON.Vector3(3.5, 0.5, 9.2));

  // ===========================================================
  // TAVERN MODULAR KIT UPGRADE
  // Replace inline placeholder boxes with AssetLibrary modules.
  // Inline boxes stay for collision (visibility=0); modules add
  // half-timber detail, proper stair treads, etc.
  // ===========================================================
  setLoad(43, 'Upgrading tavern with modular kit...');

  const _FW = tavern.metadata.floorWidth;      // 8
  const _FD = tavern.metadata.floorDepth;       // 6
  const _WH = tavern.metadata.wallHeight;       // 3.5
  const _WT = tavern.metadata.wallThick;        // 0.3
  const _SFH = tavern.metadata.secondFloorHeight;     // 3.5
  const _SFWH = tavern.metadata.secondFloorWallHeight; // 2.8

  // Hide inline mesh by name (keeps collision, removes visual)
  function hideTavernMesh(name) {
    for (const m of tavern.getChildMeshes(false)) {
      if (m.name === name) { m.visibility = 0; return; }
    }
  }

  // Apply subtle weathering variation to a cloned module
  // Randomly tints plaster/timber slightly per panel to break tiling
  let _wallVariantIdx = 0;
  function weatherPanel(node) {
    const idx = _wallVariantIdx++;
    const seed = Math.sin(idx * 127.1) * 0.5 + 0.5; // pseudo-random 0..1
    node.getChildMeshes(false).forEach(m => {
      if (!m.material) return;
      // Clone material so each panel is unique
      const mat = m.material.clone(m.material.name + '_v' + idx);
      m.material = mat;
      if (mat.name.includes('plaster') || mat.name.includes('wall_plaster')) {
        // Vary plaster: subtle yellow/brown dirt stains
        const tint = 0.88 + seed * 0.12; // brightness 0.88–1.0
        const r = mat.albedoColor.r * tint;
        const g = mat.albedoColor.g * (tint - seed * 0.04); // slightly less green = warmer
        const b = mat.albedoColor.b * (tint - seed * 0.08); // less blue = dirtier
        mat.albedoColor = new BABYLON.Color3(r, g, b);
        mat.roughness = 0.9 + seed * 0.08; // rougher in spots
      } else if (mat.name.includes('timber') || mat.name.includes('wall_timber')) {
        // Vary timber: slight darkening, grain variation
        const darken = 0.85 + seed * 0.15;
        mat.albedoColor = mat.albedoColor.scale(darken);
        mat.roughness = 0.88 + seed * 0.1;
      }
    });
  }

  // --- Ground floor: Left wall → 3 half-timber panels ---
  hideTavernMesh('leftWall');
  for (let i = 0; i < 3; i++) {
    const wm = await window.AssetLibrary.load('wall_module');
    wm.rotation.y = Math.PI / 2;
    wm.position.set(bx - _FW / 2 + _WT / 2, by, bz + (i - 1) * 2);
    weatherPanel(wm);
  }

  // --- Ground floor: Right wall → 3 half-timber panels ---
  hideTavernMesh('rightWall');
  for (let i = 0; i < 3; i++) {
    const wm = await window.AssetLibrary.load('wall_module');
    wm.rotation.y = -Math.PI / 2;
    wm.position.set(bx + _FW / 2 - _WT / 2, by, bz + (i - 1) * 2);
    weatherPanel(wm);
  }

  // --- Second floor: Left wall → 3 panels (scaled to 2.8m) ---
  hideTavernMesh('sfLeftWall');
  for (let i = 0; i < 3; i++) {
    const wm = await window.AssetLibrary.load('wall_module');
    wm.rotation.y = Math.PI / 2;
    wm.scaling.y = _SFWH / 3.5;
    wm.position.set(bx - _FW / 2 + _WT / 2, by + _SFH, bz + (i - 1) * 2);
    weatherPanel(wm);
  }

  // --- Second floor: Right wall → 3 panels ---
  hideTavernMesh('sfRightWall');
  for (let i = 0; i < 3; i++) {
    const wm = await window.AssetLibrary.load('wall_module');
    wm.rotation.y = -Math.PI / 2;
    wm.scaling.y = _SFWH / 3.5;
    wm.position.set(bx + _FW / 2 - _WT / 2, by + _SFH, bz + (i - 1) * 2);
    weatherPanel(wm);
  }

  // --- Second floor: Back wall → 4 panels ---
  hideTavernMesh('sfBackWall');
  for (let i = 0; i < 4; i++) {
    const wm = await window.AssetLibrary.load('wall_module');
    wm.scaling.y = _SFWH / 3.5;
    wm.position.set(bx + (i - 1.5) * 2, by + _SFH, bz - _FD / 2 + _WT / 2);
    weatherPanel(wm);
  }

  // --- Second floor: Front wall → 4 panels ---
  hideTavernMesh('sfFrontWall');
  for (let i = 0; i < 4; i++) {
    const wm = await window.AssetLibrary.load('wall_module');
    wm.rotation.y = Math.PI;
    wm.scaling.y = _SFWH / 3.5;
    wm.position.set(bx + (i - 1.5) * 2, by + _SFH, bz + _FD / 2 - _WT / 2);
    weatherPanel(wm);
  }

  // --- Stairs: Replace 10 inline boxes with stair_step modules ---
  const _stepCount = 10;
  const _stepH = _WH / _stepCount;              // 0.35
  const _stepD = tavern.metadata.stairOpenD / _stepCount; // 0.25
  const _stairX = tavern.metadata.stairX;        // 2.5
  const _sfFloorBackD = (_FD - _WT * 2) / 2 - tavern.metadata.stairOpenD / 2;

  for (let i = 0; i < _stepCount; i++) {
    hideTavernMesh('step' + i);
    const step = await window.AssetLibrary.load('stair_step');
    step.scaling.set(
      (tavern.metadata.stairOpenW - 0.1) / 1.3,   // width: 1.4 / 1.3
      _stepH / 0.35,                                // height: 1.0
      _stepD / 0.3                                   // depth: 0.833
    );
    step.position.set(
      bx + _stairX,
      by + i * _stepH,
      bz - _FD / 2 + _WT + _sfFloorBackD + i * _stepD + _stepD / 2
    );
  }

  // --- Front/back wall timber framing overlay (keeps inline plaster, adds beams) ---
  const timberMat = scene.getMaterialByName('wall_timber') || MAT.woodDark;
  // Front wall: horizontal beams at base, mid, and top
  for (const yOff of [0.05, _WH / 2, _WH - 0.05]) {
    const beam = BABYLON.MeshBuilder.CreateBox('fwBeam', {
      width: _FW + 0.05, height: 0.1, depth: _WT + 0.02
    }, scene);
    beam.material = timberMat;
    beam.position.set(bx, by + yOff, bz + _FD / 2 - _WT / 2);
    shadowGen.addShadowCaster(beam);
  }
  // Front wall: vertical corner posts
  for (const xOff of [-_FW / 2 + 0.05, _FW / 2 - 0.05]) {
    const post = BABYLON.MeshBuilder.CreateBox('fwPost', {
      width: 0.1, height: _WH, depth: _WT + 0.02
    }, scene);
    post.material = timberMat;
    post.position.set(bx + xOff, by + _WH / 2, bz + _FD / 2 - _WT / 2);
    shadowGen.addShadowCaster(post);
  }
  // Back wall: same treatment
  for (const yOff of [0.05, _WH / 2, _WH - 0.05]) {
    const beam = BABYLON.MeshBuilder.CreateBox('bwBeam', {
      width: _FW + 0.05, height: 0.1, depth: _WT + 0.02
    }, scene);
    beam.material = timberMat;
    beam.position.set(bx, by + yOff, bz - _FD / 2 + _WT / 2);
    shadowGen.addShadowCaster(beam);
  }

  debugLog('Modular kit: 20 wall panels + 10 stairs + timber framing loaded.');

  setLoad(48, 'Adding windows...');

  // --- WINDOWS (from AssetLibrary modular kit) ---
  // Left wall windows (2 windows)
  for(const wz of [-0.8, 1.2]){
    const win = await window.AssetLibrary.load('window_frame');
    win.position.set(bx - tavern.metadata.floorWidth/2 + 0.15, by + 1.2, bz + wz);
    win.rotation.y = Math.PI / 2;
  }
  // Right wall window
  const winR = await window.AssetLibrary.load('window_frame');
  winR.position.set(bx + tavern.metadata.floorWidth/2 - 0.15, by + 1.2, bz + 0.2);
  winR.rotation.y = -Math.PI / 2;

  // Front wall window (to the left of the door)
  const winF = await window.AssetLibrary.load('window_frame');
  winF.position.set(bx - 2.0, by + 1.2, bz + tavern.metadata.floorDepth/2 - 0.15);

  // Second floor windows
  const sfBase = by + tavern.metadata.secondFloorHeight;
  const winSF1 = await window.AssetLibrary.load('window_frame');
  winSF1.position.set(bx - 2.0, sfBase + 1.0, bz + tavern.metadata.floorDepth/2 - 0.15);
  const winSF2 = await window.AssetLibrary.load('window_frame');
  winSF2.position.set(bx + 2.0, sfBase + 1.0, bz + tavern.metadata.floorDepth/2 - 0.15);

  setLoad(50, 'Decorating interior...');

  // --- INTERIOR: TABLE ---
  const table = await window.AssetLibrary.load('table_tavern');
  table.position.set(bx - 1.5, by + 0.15, bz + 0.5);

  // --- INTERIOR: BENCH ---
  const bench = await window.AssetLibrary.load('bench_long');
  bench.position.set(bx - 1.5, by + 0.15, bz + 1.1);

  // --- INTERIOR: SHELF ---
  const shelf = await window.AssetLibrary.load('shelf_wall');
  shelf.position.set(bx + 1.5, by + 1.8, bz - 2.6);

  // --- INTERIOR: BOTTLES ON SHELF ---
  for(let i = 0; i < 4; i++){
    const bottle = await window.AssetLibrary.load('bottle');
    bottle.position.set(bx + 0.8 + i * 0.4, by + 2.0, bz - 2.55);
  }

  // --- INTERIOR: CRATE STACK ---
  const crate1 = await window.AssetLibrary.load('crate_small');
  crate1.position.set(bx + 2.8, by + 0.15 + 0.0, bz + 1.5);

  const crate2 = await window.AssetLibrary.load('crate_small');
  crate2.position.set(bx + 2.8 + 0.55, by + 0.15, bz + 1.6);

  const crate3 = await window.AssetLibrary.load('crate_large');
  crate3.position.set(bx + 2.8 + 0.2, by + 0.15 + 0.6, bz + 1.5);
  crate3.rotation.y = 0.4;

  // --- INTERIOR: TABLE LANTERN ---
  const tableLantern = await window.AssetLibrary.load('lantern_table');
  tableLantern.position.set(bx - 1.5, by + 0.15 + 0.82, bz + 0.5);
  // Interior point light near lantern
  const interiorLight = new BABYLON.PointLight('interiorLight',
    new BABYLON.Vector3(bx - 1.5, by + 1.3, bz + 0.5), scene);
  interiorLight.diffuse = new BABYLON.Color3(1, 0.8, 0.5);
  interiorLight.intensity = 0.8;
  interiorLight.range = 8;

  // --- INTERIOR: HANGING LANTERN ---
  const hangLantern = await window.AssetLibrary.load('lantern_hanging');
  hangLantern.position.set(bx, by + 3.2, bz - 0.5);
  const ceilingLight = new BABYLON.PointLight('ceilingLight',
    new BABYLON.Vector3(bx, by + 3.0, bz - 0.5), scene);
  ceilingLight.diffuse = new BABYLON.Color3(1, 0.85, 0.5);
  ceilingLight.intensity = 0.6;
  ceilingLight.range = 10;

  // --- INTERIOR: RUG ---
  const rug = await window.AssetLibrary.load('rug_rectangle');
  rug.position.set(bx - 0.5, by + 0.16, bz);

  setLoad(55, 'Adding exterior props...');

  // --- EXTERIOR: DOCK ---
  const dock = await window.AssetLibrary.load('dock_section');
  dock.position.set(3, 0, 14);

  // --- EXTERIOR: MOORING POST ---
  const mPost = await window.AssetLibrary.load('mooring_post');
  mPost.position.set(3 + 2.2, 0.6, 14 + 1.2);

  // --- EXTERIOR: PALM TREES ---
  const palmPositions = [
    new BABYLON.Vector3(-8, 0.5, 5),
    new BABYLON.Vector3(-6, 0.5, -8),
    new BABYLON.Vector3(9, 0.5, -3),
    new BABYLON.Vector3(7, 0.5, 12),
  ];
  for(const pp of palmPositions){
    const palm = await window.AssetLibrary.load('palm_tree');
    palm.position = pp.clone();
  }

  // --- EXTERIOR: ROCKS ---
  const rockDefs = [
    { pos: new BABYLON.Vector3(-10, 0.3, 0), scale: 1.2 },
    { pos: new BABYLON.Vector3(-9, 0.3, 1.5), scale: 0.7 },
    { pos: new BABYLON.Vector3(11, 0.3, 7), scale: 1.0 },
    { pos: new BABYLON.Vector3(-4, 0.5, -7), scale: 0.9 },
  ];
  for(const rd of rockDefs){
    const rock = await window.AssetLibrary.load('rock_large');
    rock.position = rd.pos.clone();
    rock.scaling.setAll(rd.scale);
  }

  // --- EXTERIOR: HANGING SIGN ---
  const sign = await window.AssetLibrary.load('sign_hanging');
  sign.position.set(
    tavern.position.x + tavern.metadata.doorCenterX + 1.5,
    tavern.position.y,
    tavern.position.z + tavern.metadata.floorDepth/2 + 0.3
  );

  setLoad(58, 'Furnishing back room...');

  // --- BACK ROOM PROPS ---
  const meta = tavern.metadata;
  const brCX = bx + meta.backDoorX;
  const brCZ = bz + meta.backRoomCenterZ;

  // Kitchen table (center of back room)
  const kitchenTable = await window.AssetLibrary.load('table_tavern');
  kitchenTable.position.set(brCX, by + 0.0, brCZ + 0.3);

  // Two chairs at kitchen table
  const chair1 = await window.AssetLibrary.load('chair_simple');
  chair1.position.set(brCX - 0.6, by + 0.0, brCZ + 0.8);
  chair1.rotation.y = Math.PI;

  const chair2 = await window.AssetLibrary.load('chair_simple');
  chair2.position.set(brCX + 0.6, by + 0.0, brCZ + 0.8);
  chair2.rotation.y = Math.PI;

  // Back room barrel cluster (storage)
  await placeBarrel(new BABYLON.Vector3(brCX + meta.backRoomWidth/2 - 0.6, by + 0.0, brCZ - meta.backRoomDepth/2 + 0.5));
  await placeBarrel(new BABYLON.Vector3(brCX + meta.backRoomWidth/2 - 1.1, by + 0.0, brCZ - meta.backRoomDepth/2 + 0.5));

  // Crate in back room corner
  const brCrate = await window.AssetLibrary.load('crate_large');
  brCrate.position.set(brCX - meta.backRoomWidth/2 + 0.7, by + 0.0, brCZ - meta.backRoomDepth/2 + 0.6);

  // Shelf on back room wall
  const brShelf = await window.AssetLibrary.load('shelf_wall');
  brShelf.position.set(brCX, by + 1.6, brCZ - meta.backRoomDepth/2 + 0.4);

  // Mugs on kitchen table
  for(let i = 0; i < 2; i++){
    const mug = await window.AssetLibrary.load('mug');
    mug.position.set(brCX - 0.3 + i * 0.6, by + 0.82, brCZ + 0.3);
  }

  // Back room lantern
  const brLantern = await window.AssetLibrary.load('lantern_table');
  brLantern.position.set(brCX, by + 0.82, brCZ + 0.3);
  const brLight = new BABYLON.PointLight('brLight',
    new BABYLON.Vector3(brCX, by + 1.3, brCZ + 0.3), scene);
  brLight.diffuse = new BABYLON.Color3(1, 0.8, 0.5);
  brLight.intensity = 0.6;
  brLight.range = 6;

  setLoad(60, 'Furnishing upstairs...');

  // --- UPSTAIRS PROPS ---
  const sfY = by + meta.secondFloorHeight + 0.15; // floor surface

  // Bed (simple crate + rug combo for now)
  const bed = await window.AssetLibrary.load('crate_large');
  bed.position.set(bx - 2.5, sfY, bz - 1.5);
  bed.scaling.set(1.2, 0.5, 2.0); // flatten into bed shape

  // Bed blanket (rug on top of bed)
  const blanket = await window.AssetLibrary.load('rug_rectangle');
  blanket.position.set(bx - 2.5, sfY + 0.45, bz - 1.5);
  blanket.scaling.set(0.45, 1, 0.7);

  // Bedside table
  const bedTable = await window.AssetLibrary.load('table_tavern');
  bedTable.position.set(bx - 1.0, sfY, bz - 2.0);
  bedTable.scaling.setAll(0.7); // smaller side table

  // Bedside lantern
  const bedLantern = await window.AssetLibrary.load('lantern_table');
  bedLantern.position.set(bx - 1.0, sfY + 0.55, bz - 2.0);
  const sfLight = new BABYLON.PointLight('sfLight',
    new BABYLON.Vector3(bx - 1.0, sfY + 1.0, bz - 2.0), scene);
  sfLight.diffuse = new BABYLON.Color3(1, 0.75, 0.4);
  sfLight.intensity = 0.5;
  sfLight.range = 6;

  // Upstairs chest
  const upstairsChest = createChest(
    new BABYLON.Vector3(bx + 1.5, sfY, bz - 1.8),
    'upstairsChest'
  );
  registerInteractable(upstairsChest);
  assignChestLoot(upstairsChest, 'rare');

  // Chair at upstairs desk area
  const sfChair = await window.AssetLibrary.load('chair_simple');
  sfChair.position.set(bx - 1.0, sfY, bz + 0.5);
  sfChair.rotation.y = Math.PI * 0.5;

  // Small shelf
  const sfShelf = await window.AssetLibrary.load('shelf_wall');
  sfShelf.position.set(bx, sfY + 1.4, bz - meta.floorDepth/2 + 0.5);
  sfShelf.scaling.setAll(0.8);

  // Bottles on upstairs shelf
  for(let i = 0; i < 3; i++){
    const b = await window.AssetLibrary.load('bottle');
    b.position.set(bx - 0.4 + i * 0.4, sfY + 1.85, bz - meta.floorDepth/2 + 0.5);
  }

  // --- NPCs ---
  setLoad(62, 'Spawning NPCs...');

  const npcDefs = [
    { key: 'npc_merchant', name: 'Merchant',
      pos: new BABYLON.Vector3(bx + 3, by + 0.5, bz + 4),
      dialogue: [
        'Welcome to Skull & Sail Trading Post!',
        'I\'ve got rum, rope, and rare charts...',
        'Gold coins speak louder than words, friend.',
      ],
      patrol: { center: new BABYLON.Vector3(bx + 3, by + 0.5, bz + 4), radius: 2.0 }
    },
    { key: 'npc_guard', name: 'Guard',
      pos: new BABYLON.Vector3(bx - 5, by + 0.5, bz + 2),
      dialogue: [
        'Keep your blade sheathed in town.',
        'The fort commander wants no trouble.',
        'I\'ve seen pirates worse than you.',
      ],
      patrol: { center: new BABYLON.Vector3(bx - 5, by + 0.5, bz + 2), radius: 3.0 }
    },
    { key: 'npc_villager', name: 'Villager',
      pos: new BABYLON.Vector3(bx + 6, by + 0.5, bz - 6),
      dialogue: [
        'Beautiful day on the island, isn\'t it?',
        'The tavern\'s got fresh stew today.',
        'Watch out for the rocks by the shore.',
      ],
      patrol: { center: new BABYLON.Vector3(bx + 6, by + 0.5, bz - 6), radius: 2.5 }
    },
  ];

  for(const def of npcDefs){
    const npc = await window.AssetLibrary.load(def.key);
    npc.position = def.pos.clone();
    npc.name = def.name;
    npc.metadata = {
      interactType: 'npc',
      npcName: def.name,
      dialogue: def.dialogue,
      dialogueIndex: 0,
      promptInspect: 'Talk to ' + def.name,
    };

    // NPC AI state
    npc.metadata.ai = {
      state: 'idle',         // idle, walking, turning
      stateTimer: 0,
      patrolCenter: def.patrol.center.clone(),
      patrolRadius: def.patrol.radius,
      walkSpeed: 0.8,        // m/s
      targetPos: null,
      turnSpeed: 2.0,        // rad/s
      targetAngle: 0,
      idleDuration: 2 + Math.random() * 3,
      walkDuration: 0,
    };

    registerInteractable(npc);
    npcs.push(npc);
  }

  // Village also gets the additional buildings from the original prototype
  setLoad(64, 'Building village structures...');
  const fort = buildFort(new BABYLON.Vector3(-12, 0.5, -10));
  const fortChest = createChest(new BABYLON.Vector3(-12, 0.65, -11.5), 'fortChest');
  assignChestLoot(fortChest, 'rare'); registerInteractable(fortChest);
  await placeBarrel(new BABYLON.Vector3(-14, 0.5, -8.5));
  await placeBarrel(new BABYLON.Vector3(-14.5, 0.5, -9.0));

  const warehouse = buildWarehouse(new BABYLON.Vector3(8, 0.5, 10));
  const whChest = createChest(new BABYLON.Vector3(9, 0.65, 9), 'warehouseChest');
  assignChestLoot(whChest, 'common'); registerInteractable(whChest);
  const whCrate1 = await window.AssetLibrary.load('crate_large');
  whCrate1.position.set(7, 0.5, 11);
  const whCrate2 = await window.AssetLibrary.load('crate_large');
  whCrate2.position.set(7.9, 0.5, 11.2); whCrate2.rotation.y = 0.3;
  const whCrate3 = await window.AssetLibrary.load('crate_small');
  whCrate3.position.set(7.4, 1.3, 11.1);
  await placeBarrel(new BABYLON.Vector3(9.5, 0.5, 11));
  await placeBarrel(new BABYLON.Vector3(10, 0.5, 10.5));

  const temple = buildRuinsTemple(new BABYLON.Vector3(-10, 0.5, 10));
  const templeChest = createChest(new BABYLON.Vector3(-10, 0.65, 8.5), 'templeChest');
  assignChestLoot(templeChest, 'rare'); registerInteractable(templeChest);

  } else if(ISLAND_TYPE === 'fort'){
  // --- FORT ISLAND: Large central fort + armory warehouse ---
  setLoad(55, 'Building fort garrison...');
  const mainFort = buildFort(new BABYLON.Vector3(0, 0.5, -2));
  // Scale up the fort
  mainFort.scaling = new BABYLON.Vector3(1.5, 1.5, 1.5);

  const fortChest = createChest(new BABYLON.Vector3(0, 0.65, -5), 'fortChest');
  assignChestLoot(fortChest, 'rare'); registerInteractable(fortChest);

  // Armory warehouse
  const armory = buildWarehouse(new BABYLON.Vector3(10, 0.5, 5));
  const armoryChest = createChest(new BABYLON.Vector3(11, 0.65, 4), 'armoryChest');
  assignChestLoot(armoryChest, 'rare'); registerInteractable(armoryChest);

  // Barrels + crates around fort
  await placeBarrel(new BABYLON.Vector3(-4, 0.5, 2));
  await placeBarrel(new BABYLON.Vector3(-4.5, 0.5, 2.5));
  await placeBarrel(new BABYLON.Vector3(4, 0.5, 2));
  await placeBarrel(new BABYLON.Vector3(10.5, 0.5, 7));
  await placeBarrel(new BABYLON.Vector3(11, 0.5, 6.5));

  // Watchtower (tall box + platform)
  const tower = BABYLON.MeshBuilder.CreateBox('watchtower', {width:2,height:8,depth:2}, scene);
  tower.material = MAT.stone; tower.position.set(-8, 4, -6);
  tower.checkCollisions = true; shadowGen.addShadowCaster(tower);
  const towerTop = BABYLON.MeshBuilder.CreateBox('towerTop', {width:3,height:0.2,depth:3}, scene);
  towerTop.material = MAT.stoneDark; towerTop.position.set(-8, 8.1, -6);
  shadowGen.addShadowCaster(towerTop);

  } else if(ISLAND_TYPE === 'ruins'){
  // --- RUINS ISLAND: Central temple (large) + scattered columns ---
  setLoad(55, 'Building ancient ruins...');
  const mainTemple = buildRuinsTemple(new BABYLON.Vector3(0, 0.5, -2));
  mainTemple.scaling = new BABYLON.Vector3(1.3, 1.3, 1.3);

  const templeChest = createChest(new BABYLON.Vector3(0, 0.65, -2), 'templeChest');
  assignChestLoot(templeChest, 'rare'); registerInteractable(templeChest);

  // Scattered ruin fragments in the surroundings
  for(let i = 0; i < 6; i++){
    const a = (i/6)*Math.PI*2 + 0.5;
    const r = 8 + Math.random()*4;
    const colH = 1 + Math.random()*3;
    const col = BABYLON.MeshBuilder.CreateCylinder('ruinCol'+i, {
      height:colH, diameterTop:0.25, diameterBottom:0.35, tessellation:8
    }, scene);
    col.material = MAT.stone;
    col.position.set(Math.cos(a)*r, 0.5+colH/2, Math.sin(a)*r);
    col.checkCollisions = true; shadowGen.addShadowCaster(col);
  }

  // Overgrown stone slabs
  for(let i = 0; i < 4; i++){
    const slab = BABYLON.MeshBuilder.CreateBox('slab'+i, {
      width:1.5+Math.random(), height:0.2, depth:1+Math.random()
    }, scene);
    slab.material = MAT.stoneDark;
    slab.position.set(-6+Math.random()*12, 0.6, -6+Math.random()*12);
    slab.rotation.y = Math.random()*Math.PI;
    slab.receiveShadows = true; shadowGen.addShadowCaster(slab);
  }

  await placeBarrel(new BABYLON.Vector3(5, 0.5, 5));
  await placeBarrel(new BABYLON.Vector3(-5, 0.5, 6));

  } else if(ISLAND_TYPE === 'tropical'){
  // --- TROPICAL ISLAND: Beach camp ---
  setLoad(55, 'Building tropical camp...');
  const camp = buildTropicalCamp(new BABYLON.Vector3(0, 0.5, -1));

  const campChest = createChest(new BABYLON.Vector3(-1, 0.65, -3.5), 'campChest');
  assignChestLoot(campChest, 'common'); registerInteractable(campChest);

  // Extra barrels around camp
  await placeBarrel(new BABYLON.Vector3(2, 0.5, -2));
  await placeBarrel(new BABYLON.Vector3(2.5, 0.5, -2.5));
  await placeBarrel(new BABYLON.Vector3(-3, 0.5, 1));

  // Beached rowboat
  const boat = BABYLON.MeshBuilder.CreateBox('rowboat', {width:1.2, height:0.4, depth:3}, scene);
  boat.material = MAT.woodDark; boat.position.set(5, 0.45, 8);
  boat.rotation.y = 0.3; boat.receiveShadows = true; shadowGen.addShadowCaster(boat);

  } else if(ISLAND_TYPE === 'outpost'){
  // --- OUTPOST ISLAND: Main warehouse + trading post ---
  setLoad(55, 'Building outpost...');
  const mainWarehouse = buildWarehouse(new BABYLON.Vector3(0, 0.5, -2));
  mainWarehouse.scaling = new BABYLON.Vector3(1.3, 1.2, 1.3);

  const whChest = createChest(new BABYLON.Vector3(1, 0.65, -3), 'warehouseChest');
  assignChestLoot(whChest, 'common'); registerInteractable(whChest);

  // Secondary storage building
  const storage2 = buildWarehouse(new BABYLON.Vector3(-8, 0.5, 4));
  const s2Chest = createChest(new BABYLON.Vector3(-7, 0.65, 3), 'storage2Chest');
  assignChestLoot(s2Chest, 'common'); registerInteractable(s2Chest);

  // Stacked crates along dock
  const c1 = await window.AssetLibrary.load('crate_large');
  c1.position.set(3, 0.5, 10);
  const c2 = await window.AssetLibrary.load('crate_large');
  c2.position.set(3.8, 0.5, 10.2); c2.rotation.y = 0.4;
  const c3 = await window.AssetLibrary.load('crate_large');
  c3.position.set(3.4, 1.3, 10.1);
  const c4 = await window.AssetLibrary.load('crate_small');
  c4.position.set(2.5, 0.5, 10.5);

  await placeBarrel(new BABYLON.Vector3(5, 0.5, 9));
  await placeBarrel(new BABYLON.Vector3(5.5, 0.5, 9.5));
  await placeBarrel(new BABYLON.Vector3(-9, 0.5, 5));
  await placeBarrel(new BABYLON.Vector3(-8.5, 0.5, 5.5));

  // Trading post sign
  const signPost = BABYLON.MeshBuilder.CreateCylinder('signPost', {height:2.5,diameter:0.1,tessellation:6}, scene);
  signPost.material = MAT.wood; signPost.position.set(2, 1.25, 7);
  signPost.checkCollisions = true; shadowGen.addShadowCaster(signPost);
  const signBoard = BABYLON.MeshBuilder.CreateBox('signBoard', {width:1.2,height:0.5,depth:0.05}, scene);
  signBoard.material = MAT.woodDark; signBoard.position.set(2, 2.3, 7);
  shadowGen.addShadowCaster(signBoard);

  } else if(ISLAND_TYPE === 'wild'){
  // --- WILD ISLAND: Wilderness cave ---
  setLoad(55, 'Building wilderness...');
  const wilds = buildWilderness(new BABYLON.Vector3(0, 0.5, -1));

  const wildChest = createChest(new BABYLON.Vector3(0, 0.65, -3), 'wildChest');
  assignChestLoot(wildChest, 'rare'); registerInteractable(wildChest);

  // Scattered supply cache
  await placeBarrel(new BABYLON.Vector3(3, 0.5, 3));
  await placeBarrel(new BABYLON.Vector3(-4, 0.5, 2));

  }

  // ============================================================
  // COMMON: Dock boarding point (all island types)
  // ============================================================
  const boardingMarker = BABYLON.MeshBuilder.CreateCylinder('boardingPoint', {
    height: 0.06, diameter: 1.5, tessellation: 16
  }, scene);
  boardingMarker.material = makeMat('boardingMat', '#4488cc', 0.5, 0);
  boardingMarker.material.alpha = 0.5;
  boardingMarker.material.emissiveColor = BABYLON.Color3.FromHexString('#2266aa');
  boardingMarker.position.set(3, 0.72, 16); // at end of dock
  boardingMarker.metadata = {
    interactType: 'boarding',
    promptInspect: 'Board Ship — Return to Open World'
  };
  registerInteractable(boardingMarker);

  setLoad(65, 'Props loaded.');
  debugLog('AssetLibrary: ' + ISLAND_TYPE + ' island loaded (' + window.AssetLibrary.keys().length + ' catalog entries).');
}

// ============================================================
// 7b. INVENTORY SYSTEM
// ============================================================

// Loot tables per chest type
const LOOT_TABLES = {
  common: [
    { name: 'Gold Coins', icon: 'G', qtyMin: 5, qtyMax: 25 },
    { name: 'Rum Bottle', icon: 'R', qtyMin: 1, qtyMax: 3 },
    { name: 'Rope', icon: '~', qtyMin: 1, qtyMax: 2 },
    { name: 'Hardtack', icon: 'H', qtyMin: 2, qtyMax: 6 },
  ],
  rare: [
    { name: 'Gold Coins', icon: 'G', qtyMin: 20, qtyMax: 80 },
    { name: 'Ruby', icon: '*', qtyMin: 1, qtyMax: 2 },
    { name: 'Silver Dagger', icon: '/', qtyMin: 1, qtyMax: 1 },
    { name: 'Treasure Map', icon: 'M', qtyMin: 1, qtyMax: 1 },
  ],
  kitchen: [
    { name: 'Gold Coins', icon: 'G', qtyMin: 2, qtyMax: 10 },
    { name: 'Rum Bottle', icon: 'R', qtyMin: 1, qtyMax: 4 },
    { name: 'Salted Fish', icon: 'F', qtyMin: 1, qtyMax: 3 },
    { name: 'Spices', icon: 'S', qtyMin: 1, qtyMax: 2 },
  ],
};

// Player inventory
const inventory = [];

function addToInventory(name, qty, icon){
  const existing = inventory.find(i => i.name === name);
  if(existing){
    existing.qty += qty;
  } else {
    inventory.push({ name, qty, icon: icon || name[0] });
  }
}

function rollLoot(tableKey){
  const table = LOOT_TABLES[tableKey] || LOOT_TABLES.common;
  const items = [];
  // Pick 2-3 random items from the table
  const count = 2 + Math.floor(Math.random() * 2);
  const shuffled = [...table].sort(() => Math.random() - 0.5);
  for(let i = 0; i < Math.min(count, shuffled.length); i++){
    const entry = shuffled[i];
    const qty = entry.qtyMin + Math.floor(Math.random() * (entry.qtyMax - entry.qtyMin + 1));
    items.push({ name: entry.name, qty, icon: entry.icon });
  }
  return items;
}

// Assign loot tables to chests
function assignChestLoot(chestNode, tableKey){
  if(!chestNode.metadata) return;
  chestNode.metadata.lootTable = tableKey;
  chestNode.metadata.loot = null; // rolled on first open
}

// Inventory UI
const invPanel = document.getElementById('inventory-panel');
const invList = document.getElementById('inv-list');
const lootPopup = document.getElementById('loot-popup');
let inventoryOpen = false;
let lootPopupTimer = 0;

function toggleInventory(){
  inventoryOpen = !inventoryOpen;
  if(inventoryOpen){
    renderInventory();
    invPanel.classList.add('visible');
  } else {
    invPanel.classList.remove('visible');
  }
}

function renderInventory(){
  if(inventory.length === 0){
    invList.innerHTML = '<div class="inv-empty">Your pockets are empty.</div>';
    return;
  }
  invList.innerHTML = inventory.map(item =>
    `<div class="inv-item">
      <span class="inv-icon">${item.icon}</span>
      <span class="inv-name">${item.name}</span>
      <span class="inv-qty">x${item.qty}</span>
    </div>`
  ).join('');
}

function showLootPopup(items){
  const text = items.map(i => `+${i.qty} ${i.name}`).join('  ');
  lootPopup.textContent = text;
  lootPopup.classList.add('visible');
  lootPopupTimer = 3.0; // seconds
}

function updateLootPopup(dt){
  if(lootPopupTimer > 0){
    lootPopupTimer -= dt;
    if(lootPopupTimer <= 0){
      lootPopup.classList.remove('visible');
    }
  }
}

// ============================================================
// 8. PLAYER CONTROLLER — First Person
// ============================================================
setLoad(70, 'Setting up player...');

const camera = new BABYLON.UniversalCamera('playerCam',
  new BABYLON.Vector3(0, 2.2, 12), scene
);
camera.setTarget(new BABYLON.Vector3(0, 1.7, 0));
camera.minZ = 0.1;
camera.maxZ = 200;
camera.fov = 1.1;
camera.speed = 0;
camera.angularSensibility = 3000;

camera.attachControl(canvas, true);
camera.inputs.removeByType('FreeCameraKeyboardMoveInput');

camera.ellipsoid = new BABYLON.Vector3(0.4, 0.9, 0.4);
camera.ellipsoidOffset = new BABYLON.Vector3(0, 0.9, 0);
camera.checkCollisions = true;
camera.applyGravity = true;

canvas.addEventListener('click', () => {
  if(!engine.isPointerLock) canvas.requestPointerLock();
});

const player = {
  speed: 4.5,
  sprintSpeed: 7.0,
  isSprinting: false,
  height: 1.75,
  interactRange: 3.5,
  keys: {}
};

window.addEventListener('keydown', e => {
  player.keys[e.code] = true;
  if(e.code === 'KeyE') handleInteract();
  if(e.code === 'ShiftLeft') player.isSprinting = true;
  if(e.code === 'Tab'){ e.preventDefault(); toggleInventory(); }
});
window.addEventListener('keyup', e => {
  player.keys[e.code] = false;
  if(e.code === 'ShiftLeft') player.isSprinting = false;
});

function updatePlayerMovement(dt){
  const speed = (player.isSprinting ? player.sprintSpeed : player.speed) * dt;
  const forward = camera.getDirection(BABYLON.Vector3.Forward());
  forward.y = 0; forward.normalize();
  const right = camera.getDirection(BABYLON.Vector3.Right());
  right.y = 0; right.normalize();

  let move = BABYLON.Vector3.Zero();
  if(player.keys['KeyW']) move.addInPlace(forward.scale(speed));
  if(player.keys['KeyS']) move.addInPlace(forward.scale(-speed));
  if(player.keys['KeyA']) move.addInPlace(right.scale(-speed));
  if(player.keys['KeyD']) move.addInPlace(right.scale(speed));

  if(move.length() > speed) move = move.normalize().scale(speed);
  camera.position.addInPlace(move);
}

// ============================================================
// 9. INTERACTION SYSTEM — Data-driven proximity + facing
// ============================================================
setLoad(75, 'Setting up interactions...');

const promptEl = document.getElementById('interact-prompt');
let currentInteractable = null;

function getInteractableCenter(node){
  if(node.getBoundingInfo && node.getBoundingInfo().isLocked === false){
    try {
      const bi = node.getBoundingInfo();
      if(bi.boundingBox.extendSizeWorld.length() > 0.01)
        return bi.boundingBox.centerWorld;
    } catch(e){}
  }
  const pos = node.getAbsolutePosition();
  return new BABYLON.Vector3(pos.x, pos.y + 0.4, pos.z);
}

function findNearestInteractable(){
  const camPos = camera.position;
  const camFwd = camera.getDirection(BABYLON.Vector3.Forward()).normalize();
  let best = null;
  let bestScore = Infinity;

  for(const node of interactables){
    const center = getInteractableCenter(node);
    const toObj = center.subtract(camPos);
    const dist = toObj.length();

    if(dist > player.interactRange) continue;

    const dir = toObj.normalize();
    const dot = BABYLON.Vector3.Dot(dir, camFwd);
    if(dot < 0.1) continue;

    const score = dist * (2 - dot);
    if(score < bestScore){
      bestScore = score;
      best = node;
    }
  }

  return best;
}

function updateInteractionPrompt(){
  const target = findNearestInteractable();
  currentInteractable = target;

  if(!target || !target.metadata){
    promptEl.classList.remove('visible');
    return;
  }

  const meta = target.metadata;
  let text = '';

  switch(meta.interactType){
    case 'door':
      text = meta.isOpen ? meta.promptClose : meta.promptOpen;
      break;
    case 'chest':
      if(!meta.isOpen) text = meta.promptOpen;
      else if(!meta.lootCollected && meta.loot) text = 'Collect Loot';
      else text = 'Empty Chest';
      break;
    case 'barrel':
      text = meta.searched ? 'Empty Barrel' : meta.promptInspect;
      break;
    case 'npc_marker':
      text = meta.promptInspect;
      break;
    case 'npc':
      text = meta.promptInspect;
      break;
    case 'boarding':
      text = meta.promptInspect;
      break;
    default:
      text = 'Interact';
  }

  promptEl.innerHTML = `<span class="key">E</span> ${text}`;
  promptEl.classList.add('visible');
}

function handleInteract(){
  if(!currentInteractable) return;
  const meta = currentInteractable.metadata;
  if(!meta) return;

  switch(meta.interactType){
    case 'door':
      toggleDoor(currentInteractable);
      debugLog('Door ' + (meta.isOpen ? 'closing' : 'opening'));
      break;
    case 'chest':
      if(!meta.isOpen){
        toggleChest(currentInteractable);
        // Roll loot on first open
        const tableKey = meta.lootTable || 'common';
        meta.loot = rollLoot(tableKey);
        meta.lootCollected = false;
        debugLog('Chest opened! Press E again to collect loot.');
      } else if(!meta.lootCollected && meta.loot){
        // Collect loot
        for(const item of meta.loot){
          addToInventory(item.name, item.qty, item.icon);
        }
        showLootPopup(meta.loot);
        debugLog('Collected: ' + meta.loot.map(i => `${i.qty}x ${i.name}`).join(', '));
        meta.lootCollected = true;
        if(inventoryOpen) renderInventory();
      } else {
        debugLog('This chest is empty.');
      }
      break;
    case 'barrel':
      if(!meta.searched){
        meta.searched = true;
        debugLog('You search the barrel... found some rum!');
      } else {
        debugLog('This barrel is empty.');
      }
      break;
    case 'npc_marker':
      debugLog('NPC spawn point — a merchant would stand here.');
      break;
    case 'npc': {
      const line = meta.dialogue[meta.dialogueIndex % meta.dialogue.length];
      meta.dialogueIndex++;
      debugLog(`${meta.npcName}: "${line}"`);
      // NPC faces the player when spoken to
      const npcNode = currentInteractable;
      const toPlayer = camera.position.subtract(npcNode.position);
      toPlayer.y = 0;
      if(npcNode.metadata.ai){
        npcNode.metadata.ai.state = 'idle';
        npcNode.metadata.ai.stateTimer = 4;
      }
      npcNode.rotation.y = Math.atan2(toPlayer.x, toPlayer.z);
      break;
    }
    case 'boarding':
      startWorldTransition();
      break;
  }
}

// ============================================================
// 10. HUD + DEBUG
// ============================================================
setLoad(85, 'Setting up HUD...');

const hudEl = document.getElementById('hud');
const debugEl = document.getElementById('debug');
let debugMessages = [];
let showDebug = true;

function debugLog(msg){
  debugMessages.unshift(msg);
  if(debugMessages.length > 8) debugMessages.pop();
}

function updateHUD(){
  const pos = camera.position;
  const loc = getLocationName(pos);

  hudEl.innerHTML =
    `<div style="font-size:16px;margin-bottom:4px;color:#c8a44e">SKULL & SAIL</div>` +
    `<div>Location: ${loc}</div>` +
    `<div style="margin-top:8px;font-size:11px;opacity:0.5">WASD — Move | MOUSE — Look | E — Interact | SHIFT — Sprint | TAB — Inventory | F3 — Debug</div>`;
}

function isInsideBuilding(pos){
  if(!tavern || !tavern.metadata) return false;
  const bx = tavern.position.x;
  const by = tavern.position.y;
  const bz = tavern.position.z;
  const meta = tavern.metadata;

  const inMain = Math.abs(pos.x - bx) < meta.floorWidth/2 - 0.5 &&
                 Math.abs(pos.z - bz) < meta.floorDepth/2 - 0.5 &&
                 pos.y > by && pos.y < by + meta.wallHeight + 0.5;

  const brCZ = bz + meta.backRoomCenterZ;
  const inBack = Math.abs(pos.x - (bx + meta.backDoorX)) < meta.backRoomWidth/2 - 0.3 &&
                 Math.abs(pos.z - brCZ) < meta.backRoomDepth/2 - 0.3 &&
                 pos.y > by && pos.y < by + meta.wallHeight + 0.5;

  const sfY = by + meta.secondFloorHeight;
  const inUpstairs = Math.abs(pos.x - bx) < meta.floorWidth/2 - 0.5 &&
                     Math.abs(pos.z - bz) < meta.floorDepth/2 - 0.5 &&
                     pos.y > sfY && pos.y < sfY + meta.secondFloorWallHeight + 0.5;

  return inMain || inBack || inUpstairs;
}

function getLocationName(pos){
  // Type-specific location names
  const typeLabels = {
    village: 'Village',
    tropical: 'Beach Camp',
    fort: 'Fort Garrison',
    ruins: 'Ancient Ruins',
    outpost: 'Trading Outpost',
    wild: 'Wilderness'
  };

  if(tavern && tavern.metadata){
    const bx = tavern.position.x;
    const by = tavern.position.y;
    const bz = tavern.position.z;
    const meta = tavern.metadata;

    const sfY = by + meta.secondFloorHeight;
    const inUpstairs = Math.abs(pos.x - bx) < meta.floorWidth/2 - 0.5 &&
                       Math.abs(pos.z - bz) < meta.floorDepth/2 - 0.5 &&
                       pos.y > sfY && pos.y < sfY + meta.secondFloorWallHeight + 0.5;
    if(inUpstairs) return 'Tavern Upstairs';

    const brCZ = bz + meta.backRoomCenterZ;
    const inBack = Math.abs(pos.x - (bx + meta.backDoorX)) < meta.backRoomWidth/2 - 0.3 &&
                   Math.abs(pos.z - brCZ) < meta.backRoomDepth/2 - 0.3 &&
                   pos.y > by && pos.y < by + meta.wallHeight + 0.5;
    if(inBack) return 'Back Room (Kitchen)';

    const inMain = Math.abs(pos.x - bx) < meta.floorWidth/2 - 0.5 &&
                   Math.abs(pos.z - bz) < meta.floorDepth/2 - 0.5 &&
                   pos.y > by && pos.y < by + meta.wallHeight + 0.5;
    if(inMain) return 'Tavern Interior';
  }

  return (typeLabels[ISLAND_TYPE] || 'Island') + ' — ' + ISLAND_NAME;
}

function updateDebug(){
  if(!showDebug){ debugEl.textContent = ''; return; }
  const pos = camera.position;
  const dir = camera.getDirection(BABYLON.Vector3.Forward());
  const loc = getLocationName(pos);

  let txt = `[DEBUG]\n`;
  txt += `pos: ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}\n`;
  txt += `dir: ${dir.x.toFixed(2)}, ${dir.y.toFixed(2)}, ${dir.z.toFixed(2)}\n`;
  txt += `location: ${loc}\n`;
  txt += `island: ${ISLAND_TYPE} (${ISLAND_NAME})\n`;
  txt += `door: ${door ? (door.metadata.isOpen ? 'OPEN' : 'CLOSED') : 'N/A'}\n`;
  txt += `interactTarget: ${currentInteractable ? currentInteractable.name : 'none'}\n`;
  txt += `interactables: ${interactables.length}\n`;
  txt += `meshes: ${scene.meshes.length}\n`;
  txt += `fps: ${engine.getFps().toFixed(0)}\n`;

  // Asset source stats + convention compliance
  if(window.AssetLibrary && window.AssetLibrary.getSources){
    const src = window.AssetLibrary.getSources();
    const keys = Object.keys(src);
    const glb = keys.filter(k => src[k] === 'GLB').length;
    const fb = keys.filter(k => src[k] === 'FALLBACK').length;
    txt += `\n--- ASSETS ---\n`;
    txt += `library: ${glb} GLB / ${fb} fallback / ${keys.length} total\n`;
    if(glb === 0) txt += `⚠ NO GLBs — assets/ dir empty, all procedural\n`;
    txt += `inline: walls, roof, door, chest, fort, warehouse, temple\n`;
    txt += `modular: L/R walls, 2F walls, stairs\n`;

    // Convention audit
    if(window.AssetLibrary.auditConventions){
      const audit = window.AssetLibrary.auditConventions();
      txt += `\n--- CONVENTIONS ---\n`;
      txt += `convention-tagged GLBs: ${audit.conventionTagged}/${audit.glb}\n`;
      txt += `suffixes: _COL _VIS _INT _PIV _NAV\n`;
    }

    // Role breakdown
    if(window.AssetLibrary.getCatalogByRole){
      const roles = window.AssetLibrary.getCatalogByRole();
      txt += `roles: `;
      for(const [role, items] of Object.entries(roles)){
        txt += `${role}(${items.length}) `;
      }
      txt += `\n`;
    }

    // Current interact target convention info
    if(currentInteractable && window.AssetLibrary.getConvention){
      const conv = window.AssetLibrary.getConvention(currentInteractable);
      if(conv){
        txt += `\n--- TARGET CONVENTION ---\n`;
        const r = conv.report;
        txt += `COL:${r.col} VIS:${r.vis} INT:${r.int} PIV:${r.piv} default:${r.default}\n`;
        if(conv.pivotPoint) txt += `pivot: ${conv.pivotPoint.x.toFixed(2)},${conv.pivotPoint.y.toFixed(2)},${conv.pivotPoint.z.toFixed(2)}\n`;
      }
    }
  }

  txt += `\n--- LOG ---\n`;
  txt += debugMessages.join('\n');

  debugEl.textContent = txt;
}

window.addEventListener('keydown', e => {
  if(e.code === 'F3'){ showDebug = !showDebug; e.preventDefault(); }
});

// ============================================================
// 10b. WORLD TRANSITION SYSTEM
// ============================================================
let transitioning = false;

function startWorldTransition(){
  if(transitioning) return;
  transitioning = true;

  debugLog('Boarding ship... returning to the open world.');

  // Detach controls so player can't move
  camera.detachControl(canvas);

  // Create full-screen fade overlay (starts invisible)
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed; inset:0; background:#0a0e14; z-index:200;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    color:#e8d5a3; opacity:0; transition:opacity 1s ease-in;
    font-family:'Segoe UI',system-ui,sans-serif; pointer-events:none;
  `;
  overlay.innerHTML = `
    <div style="font-size:24px;letter-spacing:4px;margin-bottom:16px;font-weight:300">SKULL & SAIL</div>
    <div style="font-size:14px;opacity:0.6;margin-bottom:20px">Leaving ${ISLAND_NAME}...</div>
    <div style="width:200px;height:3px;background:rgba(255,255,255,0.1);border-radius:2px">
      <div id="trans-bar" style="height:100%;width:0;background:#c8a44e;border-radius:2px;transition:width 0.3s"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Phase 1: Camera pull-back + FOV widen (first-person → cinematic wide)
  const startFOV = camera.fov;
  const startPosY = camera.position.y;
  const startFogDensity = scene.fogDensity;
  const zoomStart = performance.now();
  const zoomDuration = 1200;

  function animateZoomOut(){
    const elapsed = performance.now() - zoomStart;
    const t = Math.min(1, elapsed / zoomDuration);
    const s = t * t * (3 - 2 * t); // smoothstep

    // Widen FOV from first-person (~63°) toward cinematic (~80°)
    camera.fov = startFOV * (1 - s) + 1.4 * s; // 1.4 rad ≈ 80°
    // Pull camera up slightly for bird's-eye exit feel
    camera.position.y = startPosY + s * 3.0;
    // Pitch camera slightly downward
    camera.rotation.x = s * 0.25;
    // Lighten fog for open-world feel
    scene.fogDensity = startFogDensity * (1 - s * 0.6);

    if(t < 1){
      requestAnimationFrame(animateZoomOut);
    } else {
      // Phase 2: Fade overlay to black
      overlay.style.opacity = '1';

      // Phase 3: Progress bar + redirect
      setTimeout(() => {
        let progress = 0;
        const bar = overlay.querySelector('#trans-bar');
        const interval = setInterval(() => {
          progress += 10 + Math.random() * 15;
          if(progress >= 100){
            progress = 100;
            clearInterval(interval);
            bar.style.width = '100%';
            setTimeout(() => {
              let target;
              if(window.location.protocol === 'file:'){
                const here = window.location.pathname;
                const dir = here.substring(0, here.lastIndexOf('/'));
                const parent = dir.substring(0, dir.lastIndexOf('/'));
                target = 'file://' + parent + '/pirate3d/index.html';
              } else {
                target = window.location.protocol + '//' + window.location.hostname + ':8000';
              }
              window.location.replace(target);
            }, 500);
          } else {
            bar.style.width = progress + '%';
          }
        }, 150);
      }, 800); // wait for fade to complete
    }
  }
  requestAnimationFrame(animateZoomOut);
}

// ============================================================
// 11. RENDER LOOP + ASYNC INIT
// ============================================================
setLoad(90, 'Starting engine...');

let lastTime = performance.now();

scene.registerBeforeRender(() => {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  updatePlayerMovement(dt);
  updateNPCs(dt);
  updateLootPopup(dt);
  updateInteractionPrompt();
  updateHUD();
  updateDebug();
});

engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => engine.resize());

// Kick off async prop loading — scene renders immediately with tavern/door/chests,
// AssetLibrary props stream in as they load
if(window.AssetLibrary){
  buildAssetProps().then(() => {
    setLoad(100, 'Welcome to ' + ISLAND_NAME + ' — click to explore');
    debugLog(ISLAND_NAME + ' (' + ISLAND_TYPE + ') loaded. Explore and press E to interact.');
    debugLog('Scale: 1 unit = 1 meter. Player eye height = 1.75m.');
  }).catch(err => {
    console.error('[AssetLibrary] Error loading props:', err);
    setLoad(100, 'Loaded with errors — check console');
  });
} else {
  console.warn('AssetLibrary not found — running without models.js');
  setLoad(100, 'Ready (no AssetLibrary)');
  debugLog('Vertical slice loaded (no AssetLibrary). models.js not found.');
}

})(); // end IIFE
