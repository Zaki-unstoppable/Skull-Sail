const WORLD=6000,NUM_ISLANDS=16,NUM_ENEMIES=8;

// Seeded PRNG (mulberry32) — deterministic world generation
let _worldSeed = Math.floor(Math.random() * 2147483647);
let _seed = _worldSeed;
function seededRandom(){
  _seed |= 0; _seed = _seed + 0x6D2B79F5 | 0;
  let t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}

// ============ INFINITE WORLD + STREAMING CONFIG ============
// The world wraps seamlessly — no hard walls. Islands tile in a WORLD×WORLD grid.
// Player position is never clamped; instead, all world objects wrap relative to the player.
const HALF_WORLD = WORLD / 2;

/** Wrap a coordinate difference so it's in [-HALF_WORLD, HALF_WORLD] */
function wrapDelta(d){ return d - WORLD * Math.round(d / WORLD); }

/** Wrap world-space x,z so relative to refX,refZ it's the nearest tile copy */
function wrapPos(x, z, refX, refZ){
  return {
    x: refX + wrapDelta(x - refX),
    z: refZ + wrapDelta(z - refZ)
  };
}

// Island streaming tiers (distance from player)
const STREAM_NEAR  = 800;   // full detail, collisions, NPC logic, all props
const STREAM_MID   = 1800;  // reduced detail, simplified props, no heavy logic
const STREAM_FAR   = 3500;  // silhouette only — hide props, skip updates
// Beyond STREAM_FAR: island mesh itself is hidden (wraps to other side anyway)

// Object pool config
const POOL_WAKE_MAX = 40;
const POOL_EXPLOSION_MAX = 15;
const POOL_PROJECTILE_MAX = 30;
let W=window.innerWidth,H=window.innerHeight;
const isMobile=/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)||W<768;
// Mobile controls hidden by default — toggle via Settings

const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setSize(W,H);renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene=new THREE.Scene();
scene.background=new THREE.Color(0x4a8cc0);
scene.fog=new THREE.FogExp2(0x5a90b8,0.00012);

const camera=new THREE.PerspectiveCamera(65,W/H,0.5,4000);
window.addEventListener('resize',()=>{W=window.innerWidth;H=window.innerHeight;renderer.setSize(W,H);camera.aspect=W/H;camera.updateProjectionMatrix();});

// ============ LIGHTING — sun with shadows ============
scene.add(new THREE.AmbientLight(0x8ab4d8,0.5));
const sun=new THREE.DirectionalLight(0xfff0dd,1.4);
sun.position.set(400,600,300);
sun.castShadow=true;
sun.shadow.mapSize.width=2048;sun.shadow.mapSize.height=2048;
sun.shadow.camera.near=100;sun.shadow.camera.far=2000;
sun.shadow.camera.left=-300;sun.shadow.camera.right=300;
sun.shadow.camera.top=300;sun.shadow.camera.bottom=-300;
sun.shadow.bias=-0.001;
scene.add(sun);
scene.add(new THREE.HemisphereLight(0xaaddff,0x553322,0.5));
const rimLight=new THREE.DirectionalLight(0x6699bb,0.35);rimLight.position.set(-200,100,-300);scene.add(rimLight);

// ============ SKY — shader-based layered gradient dome ============
const skyGeo=new THREE.SphereGeometry(3000,48,32);
const skyMat=new THREE.ShaderMaterial({
  side:THREE.BackSide,
  vertexShader:`
    varying vec3 vWorldPos;
    void main(){
      vWorldPos=position;
      gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
    }
  `,
  fragmentShader:`
    varying vec3 vWorldPos;
    void main(){
      vec3 dir=normalize(vWorldPos);
      float y=dir.y; // -1 to +1

      // 5-stop gradient: deep zenith -> bright blue -> pale blue -> warm horizon -> dark below
      vec3 zenith=vec3(0.12,0.28,0.72);      // deep blue
      vec3 highSky=vec3(0.25,0.52,0.88);     // rich blue
      vec3 midSky=vec3(0.45,0.68,0.95);      // bright clear
      vec3 lowSky=vec3(0.65,0.80,0.95);      // pale
      vec3 horizon=vec3(0.82,0.82,0.88);     // warm white-blue haze
      vec3 belowHorizon=vec3(0.15,0.25,0.45);

      vec3 col;
      if(y>0.5) col=mix(highSky,zenith,smoothstep(0.5,1.0,y));
      else if(y>0.2) col=mix(midSky,highSky,smoothstep(0.2,0.5,y));
      else if(y>0.05) col=mix(lowSky,midSky,smoothstep(0.05,0.2,y));
      else if(y>-0.02) col=mix(horizon,lowSky,smoothstep(-0.02,0.05,y));
      else col=mix(belowHorizon,horizon,smoothstep(-0.15,-0.02,y));

      // Sun glow near horizon
      vec3 sunDir=normalize(vec3(0.5,0.1,0.37));
      float sunDot=max(0.0,dot(dir,sunDir));
      col+=vec3(0.35,0.25,0.1)*pow(sunDot,8.0)*0.6;  // warm glow
      col+=vec3(1.0,0.9,0.7)*pow(sunDot,64.0)*0.3;    // bright spot

      // Slight hue variation to avoid banding
      float hue=sin(dir.x*3.0+dir.z*2.0)*0.015;
      col.r+=hue; col.g+=hue*0.5;

      gl_FragColor=vec4(col,1.0);
    }
  `
});
const sky=new THREE.Mesh(skyGeo,skyMat);
scene.add(sky);

// ============ CLOUDS — fluffy, white, volumetric ============
function makeCloud(x,y,z,s){
  const g=new THREE.Group();
  // Use multiple white/off-white shades for depth
  const shades=[0xffffff,0xf5f5ff,0xeeeeff,0xe8e8f8];
  let numPuffs=8+Math.floor(Math.random()*8);
  for(let i=0;i<numPuffs;i++){
    const col=shades[Math.floor(Math.random()*shades.length)];
    const op=0.35+Math.random()*0.3;
    const mat=new THREE.MeshBasicMaterial({color:col,transparent:true,opacity:op});
    const sz=s*(0.4+Math.random()*0.9);
    const m=new THREE.Mesh(new THREE.SphereGeometry(sz,8,6),mat);
    m.position.set((Math.random()-0.5)*s*3.5,Math.random()*s*0.4-s*0.1,(Math.random()-0.5)*s*2.5);
    m.scale.y=0.35+Math.random()*0.15; // flattened puffs
    m.scale.x=0.9+Math.random()*0.3;
    g.add(m);
  }
  // Add bright top highlights
  for(let i=0;i<3;i++){
    const hm=new THREE.Mesh(new THREE.SphereGeometry(s*0.5,6,4),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0.15}));
    hm.position.set((Math.random()-0.5)*s*2,s*0.25,(Math.random()-0.5)*s*1.5);
    hm.scale.y=0.25;g.add(hm);
  }
  g.position.set(x,y,z);scene.add(g);return g;
}
let clouds=[];
for(let i=0;i<45;i++){
  let y=180+Math.random()*350;
  let s=35+Math.random()*70;
  clouds.push(makeCloud((Math.random()-0.5)*WORLD*2.5,y,(Math.random()-0.5)*WORLD*2.5,s));
}

// ============ OCEAN — shader with animated caustics ============
const oceanGeo=new THREE.PlaneGeometry(WORLD*3,WORLD*3,160,160);
const oceanUniforms={uTime:{value:0},uSunDir:{value:new THREE.Vector3(0.5,0.75,0.37).normalize()}};
const oceanMat=new THREE.ShaderMaterial({
  uniforms:oceanUniforms,
  vertexShader:`
    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec2 vAbsCoord;
    varying vec3 vNormal;
    uniform float uTime;
    void main(){
      vUv=uv;
      vec3 pos=position;
      // Get true world-space position via modelMatrix (includes ocean mesh position).
      // This is independent of player movement — waves stay fixed in world space.
      vec4 worldPos4=modelMatrix*vec4(pos,1.0);
      float ax=worldPos4.x;
      float ay=worldPos4.z; // z in world = y in plane local space (rotated -90 on X)
      vAbsCoord=vec2(ax,ay);
      // Waves — slow ocean swell, anchored to world position
      float st=uTime*0.15;
      float w=sin(ax*0.012+st*3.3)*0.9+sin(ay*0.01+st*4.7)*1.1+sin((ax+ay)*0.007+st*2.3)*0.7+sin(ax*0.035+ay*0.025+st*6.7)*0.25;
      pos.z=w;
      // Recompute world pos with displaced z for lighting/fog
      vWorldPos=(modelMatrix*vec4(pos,1.0)).xyz;
      // Approximate normal from wave derivatives
      float dx=cos(ax*0.012+st*3.3)*0.012*0.9+cos((ax+ay)*0.007+st*2.3)*0.007*0.7+cos(ax*0.035+ay*0.025+st*6.7)*0.035*0.25;
      float dy=cos(ay*0.01+st*4.7)*0.01*1.1+cos((ax+ay)*0.007+st*2.3)*0.007*0.7+cos(ax*0.035+ay*0.025+st*6.7)*0.025*0.25;
      vNormal=normalize(vec3(-dx,1.0,-dy));
      gl_Position=projectionMatrix*modelViewMatrix*vec4(pos,1.0);
    }
  `,
  fragmentShader:`
    varying vec2 vUv;
    varying vec3 vWorldPos;
    varying vec2 vAbsCoord;
    varying vec3 vNormal;
    uniform float uTime;
    uniform vec3 uSunDir;

    // Caustic pattern function — slow shimmer so ship speed reads clearly
    float caustic(vec2 p,float t){
      float st=t*0.25; // slow caustic time — gentle shimmer, not racing
      float c=0.0;
      // Layer 1: large slow cells
      vec2 p1=p*0.04+vec2(st*0.3,st*0.2);
      c+=abs(sin(p1.x*1.2)*cos(p1.y*1.3)+sin(p1.y*0.8+p1.x*0.5))*0.5;
      // Layer 2: medium cells
      vec2 p2=p*0.08+vec2(-st*0.5,st*0.4);
      c+=abs(sin(p2.x*1.5+p2.y)*cos(p2.y*1.1-p2.x*0.7))*0.35;
      // Layer 3: fine detail
      vec2 p3=p*0.15+vec2(st*0.7,-st*0.3);
      c+=abs(sin(p3.x*2.0+p3.y*1.5)*cos(p3.y*1.8))*0.2;
      // Bright vein lines
      float v1=abs(sin(p.x*0.06+st*0.8+sin(p.y*0.04+st*0.3)*2.0));
      float v2=abs(sin(p.y*0.05+st*0.6+sin(p.x*0.03+st*0.4)*2.0));
      float veins=pow(max(0.0,1.0-min(v1,v2)*1.8),4.0);
      c+=veins*0.6;
      return clamp(c,0.0,1.0);
    }

    void main(){
      // Base deep blue
      vec3 deepBlue=vec3(0.02,0.22,0.55);
      vec3 midBlue=vec3(0.08,0.42,0.72);
      vec3 brightCyan=vec3(0.3,0.75,0.9);
      vec3 white=vec3(0.85,0.95,1.0);

      // Caustic uses absolute world coords (parallax with movement)
      float c=caustic(vAbsCoord,uTime);

      // Mix colors based on caustic
      vec3 col=mix(deepBlue,midBlue,0.5+vNormal.y*0.5);
      col=mix(col,brightCyan,c*0.6);
      col=mix(col,white,pow(c,3.0)*0.5); // bright peaks are near-white

      // Sun specular — uses actual world pos for correct view direction
      vec3 viewDir=normalize(cameraPosition-vWorldPos);
      vec3 halfDir=normalize(uSunDir+viewDir);
      float spec=pow(max(dot(vNormal,halfDir),0.0),120.0);
      col+=vec3(1.0,0.95,0.8)*spec*0.8;

      // Fresnel — edges more reflective/lighter
      float fresnel=pow(1.0-max(dot(vNormal,viewDir),0.0),3.0);
      col=mix(col,vec3(0.5,0.75,0.9),fresnel*0.4);

      // Depth darkening far from camera — correct distance
      float dist=length(cameraPosition-vWorldPos);
      float fog=1.0-exp(-dist*0.0003);
      col=mix(col,vec3(0.3,0.5,0.7),fog);

      gl_FragColor=vec4(col,0.92);
    }
  `,
  transparent:true,side:THREE.DoubleSide
});
const ocean=new THREE.Mesh(oceanGeo,oceanMat);ocean.rotation.x=-Math.PI/2;ocean.position.y=-0.5;scene.add(ocean);

// Deep ocean floor
const ocean2Geo=new THREE.PlaneGeometry(WORLD*3,WORLD*3,40,40);
const ocean2=new THREE.Mesh(ocean2Geo,new THREE.MeshBasicMaterial({color:0x0a2a4a}));
ocean2.rotation.x=-Math.PI/2;ocean2.position.y=-8;scene.add(ocean2);

function getWaveH(x,z,t){
  var st=t*0.15; // must match vertex shader slow time
  return Math.sin(x*0.012+st*3.3)*0.9+Math.sin(z*0.01+st*4.7)*1.1+Math.sin((x+z)*0.007+st*2.3)*0.7+Math.sin(x*0.035+z*0.025+st*6.7)*0.25;
}
function animOcean(t){
  oceanUniforms.uTime.value=t;
}

// ============ WAKE ============
const wakeParticles=[];
// ============ POOLED WAKE SYSTEM ============
const _wakePool = [];
const _wakeSharedGeo = new THREE.CircleGeometry(3, 6);
const _wakeSharedMat = new THREE.MeshBasicMaterial({color:0xccddee,transparent:true,opacity:0.25,side:THREE.DoubleSide});

function _getWakeMesh(){
  // Reuse from pool or create new
  for(let i = 0; i < _wakePool.length; i++){
    if(!_wakePool[i].userData.active){
      _wakePool[i].userData.active = true;
      _wakePool[i].visible = true;
      return _wakePool[i];
    }
  }
  if(_wakePool.length >= POOL_WAKE_MAX) return null;
  const m = new THREE.Mesh(_wakeSharedGeo, _wakeSharedMat.clone());
  m.rotation.x = -Math.PI/2;
  m.userData = {active:false, life:0, maxLife:0, scale:1};
  _wakePool.push(m);
  scene.add(m);
  return m;
}

function spawnWake(x,z,spread){
  for(let i=0;i<2;i++){
    const m = _getWakeMesh();
    if(!m) return;
    m.position.set(x+(Math.random()-0.5)*spread, 0.4, z+(Math.random()-0.5)*spread);
    m.scale.setScalar(1);
    m.material.opacity = 0.25;
    m.userData.active = true;
    m.userData.life = 2.5;
    m.userData.maxLife = 2.5;
    m.userData.scale = 1;
    wakeParticles.push(m);
  }
}
function updateWake(dt){
  for(let i=wakeParticles.length-1;i>=0;i--){
    let w=wakeParticles[i];
    w.userData.life-=dt;
    w.userData.scale+=dt*1.2;
    w.scale.setScalar(w.userData.scale);
    w.material.opacity=Math.max(0,(w.userData.life/w.userData.maxLife)*0.2);
    if(w.userData.life<=0){
      w.userData.active = false;
      w.visible = false;
      wakeParticles.splice(i,1);
    }
  }
}

