(function(){
'use strict';
let R,S,C,CK,_oU,_palms=[],_ship,_run=false,_lp=0,_lt=0;
var _msgs=['Charting the seas...','Hoisting the sails...','Loading cannons...','Brewing grog...','Counting doubloons...','Anchors aweigh...'];
var _mi=0,_mt=0;

function _init(){
  var el=document.getElementById('loading-container');
  if(!el)return false;
  R=new THREE.WebGLRenderer({antialias:true});
  R.setSize(window.innerWidth,window.innerHeight);
  R.setPixelRatio(Math.min(window.devicePixelRatio,2));
  R.toneMapping=THREE.ACESFilmicToneMapping;
  R.toneMappingExposure=1.5;
  R.shadowMap.enabled=true;
  R.shadowMap.type=THREE.PCFSoftShadowMap;
  el.insertBefore(R.domElement,el.firstChild);
  R.domElement.style.position='absolute';
  R.domElement.style.top='0';R.domElement.style.left='0';

  S=new THREE.Scene();
  S.background=new THREE.Color(0x99ddff);
  S.fog=new THREE.FogExp2(0x99ddff, 0.00025);
  
  C=new THREE.PerspectiveCamera(48,window.innerWidth/window.innerHeight,0.1,5000);
  C.position.set(-10, 2.5, 30); C.lookAt(15, 3, -45); 
  CK=new THREE.Clock();

  _sky();_light();_ocean();_texturedSand();_jaggedMountain();_sculptedSkullAndTreasure();_palmTrees();_pirateGalleonDetailed();_clouds();
  
  window.addEventListener('resize',_onR);
  _run=true;_anim();return true;
}

function _onR(){
  if(!R)return;
  R.setSize(window.innerWidth,window.innerHeight);
  C.aspect=window.innerWidth/window.innerHeight;
  C.updateProjectionMatrix();
}

function _sky(){
  var g=new THREE.SphereGeometry(3000,32,24);
  var m=new THREE.ShaderMaterial({side:THREE.BackSide,
    vertexShader:'varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader:`varying vec3 vD;void main(){
      float y=vD.y;
      vec3 zen=vec3(.05,.35,.85),mid=vec3(.3,.7,1.),low=vec3(.6,1.,1.),hor=vec3(.9,1.,1.);
      vec3 c;
      if(y>.4)c=mix(mid,zen,smoothstep(.4,1.,y));
      else if(y>.1)c=mix(low,mid,smoothstep(.1,.4,y));
      else c=mix(hor,low,smoothstep(-.08,.1,y));
      vec3 sd=normalize(vec3(.4,.3,-1.));float d=max(0.,dot(vD,sd));
      c+=vec3(.5,.3,.1)*pow(d,4.)*.6;
      c+=vec3(1.,.95,.8)*pow(d,128.)*1.2;
      gl_FragColor=vec4(c,1.);}`
  });
  S.add(new THREE.Mesh(g,m));
}

function _light(){
  S.add(new THREE.AmbientLight(0xaaddff,0.65));
  S.add(new THREE.HemisphereLight(0xaaddff,0x886633,0.4));
  var sun=new THREE.DirectionalLight(0xfff5e0,2.4);
  sun.position.set(70,90,-160);sun.castShadow=true;
  sun.shadow.mapSize.set(2048,2048);
  var sc=sun.shadow.camera;sc.near=1;sc.far=400;sc.left=-200;sc.right=200;sc.top=200;sc.bottom=-200;
  S.add(sun);
}

function _ocean(){
  var g=new THREE.PlaneGeometry(2500,2500,128,128);
  _oU={uTime:{value:0},uSunDir:{value:new THREE.Vector3(.4,.3,-1).normalize()}};
  var m=new THREE.ShaderMaterial({uniforms:_oU,transparent:true,side:THREE.DoubleSide,
    vertexShader:`varying vec3 vW;varying vec3 vN;uniform float uTime;
      void main(){vec3 p=position;vec4 wp=modelMatrix*vec4(p,1.);float ax=wp.x,az=wp.z,t=uTime*.2;
      float w=sin(ax*.03+t*2.8)*.45+sin(az*.025+t*3.5)*.65+sin((ax+az)*.02+t*1.8)*.35;
      p.z=w;vW=(modelMatrix*vec4(p,1.)).xyz;
      float dx=cos(ax*.03+t*2.8)*.03*.45;float dz=cos(az*.025+t*3.5)*.025*.65;
      vN=normalize(vec3(-dx,1.,-dz));gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
    fragmentShader:`varying vec3 vW;varying vec3 vN;uniform float uTime;uniform vec3 uSunDir;
      void main(){vec3 dp=vec3(0.0,.3,.6),md=vec3(0.0,.6,.85),br=vec3(0.1,.9,1.0),surf=vec3(1.);
      vec3 c=mix(dp,md,0.5+vN.y*0.5);float t=uTime*0.2;vec2 p=vW.xz;
      float ca=abs(sin(p.x*0.06+t)*cos(p.y*0.05+t*0.8))*0.65+abs(sin(p.x*0.1-t*0.6)*cos(p.y*0.08+t*0.4))*0.35;
      c=mix(c,br,ca*0.65);
      float shoreline=smoothstep(15.0, -5.0, vW.z); 
      float noise=abs(sin(vW.x*0.4+uTime)*cos(vW.z*0.7-uTime*1.2));
      c=mix(c, surf, shoreline*noise*0.75);
      vec3 vd=normalize(cameraPosition-vW);vec3 hd=normalize(uSunDir+vd);
      float sp=pow(max(dot(vN,hd),0.0),160.0);c+=vec3(1.,1.,.85)*sp*1.2;
      float f=pow(1.-max(dot(vN,vd),0.),3.);c=mix(c,vec3(.7,1.,1.),f*0.6);
      float ds=length(cameraPosition-vW);float fg=1.-exp(-ds*0.0008);c=mix(c,vec3(.85,.98,1.),fg);
      gl_FragColor=vec4(c,0.96);}`
  });
  var o=new THREE.Mesh(g,m);o.rotation.x=-Math.PI/2;o.position.y=-.5;S.add(o);
}

function _texturedSand(){
  var g=new THREE.PlaneGeometry(300,100,100,50),p=g.attributes.position;
  for(var i=0;i<p.count;i++){var x=p.getX(i),y=p.getY(i);
    var h=-y*.15 + Math.sin(x*.15)*.5 + Math.sin(x*.4+y*.3)*.6;
    if(y<-12) h+=(y+12)*.18; p.setZ(i,h);}
  g.computeVertexNormals();
  var s=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0xdcb35c,roughness:1,metalness:0}));
  s.rotation.x=-Math.PI/2;s.position.set(0,-.3,25);s.receiveShadow=true;s.receiveShadow=true;S.add(s);
}

