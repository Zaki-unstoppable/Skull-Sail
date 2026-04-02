(function(){
'use strict';
let R,S,C,CK,_run=false,_lp=0,_lt=0;
let _uTime = { value: 0 };
var _msgs=['Charting the seas...','Hoisting the sails...','Loading cannons...','Brewing grog...','Counting doubloons...','Anchors aweigh...'];
var _mi=0,_mt=0;

function _init(){
  var el=document.getElementById('loading-container');
  if(!el)return false;
  R=new THREE.WebGLRenderer({antialias:true});
  R.setSize(window.innerWidth,window.innerHeight);
  R.setPixelRatio(Math.min(window.devicePixelRatio,2));
  el.insertBefore(R.domElement,el.firstChild);
  R.domElement.style.position='absolute';
  R.domElement.style.top='0';
  R.domElement.style.left='0';

  S=new THREE.Scene();
  C=new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  CK=new THREE.Clock();

  var defaultMat = new THREE.MeshBasicMaterial({color: 0x001122});
  var geo = new THREE.PlaneGeometry(2, 2);
  var mesh = new THREE.Mesh(geo, defaultMat);
  S.add(mesh);

  var texLoader = new THREE.TextureLoader();
  // Using the newly generated AI Image
  texLoader.load('loading_bg_ai.png', function(tex) {
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      
      var shaderMat = new THREE.ShaderMaterial({
        uniforms: {
          uTex: { value: tex },
          uTime: _uTime,
          uTexAspect: { value: 16/9 },
          uRes: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) }
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D uTex;
          uniform float uTime;
          uniform vec2 uRes;
          uniform float uTexAspect;
          varying vec2 vUv;

          void main() {
            float screenAspect = uRes.x / uRes.y;
            vec2 coverUv = vUv - 0.5;
            
            if (screenAspect > uTexAspect) {
                 coverUv.y *= uTexAspect / screenAspect;
            } else {
                 coverUv.x *= screenAspect / uTexAspect;
            }
            coverUv += 0.5;
            
            vec2 uv = coverUv;

            // 0. Slow Parallax Breathing (Affects Full Screen)
            vec2 p = uv - 0.5;
            p *= 0.98 + sin(uTime * 0.6) * 0.015;  
            p.x += sin(uTime * 0.4) * 0.005;
            p.y += cos(uTime * 0.5) * 0.005;
            uv = p + 0.5;

            // 1. Tree Sway (Top-Left)
            float treeMask = (1.0 - smoothstep(0.1, 0.4, uv.x)) * smoothstep(0.4, 1.0, uv.y);
            uv.x += sin(uTime * 1.5 + uv.y * 3.0) * 0.015 * treeMask;

            // 2. Ship Bobbing (Center Distance)
            float shipMask = (1.0 - smoothstep(0.0, 0.25, abs(uv.x - 0.5))) * (1.0 - smoothstep(0.0, 0.15, abs(uv.y - 0.45)));
            uv.y += sin(uTime * 2.5) * 0.006 * shipMask;

            // 3. Central Ocean Ripple (STRICTLY masked out the bottom left to protect treasure chests)
            float waterMask = smoothstep(0.45, 0.1, uv.y) * smoothstep(0.1, 0.35, uv.x);
            if (waterMask > 0.0) {
               float waveX = sin(uv.x * 40.0 + uTime * 2.0) * 0.004;
               float waveY = cos(uv.y * 50.0 - uTime * 2.5) * 0.003;
               uv.x += waveX * waterMask;
               uv.y += waveY * waterMask;
            }

            vec4 color = texture2D(uTex, uv);

            // 4. Glint Overlay on the Bottom-Left Treasure Area
            float goldMask = (1.0 - smoothstep(0.25, 0.45, uv.x)) * (1.0 - smoothstep(0.1, 0.3, uv.y));
            float glint = pow(abs(sin(uv.x * 200.0 + uTime * 4.0) * cos(uv.y * 200.0 - uTime * 3.0)), 30.0);
            
            // Subtle glowing warmth 
            vec2 sunCenter = vec2(0.5, 0.8);
            float dSun = length(uv - sunCenter);
            float sunGlow = smoothstep(0.8, 0.0, dSun) * 0.1;

            color.rgb += vec3(1.0, 0.9, 0.4) * sunGlow;
            color.rgb += vec3(1.0, 0.9, 0.6) * glint * goldMask;

            gl_FragColor = color;
          }
        `
      });
      mesh.material = shaderMat;
      console.info("[LoadingScreen] Loading New AI Generated Image.");
  }, undefined, function(err) {
      console.error("[LoadingScreen] Texture loading failed. Likely a CORS error from opening file:/// directly.", err);
  });

  window.addEventListener('resize',_onR);
  _run=true;_anim();return true;
}

function _onR(){
  if(!R)return;
  R.setSize(window.innerWidth,window.innerHeight);
  if(S && S.children[0] && S.children[0].material.uniforms) {
      S.children[0].material.uniforms.uRes.value.set(window.innerWidth, window.innerHeight);
  }
}

function _anim(){
  if(!_run)return;requestAnimationFrame(_anim);
  var t=CK.getElapsedTime();
  _uTime.value = t;

  _lp+=(_lt-_lp)*.05;
  var bar=document.getElementById('load-bar-fill');if(bar)bar.style.width=(_lp*100)+'%';
  var pc=document.getElementById('load-pct');if(pc)pc.textContent=Math.floor(_lp*100)+'%';
  _mt+=.016;if(_mt>2.5){_mt=0;_mi=(_mi+1)%_msgs.length;
    var mg=document.getElementById('load-msg');if(mg)mg.textContent=_msgs[_mi];}
  R.render(S,C);
}

window.LoadingScreen={
  start:function(){if(_init())console.info('[LoadingScreen] 2D Animated Picture Layer starting...');},
  setProgress:function(p,msg){_lt=Math.min(p,1);if(msg){var e=document.getElementById('load-msg');if(e)e.textContent=msg;}},
  hide:function(){_lt=1;setTimeout(function(){var el=document.getElementById('loading-container');
    if(el){el.style.transition='opacity 1.2s';el.style.opacity='0';
      setTimeout(function(){el.style.display='none';_run=false;
        if(R){R.dispose();R.forceContextLoss();R=null;}S=null;C=null;},1300);}},400);}
};
})();