// ============ BUILD DETAILED SHIP ============
function buildShip(opts){
  const g=new THREE.Group();
  const {hullCol,hullDark,deckCol,sailCol,scale,withCabin,withSecondMast}=opts;
  const L=6,W=2.2,H=1.6; // hull length, width, height
  const hMat=new THREE.MeshPhongMaterial({color:hullCol,flatShading:false,shininess:25});
  const dkMat=new THREE.MeshPhongMaterial({color:hullDark||0x3a2010});
  const deckC=deckCol||0xA0823A;

  // === SOLID HULL — tapered box with rounded bottom ===
  // Main hull body: a box geometry with vertex manipulation for tapering
  const hGeo=new THREE.BoxGeometry(L,H,W,12,4,6);
  const hp=hGeo.attributes.position;
  for(let i=0;i<hp.count;i++){
    let x=hp.getX(i),y=hp.getY(i),z=hp.getZ(i);
    let t=(x/L)+0.5; // 0=stern, 1=bow
    // Taper bow (front narrows)
    let bowT=t>0.7?1-((t-0.7)/0.3)*0.65:1;
    // Taper stern slightly
    let sternT=t<0.15?(t/0.15)*0.7+0.3:1;
    z*=bowT*sternT;
    // Round the bottom: push bottom verts inward
    let yNorm=(y/(H*0.5)); // -1 at bottom, +1 at top
    if(yNorm<0){
      let squeeze=1-(-yNorm)*0.4; // bottom gets narrower
      z*=squeeze;
      // Also curve the bottom slightly
      if(yNorm<-0.5){
        y+=(yNorm+0.5)*0.3; // push up slightly for roundness
      }
    }
    // Bow rises up
    if(t>0.8){y+=(t-0.8)*1.2;}
    // Stern rises slightly
    if(t<0.15){y+=(0.15-t)*0.6;}
    hp.setX(i,x);hp.setY(i,y);hp.setZ(i,z);
  }
  hGeo.computeVertexNormals();
  const hull=new THREE.Mesh(hGeo,hMat);
  hull.position.y=0.3;g.add(hull);

  // Hull plank lines (dark strips along sides)
  for(let side of[-1,1]){
    for(let sy of[-0.2,0.1,0.35]){
      const seg=16;
      const pts=[];
      for(let s=0;s<=seg;s++){
        let t=s/seg;
        let x=(t-0.5)*L*0.9;
        let bowT=t>0.7?1-((t-0.7)/0.3)*0.65:1;
        let sternT=t<0.15?(t/0.15)*0.7+0.3:1;
        let zOff=W*0.5*bowT*sternT*side;
        let yy=sy+0.3;
        if(t>0.8)yy+=(t-0.8)*1.2;
        if(t<0.15)yy+=(0.15-t)*0.6;
        pts.push(new THREE.Vector3(x,yy,zOff*0.98));
      }
      const lg=new THREE.BufferGeometry().setFromPoints(pts);
      g.add(new THREE.Line(lg,new THREE.LineBasicMaterial({color:hullDark||0x3a2010})));
    }
  }

  // Dark reinforcement bands (vertical stripes on hull)
  for(let bx=-L*0.35;bx<=L*0.35;bx+=L*0.18){
    for(let side of[-1,1]){
      let t=(bx/L)+0.5;
      let bowT=t>0.7?1-((t-0.7)/0.3)*0.65:1;
      let sternT=t<0.15?(t/0.15)*0.7+0.3:1;
      let zOff=W*0.5*bowT*sternT*side;
      const band=new THREE.Mesh(new THREE.BoxGeometry(0.06,H*0.85,0.04),dkMat);
      let yy=0.3;
      if(t>0.8)yy+=(t-0.8)*1.2;
      band.position.set(bx,yy,zOff*0.99);g.add(band);
    }
  }

  // === DECK ===
  const deckGeo=new THREE.BoxGeometry(L*0.82,0.08,W*0.82);
  const deck=new THREE.Mesh(deckGeo,new THREE.MeshPhongMaterial({color:deckC}));
  deck.position.y=1.12;g.add(deck);
  // Deck planks
  const plankMat=new THREE.MeshPhongMaterial({color:0x8a6a1e});
  for(let px=-L*0.38;px<=L*0.38;px+=0.35){
    const plank=new THREE.Mesh(new THREE.BoxGeometry(0.02,0.1,W*0.78),plankMat);
    plank.position.set(px,1.13,0);g.add(plank);
  }
  // Hatch
  const hatch=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.05,0.4),new THREE.MeshPhongMaterial({color:0x5a4020}));
  hatch.position.set(0.3,1.15,0);g.add(hatch);
  const hatchFrame=new THREE.Mesh(new THREE.BoxGeometry(0.55,0.07,0.45),new THREE.MeshPhongMaterial({color:0x4a3015}));
  hatchFrame.position.set(0.3,1.14,0);g.add(hatchFrame);

  // === RAILS ===
  const railMat=new THREE.MeshPhongMaterial({color:0x6a4a2a});
  for(let side of[-1,1]){
    // Rail follows hull taper
    let railPts=[];let railBPts=[];
    for(let s=0;s<=12;s++){
      let t=s/12;
      let x=(t-0.5)*L*0.82;
      let bowT=t>0.7?1-((t-0.7)/0.3)*0.55:1;
      let sternT=t<0.15?(t/0.15)*0.7+0.3:1;
      let z=W*0.42*bowT*sternT*side;
      let y=1.4;if(t>0.85)y+=(t-0.85)*0.8;if(t<0.1)y+=(0.1-t)*0.4;
      railPts.push(new THREE.Vector3(x,y,z));
      railBPts.push(new THREE.Vector3(x,y-0.15,z));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(railPts),new THREE.LineBasicMaterial({color:0x5a3a1a,linewidth:2})));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(railBPts),new THREE.LineBasicMaterial({color:0x5a3a1a})));
    // Posts
    for(let s=0;s<=12;s+=2){
      let t=s/12;let x=(t-0.5)*L*0.82;
      let bowT=t>0.7?1-((t-0.7)/0.3)*0.55:1;
      let sternT=t<0.15?(t/0.15)*0.7+0.3:1;
      let z=W*0.42*bowT*sternT*side;
      let y=1.32;if(t>0.85)y+=(t-0.85)*0.8;if(t<0.1)y+=(0.1-t)*0.4;
      const post=new THREE.Mesh(new THREE.CylinderGeometry(0.02,0.025,0.22,5),railMat);
      post.position.set(x,y,z);g.add(post);
    }
  }

  // === STERN CASTLE ===
  const sternDeck=new THREE.Mesh(new THREE.BoxGeometry(1.8,0.1,W*0.78),new THREE.MeshPhongMaterial({color:deckC}));
  sternDeck.position.set(-L*0.3,1.55,0);g.add(sternDeck);
  const sternWall=new THREE.Mesh(new THREE.BoxGeometry(0.1,0.9,W*0.8),hMat);
  sternWall.position.set(-L*0.42,1.2,0);g.add(sternWall);
  for(let side of[-1,1]){
    const sw=new THREE.Mesh(new THREE.BoxGeometry(1.0,0.55,0.07),hMat);
    sw.position.set(-L*0.28,1.35,side*W*0.38);g.add(sw);
  }
  // Stern windows
  const winMat=new THREE.MeshBasicMaterial({color:0xffdd88});
  for(let zz of[-0.35,0,0.35]){
    const w=new THREE.Mesh(new THREE.CircleGeometry(0.09,8),winMat);
    w.position.set(-L*0.43,1.25,zz);w.rotation.y=Math.PI;g.add(w);
  }
  // Lanterns
  for(let side of[-0.45,0.45]){
    const lan=new THREE.Mesh(new THREE.SphereGeometry(0.06,6,6),new THREE.MeshBasicMaterial({color:0xffcc66}));
    lan.position.set(-L*0.43,1.7,side);g.add(lan);
    const ll=new THREE.PointLight(0xffaa44,0.3,6);ll.position.copy(lan.position);g.add(ll);
  }
  // Stairs
  for(let s=0;s<4;s++){
    const stair=new THREE.Mesh(new THREE.BoxGeometry(W*0.35,0.06,0.2),plankMat);
    stair.position.set(-L*0.18-s*0.08,1.15+s*0.1,0);g.add(stair);
  }

  // === STEERING WHEEL ===
  const wheelMat=new THREE.MeshPhongMaterial({color:0x5a3a20});
  const wPost=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.04,0.45,5),wheelMat);
  wPost.position.set(-L*0.33,1.78,0);g.add(wPost);
  const wRim=new THREE.Mesh(new THREE.TorusGeometry(0.15,0.02,6,16),wheelMat);
  wRim.position.set(-L*0.33,2.02,0);wRim.rotation.y=Math.PI/2;g.add(wRim);
  for(let sp=0;sp<8;sp++){
    let a=(sp/8)*Math.PI*2;
    const spoke=new THREE.Mesh(new THREE.CylinderGeometry(0.012,0.012,0.28,4),wheelMat);
    spoke.position.set(-L*0.33,2.02+Math.sin(a)*0.14,Math.cos(a)*0.14);
    spoke.rotation.x=a;g.add(spoke);
  }

  // === CANNONS — mounted flush against hull ===
  const cGeo=new THREE.CylinderGeometry(0.06,0.07,0.5,6);
  const cMat=new THREE.MeshPhongMaterial({color:0x1a1a1a,specular:0x333333,shininess:50});
  for(let side of[-1,1]){
    for(let ci=-1;ci<=1;ci++){
      let cx=ci*0.9;
      let t=(cx/L)+0.5;
      let bowT=t>0.7?1-((t-0.7)/0.3)*0.65:1;
      let sternT=t<0.15?(t/0.15)*0.7+0.3:1;
      let cz=W*0.5*bowT*sternT*side;
      // Cannon barrel poking through hull
      const c=new THREE.Mesh(cGeo,cMat);
      c.rotation.x=Math.PI/2;
      c.position.set(cx,0.55,cz*0.95);g.add(c);
      // Cannon port opening
      const port=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.18,0.08),new THREE.MeshPhongMaterial({color:0x0a0a0a}));
      port.position.set(cx,0.55,cz*0.92);g.add(port);
    }
  }

  // === MASTS ===
  const mastMat=new THREE.MeshPhongMaterial({color:0x5a3a20});
  const yardMat=mastMat;
  const sailMat=new THREE.MeshPhongMaterial({color:sailCol,side:THREE.DoubleSide,transparent:true,opacity:0.9});
  const mastH=5.5;

  // Main mast
  const mast=new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.1,mastH,8),mastMat);
  mast.position.set(0.3,1.1+mastH/2,0);g.add(mast);
  // Crow's nest
  const nest=new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.3,0.12,8),new THREE.MeshPhongMaterial({color:0x4a2a15}));
  nest.position.set(0.3,1.1+mastH*0.85,0);g.add(nest);
  const nestR=new THREE.Mesh(new THREE.TorusGeometry(0.35,0.02,4,8),new THREE.MeshPhongMaterial({color:0x4a2a15}));
  nestR.position.set(0.3,1.1+mastH*0.85+0.08,0);nestR.rotation.x=Math.PI/2;g.add(nestR);
  // Yards
  const y1=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.035,2.6,5),yardMat);
  y1.rotation.z=Math.PI/2;y1.position.set(0.3,1.1+mastH*0.6,0);g.add(y1);
  const y2=new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.03,2,5),yardMat);
  y2.rotation.z=Math.PI/2;y2.position.set(0.3,1.1+mastH*0.85,0);g.add(y2);
  // Sails
  const s1=new THREE.Mesh(new THREE.PlaneGeometry(2.2,2.6,6,8),sailMat);
  s1.position.set(0.3,1.1+mastH*0.42,0);s1.rotation.y=Math.PI/2;s1.name='sail';g.add(s1);
  const s2=new THREE.Mesh(new THREE.PlaneGeometry(1.6,1.4,5,5),sailMat.clone());
  s2.position.set(0.3,1.1+mastH*0.75,0);s2.rotation.y=Math.PI/2;s2.name='sail2';g.add(s2);

  // Fore mast
  const fH=4;
  const fm=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.08,fH,7),mastMat);
  fm.position.set(L*0.25,1.1+fH/2,0);g.add(fm);
  const fy=new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.03,1.8,5),yardMat);
  fy.rotation.z=Math.PI/2;fy.position.set(L*0.25,1.1+fH*0.7,0);g.add(fy);
  const fs=new THREE.Mesh(new THREE.PlaneGeometry(1.5,1.8,5,6),sailMat.clone());
  fs.position.set(L*0.25,1.1+fH*0.42,0);fs.rotation.y=Math.PI/2;fs.name='sail';g.add(fs);

  // Mizzen mast (if big ship)
  if(withSecondMast){
    const mH=4;
    const mm=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.07,mH,7),mastMat);
    mm.position.set(-L*0.18,1.55+mH/2,0);g.add(mm);
    const my=new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.028,1.6,5),yardMat);
    my.rotation.z=Math.PI/2;my.position.set(-L*0.18,1.55+mH*0.7,0);g.add(my);
    const ms=new THREE.Mesh(new THREE.PlaneGeometry(1.3,1.8,5,6),sailMat.clone());
    ms.position.set(-L*0.18,1.55+mH*0.4,0);ms.rotation.y=Math.PI/2;ms.name='sail2';g.add(ms);
  }

  // Bowsprit
  const bs=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.02,2.5,5),mastMat);
  bs.rotation.z=Math.PI/2-0.25;bs.position.set(L*0.5+0.8,1.3,0);g.add(bs);
  // Jib
  const jibG=new THREE.BufferGeometry();
  jibG.setAttribute('position',new THREE.BufferAttribute(new Float32Array([L*0.5+1.8,1.1,0,L*0.25,1.1+fH*0.75,0,L*0.25,1.2,0]),3));
  jibG.computeVertexNormals();
  g.add(new THREE.Mesh(jibG,new THREE.MeshPhongMaterial({color:sailCol,side:THREE.DoubleSide,transparent:true,opacity:0.8})));

  // Rigging
  const lineMat=new THREE.LineBasicMaterial({color:0x3a3020,transparent:true,opacity:0.5});
  for(let side of[-1,1]){
    for(let r=0;r<3;r++){
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0.3-r*0.3,1.2,side*W*0.38),
        new THREE.Vector3(0.3,1.1+mastH*0.55+r*mastH*0.12,0)
      ]),lineMat));
    }
  }
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-L*0.38,1.6,0),new THREE.Vector3(0.3,1.1+mastH,0)
  ]),lineMat));

  // Flag
  const flag=new THREE.Mesh(new THREE.PlaneGeometry(0.8,0.5,4,3),new THREE.MeshPhongMaterial({color:0x111111,side:THREE.DoubleSide}));
  flag.position.set(0.3,1.1+mastH+0.3,0);flag.name='flag';g.add(flag);

  // Cabin
  if(withCabin){
    const cab=new THREE.Mesh(new THREE.BoxGeometry(1.4,0.65,W*0.65),new THREE.MeshPhongMaterial({color:0x5a3520}));
    cab.position.set(-L*0.3,1.87,0);g.add(cab);
    const roof=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.06,W*0.7),new THREE.MeshPhongMaterial({color:0x3a2010}));
    roof.position.set(-L*0.3,2.21,0);g.add(roof);
  }

  g.scale.setScalar(scale);
  // Enable shadows on all meshes in ship
  g.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true;}});
  return g;
}

function buildUpgradedShip(){
  const g=new THREE.Group();
  const L=8,W=3,H=2;
  const hMat=new THREE.MeshPhongMaterial({color:0x5a3a1a,flatShading:false,shininess:30});
  const dkMat=new THREE.MeshPhongMaterial({color:0x3a2010});
  const goldTrim=new THREE.MeshPhongMaterial({color:0xc8a830,specular:0xffee88,shininess:60});

  // === HULL — larger tapered with gold trim ===
  const hGeo=new THREE.BoxGeometry(L,H,W,14,5,8);
  const hp=hGeo.attributes.position;
  for(let i=0;i<hp.count;i++){
    let x=hp.getX(i),y=hp.getY(i),z=hp.getZ(i);
    let t=(x/L)+0.5;
    let bowT=t>0.65?1-((t-0.65)/0.35)*0.7:1;
    let sternT=t<0.12?(t/0.12)*0.65+0.35:1;
    z*=bowT*sternT;
    let yN=y/(H*0.5);
    if(yN<0){z*=1-(-yN)*0.35;if(yN<-0.5)y+=(yN+0.5)*0.25;}
    if(t>0.8)y+=(t-0.8)*1.8;
    if(t<0.12)y+=(0.12-t)*0.8;
    hp.setX(i,x);hp.setY(i,y);hp.setZ(i,z);
  }
  hGeo.computeVertexNormals();
  const hull=new THREE.Mesh(hGeo,hMat);hull.position.y=0.3;g.add(hull);

  // Plank lines
  for(let side of[-1,1]){
    for(let sy of[-0.3,0,0.2,0.5]){
      const pts=[];
      for(let s=0;s<=18;s++){
        let t=s/18,x=(t-0.5)*L*0.92;
        let bowT=t>0.65?1-((t-0.65)/0.35)*0.7:1;
        let sternT=t<0.12?(t/0.12)*0.65+0.35:1;
        let zOff=W*0.5*bowT*sternT*side;
        let yy=sy+0.3;if(t>0.8)yy+=(t-0.8)*1.8;if(t<0.12)yy+=(0.12-t)*0.8;
        pts.push(new THREE.Vector3(x,yy,zOff*0.98));
      }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:0x2a1508})));
    }
  }

  // Gold trim bands along hull
  for(let sy of[-0.05,0.65]){
    for(let side of[-1,1]){
      const pts=[];
      for(let s=0;s<=18;s++){
        let t=s/18,x=(t-0.5)*L*0.92;
        let bowT=t>0.65?1-((t-0.65)/0.35)*0.7:1;
        let sternT=t<0.12?(t/0.12)*0.65+0.35:1;
        let zOff=W*0.5*bowT*sternT*side;
        let yy=sy+0.3;if(t>0.8)yy+=(t-0.8)*1.8;if(t<0.12)yy+=(0.12-t)*0.8;
        pts.push(new THREE.Vector3(x,yy,zOff*1.01));
      }
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:0xc8a830,linewidth:2})));
    }
  }

  // Reinforcement bands
  for(let bx=-L*0.38;bx<=L*0.38;bx+=L*0.14){
    for(let side of[-1,1]){
      let t=(bx/L)+0.5;
      let bowT=t>0.65?1-((t-0.65)/0.35)*0.7:1;
      let sternT=t<0.12?(t/0.12)*0.65+0.35:1;
      let zOff=W*0.5*bowT*sternT*side;
      const band=new THREE.Mesh(new THREE.BoxGeometry(0.07,H*0.9,0.05),dkMat);
      let yy=0.3;if(t>0.8)yy+=(t-0.8)*1.8;
      band.position.set(bx,yy,zOff*0.99);g.add(band);
    }
  }

  // === DECK ===
  const deckMat=new THREE.MeshPhongMaterial({color:0xA0823A});
  const deck=new THREE.Mesh(new THREE.BoxGeometry(L*0.84,0.09,W*0.84),deckMat);
  deck.position.y=1.35;g.add(deck);
  const plankMat=new THREE.MeshPhongMaterial({color:0x8a6a1e});
  for(let px=-L*0.4;px<=L*0.4;px+=0.3){
    const p=new THREE.Mesh(new THREE.BoxGeometry(0.02,0.11,W*0.8),plankMat);
    p.position.set(px,1.36,0);g.add(p);
  }

  // === RAILS with ornate posts ===
  const railMat=new THREE.MeshPhongMaterial({color:0x5a3a1a});
  for(let side of[-1,1]){
    let rPts=[];
    for(let s=0;s<=14;s++){
      let t=s/14,x=(t-0.5)*L*0.84;
      let bowT=t>0.65?1-((t-0.65)/0.35)*0.6:1;
      let sternT=t<0.12?(t/0.12)*0.65+0.35:1;
      let z=W*0.44*bowT*sternT*side;
      let y=1.7;if(t>0.85)y+=(t-0.85)*1.2;if(t<0.08)y+=(0.08-t)*0.5;
      rPts.push(new THREE.Vector3(x,y,z));
    }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rPts),new THREE.LineBasicMaterial({color:0xc8a830,linewidth:2})));
    for(let s=0;s<=14;s+=2){
      let t=s/14,x=(t-0.5)*L*0.84;
      let bowT=t>0.65?1-((t-0.65)/0.35)*0.6:1;
      let sternT=t<0.12?(t/0.12)*0.65+0.35:1;
      let z=W*0.44*bowT*sternT*side;
      let y=1.52;if(t>0.85)y+=(t-0.85)*1.2;if(t<0.08)y+=(0.08-t)*0.5;
      const post=new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.03,0.3,6),railMat);
      post.position.set(x,y,z);g.add(post);
      // Gold cap on every other post
      if(s%4===0){const cap=new THREE.Mesh(new THREE.SphereGeometry(0.04,6,6),goldTrim);cap.position.set(x,y+0.18,z);g.add(cap);}
    }
  }

  // === STERN CASTLE (larger) ===
  const sternDeck=new THREE.Mesh(new THREE.BoxGeometry(2.4,0.12,W*0.8),deckMat);
  sternDeck.position.set(-L*0.32,1.85,0);g.add(sternDeck);
  const sternWall=new THREE.Mesh(new THREE.BoxGeometry(0.12,1.2,W*0.85),hMat);
  sternWall.position.set(-L*0.44,1.5,0);g.add(sternWall);
  // Gold ornament on stern
  const ornament=new THREE.Mesh(new THREE.TorusGeometry(0.25,0.04,6,12),goldTrim);
  ornament.position.set(-L*0.45,1.7,0);ornament.rotation.y=Math.PI/2;g.add(ornament);
  // Stern windows (larger, lit)
  const winMat=new THREE.MeshBasicMaterial({color:0xffdd88});
  for(let zz of[-0.5,-0.15,0.15,0.5]){
    const w=new THREE.Mesh(new THREE.CircleGeometry(0.12,8),winMat);
    w.position.set(-L*0.45,1.55,zz);w.rotation.y=Math.PI;g.add(w);
  }
  // Lanterns (brighter)
  for(let side of[-0.6,0.6]){
    const lan=new THREE.Mesh(new THREE.SphereGeometry(0.08,6,6),new THREE.MeshBasicMaterial({color:0xffcc66}));
    lan.position.set(-L*0.45,2.1,side);g.add(lan);
    g.add(new THREE.PointLight(0xffaa44,0.5,10));
  }
  for(let side of[-1,1]){
    const sw=new THREE.Mesh(new THREE.BoxGeometry(1.4,0.7,0.08),hMat);
    sw.position.set(-L*0.3,1.6,side*W*0.42);g.add(sw);
  }
  // Stairs
  for(let s=0;s<5;s++){
    const stair=new THREE.Mesh(new THREE.BoxGeometry(W*0.35,0.06,0.22),plankMat);
    stair.position.set(-L*0.18-s*0.08,1.38+s*0.1,0);g.add(stair);
  }

  // === STEERING WHEEL (ornate) ===
  const wheelMat=new THREE.MeshPhongMaterial({color:0x5a3a20});
  const wPost=new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.05,0.55,6),wheelMat);
  wPost.position.set(-L*0.34,2.1,0);g.add(wPost);
  const wRim=new THREE.Mesh(new THREE.TorusGeometry(0.2,0.025,6,16),goldTrim);
  wRim.position.set(-L*0.34,2.38,0);wRim.rotation.y=Math.PI/2;g.add(wRim);
  for(let sp=0;sp<10;sp++){
    let a=(sp/10)*Math.PI*2;
    const spoke=new THREE.Mesh(new THREE.CylinderGeometry(0.015,0.015,0.35,4),wheelMat);
    spoke.position.set(-L*0.34,2.38+Math.sin(a)*0.18,Math.cos(a)*0.18);
    spoke.rotation.x=a;g.add(spoke);
  }

  // === CANNONS — 4 per side (heavier) ===
  const cMat=new THREE.MeshPhongMaterial({color:0x1a1a1a,specular:0x444444,shininess:60});
  for(let side of[-1,1]){
    for(let ci=-2;ci<=1;ci++){
      let cx=ci*0.85+0.2;
      let t=(cx/L)+0.5;
      let bowT=t>0.65?1-((t-0.65)/0.35)*0.7:1;
      let sternT=t<0.12?(t/0.12)*0.65+0.35:1;
      let cz=W*0.5*bowT*sternT*side;
      const c=new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.1,0.65,8),cMat);
      c.rotation.x=Math.PI/2;c.position.set(cx,0.75,cz*0.95);g.add(c);
      // Cannon wheel mount
      const mount=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.06,0.2),new THREE.MeshPhongMaterial({color:0x3a2010}));
      mount.position.set(cx,0.5,cz*0.85);g.add(mount);
      const port=new THREE.Mesh(new THREE.BoxGeometry(0.28,0.22,0.08),new THREE.MeshPhongMaterial({color:0x0a0a0a}));
      port.position.set(cx,0.75,cz*0.92);g.add(port);
    }
  }

  // === MAIN MAST (taller, detailed) ===
  const mastMat=new THREE.MeshPhongMaterial({color:0x5a3a20});
  const sailMat=new THREE.MeshPhongMaterial({color:0x111111,side:THREE.DoubleSide,transparent:true,opacity:0.92});
  const whiteSail=new THREE.MeshPhongMaterial({color:0xe8dcc8,side:THREE.DoubleSide,transparent:true,opacity:0.9});
  const mastH=7.5;
  const mast=new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.13,mastH,8),mastMat);
  mast.position.set(0.3,1.35+mastH/2,0);g.add(mast);
  // Crow's nest (larger)
  const nest=new THREE.Mesh(new THREE.CylinderGeometry(0.45,0.38,0.15,8),new THREE.MeshPhongMaterial({color:0x4a2a15}));
  nest.position.set(0.3,1.35+mastH*0.82,0);g.add(nest);
  const nestR=new THREE.Mesh(new THREE.TorusGeometry(0.45,0.025,4,8),new THREE.MeshPhongMaterial({color:0x4a2a15}));
  nestR.position.set(0.3,1.35+mastH*0.82+0.1,0);nestR.rotation.x=Math.PI/2;g.add(nestR);
  // Yards
  for(let yf of[0.35,0.58,0.82]){
    let w=yf===0.35?3.2:yf===0.58?2.8:2.2;
    const yd=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.04,w,5),mastMat);
    yd.rotation.z=Math.PI/2;yd.position.set(0.3,1.35+mastH*yf,0);g.add(yd);
  }
  // Black sails
  const s1=new THREE.Mesh(new THREE.PlaneGeometry(2.8,2.8,8,10),sailMat);
  s1.position.set(0.3,1.35+mastH*0.2,0);s1.rotation.y=Math.PI/2;s1.name='sail';g.add(s1);
  const s2=new THREE.Mesh(new THREE.PlaneGeometry(2.4,2,6,8),sailMat.clone());
  s2.position.set(0.3,1.35+mastH*0.48,0);s2.rotation.y=Math.PI/2;s2.name='sail';g.add(s2);
  const s3=new THREE.Mesh(new THREE.PlaneGeometry(1.8,1.4,5,6),sailMat.clone());
  s3.position.set(0.3,1.35+mastH*0.72,0);s3.rotation.y=Math.PI/2;s3.name='sail2';g.add(s3);

  // === PIRATE FLAG — large black with skull ===
  const flagG=new THREE.Group();
  // Flag cloth
  const flagMesh=new THREE.Mesh(new THREE.PlaneGeometry(1.4,0.9,6,4),new THREE.MeshPhongMaterial({color:0x111111,side:THREE.DoubleSide}));
  flagMesh.name='flag';flagG.add(flagMesh);
  // Skull on flag (white circle + eyes)
  const skull=new THREE.Mesh(new THREE.CircleGeometry(0.18,8),new THREE.MeshBasicMaterial({color:0xeeeeee,side:THREE.DoubleSide}));
  skull.position.z=0.01;flagG.add(skull);
  const eyeM=new THREE.MeshBasicMaterial({color:0x111111,side:THREE.DoubleSide});
  const le=new THREE.Mesh(new THREE.CircleGeometry(0.04,6),eyeM);le.position.set(-0.07,0.03,0.02);flagG.add(le);
  const re=new THREE.Mesh(new THREE.CircleGeometry(0.04,6),eyeM);re.position.set(0.07,0.03,0.02);flagG.add(re);
  // Crossbones
  for(let cb of[-1,1]){
    const bone=new THREE.Mesh(new THREE.BoxGeometry(0.35,0.04,0.02),new THREE.MeshBasicMaterial({color:0xeeeeee}));
    bone.rotation.z=cb*0.5;bone.position.set(0,-0.12,0.01);flagG.add(bone);
  }
  flagG.position.set(0.3,1.35+mastH+0.5,0);g.add(flagG);

  // === FORE MAST ===
  const fH=5.5;
  const fm=new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.1,fH,7),mastMat);
  fm.position.set(L*0.26,1.35+fH/2,0);g.add(fm);
  const fy1=new THREE.Mesh(new THREE.CylinderGeometry(0.03,0.035,2.4,5),mastMat);
  fy1.rotation.z=Math.PI/2;fy1.position.set(L*0.26,1.35+fH*0.5,0);g.add(fy1);
  const fy2=new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.03,1.8,5),mastMat);
  fy2.rotation.z=Math.PI/2;fy2.position.set(L*0.26,1.35+fH*0.75,0);g.add(fy2);
  const fs1=new THREE.Mesh(new THREE.PlaneGeometry(2,2.2,6,8),sailMat.clone());
  fs1.position.set(L*0.26,1.35+fH*0.3,0);fs1.rotation.y=Math.PI/2;fs1.name='sail';g.add(fs1);
  const fs2=new THREE.Mesh(new THREE.PlaneGeometry(1.5,1.3,5,5),sailMat.clone());
  fs2.position.set(L*0.26,1.35+fH*0.62,0);fs2.rotation.y=Math.PI/2;fs2.name='sail2';g.add(fs2);

  // === MIZZEN MAST ===
  const mH=5;
  const mm=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.09,mH,7),mastMat);
  mm.position.set(-L*0.2,1.85+mH/2,0);g.add(mm);
  const my=new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.03,2,5),mastMat);
  my.rotation.z=Math.PI/2;my.position.set(-L*0.2,1.85+mH*0.65,0);g.add(my);
  const ms=new THREE.Mesh(new THREE.PlaneGeometry(1.6,2.2,5,7),sailMat.clone());
  ms.position.set(-L*0.2,1.85+mH*0.35,0);ms.rotation.y=Math.PI/2;ms.name='sail';g.add(ms);

  // Bowsprit (longer)
  const bs=new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.025,3.5,5),mastMat);
  bs.rotation.z=Math.PI/2-0.22;bs.position.set(L*0.5+1.2,1.6,0);g.add(bs);
  // Jib sail
  const jibG=new THREE.BufferGeometry();
  jibG.setAttribute('position',new THREE.BufferAttribute(new Float32Array([L*0.5+2.5,1.4,0,L*0.26,1.35+fH*0.8,0,L*0.26,1.45,0]),3));
  jibG.computeVertexNormals();
  g.add(new THREE.Mesh(jibG,new THREE.MeshPhongMaterial({color:0x222222,side:THREE.DoubleSide,transparent:true,opacity:0.85})));

  // Figurehead (gold dragon/skull shape)
  const figHead=new THREE.Mesh(new THREE.ConeGeometry(0.15,0.5,6),goldTrim);
  figHead.rotation.z=-Math.PI/2+0.2;figHead.position.set(L*0.5+0.3,1.1,0);g.add(figHead);

  // Rigging
  const lineMat=new THREE.LineBasicMaterial({color:0x3a3020,transparent:true,opacity:0.5});
  for(let side of[-1,1]){
    for(let r=0;r<4;r++){
      g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0.3-r*0.25,1.45,side*W*0.4),
        new THREE.Vector3(0.3,1.35+mastH*0.5+r*mastH*0.1,0)
      ]),lineMat));
    }
  }

  // Cabin (larger, ornate)
  const cab=new THREE.Mesh(new THREE.BoxGeometry(2,0.8,W*0.7),new THREE.MeshPhongMaterial({color:0x4a2a15}));
  cab.position.set(-L*0.32,2.25,0);g.add(cab);
  const roof=new THREE.Mesh(new THREE.BoxGeometry(2.2,0.07,W*0.75),new THREE.MeshPhongMaterial({color:0x2a1508}));
  roof.position.set(-L*0.32,2.67,0);g.add(roof);
  // Gold trim on cabin
  const cabTrim=new THREE.Mesh(new THREE.BoxGeometry(2.05,0.04,W*0.72),goldTrim);
  cabTrim.position.set(-L*0.32,2.64,0);g.add(cabTrim);

  g.scale.setScalar(4.2);
  g.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true;}});
  return g;
}