function _jaggedMountain(){
  var gr=new THREE.Group();
  var rmat1=new THREE.MeshStandardMaterial({color:0x5a544a,roughness:1}); 
  var rmat2=new THREE.MeshStandardMaterial({color:0x7a7465,roughness:1}); 
  var rmat3=new THREE.MeshStandardMaterial({color:0x4a453f,roughness:1}); 
  for(var i=0;i<45;i++){
    var r=2+Math.random()*12;
    var mat=[rmat1,rmat2,rmat3][Math.floor(Math.random()*3)];
    var p=new THREE.Mesh(new THREE.IcosahedronGeometry(r,0), mat); 
    var x=Math.random()*30-15, y=Math.random()*15-5, z=Math.random()*25-12;
    p.position.set(x,y,z);
    p.scale.set(1+Math.random()*.5, 2+Math.random()*4, 1+Math.random()*.5);
    p.rotation.set(Math.random(),Math.random(),Math.random());
    p.castShadow=true; p.receiveShadow=true; gr.add(p);
  }
  var vmat=new THREE.MeshStandardMaterial({color:0x1b5e20,roughness:1});
  for(var i=0;i<50;i++){
    var v=new THREE.Mesh(new THREE.SphereGeometry(2+Math.random()*5,6,6), vmat);
    v.position.set(Math.random()*40-20, 20+Math.random()*40, Math.random()*25-12);
    gr.add(v);
  }
  gr.position.set(120, -5, -180); gr.scale.setScalar(1.2); S.add(gr);
}

