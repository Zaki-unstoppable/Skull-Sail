/**
 * Procedural Grass System — 80k instanced blades with GLSL shaders
 * Three.js r138+ InstancedMesh with custom ShaderMaterial
 * Features: wind animation, distance fade, terrain-following, color variation
 */
(function(){
'use strict';

const BLADE_COUNT = 80000;
const SPREAD_RADIUS = 50;  // grass coverage radius per island
const BLADE_WIDTH = 0.15;
const BLADE_HEIGHT_MIN = 0.8;
const BLADE_HEIGHT_MAX = 2.2;

// Grass blade geometry — tapered triangle strip (3 segments)
function createBladeGeometry(){
  const geo = new THREE.BufferGeometry();
  // 4 vertices forming a tapered blade: wide at base, pointed at tip
  //   0,1 = base (left/right), 2,3 = mid, 4 = tip
  const verts = new Float32Array([
    -BLADE_WIDTH/2, 0, 0,          // 0: base left
     BLADE_WIDTH/2, 0, 0,          // 1: base right
    -BLADE_WIDTH/4, 0.5, 0,        // 2: mid left (narrower)
     BLADE_WIDTH/4, 0.5, 0,        // 3: mid right
     0, 1.0, 0                      // 4: tip
  ]);
  // UV: y = 0 at base, 1 at tip (used for wind bend strength)
  const uvs = new Float32Array([
    0, 0,   1, 0,
    0.25, 0.5,  0.75, 0.5,
    0.5, 1.0
  ]);
  const indices = [0,1,2, 1,3,2, 2,3,4];
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// Grass shader material
const grassVertexShader = `
  uniform float uTime;
  uniform float uWindStrength;
  uniform vec2 uWindDir;

  attribute vec3 instanceColor;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFogDist;

  void main(){
    vUv = uv;
    vColor = instanceColor;

    // Get instance transform
    vec4 worldPos = instanceMatrix * vec4(position, 1.0);

    // Wind: bend increases with height (uv.y = 0 at base, 1 at tip)
    float bendFactor = uv.y * uv.y; // quadratic bend — more at tip
    float windPhase = worldPos.x * 0.1 + worldPos.z * 0.07 + uTime * 1.5;
    float windSway = sin(windPhase) * 0.5 + sin(windPhase * 2.3 + 1.5) * 0.25;
    float gustPhase = worldPos.x * 0.03 + worldPos.z * 0.04 + uTime * 0.4;
    float gust = max(0.0, sin(gustPhase)) * 0.5;

    float totalWind = (windSway + gust) * uWindStrength * bendFactor;
    worldPos.x += totalWind * uWindDir.x;
    worldPos.z += totalWind * uWindDir.y;
    // Slight vertical compression when bending
    worldPos.y -= abs(totalWind) * 0.15 * bendFactor;

    vec4 mvPos = viewMatrix * worldPos;
    vFogDist = -mvPos.z;

    gl_Position = projectionMatrix * mvPos;
  }
`;

const grassFragmentShader = `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFogDist;

  uniform vec3 uFogColor;
  uniform float uFogDensity;

  void main(){
    // Darken at base, lighten at tip (subsurface scattering approximation)
    float heightGrad = vUv.y;
    vec3 col = vColor * (0.5 + heightGrad * 0.6);

    // Slight yellow tip for dry grass look
    col = mix(col, col * vec3(1.1, 1.05, 0.85), heightGrad * 0.3);

    // Simple ambient occlusion at base
    col *= 0.6 + heightGrad * 0.4;

    // Fog
    float fogFactor = 1.0 - exp(-uFogDensity * vFogDist);
    col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));

    // Alpha fade at very tip for soft edges
    float alpha = 1.0 - smoothstep(0.85, 1.0, heightGrad) * 0.3;

    gl_FragColor = vec4(col, alpha);
  }
`;

/**
 * Create an 80k-blade instanced grass field around an island
 * @param {THREE.Scene} scene
 * @param {THREE.Vector3} center — island center position
 * @param {number} radius — island grass radius
 * @param {number} groundY — ground surface Y height
 * @returns {{ mesh: THREE.InstancedMesh, update: function(time: number) }}
 */
window.createGrassField = function(scene, center, radius, groundY, bladeCount){
  bladeCount = bladeCount || BLADE_COUNT;
  const bladeGeo = createBladeGeometry();
  const spread = Math.min(radius, SPREAD_RADIUS);

  const grassMat = new THREE.ShaderMaterial({
    vertexShader: grassVertexShader,
    fragmentShader: grassFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uWindStrength: { value: 1.2 },
      uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
      uFogColor: { value: new THREE.Color(0x5a90b8) },
      uFogDensity: { value: 0.00012 }
    },
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: true
  });

  const mesh = new THREE.InstancedMesh(bladeGeo, grassMat, bladeCount);
  mesh.frustumCulled = false;

  // Per-instance color attribute
  const colors = new Float32Array(bladeCount * 3);
  const dummy = new THREE.Object3D();

  for(let i = 0; i < bladeCount; i++){
    // Distribute in a disc with density falloff at edges
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * spread; // sqrt for uniform disc distribution
    const x = center.x + Math.cos(angle) * dist;
    const z = center.z + Math.sin(angle) * dist;

    // Blade height variation
    const bladeH = BLADE_HEIGHT_MIN + Math.random() * (BLADE_HEIGHT_MAX - BLADE_HEIGHT_MIN);
    // Slight random lean
    const lean = (Math.random() - 0.5) * 0.3;

    dummy.position.set(x, groundY, z);
    dummy.rotation.set(lean, Math.random() * Math.PI * 2, 0);
    dummy.scale.set(1, bladeH, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    // Color variation: greens with slight yellow/brown noise
    const hueShift = Math.random() * 0.15;
    const brightness = 0.7 + Math.random() * 0.3;
    colors[i*3]   = (0.15 + hueShift * 0.3) * brightness;  // R
    colors[i*3+1] = (0.45 + Math.random() * 0.2) * brightness;  // G
    colors[i*3+2] = (0.08 + hueShift * 0.1) * brightness;  // B
  }

  bladeGeo.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(colors, 3));
  mesh.instanceMatrix.needsUpdate = true;

  scene.add(mesh);

  return {
    mesh: mesh,
    update: function(time){
      grassMat.uniforms.uTime.value = time;
    },
    setWind: function(strength, dirX, dirZ){
      grassMat.uniforms.uWindStrength.value = strength;
      grassMat.uniforms.uWindDir.value.set(dirX, dirZ).normalize();
    }
  };
};

})();