// ============ CHARACTER ============
function buildCharacter(){
  const g=new THREE.Group();
  const torso=new THREE.Mesh(new THREE.BoxGeometry(0.5,0.7,0.35),new THREE.MeshPhongMaterial({color:0x8B1A1A}));
  torso.position.y=1.1;g.add(torso);
  const head=new THREE.Mesh(new THREE.SphereGeometry(0.2,8,8),new THREE.MeshPhongMaterial({color:0xd4a574}));
  head.position.y=1.65;g.add(head);
  const hat=new THREE.Mesh(new THREE.CylinderGeometry(0.3,0.35,0.15,6),new THREE.MeshPhongMaterial({color:0x1a1a1a}));
  hat.position.y=1.85;g.add(hat);
  const hatTop=new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.2,0.2,6),new THREE.MeshPhongMaterial({color:0x222222}));
  hatTop.position.y=1.95;g.add(hatTop);
  const armMat=new THREE.MeshPhongMaterial({color:0x8B1A1A});
  let la=new THREE.Mesh(new THREE.BoxGeometry(0.18,0.55,0.18),armMat);la.position.set(0.35,1.05,0);g.add(la);
  let ra=new THREE.Mesh(new THREE.BoxGeometry(0.18,0.55,0.18),armMat);ra.position.set(-0.35,1.05,0);g.add(ra);
  const hMat=new THREE.MeshPhongMaterial({color:0xd4a574});
  let lh=new THREE.Mesh(new THREE.SphereGeometry(0.08,6,6),hMat);lh.position.set(0.35,0.73,0);g.add(lh);
  let rh=new THREE.Mesh(new THREE.SphereGeometry(0.08,6,6),hMat);rh.position.set(-0.35,0.73,0);g.add(rh);
  const legMat=new THREE.MeshPhongMaterial({color:0x2a1a0a});
  let ll=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.6,0.22),legMat);ll.position.set(0.12,0.45,0);g.add(ll);
  let rl=new THREE.Mesh(new THREE.BoxGeometry(0.2,0.6,0.22),legMat);rl.position.set(-0.12,0.45,0);g.add(rl);
  const bootMat=new THREE.MeshPhongMaterial({color:0x1a0a00});
  let lb=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.2,0.3),bootMat);lb.position.set(0.12,0.18,0.04);g.add(lb);
  let rb=new THREE.Mesh(new THREE.BoxGeometry(0.22,0.2,0.3),bootMat);rb.position.set(-0.12,0.18,0.04);g.add(rb);
  let belt=new THREE.Mesh(new THREE.BoxGeometry(0.52,0.08,0.36),new THREE.MeshPhongMaterial({color:0x3a2a10}));belt.position.set(0,0.78,0);g.add(belt);
  const sword=new THREE.Mesh(new THREE.BoxGeometry(0.04,0.45,0.04),new THREE.MeshPhongMaterial({color:0x888888,specular:0xffffff,shininess:80}));
  sword.position.set(-0.3,0.65,0.15);sword.rotation.z=0.2;g.add(sword);
  return g;
}

// ============ ISLAND ============
function buildIsland(isl){
  const g=new THREE.Group();
  const pts=isl.shape.map(s=>new THREE.Vector2(s.x,s.y));
  const shape=new THREE.Shape(pts);

  // Layer 1: Underwater rock base — dark stone (largest)
  const baseGeo=new THREE.ExtrudeGeometry(shape,{depth:4,bevelEnabled:true,bevelThickness:3,bevelSize:4,bevelSegments:3});
  const base=new THREE.Mesh(baseGeo,new THREE.MeshPhongMaterial({color:0x4a3a2a,flatShading:true}));
  base.rotation.x=-Math.PI/2;base.position.y=-3;g.add(base);

  // Layer 2: Sandy beach — clearly smaller than base
  const bPts=pts.map(p=>new THREE.Vector2(p.x*0.82,p.y*0.82));
  const beachGeo=new THREE.ExtrudeGeometry(new THREE.Shape(bPts),{depth:3,bevelEnabled:true,bevelThickness:1.5,bevelSize:2,bevelSegments:2});
  const beach=new THREE.Mesh(beachGeo,new THREE.MeshPhongMaterial({color:0xe8cc8a,flatShading:true,polygonOffset:true,polygonOffsetFactor:-1}));
  beach.rotation.x=-Math.PI/2;beach.position.y=0.5;g.add(beach);

  // Layer 3: Dirt/earth layer
  const dPts=pts.map(p=>new THREE.Vector2(p.x*0.62,p.y*0.62));
  const dirtGeo=new THREE.ExtrudeGeometry(new THREE.Shape(dPts),{depth:2.5,bevelEnabled:true,bevelThickness:1,bevelSize:1.5,bevelSegments:2});
  const dirt=new THREE.Mesh(dirtGeo,new THREE.MeshPhongMaterial({color:0x6b4f2a,flatShading:true,polygonOffset:true,polygonOffsetFactor:-2}));
  dirt.rotation.x=-Math.PI/2;dirt.position.y=2.5;g.add(dirt);

  // Layer 4: Grass
  const gPts=pts.map(p=>new THREE.Vector2(p.x*0.45,p.y*0.45));
  const grassGeo=new THREE.ExtrudeGeometry(new THREE.Shape(gPts),{depth:2,bevelEnabled:true,bevelThickness:0.8,bevelSize:1.5,bevelSegments:2});
  const grass=new THREE.Mesh(grassGeo,new THREE.MeshPhongMaterial({color:0x3a8a2a,flatShading:true,polygonOffset:true,polygonOffsetFactor:-3}));
  grass.rotation.x=-Math.PI/2;grass.position.y=4;g.add(grass);

  // Layer 5: Dark green hilltop
  const hPts=pts.map(p=>new THREE.Vector2(p.x*0.25,p.y*0.25));
  const hillGeo=new THREE.ExtrudeGeometry(new THREE.Shape(hPts),{depth:1.5,bevelEnabled:true,bevelThickness:0.6,bevelSize:1,bevelSegments:2});
  const hill=new THREE.Mesh(hillGeo,new THREE.MeshPhongMaterial({color:0x2d6a1f,flatShading:true,polygonOffset:true,polygonOffsetFactor:-4}));
  hill.rotation.x=-Math.PI/2;hill.position.y=5.5;g.add(hill);
  // Store top height for collision
  isl.groundH=7;

  // Grass tufts scattered on green area
  const tuffMat=new THREE.MeshPhongMaterial({color:0x4a9a35,flatShading:true,side:THREE.DoubleSide});
  for(let ti=0;ti<15+Math.floor(Math.random()*10);ti++){
    let a=Math.random()*Math.PI*2,d=Math.random()*isl.r*0.5;
    let tx=Math.cos(a)*d,tz=Math.sin(a)*d;
    const tGeo=new THREE.PlaneGeometry(2+Math.random()*2,3+Math.random()*2,1,1);
    const tuft=new THREE.Mesh(tGeo,tuffMat);
    tuft.position.set(tx,4.5+Math.random(),tz);
    tuft.rotation.y=Math.random()*Math.PI;tuft.rotation.x=-0.1;
    g.add(tuft);
  }

  // Bushes — round green blobs
  const bushMat=new THREE.MeshPhongMaterial({color:0x2a7a22,flatShading:true});
  const bushMat2=new THREE.MeshPhongMaterial({color:0x358a2d,flatShading:true});
  for(let bi=0;bi<6+Math.floor(Math.random()*6);bi++){
    let a=Math.random()*Math.PI*2,d=Math.random()*isl.r*0.55;
    let bx=Math.cos(a)*d,bz=Math.sin(a)*d;
    const bush=new THREE.Mesh(new THREE.SphereGeometry(1.5+Math.random()*2,6,5),Math.random()>0.5?bushMat:bushMat2);
    bush.position.set(bx,4+Math.random(),bz);
    bush.scale.y=0.5+Math.random()*0.3;
    g.add(bush);
  }

  // ---- PALM TREES — tall and detailed ----
  for(let tr of isl.palmTrees){
    const trunkH=tr.h*0.7; // taller trunks
    // Curved trunk using multiple segments
    const trunkMat=new THREE.MeshPhongMaterial({color:0x6b4f2a});
    const trunkDark=new THREE.MeshPhongMaterial({color:0x5a3f1a});
    for(let seg=0;seg<5;seg++){
      let t=seg/5, t2=(seg+1)/5;
      let segH=trunkH/5;
      let lean=tr.lean*0.3;
      let cx=tr.ox+Math.sin(t*lean*3)*t*3;
      let cz=tr.oy+Math.cos(t*lean*2)*t*1.5;
      let r1=0.5-t*0.06, r2=0.5-t2*0.06;
      const seg_m=new THREE.Mesh(new THREE.CylinderGeometry(r2,r1,segH,7),seg%2===0?trunkMat:trunkDark);
      seg_m.position.set(cx,3.5+t*trunkH+segH/2,cz);
      seg_m.rotation.z=lean*t*0.5;
      g.add(seg_m);
    }
    // Top position
    let topX=tr.ox+Math.sin(tr.lean*0.3*3)*3;
    let topZ=tr.oy+Math.cos(tr.lean*0.3*2)*1.5;
    let topY=3.5+trunkH;

    // Coconuts
    const coconutMat=new THREE.MeshPhongMaterial({color:0x5a3a1a});
    for(let c=0;c<3;c++){
      const coco=new THREE.Mesh(new THREE.SphereGeometry(0.45,6,6),coconutMat);
      coco.position.set(topX+(Math.random()-0.5)*1.2,topY-0.5,topZ+(Math.random()-0.5)*1.2);
      g.add(coco);
    }

    // Palm fronds — large, drooping
    let leafSize=7+tr.h*0.2;
    for(let f=0;f<8;f++){
      const lGeo=new THREE.PlaneGeometry(leafSize,2.2,5,1);
      const lp=lGeo.attributes.position;
      for(let i=0;i<lp.count;i++){
        let lx=lp.getX(i);
        lp.setY(i,lp.getY(i)-Math.abs(lx)*0.28); // droop
      }
      lGeo.computeVertexNormals();
      const leafCol=f%2===0?0x2d8a2d:0x3a9a38;
      const leaf=new THREE.Mesh(lGeo,new THREE.MeshPhongMaterial({color:leafCol,side:THREE.DoubleSide,flatShading:true}));
      leaf.position.set(topX,topY+0.5,topZ);
      leaf.rotation.y=(f/8)*Math.PI*2+Math.random()*0.2;
      leaf.rotation.z=-0.4-Math.random()*0.2;
      g.add(leaf);
    }
  }

  // Rocks — scattered around beach and inland, various sizes and dark tones
  const rockCols=[0x666666,0x777777,0x888888,0x5a5a5a];
  for(let r=0;r<6+Math.floor(Math.random()*5);r++){
    let a=Math.random()*Math.PI*2;
    let d=isl.r*(0.3+Math.random()*0.65);
    let rSize=1.5+Math.random()*3;
    const rockMat=new THREE.MeshPhongMaterial({color:rockCols[Math.floor(Math.random()*rockCols.length)],flatShading:true});
    const rock=new THREE.Mesh(new THREE.DodecahedronGeometry(rSize,0),rockMat);
    rock.position.set(Math.cos(a)*d,2+Math.random()*2,Math.sin(a)*d);
    rock.rotation.set(Math.random(),Math.random(),Math.random());
    rock.scale.y=0.4+Math.random()*0.3;
    g.add(rock);
  }
  // Shoreline rocks
  for(let r=0;r<4+Math.floor(Math.random()*3);r++){
    let a=Math.random()*Math.PI*2;
    let d=isl.r*0.85+Math.random()*isl.r*0.1;
    const rock=new THREE.Mesh(new THREE.DodecahedronGeometry(1+Math.random()*2,0),new THREE.MeshPhongMaterial({color:0x7a7a6a,flatShading:true}));
    rock.position.set(Math.cos(a)*d,0.5+Math.random(),Math.sin(a)*d);
    rock.rotation.set(Math.random(),Math.random(),Math.random());rock.scale.y=0.35;
    g.add(rock);
  }
  // === TREASURE CHEST — detailed ===
  if(isl.hasTreasure){
    const cg=new THREE.Group();
    // Chest body
    const chestMat=new THREE.MeshPhongMaterial({color:0x6B3A10,shininess:30});
    cg.add(new THREE.Mesh(new THREE.BoxGeometry(2.2,1.2,1.5),chestMat));
    // Rounded lid
    const lid=new THREE.Mesh(new THREE.CylinderGeometry(0.75,0.75,2.2,10,1,false,0,Math.PI),new THREE.MeshPhongMaterial({color:0x7B4A20}));
    lid.rotation.z=Math.PI/2;lid.position.y=0.6;cg.add(lid);
    // Gold bands
    const bandMat=new THREE.MeshPhongMaterial({color:0xdaa520,emissive:0x665500,emissiveIntensity:0.5,shininess:80});
    for(let bx of[-0.7,-0.2,0.3,0.8]){let bd=new THREE.Mesh(new THREE.BoxGeometry(0.1,1.35,1.55),bandMat);bd.position.set(bx,0,0);cg.add(bd);}
    // Corner reinforcements
    for(let cx of[-1.05,1.05])for(let cz of[-0.7,0.7]){
      const corner=new THREE.Mesh(new THREE.BoxGeometry(0.15,1.3,0.15),bandMat);
      corner.position.set(cx,0,cz);cg.add(corner);
    }
    // Lock
    const lockBody=new THREE.Mesh(new THREE.BoxGeometry(0.25,0.35,0.2),new THREE.MeshPhongMaterial({color:0xccaa00,emissive:0x443300,shininess:60}));
    lockBody.position.set(0,0.4,0.78);cg.add(lockBody);
    const keyhole=new THREE.Mesh(new THREE.CircleGeometry(0.05,6),new THREE.MeshBasicMaterial({color:0x222222}));
    keyhole.position.set(0,0.38,0.89);cg.add(keyhole);
    // Glow
    cg.add(new THREE.PointLight(0xffd700,1,20));
    cg.name='chest';
    let cp=isl.palmTrees.length>0?{x:isl.palmTrees[0].ox*0.3,z:isl.palmTrees[0].oy*0.3}:{x:0,z:0};
    cg.position.set(cp.x,5,cp.z);
    g.add(cg);
  }

  // === BURIED TREASURE marker (subtle mound) ===
  if(isl.hasBuried){
    let ba=Math.random()*Math.PI*2,bd=isl.r*0.3+Math.random()*isl.r*0.2;
    isl.buriedX=Math.cos(ba)*bd;isl.buriedZ=Math.sin(ba)*bd;
    const mound=new THREE.Mesh(new THREE.SphereGeometry(1.5,6,4),new THREE.MeshPhongMaterial({color:0xc2a66b,flatShading:true}));
    mound.scale.y=0.25;mound.position.set(isl.buriedX,5.2,isl.buriedZ);
    mound.name='buried';g.add(mound);
    // Small X mark
    const xMat=new THREE.MeshBasicMaterial({color:0x8B1A1A});
    const x1=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.08,0.15),xMat);
    x1.rotation.y=Math.PI/4;x1.position.set(isl.buriedX,5.4,isl.buriedZ);g.add(x1);
    const x2=new THREE.Mesh(new THREE.BoxGeometry(1.5,0.08,0.15),xMat);
    x2.rotation.y=-Math.PI/4;x2.position.set(isl.buriedX,5.4,isl.buriedZ);g.add(x2);
  }

  // === SHOP — dock with building ===
  if(isl.hasShop){
    const dockMat=new THREE.MeshPhongMaterial({color:0x6a4a2a});
    const dp=new THREE.Mesh(new THREE.BoxGeometry(5,0.2,3),dockMat);dp.position.set(0,2.5,isl.r*0.55);g.add(dp);
    for(let dx=-2;dx<=2;dx+=1){const pile=new THREE.Mesh(new THREE.CylinderGeometry(0.15,0.18,5,6),dockMat);pile.position.set(dx,0.5,isl.r*0.55);g.add(pile);}
    // Shop building
    const shopW=new THREE.MeshPhongMaterial({color:0x7a5a30});
    const sw=new THREE.Mesh(new THREE.BoxGeometry(4,3,3),shopW);sw.position.set(0,5,isl.r*0.35);g.add(sw);
    const sr=new THREE.Mesh(new THREE.CylinderGeometry(0,3,2,4),new THREE.MeshPhongMaterial({color:0x8B1A1A}));
    sr.position.set(0,7,isl.r*0.35);sr.rotation.y=Math.PI/4;g.add(sr);
    // Door
    const door=new THREE.Mesh(new THREE.BoxGeometry(1,2,0.1),new THREE.MeshPhongMaterial({color:0x4a2a10}));
    door.position.set(0,4.5,isl.r*0.35+1.55);g.add(door);
    // Sign
    const sign=new THREE.Mesh(new THREE.BoxGeometry(2.5,0.8,0.12),new THREE.MeshPhongMaterial({color:0x5a3820}));
    sign.position.set(2.5,6,isl.r*0.45);g.add(sign);
    g.add(new THREE.PointLight(0xffcc66,0.6,25));
  }

  // === LOOKOUT TOWER ===
  if(isl.hasTower){
    let ta=Math.random()*Math.PI*2,td=isl.r*0.25;
    let tx=Math.cos(ta)*td,tz=Math.sin(ta)*td;
    // Tower base
    const tMat=new THREE.MeshPhongMaterial({color:0x5a4a30});
    const base=new THREE.Mesh(new THREE.CylinderGeometry(1.5,2,8,8),tMat);
    base.position.set(tx,9,tz);g.add(base);
    // Platform
    const plat=new THREE.Mesh(new THREE.CylinderGeometry(2.5,2.5,0.3,8),new THREE.MeshPhongMaterial({color:0x6a4a2a}));
    plat.position.set(tx,13.2,tz);g.add(plat);
    // Railing
    for(let ri=0;ri<8;ri++){
      let ra=(ri/8)*Math.PI*2;
      const post=new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.06,1.2,4),tMat);
      post.position.set(tx+Math.cos(ra)*2.3,13.8,tz+Math.sin(ra)*2.3);g.add(post);
    }
    // Roof
    const roof=new THREE.Mesh(new THREE.ConeGeometry(3,2,8),new THREE.MeshPhongMaterial({color:0x8a3a1a}));
    roof.position.set(tx,15.3,tz);g.add(roof);
    // Light
    g.add(new THREE.PointLight(0xffaa44,0.5,30));
  }

  // === FORT (stone walls + cannons) ===
  if(isl.hasFort){
    let fx=isl.r*-0.15,fz=isl.r*-0.15;
    const sMat=new THREE.MeshPhongMaterial({color:0x888877,flatShading:true});
    const dMat=new THREE.MeshPhongMaterial({color:0x666655,flatShading:true});
    // Walls
    for(let side=0;side<4;side++){
      let ang=(side/4)*Math.PI*2;
      let wx=fx+Math.cos(ang)*12,wz=fz+Math.sin(ang)*12;
      const wall=new THREE.Mesh(new THREE.BoxGeometry(12,5,1.5),sMat);
      wall.position.set(wx,7.5,wz);wall.rotation.y=ang+Math.PI/2;g.add(wall);
      // Crenellations
      for(let ci=-5;ci<=5;ci+=2){
        const cren=new THREE.Mesh(new THREE.BoxGeometry(0.8,1.2,1.6),dMat);
        let cx2=wx+Math.cos(ang+Math.PI/2)*ci;
        let cz2=wz+Math.sin(ang+Math.PI/2)*ci;
        cren.position.set(cx2,10.5,cz2);g.add(cren);
      }
    }
    // Corner towers
    for(let ct=0;ct<4;ct++){
      let ang=(ct/4)*Math.PI*2+Math.PI/4;
      let cx=fx+Math.cos(ang)*16,cz=fz+Math.sin(ang)*16;
      const tower=new THREE.Mesh(new THREE.CylinderGeometry(2,2.3,8,8),sMat);
      tower.position.set(cx,9,cz);g.add(tower);
      const tTop=new THREE.Mesh(new THREE.ConeGeometry(2.5,2,8),new THREE.MeshPhongMaterial({color:0x6a3a1a}));
      tTop.position.set(cx,14,cz);g.add(tTop);
    }
    // Fort chest (special — may contain shovel)
    const fcg=new THREE.Group();
    fcg.add(new THREE.Mesh(new THREE.BoxGeometry(2,1.2,1.4),new THREE.MeshPhongMaterial({color:0x4a3020})));
    const fBand=new THREE.MeshPhongMaterial({color:0x888888,shininess:60});
    for(let bx of[-0.6,0,0.6]){fcg.add(new THREE.Mesh(new THREE.BoxGeometry(0.08,1.25,1.45),fBand));}
    fcg.add(new THREE.PointLight(0x88aaff,0.6,12));
    fcg.name='fortchest';fcg.position.set(fx,5.5,fz);g.add(fcg);
    isl.hasFortChest=true;isl.fortChestLooted=false;
  }

  // === HUTS ===
  if(isl.hasHuts){
    let numHuts=2+Math.floor(Math.random()*3);
    for(let hi=0;hi<numHuts;hi++){
      let ha=(hi/numHuts)*Math.PI*2+Math.random()*0.5;
      let hd=isl.r*0.3+Math.random()*isl.r*0.15;
      let hx=Math.cos(ha)*hd,hz=Math.sin(ha)*hd;
      // Hut body
      const hutMat=new THREE.MeshPhongMaterial({color:0x8a6a3a});
      const hut=new THREE.Mesh(new THREE.CylinderGeometry(2,2.2,3,6),hutMat);
      hut.position.set(hx,6.5,hz);g.add(hut);
      // Thatched roof
      const thatch=new THREE.Mesh(new THREE.ConeGeometry(3,2.5,6),new THREE.MeshPhongMaterial({color:0x9a8a4a}));
      thatch.position.set(hx,9,hz);g.add(thatch);
      // Door
      const hutDoor=new THREE.Mesh(new THREE.BoxGeometry(0.8,1.8,0.1),new THREE.MeshPhongMaterial({color:0x5a3a1a}));
      hutDoor.position.set(hx+2.1,5.9,hz);g.add(hutDoor);
    }
  }

  // === CASTLE RUINS ===
  if(isl.hasCastle){
    let cx=isl.r*0.1,cz=isl.r*-0.1;
    const rMat=new THREE.MeshPhongMaterial({color:0x777766,flatShading:true});
    // Broken walls
    for(let wi=0;wi<6;wi++){
      let wa=(wi/6)*Math.PI*2+Math.random()*0.3;
      let wd=8+Math.random()*3;
      let wh=4+Math.random()*5;
      const rWall=new THREE.Mesh(new THREE.BoxGeometry(5+Math.random()*3,wh,1.2),rMat);
      rWall.position.set(cx+Math.cos(wa)*wd,5+wh/2,cz+Math.sin(wa)*wd);
      rWall.rotation.y=wa+Math.PI/2+Math.random()*0.2;
      g.add(rWall);
    }
    // Broken tower
    const rTower=new THREE.Mesh(new THREE.CylinderGeometry(1.8,2.2,10,7),rMat);
    rTower.position.set(cx-5,10,cz+3);g.add(rTower);
    // Castle chest (special loot)
    const ccg=new THREE.Group();
    ccg.add(new THREE.Mesh(new THREE.BoxGeometry(2.5,1.4,1.6),new THREE.MeshPhongMaterial({color:0x3a2a18})));
    const cBand=new THREE.MeshPhongMaterial({color:0x998855,shininess:40,emissive:0x332200,emissiveIntensity:0.3});
    for(let bx of[-0.8,0,0.8]){let b=new THREE.Mesh(new THREE.BoxGeometry(0.1,1.45,1.65),cBand);b.position.x=bx;ccg.add(b);}
    ccg.add(new THREE.PointLight(0xddaa44,0.8,15));
    ccg.name='castlechest';ccg.position.set(cx,5.5,cz);g.add(ccg);
    isl.hasCastleChest=true;isl.castleChestLooted=false;
  }

  // === UPGRADE CENTER ===
  if(isl.hasUpgrade){
    let ux=isl.r*0.2,uz=isl.r*0.3;
    const uMat=new THREE.MeshPhongMaterial({color:0x5a5a5a});
    // Anvil building
    const anvil=new THREE.Mesh(new THREE.BoxGeometry(4,3.5,3.5),uMat);
    anvil.position.set(ux,6.8,uz);g.add(anvil);
    const aRoof=new THREE.Mesh(new THREE.BoxGeometry(5,0.3,4.5),new THREE.MeshPhongMaterial({color:0x4a3a2a}));
    aRoof.position.set(ux,8.8,uz);g.add(aRoof);
    // Chimney
    const chimney=new THREE.Mesh(new THREE.CylinderGeometry(0.4,0.5,3,6),new THREE.MeshPhongMaterial({color:0x444444}));
    chimney.position.set(ux+1.5,10,uz-1);g.add(chimney);
    // Forge glow
    g.add(new THREE.PointLight(0xff6622,0.6,15));
    isl.upgradeAvailable=true;
  }

  g.position.set(isl.x,0,isl.y);
  g.traverse(c=>{if(c.isMesh){c.castShadow=true;c.receiveShadow=true;}});
  return g;
}