function _sculptedSkullAndTreasure(){
  var gr=new THREE.Group();
  var wmat=new THREE.MeshStandardMaterial({color:0x3a1005,roughness:.9});
  var gmat=new THREE.MeshStandardMaterial({color:0xffcc00,metalness:1,roughness:.1});
  var cmat=new THREE.MeshStandardMaterial({color:0xeeeeee,roughness:.7});

  // Sculpted Skull
  var sk=new THREE.Group();
  var cranium=new THREE.Mesh(new THREE.SphereGeometry(.5, 16, 12), cmat); sk.add(cranium);
  var jaw=new THREE.Mesh(new THREE.BoxGeometry(.4, .35, .38), cmat); jaw.position.set(0,-.3,.12); sk.add(jaw);
  // Eye Sockets
  [ -.15, .15 ].forEach(x=>{
    var sock=new THREE.Mesh(new THREE.SphereGeometry(.14, 8, 8), new THREE.MeshBasicMaterial({color:0x000000}));
    sock.position.set(x, 0.05, .4); sk.add(sock);
  });
  // Nasal Cavity
  var nose=new THREE.Mesh(new THREE.ConeGeometry(.08, .12, 4), new THREE.MeshBasicMaterial({color:0x000000}));
  nose.position.set(0, -.12, .45); nose.rotation.x=0.4; sk.add(nose);
  // Cheekbones
  [ -.25, .25 ].forEach(x=>{
    var ch=new THREE.Mesh(new THREE.SphereGeometry(.12, 6, 6), cmat);
    ch.position.set(x, -.1, .3); sk.add(ch);
  });
  
  sk.position.set(-6, .4, 8); sk.rotation.set(-.4, .8, 0); sk.castShadow=true; gr.add(sk);

  var makeChest=(w,h,d)=>{
    var c=new THREE.Group();
    var b=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),wmat); b.position.y=h/2; c.add(b);
    var lid=new THREE.Mesh(new THREE.CylinderGeometry(d/2,d/2,w,12,1,false,0,Math.PI),wmat);
    lid.rotation.z=Math.PI/2; lid.position.y=h; c.add(lid);
    [-w/2.4, w/2.4].forEach(x=>{
      var bd=new THREE.Mesh(new THREE.BoxGeometry(.15, h+d/2.5, d+.1),gmat);
      bd.position.set(x,h/2,0); c.add(bd);
    });
    return c;
  };

  var c1=makeChest(2.2, 1.2, 1.4); c1.position.set(0,0,0); gr.add(c1);
  var c2=makeChest(1.8, 1, 1.2); c2.position.set(2.8,0,.8); c2.rotation.y=-.4; gr.add(c2);
  var c3=makeChest(1.6, .9, 1.1); c3.position.set(-1.2, .9, -.5); c3.rotation.set(.3,.5,.1); gr.add(c3);

  // Gold coins
  var cg=new THREE.CylinderGeometry(.12, .12, .02, 8);
  for(var i=0;i<450;i++){
    var cn=new THREE.Mesh(cg,gmat);
    var r=Math.random()*5; var a=Math.random()*Math.PI*2;
    cn.position.set(-3+Math.cos(a)*r, -.22, 5+Math.sin(a)*r);
    cn.rotation.set(Math.random(),Math.random(),Math.random());
    gr.add(cn);
  }

  gr.position.set(-12, 0, 18); gr.rotation.y=.4; gr.castShadow=true; S.add(gr);
}