function buildLootCrate(){
  const g=new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.5,1,1),new THREE.MeshPhongMaterial({color:0x6b4020})));
  let lband=new THREE.Mesh(new THREE.BoxGeometry(1.55,0.12,1.05),new THREE.MeshPhongMaterial({color:0x888888}));lband.position.set(0,0.2,0);g.add(lband);
  let lgl=new THREE.PointLight(0xffaa44,0.6,12);lgl.position.set(0,1,0);g.add(lgl);
  return g;
}

function mkBall(isP){
  // Heavy iron cannonball
  const m=new THREE.Mesh(new THREE.SphereGeometry(0.8,10,10),new THREE.MeshPhongMaterial({
    color:0x2a2a2a,specular:0x666666,shininess:80,emissive:isP?0x331100:0x330000,emissiveIntensity:0.3
  }));
  m.castShadow=true;
  // Faint trail glow
  m.add(new THREE.PointLight(isP?0xff8833:0xff3333,0.5,8));
  return m;
}
function mkMuzzleFlash(x,y,z){
  const g=new THREE.Group();g.position.set(x,y,z);g.userData={life:0.4};
  // Flash
  const flash=new THREE.Mesh(new THREE.SphereGeometry(1.5,6,6),new THREE.MeshBasicMaterial({color:0xffcc44,transparent:true,opacity:0.8}));
  g.add(flash);
  // Smoke puffs
  for(let i=0;i<5;i++){
    const sm=new THREE.Mesh(new THREE.SphereGeometry(0.5+Math.random()*0.8,5,5),new THREE.MeshBasicMaterial({color:0x888888,transparent:true,opacity:0.5}));
    let a=Math.random()*Math.PI*2,s=1+Math.random()*2;
    sm.userData={vx:Math.cos(a)*s,vy:1+Math.random()*2,vz:Math.sin(a)*s};
    g.add(sm);
  }
  g.add(new THREE.PointLight(0xffaa44,3,20));
  scene.add(g);return g;
}
function mkExplosion(x,y,z,col,count){
  const g=new THREE.Group();g.position.set(x,y,z);g.userData={life:1};
  for(let i=0;i<(count||10);i++){
    const m=new THREE.Mesh(new THREE.SphereGeometry(0.1+Math.random()*0.25,4,4),new THREE.MeshBasicMaterial({color:col,transparent:true}));
    let a=Math.random()*Math.PI*2,e=Math.random()*Math.PI-Math.PI/2,s=1+Math.random()*3;
    m.userData={vx:Math.cos(a)*Math.cos(e)*s,vy:Math.sin(e)*s+2.5,vz:Math.sin(a)*Math.cos(e)*s};g.add(m);
  }
  g.add(new THREE.PointLight(col,2,20));scene.add(g);return g;
}
function mkSplash(x,z){
  const g=new THREE.Group();g.position.set(x,0.5,z);g.userData={life:0.8};
  for(let i=0;i<6;i++){
    const m=new THREE.Mesh(new THREE.SphereGeometry(0.08,4,4),new THREE.MeshBasicMaterial({color:0xaaddff,transparent:true}));
    let a=Math.random()*Math.PI*2,s=1+Math.random()*2;
    m.userData={vx:Math.cos(a)*s*0.5,vy:2+Math.random()*3,vz:Math.sin(a)*s*0.5};g.add(m);
  }
  scene.add(g);return g;
}

// ============ GAME STATE ============
let gameStarted=false,gameOver=false,time=0;
let logs=[];function addLog(m){logs.unshift(m);if(logs.length>4)logs.pop();}
let wind={angle:Math.random()*Math.PI*2,speed:0.5+Math.random()*0.5,timer:0,targetAngle:Math.random()*Math.PI*2,targetSpeed:0.5+Math.random()*0.5};

// === PLAYER — FIXED SPEEDS ===
let P={x:WORLD/2,z:WORLD/2,angle:0,
  speed:0,throttle:0,
  maxSpeed:35,accel:12,decel:8,drag:0.6,turnSpeed:0.018,
  sailsUp:false,sailLevel:0,windBonus:0,
  health:100,maxHealth:100,gold:0,kills:0,treasures:0,
  cannonCD:0,maxCannonCD:2.5,invuln:0,
  onShip:true,walkSpeed:14,bobT:0,
  hullArmor:0,cannonPower:0,
  vy:0,onGround:true,jumpForce:18,gravity:45,py:0,
  // Inventory
  wood:0,iron:0,tools:0,hasShovel:false,treasureMaps:0,
  shipUpgraded:false
};
let playerMesh,playerChar,shipMesh;
let camOrbitAngle=0,camOrbitPitch=0.35,camDist=30,camTarget=new THREE.Vector3();
let leanAmount=0,leanSplashTimer=0; // ship lean into turns

// ============ DUAL CAMERA SYSTEM — Ship (cinematic) vs On-Foot (intimate) ============
// Camera presets: these are TARGET values — actual values interpolate toward them
const CAM_SHIP = {
  dist: 48,           // farther back for scale
  pitch: 0.28,        // slightly lower pitch = more horizon visible
  heightOffset: 8,    // camera rides higher above ship
  fov: 72,            // wider FOV for open-world feel
  fogDensity: 0.00008,// lighter fog = deeper horizon, island silhouettes
  followLerp: 0.06,   // slower, smoother camera follow
  targetLerp: 0.08,   // smooth target tracking
  shoulderX: 0,       // no shoulder offset on ship
  minDist: 30, maxDist: 80,
  minPitch: 0.05, maxPitch: 0.8,
};
const CAM_FOOT = {
  dist: 18,           // closer for intimacy
  pitch: 0.32,        // slightly higher pitch = more ground visible, less sky
  heightOffset: 1.5,  // lower, grounded
  fov: 58,            // tighter FOV = things feel bigger, closer
  fogDensity: 0.00025,// heavier fog = hides empty space, feels enclosed
  followLerp: 0.12,   // snappier character tracking
  targetLerp: 0.15,   // responsive look target
  shoulderX: 1.2,     // subtle right-shoulder offset for character framing
  minDist: 10, maxDist: 35,
  minPitch: 0.08, maxPitch: 1.1,
};
// Current interpolated camera state
let camState = {
  dist: CAM_SHIP.dist,
  pitch: CAM_SHIP.pitch,
  heightOffset: CAM_SHIP.heightOffset,
  fov: CAM_SHIP.fov,
  fogDensity: CAM_SHIP.fogDensity,
  followLerp: CAM_SHIP.followLerp,
  targetLerp: CAM_SHIP.targetLerp,
  shoulderX: CAM_SHIP.shoulderX,
  minDist: CAM_SHIP.minDist,
  maxDist: CAM_SHIP.maxDist,
  minPitch: CAM_SHIP.minPitch,
  maxPitch: CAM_SHIP.maxPitch,
  transition: 0, // 0 = fully ship, 1 = fully on-foot
};
// Transition speed (0→1 or 1→0 takes ~1.2 seconds)
const CAM_TRANSITION_SPEED = 0.85;

/** Smoothly lerp a single float */
function lerpF(a,b,t){ return a + (b - a) * t; }

/** Update camState toward the active preset each frame */
function updateCamState(dt){
  const targetT = P.onShip ? 0 : 1;
  const speed = CAM_TRANSITION_SPEED * dt;
  // Ease transition with smoothstep-like curve
  if(Math.abs(camState.transition - targetT) > 0.001){
    camState.transition += (targetT - camState.transition) * Math.min(1, speed * 3);
  } else {
    camState.transition = targetT;
  }
  const t = camState.transition;
  // Smoothstep for more natural ease-in-out
  const s = t * t * (3 - 2 * t);

  camState.dist = lerpF(CAM_SHIP.dist, CAM_FOOT.dist, s);
  camState.pitch = lerpF(CAM_SHIP.pitch, CAM_FOOT.pitch, s);
  camState.heightOffset = lerpF(CAM_SHIP.heightOffset, CAM_FOOT.heightOffset, s);
  camState.fov = lerpF(CAM_SHIP.fov, CAM_FOOT.fov, s);
  camState.fogDensity = lerpF(CAM_SHIP.fogDensity, CAM_FOOT.fogDensity, s);
  camState.followLerp = lerpF(CAM_SHIP.followLerp, CAM_FOOT.followLerp, s);
  camState.targetLerp = lerpF(CAM_SHIP.targetLerp, CAM_FOOT.targetLerp, s);
  camState.shoulderX = lerpF(CAM_SHIP.shoulderX, CAM_FOOT.shoulderX, s);
  camState.minDist = lerpF(CAM_SHIP.minDist, CAM_FOOT.minDist, s);
  camState.maxDist = lerpF(CAM_SHIP.maxDist, CAM_FOOT.maxDist, s);
  camState.minPitch = lerpF(CAM_SHIP.minPitch, CAM_FOOT.minPitch, s);
  camState.maxPitch = lerpF(CAM_SHIP.maxPitch, CAM_FOOT.maxPitch, s);

  // Apply dynamic FOV
  if(Math.abs(camera.fov - camState.fov) > 0.1){
    camera.fov = lerpF(camera.fov, camState.fov, Math.min(1, dt * 2.5));
    camera.updateProjectionMatrix();
  }
  // Apply dynamic fog
  scene.fog.density = lerpF(scene.fog.density, camState.fogDensity, Math.min(1, dt * 2));
}

// ============ PERSISTENCE — Save/restore across island transitions ============
const SAVE_KEY = 'skullsail_state';

function saveGameState(){
  const state = {
    version: 1,
    timestamp: Date.now(),
    worldSeed: _worldSeed,
    player: {
      x: P.x, z: P.z, angle: P.angle,
      health: P.health, maxHealth: P.maxHealth,
      gold: P.gold, kills: P.kills, treasures: P.treasures,
      hullArmor: P.hullArmor, cannonPower: P.cannonPower,
      wood: P.wood, iron: P.iron, tools: P.tools,
      hasShovel: P.hasShovel, treasureMaps: P.treasureMaps,
      shipUpgraded: P.shipUpgraded
    },
    camera: {
      orbitAngle: camOrbitAngle,
      orbitPitch: camOrbitPitch,
      dist: camDist
    },
    wind: { angle: wind.angle, speed: wind.speed },
    time: time,
    // Island progress — which islands have been looted/visited
    islandProgress: islands.map(isl => ({
      name: isl.name, type: isl.type,
      treasureCollected: isl.treasureCollected,
      buriedFound: isl.buriedFound
    }))
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    console.log('[Save] Game state saved');
  } catch(e) {
    console.warn('[Save] Failed:', e);
  }
}

function loadGameState(){
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if(!raw) return null;
    const state = JSON.parse(raw);
    // Expire saves older than 2 hours
    if(Date.now() - state.timestamp > 2 * 60 * 60 * 1000){
      localStorage.removeItem(SAVE_KEY);
      return null;
    }
    return state;
  } catch(e) {
    console.warn('[Save] Failed to load:', e);
    return null;
  }
}

function applyGameState(state){
  // Restore world seed so islands regenerate identically
  if(state.worldSeed !== undefined){
    _worldSeed = state.worldSeed;
  }
  // Restore player stats
  const s = state.player;
  P.x = s.x; P.z = s.z; P.angle = s.angle;
  P.health = s.health; P.maxHealth = s.maxHealth;
  P.gold = s.gold; P.kills = s.kills; P.treasures = s.treasures;
  P.hullArmor = s.hullArmor; P.cannonPower = s.cannonPower;
  P.wood = s.wood; P.iron = s.iron; P.tools = s.tools;
  P.hasShovel = s.hasShovel; P.treasureMaps = s.treasureMaps;
  P.shipUpgraded = s.shipUpgraded;
  P.speed = 0; P.throttle = 0; P.sailsUp = false;

  // Restore camera
  camOrbitAngle = state.camera.orbitAngle;
  camOrbitPitch = state.camera.orbitPitch;
  camDist = state.camera.dist;

  // Restore wind
  wind.angle = state.wind.angle;
  wind.speed = state.wind.speed;
  wind.targetAngle = state.wind.angle;
  wind.targetSpeed = state.wind.speed;

  time = state.time;

  // Restore island progress after islands are generated
  if(state.islandProgress && islands.length > 0){
    for(let i = 0; i < Math.min(state.islandProgress.length, islands.length); i++){
      if(state.islandProgress[i].name === islands[i].name){
        islands[i].treasureCollected = state.islandProgress[i].treasureCollected;
        islands[i].buriedFound = state.islandProgress[i].buriedFound;
      }
    }
  }

  console.log('[Save] Game state restored — pos:', P.x.toFixed(0), P.z.toFixed(0));
}

function clearSavedState(){
  localStorage.removeItem(SAVE_KEY);
}

// ============ ISLAND TRANSITION — Cinematic zoom, then redirect to Babylon.js ============
let tavernTransitioning = false;

function startIslandTransition(island){
  if(tavernTransitioning) return;
  tavernTransitioning = true;
  addLog('Docking at ' + island.name + '...');

  // Flavor text per island type
  const flavorMap = {
    tropical: 'Approaching the shores...',
    fort: 'Entering the fortress...',
    village: 'Walking into town...',
    ruins: 'Exploring the ruins...',
    outpost: 'Arriving at the outpost...',
    wild: 'Venturing into the wilds...'
  };
  const flavor = flavorMap[island.type] || 'Going ashore...';

  // Full-screen overlay (starts invisible)
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed;inset:0;background:#0a0e14;z-index:200;opacity:0;
    transition:opacity 1.2s ease-in;pointer-events:none;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    color:#e8d5a3;font-family:'Segoe UI',system-ui,sans-serif;
  `;
  overlay.innerHTML = `
    <div style="font-size:22px;letter-spacing:4px;margin-bottom:12px;font-weight:300">${island.name.toUpperCase()}</div>
    <div style="font-size:14px;opacity:0.6;margin-bottom:16px">${flavor}</div>
    <div style="width:180px;height:3px;background:rgba(255,255,255,0.1);border-radius:2px">
      <div id="tavern-bar" style="height:100%;width:0;background:#c8a44e;border-radius:2px;transition:width 0.3s"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Phase 1: Camera zoom to near first-person (1.5s)
  const startDist = camDist;
  const startFOV = camera.fov;
  const startPitch = camOrbitPitch;
  const zoomStart = performance.now();
  const zoomDuration = 1500;

  function animateZoom(){
    const elapsed = performance.now() - zoomStart;
    const t = Math.min(1, elapsed / zoomDuration);
    const s = t * t * (3 - 2 * t); // smoothstep

    // Dolly-zoom toward first-person
    camDist = lerpF(startDist, 1.5, s);
    camera.fov = lerpF(startFOV, 90, s);
    camera.updateProjectionMatrix();
    camOrbitPitch = lerpF(startPitch, 0.12, s);
    // Tighten fog as we approach interior
    scene.fog.density = lerpF(scene.fog.density, 0.002, s * 0.5);

    if(t < 1){
      requestAnimationFrame(animateZoom);
    } else {
      // Phase 2: Fade to black
      overlay.style.opacity = '1';
      const bar = overlay.querySelector('#tavern-bar');
      let progress = 0;
      const barInterval = setInterval(() => {
        progress += 10 + Math.random() * 15;
        if(progress >= 100){
          progress = 100;
          clearInterval(barInterval);
          bar.style.width = '100%';
          // Phase 3: Redirect to Babylon.js with island type + name
          setTimeout(() => {
            try {
              saveGameState();
              const params = '?type=' + encodeURIComponent(island.type) + '&name=' + encodeURIComponent(island.name);
              const target = new URL('../pirate3d-babylon/index.html' + params, window.location.href).href;
              console.log('[Dock] Redirecting to:', target);
              window.location.replace(target);
            } catch(e) {
              console.error('[Dock] Redirect failed:', e);
            }
          }, 500);
        } else {
          bar.style.width = progress + '%';
        }
      }, 150);
    }
  }
  requestAnimationFrame(animateZoom);
}

// ============ CLUSTER-BASED REVEAL SYSTEM ============
// Props reveal in meaningful groups: hero → structural → filler → clutter.
// Each island tracks its placed assets grouped by cluster.
// Proxies represent clusters at distance; full detail swaps in close.

// Reveal distance bands (from island center)
const REVEAL_HERO       = 2200;  // hero landmarks visible very far
const REVEAL_STRUCTURAL = 1000;  // structural clusters at mid range
const REVEAL_FILLER     = 500;   // filler only when near
const REVEAL_PROXY_OUT  = 1200;  // proxy visible beyond this (silhouette mode)
const REVEAL_PROXY_IN   = 800;   // proxy fades out below this (full detail takes over)
const HYSTERESIS        = 80;    // prevent flicker at band edges

// Per-island asset registry: populated by initAssetPipeline
// Each entry: { islandIdx, clusters: Map<clusterName, {hero:[], structural:[], filler:[], proxy:null, anchorPos}> }
let islandAssetRegistry = [];

/** Build the per-island registry from placedAssets after pipeline runs */
function buildIslandAssetRegistry(){
  islandAssetRegistry = islands.map((isl, idx) => ({
    islandIdx: idx,
    islandName: isl.name,
    islandType: isl.type,
    center: { x: isl.x, z: isl.y },
    radius: isl.r,
    clusters: new Map(),
    proxyGroup: null,          // THREE.Group of cluster proxies
    revealState: {             // current reveal tier with hysteresis
      hero: false, structural: false, filler: false, proxy: false
    },
    stats: { hero: 0, structural: 0, filler: 0, manifest: 0, fallback: 0 }
  }));

  // Sort placed assets into island clusters
  for(const asset of placedAssets){
    if(!asset.object || !asset.position) continue;
    const ax = asset.position.x, az = asset.position.z;

    // Find which island this prop belongs to
    let bestIdx = -1, bestDist = Infinity;
    for(let i = 0; i < islands.length; i++){
      const isl = islands[i];
      const d = Math.hypot(ax - isl.x, az - isl.y);
      if(d < isl.r * 1.2 && d < bestDist){ bestDist = d; bestIdx = i; }
    }
    if(bestIdx < 0) continue;

    const reg = islandAssetRegistry[bestIdx];
    const clusterName = asset.zoneTag || 'default';
    if(!reg.clusters.has(clusterName)){
      reg.clusters.set(clusterName, { hero: [], structural: [], filler: [], anchorPos: null });
    }
    const cluster = reg.clusters.get(clusterName);

    const role = asset.role || 'filler';
    if(role === 'hero'){
      cluster.hero.push(asset.object);
      reg.stats.hero++;
    } else if(role === 'structural'){
      cluster.structural.push(asset.object);
      reg.stats.structural++;
    } else {
      cluster.filler.push(asset.object);
      reg.stats.filler++;
    }

    // Track anchor center (average of hero positions, or first structural)
    if(role === 'hero' && !cluster.anchorPos){
      cluster.anchorPos = { x: ax, z: az };
    } else if(role === 'structural' && !cluster.anchorPos){
      cluster.anchorPos = { x: ax, z: az };
    }

    // Track manifest vs fallback
    if(asset.object.name && asset.object.name.startsWith('fallback_')) reg.stats.fallback++;
    else reg.stats.manifest++;
  }

  // Build cluster proxies for each island
  for(const reg of islandAssetRegistry){
    reg.proxyGroup = buildClusterProxies(reg);
    if(reg.proxyGroup){
      reg.proxyGroup.visible = false;
      scene.add(reg.proxyGroup);
    }
  }

  console.info('[RevealSystem] Registry built for', islandAssetRegistry.length, 'islands');
  if(assetDebugEnabled) logRevealDebug();
}

/** Create simplified proxy silhouettes for an island's major clusters */
function buildClusterProxies(reg){
  const group = new THREE.Group();
  group.name = 'proxy_' + reg.islandName;
  const proxyMat = new THREE.MeshLambertMaterial({
    color: getProxyColor(reg.islandType),
    transparent: true, opacity: 0.6
  });

  let hasContent = false;
  for(const [name, cluster] of reg.clusters){
    // Only build proxies for clusters with structural or hero content
    if(cluster.hero.length === 0 && cluster.structural.length === 0) continue;
    if(!cluster.anchorPos) continue;

    // Proxy shape: simple box/cone to represent the cluster's identity
    let proxyMesh;
    if(name.includes('fort') || name.includes('cannon') || name.includes('guard')){
      // Fort proxy: tall box
      const geo = new THREE.BoxGeometry(8, 12, 8);
      proxyMesh = new THREE.Mesh(geo, proxyMat);
      proxyMesh.position.set(cluster.anchorPos.x,
        getRevealTerrainHeight(cluster.anchorPos.x, cluster.anchorPos.z,
          {position: reg.center, radius: reg.radius}) + 6,
        cluster.anchorPos.z);
    } else if(name.includes('village') || name.includes('outpost')){
      // Village proxy: wider low box with cone roof
      const g2 = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 10), proxyMat);
      base.position.y = 2.5; g2.add(base);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(7, 4, 4), proxyMat);
      roof.position.y = 7; roof.rotation.y = Math.PI/4; g2.add(roof);
      proxyMesh = g2;
      const py = getRevealTerrainHeight(cluster.anchorPos.x, cluster.anchorPos.z,
        {position: reg.center, radius: reg.radius});
      proxyMesh.position.set(cluster.anchorPos.x, py, cluster.anchorPos.z);
    } else if(name.includes('dock')){
      // Dock proxy: flat wide plank
      const geo = new THREE.BoxGeometry(12, 2, 5);
      proxyMesh = new THREE.Mesh(geo, proxyMat);
      proxyMesh.position.set(cluster.anchorPos.x, 1.5, cluster.anchorPos.z);
    } else if(name.includes('shipwreck') || name.includes('debris')){
      // Shipwreck proxy: angled hull shape
      const geo = new THREE.BoxGeometry(14, 4, 6);
      proxyMesh = new THREE.Mesh(geo, proxyMat);
      proxyMesh.rotation.z = 0.3;
      proxyMesh.position.set(cluster.anchorPos.x, 2, cluster.anchorPos.z);
    } else if(name.includes('ruin')){
      // Ruin proxy: broken column shapes
      const g2 = new THREE.Group();
      for(let ci = 0; ci < 3; ci++){
        const col = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.3, 6+ci*2, 6), proxyMat);
        col.position.set(ci*3-3, 3+ci, ci*2-2); g2.add(col);
      }
      proxyMesh = g2;
      const py = getRevealTerrainHeight(cluster.anchorPos.x, cluster.anchorPos.z,
        {position: reg.center, radius: reg.radius});
      proxyMesh.position.set(cluster.anchorPos.x, py, cluster.anchorPos.z);
    } else {
      // Generic proxy: small box
      const geo = new THREE.BoxGeometry(5, 4, 5);
      proxyMesh = new THREE.Mesh(geo, proxyMat);
      const py = getRevealTerrainHeight(cluster.anchorPos.x, cluster.anchorPos.z,
        {position: reg.center, radius: reg.radius});
      proxyMesh.position.set(cluster.anchorPos.x, py + 2, cluster.anchorPos.z);
    }

    if(proxyMesh){
      proxyMesh.name = 'clusterProxy_' + name;
      if(proxyMesh.isMesh){ proxyMesh.castShadow = false; proxyMesh.receiveShadow = false; }
      else proxyMesh.traverse(c => { if(c.isMesh){ c.castShadow = false; c.receiveShadow = false; }});
      group.add(proxyMesh);
      hasContent = true;
    }
  }

  return hasContent ? group : null;
}

/** Island-type → proxy tint color */
function getProxyColor(type){
  switch(type){
    case 'fort': return 0x808070;
    case 'village': return 0x9A8060;
    case 'ruins': return 0xA0A080;
    case 'outpost': return 0x7A7060;
    default: return 0x607050;
  }
}

/** Terrain height helper — uses PlacementSystem.ExclusionMask if available, else inline */
function getRevealTerrainHeight(x, z, island){
  if(window.PlacementSystem && window.PlacementSystem.ExclusionMask){
    return window.PlacementSystem.ExclusionMask.getTerrainHeight(x, z, island);
  }
  const dx = x - island.position.x, dz = z - island.position.z;
  const nd = Math.sqrt(dx*dx + dz*dz) / island.radius;
  if(nd > 1.0) return 0;
  if(nd > 0.82) return 0.5;
  if(nd > 0.62) return 2.5;
  if(nd > 0.45) return 4.0;
  if(nd > 0.25) return 5.5;
  return 7.0;
}

// ---- Reveal update (called from updateIslandStreaming) ----
function updateClusterReveal(islandIdx, dist){
  const reg = islandAssetRegistry[islandIdx];
  if(!reg) return;

  const rs = reg.revealState;

  // Hysteresis: use different thresholds for show vs hide
  const shouldShowHero       = dist < REVEAL_HERO + (rs.hero ? HYSTERESIS : 0);
  const shouldShowStructural = dist < REVEAL_STRUCTURAL + (rs.structural ? HYSTERESIS : 0);
  const shouldShowFiller     = dist < REVEAL_FILLER + (rs.filler ? HYSTERESIS : 0);
  const shouldShowProxy      = dist > REVEAL_PROXY_IN - (rs.proxy ? HYSTERESIS : 0) &&
                               dist < REVEAL_HERO;

  // Only update if state changed
  if(shouldShowHero !== rs.hero){
    rs.hero = shouldShowHero;
    for(const [, cluster] of reg.clusters){
      for(const obj of cluster.hero) obj.visible = shouldShowHero;
    }
  }

  if(shouldShowStructural !== rs.structural){
    rs.structural = shouldShowStructural;
    for(const [, cluster] of reg.clusters){
      for(const obj of cluster.structural) obj.visible = shouldShowStructural;
    }
  }

  if(shouldShowFiller !== rs.filler){
    rs.filler = shouldShowFiller;
    for(const [, cluster] of reg.clusters){
      for(const obj of cluster.filler) obj.visible = shouldShowFiller;
    }
  }

  // Proxy visibility: show when far, hide when close
  if(shouldShowProxy !== rs.proxy){
    rs.proxy = shouldShowProxy;
    if(reg.proxyGroup) reg.proxyGroup.visible = shouldShowProxy;
  }

  // Wrap proxy position
  if(reg.proxyGroup){
    const wp = wrapPos(reg.center.x, reg.center.z, P.x, P.z);
    // Proxies are children of their group — just move the group offset
    // Actually proxies are positioned in world space, so we need to offset them
    const dx = wp.x - reg.center.x;
    const dz = wp.z - reg.center.z;
    reg.proxyGroup.position.set(dx, 0, dz);
  }
}

/** Debug log: curated vs fallback usage per island */
function logRevealDebug(){
  console.group('[RevealSystem] Island Asset Debug');
  for(const reg of islandAssetRegistry){
    const clusterNames = Array.from(reg.clusters.keys());
    const totalProps = reg.stats.hero + reg.stats.structural + reg.stats.filler;
    console.info(
      `%c${reg.islandName} (${reg.islandType})%c — ${totalProps} props: ` +
      `${reg.stats.hero}H ${reg.stats.structural}S ${reg.stats.filler}F | ` +
      `manifest:${reg.stats.manifest} fallback:${reg.stats.fallback} | ` +
      `clusters: ${clusterNames.join(', ')} | ` +
      `proxy: ${reg.proxyGroup ? 'YES' : 'NO'}`,
      'font-weight:bold;color:#ffa', 'color:inherit'
    );
  }
  console.groupEnd();
}

// Empty stub replaced by cluster reveal in updateIslandStreaming
function updatePropVisibility(dt){
  // No longer needed — cluster reveal handles all prop visibility
}
let islands=[],islMeshes=[],enemies=[],projectiles=[],explosions=[],lootCrates=[];
let promptText='',promptTimer=0;
function showPrompt(t,dur){promptText=t;promptTimer=dur||2;}
let lootOpen=false,lootData=null;
let camShake=0,wakeTimer=0;

// ============ ISLAND STREAMING + WORLD WRAP ============
// Each island gets a streaming tier updated every ~0.3s
let islandTiers = []; // parallel to islands[], values: 'near','mid','far','hidden'
let streamTimer = 0;
const STREAM_INTERVAL = 0.3;

function updateIslandStreaming(dt){
  streamTimer += dt;
  if(streamTimer < STREAM_INTERVAL) return;
  streamTimer = 0;

  for(let i = 0; i < islands.length; i++){
    const isl = islands[i];
    // Wrap island position relative to player for distance calc
    const wp = wrapPos(isl.x, isl.y, P.x, P.z);
    const dist = Math.hypot(wp.x - P.x, wp.z - P.z);

    let tier;
    if(dist < STREAM_NEAR) tier = 'near';
    else if(dist < STREAM_MID) tier = 'mid';
    else if(dist < STREAM_FAR) tier = 'far';
    else tier = 'hidden';

    const prevTier = islandTiers[i];
    islandTiers[i] = tier;

    const mesh = islMeshes[i];
    if(!mesh) continue;

    // Position the island mesh at the wrapped location
    mesh.position.x = wp.x;
    mesh.position.z = wp.z;

    if(tier === 'hidden'){
      mesh.visible = false;
    } else if(tier === 'far'){
      // Silhouette only — show main mesh but hide small children
      mesh.visible = true;
      mesh.traverse(c => {
        if(c === mesh) return;
        // Keep large landmark children (forts, towers), hide small detail
        if(c.name === 'palm' || c.name === 'rock_small' || c.name === 'bush' ||
           c.name === 'grass' || c.name === 'crate' || c.name === 'barrel'){
          c.visible = false;
        }
      });
    } else if(tier === 'mid'){
      mesh.visible = true;
      mesh.traverse(c => {
        if(c === mesh) return;
        // Show palms and landmarks, hide tiny clutter
        if(c.name === 'grass' || c.name === 'rock_small'){
          c.visible = false;
        } else {
          c.visible = true;
        }
      });
    } else {
      // Near — everything visible
      mesh.visible = true;
      mesh.traverse(c => { c.visible = true; });
    }

    // ---- Cluster-based prop reveal (replaces old per-prop cull) ----
    if(islandAssetRegistry.length > 0){
      updateClusterReveal(i, dist);
    }
  }

  // Wrap any unregistered fallback props (safety net for props not in registry)
  if(islandAssetRegistry.length === 0){
    // Registry not built yet — use simple distance cull
    scene.children.forEach(c => {
      if(!c.name || !c.name.startsWith('fallback_')) return;
      const wp2 = wrapPos(c.position.x, c.position.z, P.x, P.z);
      c.position.x = wp2.x;
      c.position.z = wp2.z;
      const d = Math.hypot(wp2.x - P.x, wp2.z - P.z);
      c.visible = d < (P.onShip ? 600 : 250);
    });
  }
}

// ============ ENEMY SLEEP SYSTEM ============
// Enemies far from the player skip AI updates
const ENEMY_ACTIVE_RANGE = 1200;  // full AI
const ENEMY_SLEEP_RANGE  = 2500;  // beyond this: freeze position, skip entirely

// ============ NATURAL DISASTERS ============
let disasters=[],disasterTimer=0,disasterInterval=300; // 5 minutes
const DISASTER_TYPES=['whirlpool','typhoon','tornado'];

function spawnDisaster(){
  let type=DISASTER_TYPES[Math.floor(Math.random()*DISASTER_TYPES.length)];
  let x=Math.random()*WORLD,z=Math.random()*WORLD;
  let d={type,x,z,age:0,duration:45+Math.random()*30,radius:type==='whirlpool'?80:type==='typhoon'?150:60,
    mesh:new THREE.Group(),active:true,rotSpeed:type==='whirlpool'?2:type==='tornado'?3:0.5};

  if(type==='whirlpool'){
    // Swirling water vortex
    const ringMat=new THREE.MeshPhongMaterial({color:0x0a3060,transparent:true,opacity:0.6,side:THREE.DoubleSide});
    for(let r=0;r<5;r++){
      const ring=new THREE.Mesh(new THREE.TorusGeometry(d.radius*(0.2+r*0.18)*0.15,2+r*0.5,8,24),ringMat);
      ring.rotation.x=Math.PI/2;ring.position.y=-2-r*1.5;ring.name='whirlRing';d.mesh.add(ring);
    }
    // Central dark cone
    const cone=new THREE.Mesh(new THREE.ConeGeometry(8,15,12,1,true),new THREE.MeshPhongMaterial({color:0x051530,transparent:true,opacity:0.7,side:THREE.DoubleSide}));
    cone.position.y=-8;d.mesh.add(cone);
    // Foam particles
    const foamMat=new THREE.MeshBasicMaterial({color:0xccddee,transparent:true,opacity:0.5});
    for(let i=0;i<20;i++){
      let a=Math.random()*Math.PI*2,r2=20+Math.random()*40;
      const foam=new THREE.Mesh(new THREE.SphereGeometry(1+Math.random()*2,4,4),foamMat);
      foam.position.set(Math.cos(a)*r2,-1+Math.random()*2,Math.sin(a)*r2);foam.name='foam';d.mesh.add(foam);
    }
  }
  else if(type==='tornado'){
    // Spinning funnel
    const funnelMat=new THREE.MeshPhongMaterial({color:0x555566,transparent:true,opacity:0.45,side:THREE.DoubleSide});
    for(let h=0;h<8;h++){
      let r=3+h*2.5,y=h*8;
      const ring=new THREE.Mesh(new THREE.TorusGeometry(r,1.5+h*0.3,6,16),funnelMat);
      ring.rotation.x=Math.PI/2;ring.position.y=y;ring.name='tornadoRing';d.mesh.add(ring);
    }
    // Debris particles
    const debrisMat=new THREE.MeshPhongMaterial({color:0x4a3a2a});
    for(let i=0;i<15;i++){
      let a=Math.random()*Math.PI*2,r2=5+Math.random()*15,y=Math.random()*50;
      const deb=new THREE.Mesh(new THREE.BoxGeometry(1,0.5,0.5),debrisMat);
      deb.position.set(Math.cos(a)*r2,y,Math.sin(a)*r2);deb.name='debris';d.mesh.add(deb);
    }
    // Dark cloud at top
    const cloudMat=new THREE.MeshPhongMaterial({color:0x2a2a33,transparent:true,opacity:0.7});
    for(let i=0;i<6;i++){
      let cx=Math.random()*30-15,cz=Math.random()*30-15;
      const cl=new THREE.Mesh(new THREE.SphereGeometry(8+Math.random()*6,6,6),cloudMat);
      cl.position.set(cx,55+Math.random()*10,cz);cl.scale.y=0.4;d.mesh.add(cl);
    }
  }
  else if(type==='typhoon'){
    // Dark storm clouds spread wide
    const cloudMat=new THREE.MeshPhongMaterial({color:0x1a1a28,transparent:true,opacity:0.65});
    for(let i=0;i<20;i++){
      let a=Math.random()*Math.PI*2,r2=Math.random()*d.radius*0.8;
      const cl=new THREE.Mesh(new THREE.SphereGeometry(12+Math.random()*10,6,6),cloudMat);
      cl.position.set(Math.cos(a)*r2,80+Math.random()*20,Math.sin(a)*r2);cl.scale.y=0.35;cl.name='stormCloud';d.mesh.add(cl);
    }
    // Rain columns
    const rainMat=new THREE.MeshBasicMaterial({color:0x8899bb,transparent:true,opacity:0.2});
    for(let i=0;i<12;i++){
      let a=Math.random()*Math.PI*2,r2=Math.random()*d.radius*0.6;
      const rain=new THREE.Mesh(new THREE.CylinderGeometry(2,2,80,4,1,true),rainMat);
      rain.position.set(Math.cos(a)*r2,40,Math.sin(a)*r2);rain.name='rain';d.mesh.add(rain);
    }
    // Lightning flash light
    const lightning=new THREE.PointLight(0xccccff,0,300);
    lightning.position.set(0,70,0);lightning.name='lightning';d.mesh.add(lightning);
    d.lightningTimer=0;d.lightningInterval=3+Math.random()*5;
    // Swirling wind particles
    const windMat=new THREE.MeshBasicMaterial({color:0xaabbcc,transparent:true,opacity:0.3});
    for(let i=0;i<10;i++){
      let a=Math.random()*Math.PI*2,r2=30+Math.random()*60;
      const wp=new THREE.Mesh(new THREE.SphereGeometry(1.5,3,3),windMat);
      wp.position.set(Math.cos(a)*r2,5+Math.random()*30,Math.sin(a)*r2);wp.name='windP';d.mesh.add(wp);
    }
  }

  d.mesh.position.set(x,0,z);
  scene.add(d.mesh);
  disasters.push(d);
  let label=type==='whirlpool'?'WHIRLPOOL':type==='typhoon'?'TYPHOON':'TORNADO';
  addLog(`WARNING: ${label} spotted!`);
  showPrompt(`DANGER: ${label} forming nearby!`,4);
}