function _makePalm(h,lean){
  var gr=new THREE.Group(),tm=new THREE.MeshStandardMaterial({color:0x4e342e});
  for(var i=0;i<12;i++){
    var t=i/12,r=.5-t*.25;
    var seg=new THREE.Mesh(new THREE.CylinderGeometry(r-.05,r,h/12,6),tm);
    seg.position.set(lean*t*t*h*.5, t*h+h/24, 0); seg.rotation.z=-lean*t*.3; seg.castShadow=true; gr.add(seg);
  }
  var cg=new THREE.Group();cg.position.set(lean*h*.5, h, 0);cg.name='crown';
  var fm=new THREE.MeshStandardMaterial({color:0x1b5e20,side:2,roughness:.8});
  for(var i=0;i<14;i++){
    var f=new THREE.Mesh(new THREE.PlaneGeometry(1.5,7,2,8),fm);
    f.rotation.y=(i/14)*Math.PI*2; f.rotation.x=.35+Math.random()*.4; cg.add(f);
  }
  gr.add(cg); return gr;
}

function _palmTrees(){
  var ps=[{x:-30,z:25,h:22,l:.45,p:0},{x:-45,z:40,h:26,l:.35,p:1.5},{x:-20,z:35,h:18,l:.55,p:3}];
  ps.forEach(d=>{
    var m=_makePalm(d.h,d.l);m.position.set(d.x,-.3,d.z);
    m.userData.phase=d.p;S.add(m);_palms.push(m);
  });
}

function _pirateGalleonDetailed(){
  _ship=new THREE.Group();
  var hmat=new THREE.MeshStandardMaterial({color:0x211a14,roughness:.9});
  var wmat=new THREE.MeshStandardMaterial({color:0x4e342e,roughness:.8});
  var smat=new THREE.MeshStandardMaterial({color:0xfffdfa,side:2,roughness:.9});
  
  // Hull
  var hull=new THREE.Mesh(new THREE.BoxGeometry(14,2.5,4.5,12,3,6),hmat);
  _ship.add(hull);
  var fCastle=new THREE.Mesh(new THREE.BoxGeometry(4.5,1.5,4),hmat);
  fCastle.position.set(-5, 1.8, 0); _ship.add(fCastle);
  var sCastle=new THREE.Mesh(new THREE.BoxGeometry(6,2.5,4.5),hmat);
  sCastle.position.set(4.5, 2.2, 0); _ship.add(sCastle);

  const makeMast=(x,h,sz)=>{
    var m=new THREE.Group();
    m.add(new THREE.Mesh(new THREE.CylinderGeometry(sz*.6,sz,h,8),wmat));
    // Yards and Curved Sails
    [0.4, 0.7, 0.95].forEach((th,idx)=>{
      var yh=h*th;
      var yd=new THREE.Mesh(new THREE.CylinderGeometry(.12,.12,sz*8-idx*2,4),wmat);
      yd.position.y=yh; yd.rotation.z=Math.PI/2; m.add(yd);
      
      // Deep Curved Sail Geometry
      var saGeo=new THREE.PlaneGeometry(sz*7-idx*1.5, h*0.25, 10, 8);
      var pos=saGeo.attributes.position;
      for(var i=0;i<pos.count;i++){
        var px=pos.getX(i), py=pos.getY(i);
        // Create wind-billow curve: max displacement at center (x=0, y=0)
        var dx=1-Math.pow(px/(sz*3.5),2);
        var dy=1-Math.pow(py/(h*0.125),2);
        pos.setZ(i, dx*dy*1.5);
      }
      saGeo.computeVertexNormals();
      var sa=new THREE.Mesh(saGeo,smat);
      sa.position.set(0, yh-h*0.12, 0.5); sa.rotation.y=Math.PI/2; sa.name='sail'; m.add(sa);
    });
    m.position.set(x, 1, 0); return m;
  };

  _ship.add(makeMast(-4.5, 14, .22));
  _ship.add(makeMast(0, 18, .28));
  _ship.add(makeMast(5, 11, .18));

  // Jolly Roger and Flagmast
  var flm=new THREE.Mesh(new THREE.CylinderGeometry(.05,.05,3,4),wmat);
  flm.position.set(0,19.5,0); _ship.add(flm);
  var flag=new THREE.Mesh(new THREE.PlaneGeometry(2,1.2,4,2),new THREE.MeshBasicMaterial({color:0x000000,side:2}));
  flag.position.set(1.1,19.5,0); flag.name='flag'; _ship.add(flag);

  _ship.position.set(18,-.5,-100); _ship.scale.setScalar(4); S.add(_ship);
}