function updateDisasters(dt){
  for(let i=disasters.length-1;i>=0;i--){
    let d=disasters[i];
    d.age+=dt;
    if(d.age>d.duration){
      scene.remove(d.mesh);disasters.splice(i,1);continue;
    }
    // Fade in/out
    let fade=1;
    if(d.age<3)fade=d.age/3;
    else if(d.age>d.duration-5)fade=(d.duration-d.age)/5;

    // Rotate elements
    if(d.type==='whirlpool'){
      d.mesh.children.forEach((c,ci)=>{
        if(c.name==='whirlRing'){c.rotation.z+=d.rotSpeed*dt*(1+ci*0.3);}
        if(c.name==='foam'){
          let a=Math.atan2(c.position.z,c.position.x)+d.rotSpeed*dt*0.8;
          let r=Math.hypot(c.position.x,c.position.z);
          c.position.x=Math.cos(a)*r;c.position.z=Math.sin(a)*r;
          c.position.y=Math.sin(d.age*3+ci)*1.5;
        }
      });
    }
    else if(d.type==='tornado'){
      d.mesh.children.forEach((c,ci)=>{
        if(c.name==='tornadoRing'){c.rotation.z+=d.rotSpeed*dt*(0.5+ci*0.2);}
        if(c.name==='debris'){
          let a=Math.atan2(c.position.z,c.position.x)+d.rotSpeed*dt*1.5;
          let r=Math.hypot(c.position.x,c.position.z);
          c.position.x=Math.cos(a)*r;c.position.z=Math.sin(a)*r;
          c.position.y+=dt*5;if(c.position.y>55)c.position.y=2;
          c.rotation.x+=dt*3;c.rotation.z+=dt*2;
        }
      });
    }
    else if(d.type==='typhoon'){
      d.lightningTimer-=dt;
      if(d.lightningTimer<=0){
        d.mesh.children.forEach(c=>{if(c.name==='lightning')c.intensity=4;});
        d.lightningTimer=d.lightningInterval;d.lightningInterval=2+Math.random()*6;
        camShake=Math.max(camShake,0.3);
      }
      d.mesh.children.forEach(c=>{
        if(c.name==='lightning'&&c.intensity>0)c.intensity*=0.85;
        if(c.name==='stormCloud'){
          let a=Math.atan2(c.position.z,c.position.x)+d.rotSpeed*dt*0.3;
          let r=Math.hypot(c.position.x,c.position.z);
          c.position.x=Math.cos(a)*r;c.position.z=Math.sin(a)*r;
        }
        if(c.name==='windP'){
          let a=Math.atan2(c.position.z,c.position.x)+d.rotSpeed*dt;
          let r=Math.hypot(c.position.x,c.position.z);
          c.position.x=Math.cos(a)*r;c.position.z=Math.sin(a)*r;
          c.position.y=5+Math.sin(d.age*2+r*0.1)*15;
        }
        if(c.name==='rain'){
          c.position.y=40+Math.sin(d.age*5)*3;
        }
      });
    }

    // Wrap disaster mesh position
    let dw = wrapPos(d.x, d.z, P.x, P.z);
    d.mesh.position.set(dw.x, d.mesh.position.y, dw.z);

    // Affect player ship if in range
    if(P.onShip){
      let dx=wrapDelta(P.x-d.x),dz=wrapDelta(P.z-d.z),dist=Math.hypot(dx,dz);
      if(dist<d.radius){
        let strength=(1-dist/d.radius)*fade;
        if(d.type==='whirlpool'){
          // Pull toward center + spin
          let pullA=Math.atan2(-dz,-dx);
          let tangentA=pullA+Math.PI/2;
          P.x+=Math.cos(pullA)*strength*25*dt+Math.cos(tangentA)*strength*15*dt;
          P.z+=Math.sin(pullA)*strength*25*dt+Math.sin(tangentA)*strength*15*dt;
          P.angle+=strength*dt*1.5;
          // Damage near center
          if(dist<d.radius*0.3){P.health-=dt*15*strength;camShake=Math.max(camShake,0.5);}
        }
        else if(d.type==='tornado'){
          // Fling outward + spin + damage
          let flingA=Math.atan2(dz,dx);
          P.x+=Math.cos(flingA+Math.sin(d.age*2))*strength*35*dt;
          P.z+=Math.sin(flingA+Math.sin(d.age*2))*strength*35*dt;
          P.angle+=strength*dt*2;
          P.health-=dt*10*strength;
          camShake=Math.max(camShake,strength*0.8);
        }
        else if(d.type==='typhoon'){
          // Random wind push + slow + damage
          P.x+=Math.cos(d.age*0.7)*strength*20*dt;
          P.z+=Math.sin(d.age*0.9)*strength*20*dt;
          P.speed*=(1-strength*0.3*dt);
          if(Math.random()<dt*2*strength)P.health-=3;
          camShake=Math.max(camShake,strength*0.4);
        }
      }
    }
  }
}

function resetPlayer(){
  P={x:WORLD/2,z:WORLD/2,angle:0,speed:0,throttle:0,
    maxSpeed:35,accel:12,decel:8,drag:0.6,turnSpeed:0.018,
    sailsUp:false,sailLevel:0,windBonus:0,
    health:100,maxHealth:100,gold:0,kills:0,treasures:0,
    cannonCD:0,maxCannonCD:2.5,invuln:0,
    onShip:true,walkSpeed:14,bobT:0,
    hullArmor:0,cannonPower:0,
    vy:0,onGround:true,jumpForce:18,gravity:45,py:0,
    wood:0,iron:0,tools:0,hasShovel:false,treasureMaps:0,shipUpgraded:false};
  camOrbitAngle=0;camOrbitPitch=CAM_SHIP.pitch;camDist=CAM_SHIP.dist;camState.transition=0;
}

// Island types: each gets unique structures
const ISLAND_TYPES=['tropical','fort','village','ruins','outpost','wild'];
function genIslands(){
  islMeshes.forEach(m=>scene.remove(m));islMeshes=[];islands=[];
  // Reset seed so islands generate identically for a given _worldSeed
  _seed = _worldSeed;
  const R = seededRandom; // shorthand
  const names=['Skull','Coral','Shadow','Palm','Ember','Mist','Bone','Storm','Jade','Iron','Anchor','Rum','Dagger','Serpent','Tide','Crow'];
  const sizes=['small','medium','large'];
  for(let i=0;i<NUM_ISLANDS;i++){
    let x,y,ok;do{x=500+R()*(WORLD-1000);y=500+R()*(WORLD-1000);ok=true;for(let j of islands)if(Math.hypot(x-j.x,y-j.y)<600)ok=false;}while(!ok);
    // Size variation
    let size=sizes[i%3===0?2:i%2===0?1:0];
    let r=size==='large'?130+R()*50:size==='medium'?90+R()*40:55+R()*25;
    let shape=[];let nPts=size==='large'?10+Math.floor(R()*4):size==='medium'?8+Math.floor(R()*3):6+Math.floor(R()*3);
    for(let p=0;p<nPts;p++){let a=(p/nPts)*Math.PI*2;shape.push({x:Math.cos(a)*r*(0.65+R()*0.45),y:Math.sin(a)*r*(0.65+R()*0.45)});}
    let palmCount=size==='large'?8+Math.floor(R()*6):size==='medium'?5+Math.floor(R()*4):2+Math.floor(R()*3);
    let palms=[];for(let t=0;t<palmCount;t++){let a=R()*Math.PI*2;let d=R()*r*0.55;palms.push({ox:Math.cos(a)*d,oy:Math.sin(a)*d,h:14+R()*12,lean:(R()-0.5)*0.4});}
    // Unique island type
    let type=ISLAND_TYPES[i%ISLAND_TYPES.length];
    // Features based on type
    let hasTreasure=type==='ruins'||type==='wild'||(R()<0.4);
    let hasShop=type==='village'||type==='outpost';
    let hasFort=type==='fort';
    let hasTower=type==='outpost'||type==='fort';
    let hasHuts=type==='village'||type==='tropical';
    let hasCastle=type==='ruins'&&size!=='small';
    let hasUpgrade=type==='village'&&size!=='small';
    let hasBuried=R()<0.5; // buried treasure on some islands
    let isl={x,y,r,shape,palmTrees:palms,size,type,
      hasTreasure,treasureCollected:false,hasShop,hasFort,hasTower,hasHuts,hasCastle,hasUpgrade,
      hasBuried,buriedFound:false,
      name:names[i]+' Isle',
      goldReward:size==='large'?60+Math.floor(R()*80):size==='medium'?30+Math.floor(R()*50):15+Math.floor(R()*30),
      repairCost:25+Math.floor(R()*20),
      groundH:7
    };
    islands.push(isl);let m=buildIsland(isl);scene.add(m);islMeshes.push(m);
  }
  // Initialize streaming tiers
  islandTiers = islands.map(() => 'near');
}

function genEnemies(){
  enemies.forEach(e=>{scene.remove(e.mesh);});enemies=[];
  for(let i=0;i<NUM_ENEMIES;i++)spawnEnemy(false);
}

function spawnEnemy(nearP){
  let x,z;
  if(nearP){let a=Math.random()*Math.PI*2,d=600+Math.random()*500;x=P.x+Math.cos(a)*d;z=P.z+Math.sin(a)*d;}
  else{x=Math.random()*WORLD;z=Math.random()*WORLD;}
  // Wrap into world range (infinite world)
  x=((x%WORLD)+WORLD)%WORLD; z=((z%WORLD)+WORLD)%WORLD;
  let tier=Math.random();let t=tier<0.3?0:tier<0.7?1:2;
  let e={x,z,angle:Math.random()*Math.PI*2,speed:0,targetSpeed:0,
    maxSpeed:[12,15,18][t],
    health:[60,100,150][t],maxHealth:[60,100,150][t],
    cannonCD:0,cannonRange:[200,230,260][t],
    ai:'patrol',aiTimer:0,
    patrolTarget:{x:x+Math.cos(Math.random()*6.28)*400,z:z+Math.sin(Math.random()*6.28)*400},
    tier:t,goldDrop:[25,50,90][t],name:['Sloop','Brigantine','Man-o-War'][t],
    sinking:false,sinkTimer:0,bobT:Math.random()*6.28,
    turnRate:[0.012,0.009,0.007][t],
    accel:[8,6,5][t],
    lootTable:(()=>{let items=[];let r=Math.random;if(t===0){items.push(r()>0.5?'10 Wood':'5 Iron');if(r()>0.7)items.push('1 Tools');}else if(t===1){items.push(r()>0.5?'20 Wood':'10 Iron');items.push(r()>0.5?'2 Tools':'Cannonball Supply');if(r()>0.8)items.push('Ship Repair Kit');}else{items.push('30 Wood','15 Iron','3 Tools');if(r()>0.5)items.push('Ship Repair Kit');if(r()>0.7)items.push('Treasure Map');}return items;})(),
    orbitDir:Math.random()>0.5?1:-1
  };
  let sc=[2.5,3.2,4][t];
  e.mesh=buildShip({
    hullCol:[0x6a4a30,0x5a2828,0x3a1515][t],
    hullDark:[0x4a3020,0x3a1818,0x2a0a0a][t],
    sailCol:[0xcccccc,0x882222,0x220000][t],
    deckCol:[0x9a7a30,0x8a6a28,0x7a5a20][t],
    scale:sc,withCabin:t>=1,withSecondMast:t>=2
  });
  e.mesh.position.set(x,0,z);scene.add(e.mesh);
  enemies.push(e);
}

function fireCannons(){
  if(P.cannonCD>0||!P.onShip)return;
  let la=P.angle-Math.PI/2,ra=P.angle+Math.PI/2;
  let s=10;let dmg=22+P.cannonPower*8;
  let wh=getWaveH(P.x,P.z,time);
  // Fire both sides with muzzle flash
  let lx=P.x+Math.cos(la)*s,lz=P.z+Math.sin(la)*s;
  let rx=P.x+Math.cos(ra)*s,rz=P.z+Math.sin(ra)*s;
  addProj(lx,lz,la,true,dmg);
  addProj(rx,rz,ra,true,dmg);
  explosions.push(mkMuzzleFlash(lx,wh+5,lz));
  explosions.push(mkMuzzleFlash(rx,wh+5,rz));
  P.cannonCD=P.maxCannonCD;camShake=0.4;
}

function addProj(fx,fz,ang,isP,dmg){
  let spread=(Math.random()-0.5)*0.08;
  let m=mkBall(isP);m.position.set(fx,5,fz);scene.add(m);
  let spd=isP?120:90;
  projectiles.push({mesh:m,vx:Math.cos(ang+spread)*spd,vz:Math.sin(ang+spread)*spd,vy:30,isPlayer:isP,life:3,damage:dmg||12});
}

function spawnLootCrate(x,z,items,gold){
  let m=buildLootCrate();m.position.set(x,0.5,z);scene.add(m);
  lootCrates.push({mesh:m,x,z,items,gold,bobT:Math.random()*6.28,life:60});
}

function showLoot(title,items,gold){
  lootOpen=true;lootData={items,gold};
  document.getElementById('loot-title').textContent=title;
  let html='';if(gold>0)html+=`<div style="color:#ffd700;">+${gold} Gold</div>`;
  for(let it of items){
    let col='#ddd';
    if(it.includes('Wood'))col='#c49a6c';
    else if(it.includes('Iron'))col='#a0b0c0';
    else if(it.includes('Tools'))col='#88ccff';
    else if(it.includes('Shovel'))col='#ff9944';
    else if(it.includes('Treasure Map'))col='#ffdd44';
    else if(it.includes('Repair Kit'))col='#44ff88';
    html+=`<div style="color:${col};">• ${it}</div>`;
  }
  document.getElementById('loot-items').innerHTML=html;
  document.getElementById('loot-popup').style.display='block';
}
document.getElementById('loot-close').addEventListener('click',()=>{
  document.getElementById('loot-popup').style.display='none';lootOpen=false;
  if(lootData){
    P.gold+=lootData.gold;
    for(let it of lootData.items){
      if(it.includes('Repair Kit')){P.health=Math.min(P.maxHealth,P.health+30);addLog('Ship repaired +30 HP!');}
      let m=it.match(/^(\d+)\s+Wood/);if(m)P.wood+=parseInt(m[1]);
      m=it.match(/^(\d+)\s+Iron/);if(m)P.iron+=parseInt(m[1]);
      m=it.match(/^(\d+)\s+Tools/);if(m)P.tools+=parseInt(m[1]);
      if(it==='Shovel'){P.hasShovel=true;addLog('Got a Shovel!');}
      if(it==='Treasure Map'){P.treasureMaps++;addLog('Got a Treasure Map!');}
    }
    lootData=null;
  }
});

// ============ INPUT ============
let keys={};
window.addEventListener('keydown',e=>{keys[e.key.toLowerCase()]=true;if([' ','e','f','r'].includes(e.key.toLowerCase()))e.preventDefault();if(e.key===' '&&!P.onShip&&P.onGround){P.vy=P.jumpForce;P.onGround=false;}});
window.addEventListener('keyup',e=>{keys[e.key.toLowerCase()]=false;});
let mouseDown=false;
renderer.domElement.addEventListener('mousedown',e=>{if(e.button===0||e.button===2)mouseDown=true;});
window.addEventListener('mouseup',()=>mouseDown=false);
window.addEventListener('mousemove',e=>{if(!mouseDown||!gameStarted||gameOver||lootOpen||settingsOpen)return;let s=settings.sensitivity*0.001;camOrbitAngle-=e.movementX*s;camOrbitPitch+=e.movementY*s;camOrbitPitch=Math.max(camState.minPitch,Math.min(camState.maxPitch,camOrbitPitch));});
renderer.domElement.addEventListener('wheel',e=>{camDist+=e.deltaY*0.01*settings.zoomSens;camDist=Math.max(camState.minDist,Math.min(camState.maxDist,camDist));},{passive:true});
renderer.domElement.addEventListener('contextmenu',e=>e.preventDefault());
let lastTouch=null;
renderer.domElement.addEventListener('touchstart',e=>{if(e.touches.length===1&&!joyActive2)lastTouch={x:e.touches[0].clientX,y:e.touches[0].clientY};});
renderer.domElement.addEventListener('touchmove',e=>{if(lastTouch&&e.touches.length===1&&!joyActive2){let dx=e.touches[0].clientX-lastTouch.x,dy=e.touches[0].clientY-lastTouch.y;camOrbitAngle-=dx*0.008;camOrbitPitch+=dy*0.008;camOrbitPitch=Math.max(camState.minPitch,Math.min(camState.maxPitch,camOrbitPitch));lastTouch={x:e.touches[0].clientX,y:e.touches[0].clientY};}});
renderer.domElement.addEventListener('touchend',()=>lastTouch=null);
let joyInput2={x:0,y:0},joyActive2=false,joyTid=null;
const jZ=document.getElementById('joystick-zone'),jS=document.getElementById('joystick-stick');
function hJoy(cx,cy){const r=jZ.getBoundingClientRect();let dx=cx-r.left-60,dy=cy-r.top-60;let d=Math.hypot(dx,dy),mx=45;if(d>mx){dx=dx/d*mx;dy=dy/d*mx;}jS.style.transform=`translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px))`;joyInput2.x=dx/mx;joyInput2.y=dy/mx;}
jZ.addEventListener('touchstart',e=>{e.preventDefault();e.stopPropagation();joyActive2=true;joyTid=e.changedTouches[0].identifier;hJoy(e.changedTouches[0].clientX,e.changedTouches[0].clientY);});
window.addEventListener('touchmove',e=>{for(let t of e.changedTouches)if(t.identifier===joyTid)hJoy(t.clientX,t.clientY);});
window.addEventListener('touchend',e=>{for(let t of e.changedTouches)if(t.identifier===joyTid){joyActive2=false;joyTid=null;joyInput2.x=0;joyInput2.y=0;jS.style.transform='translate(-50%,-50%)';}});
document.getElementById('fire-btn').addEventListener('touchstart',e=>{e.preventDefault();e.stopPropagation();fireCannons();});
document.getElementById('interact-btn').addEventListener('touchstart',e=>{e.preventDefault();e.stopPropagation();keys['e']=true;setTimeout(()=>keys['e']=false,100);keys['f']=true;setTimeout(()=>keys['f']=false,100);});
document.getElementById('sail-btn').addEventListener('touchstart',e=>{e.preventDefault();e.stopPropagation();if(P.onShip)P.sailsUp=!P.sailsUp;});

// ============ SETTINGS ============
let settings={
  sensitivity:5,zoomSens:3,mobileMode:false,
  keys:{forward:'w',back:'s',left:'a',right:'d',fire:' ',interact:'e',board:'f',sails:'r'}
};
let settingsOpen=false,rebindTarget=null;

document.getElementById('settings-btn').addEventListener('click',()=>{
  settingsOpen=!settingsOpen;
  document.getElementById('settings-panel').style.display=settingsOpen?'block':'none';
});
document.getElementById('settings-close').addEventListener('click',()=>{
  settingsOpen=false;document.getElementById('settings-panel').style.display='none';
  // Remove any listening state
  document.querySelectorAll('.key-bind').forEach(b=>b.classList.remove('listening'));
  rebindTarget=null;
});
document.getElementById('sens-slider').addEventListener('input',e=>{settings.sensitivity=parseInt(e.target.value);});
document.getElementById('zoom-slider').addEventListener('input',e=>{settings.zoomSens=parseInt(e.target.value);});
document.getElementById('ctrl-mode').addEventListener('change',e=>{
  settings.mobileMode=e.target.value==='mobile';
  document.getElementById('mobile-controls').style.display=settings.mobileMode?'block':'none';
  document.getElementById('controls-info').style.display=settings.mobileMode?'none':'block';
});

// Key rebinding
document.querySelectorAll('.key-bind').forEach(btn=>{
  // Display initial key name
  let action=btn.dataset.action;
  btn.textContent=settings.keys[action]===' '?'SPACE':settings.keys[action].toUpperCase();
  btn.addEventListener('click',()=>{
    // Clear previous listening
    document.querySelectorAll('.key-bind').forEach(b=>b.classList.remove('listening'));
    btn.classList.add('listening');btn.textContent='...';
    rebindTarget=action;
  });
});
window.addEventListener('keydown',e=>{
  if(rebindTarget){
    let k=e.key.toLowerCase();
    if(k==='escape'){
      // Cancel rebind
      let btn=document.querySelector(`[data-action="${rebindTarget}"]`);
      btn.textContent=settings.keys[rebindTarget]===' '?'SPACE':settings.keys[rebindTarget].toUpperCase();
      btn.classList.remove('listening');
      rebindTarget=null;return;
    }
    settings.keys[rebindTarget]=k===' '?' ':k;
    let btn=document.querySelector(`[data-action="${rebindTarget}"]`);
    btn.textContent=k===' '?'SPACE':k.toUpperCase();
    btn.classList.remove('listening');
    rebindTarget=null;e.preventDefault();return;
  }
});

function angleDiff(a,b){let d=b-a;while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;return d;}
function lerpAngle(a,b,t){return a+angleDiff(a,b)*t;}

// ============ INIT ============
function initGame(){
  resetPlayer();
  if(playerChar)scene.remove(playerChar);
  if(shipMesh)scene.remove(shipMesh);
  playerChar=buildCharacter();scene.add(playerChar);
  shipMesh=buildShip({hullCol:0x8b6b3a,hullDark:0x6a4a20,sailCol:0xf0e6d2,deckCol:0xA0823A,scale:3.5,withCabin:true,withSecondMast:true});
  shipMesh.position.set(P.x,0,P.z);scene.add(shipMesh);
  genIslands();genEnemies();
  projectiles.forEach(p=>scene.remove(p.mesh));projectiles=[];
  explosions.forEach(e=>scene.remove(e));explosions=[];
  lootCrates.forEach(l=>scene.remove(l.mesh));lootCrates=[];
  disasters.forEach(d=>scene.remove(d.mesh));disasters=[];disasterTimer=0;
  wakeParticles.forEach(w=>scene.remove(w.mesh));wakeParticles.length=0;
  logs=[];gameOver=false;lootOpen=false;
  document.getElementById('death-screen').style.display='none';
  document.getElementById('loot-popup').style.display='none';
  document.getElementById('enemy-hud').innerHTML='';
  addLog("Ye arrive at yer ship. Press F to board.");
  showPrompt("[F] Board Ship",4);
}

// ============ UPDATE ============
function update(dt){
  if(!gameStarted||gameOver||lootOpen||settingsOpen)return;
  time+=dt;P.bobT+=dt*2;

  // Wind
  wind.timer+=dt;
  if(wind.timer>30){wind.targetAngle=wind.angle+(Math.random()-0.5)*1.0;wind.targetSpeed=0.35+Math.random()*0.55;wind.timer=0;addLog("The wind shifts...");}
  wind.angle=lerpAngle(wind.angle,wind.targetAngle,dt*0.3);
  wind.speed+=(wind.targetSpeed-wind.speed)*dt*0.5;

  // Natural disasters
  disasterTimer+=dt;
  if(disasterTimer>=disasterInterval){
    disasterTimer=0;
    // Spawn 2 random disasters
    spawnDisaster();
    setTimeout(()=>spawnDisaster(),2000);
  }
  updateDisasters(dt);

  let sk=settings.keys;
  let steerL=keys[sk.left]||keys['arrowleft']||(joyActive2&&joyInput2.x<-0.3);
  let steerR=keys[sk.right]||keys['arrowright']||(joyActive2&&joyInput2.x>0.3);
  let fwd=keys[sk.forward]||keys['arrowup']||(joyActive2&&joyInput2.y<-0.3);
  let bck=keys[sk.back]||keys['arrowdown']||(joyActive2&&joyInput2.y>0.3);

  if(keys[sk.sails]&&P.onShip){P.sailsUp=!P.sailsUp;keys[sk.sails]=false;addLog(P.sailsUp?'Sails raised!':'Sails furled.');}

  if(P.onShip){
    // Steering
    let speedFactor=0.3+Math.min(1,Math.abs(P.speed)/P.maxSpeed)*0.7;
    let turnInput=0;
    if(steerL){P.angle-=P.turnSpeed*speedFactor;turnInput=-1;}
    if(steerR){P.angle+=P.turnSpeed*speedFactor;turnInput=1;}

    // Ship lean into turns — builds up smoothly, decays back
    let targetLean=turnInput*0.18*Math.min(1,Math.abs(P.speed)/15); // lean proportional to speed
    leanAmount+=(targetLean-leanAmount)*dt*4; // smooth ease
    if(turnInput===0)leanAmount*=(1-dt*3); // decay when not turning

    // Splash on lean side
    leanSplashTimer+=dt;
    if(Math.abs(leanAmount)>0.06&&Math.abs(P.speed)>5&&leanSplashTimer>0.15){
      leanSplashTimer=0;
      let splashSide=leanAmount>0?1:-1; // splash on the side we're leaning toward
      let splashX=P.x+Math.cos(P.angle+splashSide*Math.PI/2)*8;
      let splashZ=P.z+Math.sin(P.angle+splashSide*Math.PI/2)*8;
      spawnWake(splashX,splashZ,4);
      if(Math.abs(leanAmount)>0.12){
        // bigger splash for hard turns
        mkSplash(splashX+(Math.random()-0.5)*3,splashZ+(Math.random()-0.5)*3);
      }
    }


    // Throttle
    if(fwd)P.throttle=Math.min(1,P.throttle+dt*0.8);
    else if(bck)P.throttle=Math.max(-0.2,P.throttle-dt*1.0);
    else{P.throttle*=(1-dt*0.5);if(Math.abs(P.throttle)<0.01)P.throttle=0;}

    // Sails
    if(P.sailsUp)P.sailLevel=Math.min(1,P.sailLevel+dt*0.6);
    else P.sailLevel=Math.max(0,P.sailLevel-dt*0.8);

    // Wind bonus
    let windAlign=Math.cos(wind.angle-P.angle);
    let windFactor=(0.2+Math.max(0,windAlign)*0.8)*wind.speed;
    if(windAlign<-0.5)windFactor*=0.3;
    P.windBonus=P.sailLevel*windFactor*10;

    // Speed — ALL multiplied by dt
    let targetSpeed=P.throttle*P.maxSpeed+P.windBonus;
    let accelRate=P.throttle>0?P.accel:P.decel;
    P.speed+=(targetSpeed-P.speed)*accelRate*dt;
    P.speed*=(1-P.drag*dt);

    // MOVE — multiplied by dt!
    P.x+=Math.cos(P.angle)*P.speed*dt;
    P.z+=Math.sin(P.angle)*P.speed*dt;

    // Cannons
    if(keys[sk.fire])fireCannons();
    if(P.cannonCD>0)P.cannonCD-=dt;
    if(P.cannonCD<0)P.cannonCD=0;

    // Ship mesh
    let wh=getWaveH(P.x,P.z,time);
    shipMesh.position.set(P.x,wh,P.z);
    shipMesh.rotation.y=-P.angle;
    let whF=getWaveH(P.x+Math.cos(P.angle)*5,P.z+Math.sin(P.angle)*5,time);
    let whS=getWaveH(P.x+Math.cos(P.angle+1.57)*3,P.z+Math.sin(P.angle+1.57)*3,time);
    shipMesh.rotation.z=-(whF-wh)*0.03;
    shipMesh.rotation.x=(whS-wh)*0.03+leanAmount; // wave tilt + turn lean

    // Sails billow
    shipMesh.traverse(c=>{
      if(c.name==='sail'||c.name==='sail2'){
        let geo=c.geometry,pos=geo.attributes.position;
        let bl=P.sailLevel*0.6;
        for(let i=0;i<pos.count;i++){let ox=pos.getX(i);pos.setZ(i,Math.sin((pos.getY(i)+1.3)*1.1+time*1.5)*bl*(0.3+Math.abs(ox)*0.5));}
        pos.needsUpdate=true;
      }
      if(c.name==='flag'){
        let geo=c.geometry,pos=geo.attributes.position;
        for(let i=0;i<pos.count;i++){let ox=pos.getX(i);pos.setZ(i,Math.sin(ox*3+time*4)*0.1);}
        pos.needsUpdate=true;
      }
    });

    // Wake
    wakeTimer+=dt;
    if(Math.abs(P.speed)>3&&wakeTimer>0.2){
      wakeTimer=0;
      spawnWake(P.x-Math.cos(P.angle)*15,P.z-Math.sin(P.angle)*15,5);
    }

    // Player on ship
    // Position player at steering wheel (stern, offset ~7 units behind bow along ship axis)
    let wheelOffX=-7.5; // local ship X offset (stern area where wheel is)
    let pWorldX=P.x+Math.cos(P.angle)*wheelOffX;
    let pWorldZ=P.z+Math.sin(P.angle)*wheelOffX;
    playerChar.position.set(pWorldX,wh+5.8,pWorldZ);
    playerChar.rotation.y=-P.angle;

    // --- ISLAND DOCK DETECTION ---
    // When ship is near an island, show entry prompt
    if(!tavernTransitioning){
      let nearestIsland = null, nearestDist = Infinity;
      for(let isl of islands){
        let d=Math.hypot(wrapDelta(P.x-isl.x),wrapDelta(P.z-isl.y));
        if(d < isl.r + 40 && d < nearestDist){
          nearestDist = d;
          nearestIsland = isl;
        }
      }
      if(nearestIsland && nearestDist < nearestIsland.r + 40){
        showPrompt(`[F] Dock at ${nearestIsland.name}`,0.2);
        if(keys[sk.board]){
          keys[sk.board]=false;
          P.throttle=0;P.speed=0;P.sailsUp=false;
          addLog(`Docking at ${nearestIsland.name}...`);
          startIslandTransition(nearestIsland);
        }
      }
    }

    for(let i=lootCrates.length-1;i>=0;i--){
      let lc=lootCrates[i];
      if(Math.hypot(wrapDelta(P.x-lc.x),wrapDelta(P.z-lc.z))<10){showPrompt("[E] Collect Loot",0.2);if(keys[sk.interact]){showLoot('PLUNDER',lc.items,lc.gold);scene.remove(lc.mesh);lootCrates.splice(i,1);keys[sk.interact]=false;break;}}
    }
  }

  // Loot on ship
  if(P.onShip){for(let i=lootCrates.length-1;i>=0;i--){let lc=lootCrates[i];if(Math.hypot(wrapDelta(P.x-lc.x),wrapDelta(P.z-lc.z))<18){showPrompt("[E] Collect Loot",0.2);if(keys[sk.interact]){showLoot('PLUNDER',lc.items,lc.gold);scene.remove(lc.mesh);lootCrates.splice(i,1);keys[sk.interact]=false;break;}}}}

  // Infinite world — wrap coordinates to prevent float precision issues.
  // When wrapping, also shift camera/camTarget/shipMesh so nothing visually jumps.
  {
    let wrapX = 0, wrapZ = 0;
    if(P.x < 0){ wrapX = WORLD; } else if(P.x > WORLD){ wrapX = -WORLD; }
    if(P.z < 0){ wrapZ = WORLD; } else if(P.z > WORLD){ wrapZ = -WORLD; }
    if(wrapX !== 0 || wrapZ !== 0){
      P.x += wrapX; P.z += wrapZ;
      // Snap camera + target so lerp doesn't interpolate across the seam
      camera.position.x += wrapX; camera.position.z += wrapZ;
      camTarget.x += wrapX; camTarget.z += wrapZ;
      // Snap ship mesh too so it doesn't lag behind
      shipMesh.position.x += wrapX; shipMesh.position.z += wrapZ;
      // Snap player character
      playerChar.position.x += wrapX; playerChar.position.z += wrapZ;
    }
  }
  if(P.invuln>0)P.invuln-=dt;

  // Island collision (wrapped)
  if(P.onShip){for(let isl of islands){let wx=wrapDelta(P.x-isl.x),wz=wrapDelta(P.z-isl.y),d=Math.hypot(wx,wz);if(d<isl.r+12){let push=isl.r+12-d;P.x+=wx/d*push;P.z+=wz/d*push;P.speed*=0.3;P.throttle*=0.5;}}}

  // ===== ENEMY AI (with streaming + sleep) =====
  for(let e of enemies){
    if(e.sinking){e.sinkTimer+=dt;e.mesh.position.y-=dt*0.8;e.mesh.rotation.z+=dt*0.15;e.mesh.rotation.x+=dt*0.05;continue;}

    // Wrap enemy position relative to player
    let ew = wrapPos(e.x, e.z, P.x, P.z);
    let dx=P.x-ew.x,dz=P.z-ew.z,dp=Math.hypot(dx,dz);

    // Sleep system: skip far enemies entirely
    if(dp > ENEMY_SLEEP_RANGE){
      e.mesh.visible = false;
      continue;
    }
    e.mesh.visible = true;

    // Position mesh at wrapped location
    e.mesh.position.x = ew.x;
    e.mesh.position.z = ew.z;

    // Reduced updates for mid-range enemies
    if(dp > ENEMY_ACTIVE_RANGE){
      // Drift slowly but skip AI, cannon logic, sail animation
      e.x += Math.cos(e.angle) * 3 * dt;
      e.z += Math.sin(e.angle) * 3 * dt;
      e.bobT += dt;
      let ewh = getWaveH(ew.x, ew.z, time);
      e.mesh.position.y = ewh;
      e.mesh.rotation.y = -e.angle;
      continue;
    }

    e.aiTimer+=dt;

    if(dp<350&&P.onShip&&e.ai!=='chase'){e.ai='chase';e.aiTimer=0;e.orbitDir=Math.random()>0.5?1:-1;}
    else if((dp>550||!P.onShip)&&e.ai==='chase'){e.ai='patrol';e.aiTimer=0;}

    let desiredAngle=e.angle;
    if(e.ai==='chase'){
      let atp=Math.atan2(dz,dx);
      if(dp>e.cannonRange+40){desiredAngle=atp+Math.sin(time*0.3+e.bobT)*0.15;e.targetSpeed=e.maxSpeed*0.8;}
      else if(dp>e.cannonRange-30){desiredAngle=atp+e.orbitDir*Math.PI*0.45;e.targetSpeed=e.maxSpeed*0.5;}
      else{desiredAngle=atp+e.orbitDir*Math.PI*0.6;e.targetSpeed=e.maxSpeed*0.65;}
      if(dp<e.cannonRange&&e.cannonCD<=0){
        let sideAngle=Math.abs(Math.cos(e.angle-atp));
        if(sideAngle<0.65){addProj(ew.x,ew.z,atp+(Math.random()-0.5)*0.15,false,10+e.tier*4);e.cannonCD=3+Math.random()*2;}
      }
    } else {
      let ptDx=e.patrolTarget.x-e.x,ptDz=e.patrolTarget.z-e.z;
      if(Math.hypot(ptDx,ptDz)<80||e.aiTimer>30){e.patrolTarget={x:e.x+(Math.random()-0.5)*1000,z:e.z+(Math.random()-0.5)*1000};e.aiTimer=0;}
      desiredAngle=Math.atan2(ptDz,ptDx);e.targetSpeed=e.maxSpeed*0.3;
    }

    let diff=angleDiff(e.angle,desiredAngle);
    e.angle+=diff*e.turnRate*1.5;
    e.speed+=(e.targetSpeed-e.speed)*e.accel*dt;
    e.speed=Math.max(0,Math.min(e.maxSpeed,e.speed));

    // FIXED: multiply by dt
    e.x+=Math.cos(e.angle)*e.speed*dt;
    e.z+=Math.sin(e.angle)*e.speed*dt;
    // Wrap enemy position for infinite world
    if(e.x < 0) e.x += WORLD; else if(e.x > WORLD) e.x -= WORLD;
    if(e.z < 0) e.z += WORLD; else if(e.z > WORLD) e.z -= WORLD;
    if(e.cannonCD>0)e.cannonCD-=dt;

    // Island avoidance (wrapped)
    for(let isl of islands){let ix=wrapDelta(e.x-isl.x),iz=wrapDelta(e.z-isl.y),id=Math.hypot(ix,iz);if(id<isl.r+60){let urgency=Math.max(0,1-((id-isl.r)/60));e.angle=lerpAngle(e.angle,Math.atan2(iz,ix),urgency*0.05);if(id<isl.r+20){e.x+=ix/id*1.5;e.z+=iz/id*1.5;e.speed*=0.8;}}}
    // Enemy avoidance
    for(let other of enemies){if(other===e||other.sinking)continue;let ox=e.x-other.x,oz=e.z-other.z,od=Math.hypot(ox,oz);if(od<40&&od>0){e.x+=ox/od*0.5;e.z+=oz/od*0.5;}}

    e.bobT+=dt;
    let ewh=getWaveH(e.x,e.z,time);
    e.mesh.position.set(ew.x,ewh,ew.z);
    e.mesh.rotation.y=-e.angle;
    let ewhF=getWaveH(e.x+Math.cos(e.angle)*3,e.z+Math.sin(e.angle)*3,time);
    let ewhS=getWaveH(e.x+Math.cos(e.angle+1.57)*2,e.z+Math.sin(e.angle+1.57)*2,time);
    e.mesh.rotation.z=-(ewhF-ewh)*0.025;e.mesh.rotation.x=(ewhS-ewh)*0.025;

    e.mesh.traverse(c=>{
      if(c.name==='sail'||c.name==='sail2'){let geo=c.geometry,pos=geo.attributes.position;let bl=0.3+e.speed/e.maxSpeed*0.4;for(let i=0;i<pos.count;i++){let ox=pos.getX(i);pos.setZ(i,Math.sin((pos.getY(i)+1)*1.1+time*1.3)*bl*(0.3+Math.abs(ox)*0.4));}pos.needsUpdate=true;}
      if(c.name==='flag'){let geo=c.geometry,pos=geo.attributes.position;for(let i=0;i<pos.count;i++){let ox=pos.getX(i);pos.setZ(i,Math.sin(ox*3+time*3.5)*0.06);}pos.needsUpdate=true;}
    });

    if(e.speed>3&&Math.random()<0.05)spawnWake(e.x-Math.cos(e.angle)*8,e.z-Math.sin(e.angle)*8,3);
  }

  // Remove sunk
  for(let i=enemies.length-1;i>=0;i--){let e=enemies[i];if(e.sinking&&e.sinkTimer>6){scene.remove(e.mesh);spawnLootCrate(e.x,e.z,e.lootTable,e.goldDrop);enemies.splice(i,1);setTimeout(()=>{if(!gameOver&&enemies.length<NUM_ENEMIES)spawnEnemy(true);},15000+Math.random()*10000);}}

  // Projectiles
  for(let i=projectiles.length-1;i>=0;i--){
    let p=projectiles[i];
    p.mesh.position.x+=p.vx*dt;p.mesh.position.z+=p.vz*dt;
    p.vy-=dt*60;p.mesh.position.y+=p.vy*dt;
    p.life-=dt;
    if(p.mesh.position.y<-0.5||p.life<=0){if(p.mesh.position.y<2)explosions.push(mkSplash(p.mesh.position.x,p.mesh.position.z));scene.remove(p.mesh);projectiles.splice(i,1);continue;}
    if(p.isPlayer){
      for(let e of enemies){if(e.sinking)continue;if(Math.hypot(p.mesh.position.x-e.mesh.position.x,p.mesh.position.z-e.mesh.position.z)<12&&Math.abs(p.mesh.position.y-e.mesh.position.y)<8){e.health-=p.damage;explosions.push(mkExplosion(p.mesh.position.x,p.mesh.position.y,p.mesh.position.z,0xff6633,12));scene.remove(p.mesh);projectiles.splice(i,1);if(e.health<=0){e.sinking=true;e.sinkTimer=0;P.kills++;addLog(`Sunk a ${e.name}!`);explosions.push(mkExplosion(e.mesh.position.x,3,e.mesh.position.z,0xff4400,25));}break;}}
    } else {
      let hitDist=P.onShip?14:3;
      if(Math.hypot(p.mesh.position.x-P.x,p.mesh.position.z-P.z)<hitDist&&P.invuln<=0){let dmg=Math.max(3,p.damage-P.hullArmor*2);P.health-=dmg;P.invuln=1;explosions.push(mkExplosion(p.mesh.position.x,p.mesh.position.y,p.mesh.position.z,0xff3300,10));scene.remove(p.mesh);projectiles.splice(i,1);camShake=0.4;if(P.health<=0){gameOver=true;document.getElementById('death-screen').style.display='flex';document.getElementById('death-stats').textContent=`Gold: ${P.gold} | Sunk: ${P.kills} | Treasures: ${P.treasures}`;}}
    }
  }

  // Explosions
  for(let i=explosions.length-1;i>=0;i--){let ex=explosions[i];ex.userData.life-=dt*2;let f=Math.max(0,ex.userData.life);ex.children.forEach(c=>{if(c.userData.vx!==undefined){c.position.x+=c.userData.vx*dt;c.position.y+=c.userData.vy*dt;c.position.z+=c.userData.vz*dt;c.userData.vy-=dt*4;}if(c.material&&c.material.opacity!==undefined)c.material.opacity=f;if(c.isLight)c.intensity=f*2;});if(f<=0){scene.remove(ex);explosions.splice(i,1);}}

  updateWake(dt);

  // Loot crates bob
  for(let i=lootCrates.length-1;i>=0;i--){let lc=lootCrates[i];lc.bobT+=dt;lc.life-=dt;let wh=getWaveH(lc.x,lc.z,time);lc.mesh.position.y=wh+0.8+Math.sin(lc.bobT*2)*0.3;lc.mesh.rotation.y+=dt*0.3;if(lc.life<=0){scene.remove(lc.mesh);lootCrates.splice(i,1);}}

  // Clouds drift
  // Clouds drift and wrap around player for infinite sky
  for(let c of clouds){
    c.position.x+=dt*2;
    // Keep clouds centered around the player
    if(c.position.x > P.x + WORLD*1.2) c.position.x -= WORLD*2.4;
    if(c.position.x < P.x - WORLD*1.2) c.position.x += WORLD*2.4;
    if(c.position.z > P.z + WORLD*1.2) c.position.z -= WORLD*2.4;
    if(c.position.z < P.z - WORLD*1.2) c.position.z += WORLD*2.4;
  }

  // Prompt
  if(promptTimer>0){promptTimer-=dt;document.getElementById('prompt-box').style.display='block';document.getElementById('prompt-box').textContent=promptText;document.getElementById('prompt-box').style.opacity=Math.min(1,promptTimer*3);}
  else{document.getElementById('prompt-box').style.display='none';}

  // ---- DUAL CAMERA SYSTEM ----
  // 1. Update camera state interpolation (ship ↔ on-foot)
  updateCamState(dt);
  updateIslandStreaming(dt);

  // 2. Shake
  if(camShake>0)camShake-=dt*2;
  let shakeX=camShake>0?(Math.random()-0.5)*camShake*2:0;
  let shakeY=camShake>0?(Math.random()-0.5)*camShake:0;

  // 3. Clamp user-adjusted camDist and camOrbitPitch to current limits
  camDist=Math.max(camState.minDist,Math.min(camState.maxDist,camDist));
  camOrbitPitch=Math.max(camState.minPitch,Math.min(camState.maxPitch,camOrbitPitch));

  // 4. Smoothly drive camDist toward the preset target
  //    (user can override with scroll, but it drifts back gently)
  const targetDist = camState.dist;
  camDist = lerpF(camDist, targetDist, dt * 1.2);

  // 5. Gently nudge pitch toward preset when user isn't dragging
  if(!mouseDown){
    camOrbitPitch = lerpF(camOrbitPitch, camState.pitch, dt * 0.8);
  }

  // 6. Ship: auto-follow behind ship heading
  if(P.onShip&&!mouseDown){
    let behindAngle=P.angle+Math.PI;
    camOrbitAngle=lerpAngle(camOrbitAngle,behindAngle,dt*2.5);
  }

  // 7. Compute look target with height offset
  let lookTargetY = P.onShip
    ? getWaveH(P.x,P.z,time) + 5
    : playerChar.position.y + 1;
  let lookTarget=new THREE.Vector3(P.x, lookTargetY, P.z);

  // 8. Compute camera position with shoulder offset
  let shoulderOff = camState.shoulderX;
  let shoulderAngle = camOrbitAngle + Math.PI / 2; // perpendicular to view direction
  let cx = lookTarget.x
    + Math.cos(camOrbitAngle) * Math.cos(camOrbitPitch) * camDist
    + Math.cos(shoulderAngle) * shoulderOff
    + shakeX;
  let cy = lookTarget.y
    + Math.sin(camOrbitPitch) * camDist
    + camState.heightOffset
    + shakeY;
  let cz = lookTarget.z
    + Math.sin(camOrbitAngle) * Math.cos(camOrbitPitch) * camDist
    + Math.sin(shoulderAngle) * shoulderOff;

  // 9. Floor camera height (don't dip below terrain)
  cy = Math.max(P.onShip ? 6 : lookTargetY + 2, cy);

  // 10. Apply with mode-dependent smoothing
  camera.position.lerp(new THREE.Vector3(cx, cy, cz), camState.followLerp);
  camTarget.lerp(lookTarget, camState.targetLerp);
  camera.lookAt(camTarget);
  sky.position.copy(camera.position);
  // Ocean follows player so water extends to horizon in all directions
  ocean.position.x = P.x; ocean.position.z = P.z;
  ocean2.position.x = P.x; ocean2.position.z = P.z;
  // Move sun shadow to follow player for consistent shadow coverage
  sun.position.set(P.x+400,600,P.z+300);
  sun.target.position.set(P.x,0,P.z);
  sun.target.updateMatrixWorld();

  // HUD
  document.getElementById('health-fill').style.width=(P.health/P.maxHealth*100)+'%';
  let hpPct=P.health/P.maxHealth;
  document.getElementById('health-fill').style.background=hpPct>0.5?'linear-gradient(90deg,#27ae60,#2ecc71)':hpPct>0.25?'linear-gradient(90deg,#e67e22,#f39c12)':'linear-gradient(90deg,#c0392b,#e74c3c)';
  let cannonPct=P.onShip?Math.max(0,1-P.cannonCD/P.maxCannonCD):1;
  document.getElementById('cannon-fill').style.width=(cannonPct*100)+'%';
  document.getElementById('cannon-bar').style.display=P.onShip?'block':'none';

  let waVal=P.onShip?Math.cos(wind.angle-P.angle):0;
  let wLbl=waVal>0.3?'TAILWIND':waVal<-0.3?'HEADWIND':'CROSSWIND';
  document.getElementById('wind-info').innerHTML=P.onShip?`WIND: ${wLbl} · ${(wind.speed*100).toFixed(0)}%`:'';

  let sailInd=document.getElementById('sail-indicator');
  if(P.onShip){sailInd.style.display='block';sailInd.innerHTML=`SAILS: ${P.sailsUp?'<span style="color:#2ecc71">RAISED</span>':'<span style="color:#888">FURLED</span>'} [R]`;}else{sailInd.style.display='none';}

  document.getElementById('hud').innerHTML=
    `<span class="hlbl">Gold</span> <span class="hval" style="color:#ffd700">${P.gold}</span><br>`+
    (P.onShip?`<span class="hlbl">Speed</span> <span class="hval">${P.speed.toFixed(1)}</span><br>`+
    `<span class="hlbl">Throttle</span> <span class="hval">${(Math.max(0,P.throttle)*100).toFixed(0)}%</span><br>`:'')+
    `<span class="hlbl">Wood</span> <span class="hval" style="color:#c49a6c">${P.wood}</span><br>`+
    `<span class="hlbl">Iron</span> <span class="hval" style="color:#a0b0c0">${P.iron}</span><br>`+
    `<span class="hlbl">Tools</span> <span class="hval" style="color:#88ccff">${P.tools}</span><br>`+
    (P.hasShovel?`<span class="hlbl" style="color:#ff9944">⛏ Shovel</span><br>`:'')+
    `<span class="hlbl">Kills</span> <span class="hval">${P.kills}</span><br>`+
    `<span class="hlbl">Treasures</span> <span class="hval">${P.treasures}</span>`+
    (P.treasureMaps>0?`<br><span class="hlbl" style="color:#ffdd44">Maps</span> <span class="hval">${P.treasureMaps}</span>`:'');

  let lH='';for(let i=0;i<logs.length;i++)lH+=`<div style="opacity:${1-i*0.25}">${logs[i]}</div>`;
  document.getElementById('log').innerHTML=lH;

  let heading=(((-P.angle*180/Math.PI)%360)+360)%360;
  let dirs=['N','NE','E','SE','S','SW','W','NW'];
  document.getElementById('compass').innerHTML=P.onShip?`${dirs[Math.round(heading/45)%8]} · ${heading.toFixed(0)}°`:'';

  // Minimap — player-centered (infinite world, no edges visible)
  const mc=document.getElementById('mm').getContext('2d');
  mc.fillStyle='#0a1825';mc.fillRect(0,0,150,150);
  const mmRange = P.onShip ? 2000 : 600; // visible radius on minimap
  const mmScale = 75 / mmRange; // pixels per world unit (center at 75,75)
  // Grid lines
  mc.strokeStyle='rgba(100,150,200,0.06)';mc.lineWidth=0.5;
  const gridStep = P.onShip ? 500 : 150;
  for(let g = -mmRange; g <= mmRange; g += gridStep){
    let gx = 75 + (g - ((P.x % gridStep) - gridStep/2 + gridStep) % gridStep + gridStep/2) * mmScale;
    // Simplified: just draw a few grid lines
  }
  // Islands (wrapped relative to player)
  for(let isl of islands){
    let dx = wrapDelta(isl.x - P.x), dz = wrapDelta(isl.y - P.z);
    if(Math.abs(dx) > mmRange || Math.abs(dz) > mmRange) continue;
    mc.fillStyle=isl.hasTreasure&&!isl.treasureCollected?'#c2a66b':isl.hasShop?'#5a8a5a':'#3a5a3a';
    mc.beginPath();mc.arc(75+dx*mmScale, 75+dz*mmScale, Math.max(2, isl.r*mmScale), 0, Math.PI*2);mc.fill();
  }
  // Enemies (wrapped)
  for(let e of enemies){
    if(e.sinking) continue;
    let dx = wrapDelta(e.x - P.x), dz = wrapDelta(e.z - P.z);
    if(Math.abs(dx) > mmRange || Math.abs(dz) > mmRange) continue;
    mc.fillStyle=['#cc6633','#cc3333','#ff2222'][e.tier];
    mc.fillRect(75+dx*mmScale-2, 75+dz*mmScale-2, 4, 4);
  }
  // Loot crates (wrapped)
  for(let lc of lootCrates){
    let dx = wrapDelta(lc.x - P.x), dz = wrapDelta(lc.z - P.z);
    if(Math.abs(dx) > mmRange || Math.abs(dz) > mmRange) continue;
    mc.fillStyle='#daa520';mc.fillRect(75+dx*mmScale-1.5, 75+dz*mmScale-1.5, 3, 3);
  }
  // Player always at center
  mc.fillStyle=P.onShip?'#ffe4a1':'#88ff88';mc.beginPath();mc.arc(75, 75, 3, 0, Math.PI*2);mc.fill();
  if(P.onShip){mc.fillStyle='#ffe4a1';mc.save();mc.translate(75, 75);mc.rotate(P.angle);mc.fillRect(0,-1,8,2);mc.restore();}
  // Wind arrow
  mc.strokeStyle='rgba(100,200,255,0.4)';mc.lineWidth=1.5;mc.save();mc.translate(130,130);mc.rotate(wind.angle);mc.beginPath();mc.moveTo(-8,0);mc.lineTo(8,0);mc.moveTo(4,-3);mc.lineTo(8,0);mc.lineTo(4,3);mc.stroke();mc.restore();

  // Island labels
  for(let isl of islands){let d=Math.hypot(wrapDelta(P.x-isl.x),wrapDelta(P.z-isl.y));if(d<isl.r+50&&!P.onShip){
    let label=isl.name+' ('+isl.type+')';let action='';
    if(isl.hasTreasure&&!isl.treasureCollected)action='[E] Search for Treasure';
    else if(isl.hasFortChest&&!isl.fortChestLooted)action='[E] Open Fort Chest';
    else if(isl.hasCastleChest&&!isl.castleChestLooted)action='[E] Open Castle Chest';
    else if(isl.hasBuried&&!isl.buriedLooted){let bx=isl.x+isl.buriedX,bz=isl.y+isl.buriedZ;if(Math.hypot(P.x-bx,P.z-bz)<12)action=P.hasShovel?'[E] Dig Buried Treasure':'Buried treasure (need Shovel)';}
    else if(isl.hasShop)action=`[E] Repair Ship (${isl.repairCost}g)`;
    else if(isl.hasUpgrade)action=P.shipUpgraded?'Ship fully upgraded!':`[E] Upgrade Ship (500g + 50 iron)`;
    if(action)showPrompt(`${label} — ${action}`,0.2);
    else if(d<isl.r+20)showPrompt(label,0.2);
  }}

  // Enemy HUD
  let ehud=document.getElementById('enemy-hud');let ehHtml='';
  for(let e of enemies){
    if(e.sinking)continue;let d=Math.hypot(P.x-e.x,P.z-e.z);if(d>400)continue;
    let v=new THREE.Vector3(e.x,e.mesh.position.y+18,e.z);v.project(camera);
    if(v.z>1)continue;let sx=(v.x*0.5+0.5)*W,sy=(-v.y*0.5+0.5)*H;
    if(sx<0||sx>W||sy<0||sy>H)continue;
    let hp=(e.health/e.maxHealth*100);let barCol=hp>50?'#27ae60':hp>25?'#e67e22':'#c0392b';
    ehHtml+=`<div class="enemy-name" style="left:${sx-25}px;top:${sy-16}px">${e.name}</div>`;
    ehHtml+=`<div class="enemy-hp" style="left:${sx-25}px;top:${sy-4}px"><div class="enemy-hp-fill" style="width:${hp}%;background:${barCol}"></div></div>`;
  }
  ehud.innerHTML=ehHtml;
}