function _clouds(){
  for(var i=0;i<30;i++){
    var gr=new THREE.Group();
    for(var j=0;j<12;j++){
      var m=new THREE.Mesh(new THREE.SphereGeometry(25,12,8),new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.35}));
      m.position.set(Math.random()*80-40, Math.random()*10, Math.random()*40-20); m.scale.y=.3; gr.add(m);
    }
    gr.position.set(Math.random()*1500-750, 120+Math.random()*180, -400-Math.random()*600); S.add(gr);
  }
}

function _anim(){
  if(!_run)return;requestAnimationFrame(_anim);
  var t=CK.getElapsedTime();
  if(_oU)_oU.uTime.value=t;
  _palms.forEach(pm=>{
    var cr=pm.getObjectByName('crown');
    if(cr){cr.rotation.x=.1+Math.sin(t*0.7+pm.userData.phase)*.12;cr.rotation.z=Math.sin(t*1.3+pm.userData.phase)*.07;}
    pm.rotation.z=Math.sin(t*.35+pm.userData.phase)*.035;
  });
  if(_ship){
    var wt=t*.2,sx=_ship.position.x,sz=_ship.position.z;
    _ship.position.y=(Math.sin(sx*.03+wt*2.5)*.45+Math.sin(sz*.025+wt*3.5)*.7)*.65-.5;
    _ship.rotation.z=Math.sin(t*.35)*.045;_ship.rotation.x=Math.sin(t*.55)*.035;
    _ship.traverse(ch=>{
      if(ch.name==='sail'){
        var sp=ch.geometry.attributes.position;
        for(var i=0;i<sp.count;i++){sp.setZ(i,Math.sin(sp.getX(i)*1.1+t*.8)*.3);}
        sp.needsUpdate=true;
      }
      if(ch.name==='flag'){
        var fp=ch.geometry.attributes.position;
        for(var i=0;i<fp.count;i++){fp.setZ(i,Math.sin(fp.getX(i)*3+t*2.5)*.15);}
        fp.needsUpdate=true;
      }
    });
  }
  C.position.y=3+Math.sin(t*.15)*.18;
  _lp+=(_lt-_lp)*.05;
  var bar=document.getElementById('load-bar-fill');if(bar)bar.style.width=(_lp*100)+'%';
  var pc=document.getElementById('load-pct');if(pc)pc.textContent=Math.floor(_lp*100)+'%';
  _mt+=.016;if(_mt>2.5){_mt=0;_mi=(_mi+1)%_msgs.length;
    var mg=document.getElementById('load-msg');if(mg)mg.textContent=_msgs[_mi];}
  R.render(S,C);
}

window.LoadingScreen={
  start:function(){if(_init())console.info('[LoadingScreen] High-Def Pirate ver started');},
  setProgress:function(p,msg){_lt=Math.min(p,1);if(msg){var e=document.getElementById('load-msg');if(e)e.textContent=msg;}},
  hide:function(){_lt=1;setTimeout(function(){var el=document.getElementById('loading-container');
    if(el){el.style.transition='opacity 1.2s';el.style.opacity='0';
      setTimeout(function(){el.style.display='none';_run=false;
        if(R){R.dispose();R.forceContextLoss();R=null;}S=null;C=null;},1300);}},400);}
};
})();