// ============ LOOP ============
let lastT=0;
function loop(now){
  requestAnimationFrame(loop);
  let dt=Math.min((now-lastT)/1000,0.05);lastT=now;
  if(gameStarted){update(dt);animOcean(time);}
  renderer.render(scene,camera);
}

function startGameFresh(){
  console.info('[Init] Starting game via Play button...');
  const ts = document.getElementById('title-screen');
  if(ts) ts.style.opacity='0';
  if(ts) setTimeout(()=>ts.style.display='none',1200);
  
  // Hide the loading screen canvas
  if(window.LoadingScreen) window.LoadingScreen.hide();
  // Hide the play button
  const pb = document.getElementById('play-btn');
  if(pb) pb.style.display = 'none';

  gameStarted=true;initGame();
  if(window.AssetPipeline) initAssetPipeline();
}
window.startGameFresh = startGameFresh;

const pb = document.getElementById('play-btn');
if (pb) {
  pb.addEventListener('click',()=>{
    console.log('[Play] Ready to Set Sail...');
    startGameFresh();
  });
} else {
  console.warn('[Warning] #play-btn not found at initialization.');
}
const restartBtn = document.getElementById('restart-btn');
if(restartBtn) restartBtn.addEventListener('click',()=>{
  clearSavedState();
  initGame();
});

// AUTO-RESUME: If returning from an island visit, skip title and restore state
(function checkAutoResume(){
  const saved = loadGameState();
  if(!saved) return;
  console.log('[Resume] Restoring game state from island visit...');
  // Apply seed + stats BEFORE initGame so islands match
  applyGameState(saved);
  // Skip title screen immediately
  const ts = document.getElementById('title-screen');
  if(ts) ts.style.display='none';
  if(window.LoadingScreen) window.LoadingScreen.hide();
  gameStarted = true;
  initGame();
  // Re-apply player state AFTER initGame (which calls resetPlayer)
  applyGameState(saved);
  // Position ship at saved location
  if(shipMesh){ shipMesh.position.set(P.x, 0, P.z); shipMesh.rotation.y = P.angle; }
  if(window.AssetPipeline) initAssetPipeline();
  addLog('Returning from ' + (saved.islandProgress ? 'island visit' : 'shore') + '...');
  // Clear the save so a normal refresh shows title screen
  clearSavedState();
})();
requestAnimationFrame(loop);

// ============================================================
// ASSET PIPELINE INTEGRATION
// Connects the external asset services to the game world.
// The pipeline runs asynchronously — the game is playable
// immediately with procedural fallbacks, and external assets
// are swapped in as they load.
// ============================================================

let assetPipelineActive=false;
let assetDebugEnabled=false;
let placedAssets=[]; // track all pipeline-placed assets for cleanup

// Toggle debug overlay with backtick key
window.addEventListener('keydown',e=>{
  if(e.key==='`'){
    assetDebugEnabled=!assetDebugEnabled;
    document.getElementById('asset-debug').style.display=assetDebugEnabled?'block':'none';
  }
});

function updateLoadingBar(pct,text){
  const overlay=document.getElementById('loading-overlay');
  const fill=document.getElementById('loading-fill');
  const label=document.getElementById('loading-text');
  if(pct>=0){
    overlay.style.display='flex';
    fill.style.width=pct+'%';
    if(text)label.textContent=text;
  }
  if(pct>=100){
    setTimeout(()=>{overlay.style.display='none';},800);
  }
}

function updateAssetDebug(info){
  if(!assetDebugEnabled)return;
  const el=document.getElementById('asset-debug');
  el.innerHTML=info;
}

/** Initialize the asset pipeline after game start.
 *  PLAY MODE (no proxy): uses curated fallback geometry only — fast, no API calls.
 *  INGEST MODE (proxy available): full API services for fetching external assets.
 */
async function initAssetPipeline(){
  if(assetPipelineActive)return;
  assetPipelineActive=true;

  const AP=window.AssetPipeline;
  const PL=window.PlacementSystem;
  if(!PL){
    console.warn('PlacementSystem not loaded — skipping pipeline.');
    return;
  }

  console.info('[AssetPipeline] Initializing...');
  updateLoadingBar(5,'Initializing...');

  // Check proxy availability
  let proxyAvailable=false;
  try{
    proxyAvailable=!!await Promise.race([
      fetch('http://localhost:3001/api/health').then(r=>r.ok),
      new Promise(r=>setTimeout(()=>r(false),1500))
    ]);
  }catch(e){}

  // ── PLAY MODE: fast path, no API services ──
  if(!proxyAvailable){
    console.info('[AssetPipeline] PLAY MODE — curated fallback geometry, no API calls');
    updateLoadingBar(10,'Placing island props...');

    const placer=new PL.AssetPlacementService({});
    window.gameAssetServices={placer};

    let completedIslands=0;
    for(let i=0;i<islands.length;i++){
      const isl=islands[i];
      const seed=hashSeed(isl.name+isl.x+isl.y);
      const mappedIsland={
        position:{x:isl.x,z:isl.y},radius:isl.r,type:isl.type,name:isl.name,
        seed:seed,
        hasFort:isl.hasFort,hasShop:isl.hasShop,hasTower:isl.hasTower,
        hasHuts:isl.hasHuts,hasCastle:isl.hasCastle,hasUpgrade:isl.hasUpgrade,
        hasTreasure:isl.hasTreasure
      };
      try{
        const zones=new PL.IslandZoneMapper().mapZones(mappedIsland);
        const plans=placer.planPlacements(mappedIsland,zones,seed);
        const placed=await placer.executePlacements(plans,scene);
        placedAssets.push(...placed);
        completedIslands++;
        const pct=10+((completedIslands/islands.length)*85);
        updateLoadingBar(pct,`${isl.name}: ${placed.length} props`);
        console.info(`[AssetPipeline] ${isl.name} (${isl.type}): ${placed.length} props`);
      }catch(err){
        console.warn(`[AssetPipeline] Failed for ${isl.name}:`,err);
      }
      await new Promise(r=>setTimeout(r,4));
    }

    updateLoadingBar(98,'Building reveal system...');
    buildIslandAssetRegistry();
    updateLoadingBar(100,'World ready!');
    console.info(`[AssetPipeline] PLAY MODE complete. ${placedAssets.length} props across ${islands.length} islands.`);
    return;
  }

  // ── INGEST MODE: full API pipeline ──
  console.info('[AssetPipeline] INGEST MODE — proxy available, full API pipeline');
  if(!AP){
    console.warn('AssetPipeline module not loaded — falling back to play mode.');
    proxyAvailable=false;
    // Re-run as play mode
    assetPipelineActive=false;
    return initAssetPipeline();
  }

  const cache=new AP.AssetCache();
  const registry=new AP.AssetMetadataRegistry();
  const scorer=new AP.AssetScoringService();
  const searcher=new AP.AssetSearchService(cache,scorer);
  const downloader=new AP.AssetDownloadService(cache);
  const textureImporter=new AP.TextureImportService(downloader);
  const modelImporter=new AP.ModelImportService(downloader);
  const characterImporter=new AP.CharacterImportService(modelImporter);
  const npcService=new AP.NPCPopulationService(characterImporter,searcher);
  const inventoryService=new AP.InventoryModelService(searcher,modelImporter);
  const disasterService=new AP.DisasterAssetService(searcher,modelImporter);
  const weatherService=new AP.WeatherVisualService(scene);

  const zoneMapper=new PL.IslandZoneMapper();
  const placer=new PL.AssetPlacementService({
    assetSearchService:searcher,modelImportService:modelImporter,
    metadataRegistry:registry
  });

  window.gameAssetServices={
    cache,registry,scorer,searcher,downloader,
    textureImporter,modelImporter,characterImporter,
    npcService,inventoryService,disasterService,weatherService,
    zoneMapper,placer
  };

  updateLoadingBar(10,'Mapping island zones...');

  let completedIslands=0;
  for(let i=0;i<islands.length;i++){
    const isl=islands[i];
    const seed=hashSeed(isl.name+isl.x+isl.y);
    const mappedIsland={
      position:{x:isl.x,z:isl.y},radius:isl.r,type:isl.type,name:isl.name,
      seed:seed,
      hasFort:isl.hasFort,hasShop:isl.hasShop,hasTower:isl.hasTower,
      hasHuts:isl.hasHuts,hasCastle:isl.hasCastle,hasUpgrade:isl.hasUpgrade,
      hasTreasure:isl.hasTreasure
    };
    try{
      const zones=zoneMapper.mapZones(mappedIsland);
      const plans=placer.planPlacements(mappedIsland,zones,seed);
      const placed=await placer.executePlacements(plans,scene);
      placedAssets.push(...placed);
      completedIslands++;
      const pct=10+((completedIslands/islands.length)*70);
      updateLoadingBar(pct,`${isl.name}: ${placed.length} props (anchored clusters)`);
      console.info(`[AssetPipeline] ${isl.name} (${isl.type}): ${placed.length} props`);
    }catch(err){
      console.warn(`[AssetPipeline] Failed for ${isl.name}:`,err);
    }
    await new Promise(r=>setTimeout(r,4));
  }

  if(textureImporter){
    updateLoadingBar(85,'Loading terrain textures...');
    try{ await applyTerrainTextures(textureImporter,registry); }
    catch(err){ console.warn('[AssetPipeline] Terrain textures failed:',err); }
  }

  updateLoadingBar(92,'Setting up weather...');
  weatherService.applyWeather(scene,{state:'clear',windAngle:wind.angle,windSpeed:wind.speed});

  updateLoadingBar(96,'Enhancing disasters...');
  try{
    for(const type of ['whirlpool','tornado','typhoon']){
      await disasterService.getDisasterVisuals(type);
    }
  }catch(err){ console.warn('[AssetPipeline] Disaster assets:',err); }

  updateLoadingBar(98,'Building reveal system...');
  buildIslandAssetRegistry();
  updateLoadingBar(100,'World ready!');
  console.info(`[AssetPipeline] INGEST MODE complete. ${placedAssets.length} assets across ${islands.length} islands.`);

  const attr=registry.exportAttribution();
  if(attr)console.info('[AssetPipeline] Attribution:\n'+attr);
}

/** Apply PBR materials to island terrain from ambientCG/Poly Haven */
async function applyTerrainTextures(textureImporter,registry){
  const terrainMappings=[
    {search:'beach sand',target:'beach',layers:[1]},
    {search:'brown dirt ground',target:'dirt',layers:[2]},
    {search:'grass ground',target:'grass',layers:[3]},
    {search:'rock cliff',target:'rock',layers:[0,4]},
  ];

  for(const mapping of terrainMappings){
    try{
      const texSet=await textureImporter.searchAndImport(mapping.search,'terrain');
      if(texSet&&texSet.albedo){
        // Apply to matching island layers
        for(const islGroup of islMeshes){
          islGroup.traverse(child=>{
            if(child.isMesh&&child.userData.terrainLayer!==undefined){
              if(mapping.layers.includes(child.userData.terrainLayer)){
                if(texSet.albedo)child.material.map=texSet.albedo;
                if(texSet.normal)child.material.normalMap=texSet.normal;
                if(texSet.roughness)child.material.roughnessMap=texSet.roughness;
                child.material.needsUpdate=true;
              }
            }
          });
        }
        registry.register({
          id:mapping.search,source:'texture',title:mapping.search,
          category:'terrain',zoneTag:mapping.target
        });
      }
    }catch(err){
      console.warn(`[Textures] Failed to load ${mapping.search}:`,err);
    }
  }
}

/** Simple string hash for deterministic seeds */
function hashSeed(str){
  let h=0;
  for(let i=0;i<str.length;i++){
    h=((h<<5)-h)+str.charCodeAt(i);
    h|=0;
  }
  return Math.abs(h);
}

/** Hook: Update weather service each frame (called from update loop) */
const _origUpdate=update;
// We patch the update function to include weather and asset debug updates
const _patchedUpdate=function(dt){
  _origUpdate(dt);
  if(window.gameAssetServices){
    const ws=window.gameAssetServices.weatherService;
    if(ws)ws.updateWeather(dt);

    // Update debug overlay
    if(assetDebugEnabled&&window.gameAssetServices.registry){
      const reg=window.gameAssetServices.registry;
      const entries=reg.entries||[];
      let html=`<b>Assets: ${placedAssets.length}</b> | Sources: `;
      const sources={};
      entries.forEach(e=>{sources[e.source]=(sources[e.source]||0)+1;});
      html+=Object.entries(sources).map(([k,v])=>`${k}:${v}`).join(' ');
      updateAssetDebug(html);
    }
  }
};
// Replace update reference in the loop
// (The loop calls update(dt) directly, so we reassign)
// This is done by overwriting the global 'update' variable
update=_patchedUpdate;

