(function(){
'use strict';
let _run=false, _lp=0, _lt=0;
var _msgs=['Charting the seas...','Hoisting the sails...','Loading cannons...','Brewing grog...','Counting doubloons...','Anchors aweigh...'];
var _mi=0, _mt=0, _reqFrame;

function _init(){
  var el=document.getElementById('loading-container');
  if(!el)return false;
  
  // The user produced a perfectly looped cut 'loadscreen.mp4'! Let's use simple, native flawless HTML5 looping.
  var vid = document.createElement('video');
  vid.id = 'loading-video-1'; // Keep ID for any external ref
  vid.src = 'loadscreen.mp4';
  vid.muted = true;
  vid.playsInline = true;
  vid.autoplay = true;
  vid.loop = true;
  vid.preload = 'auto';
  
  // Perfectly centered, no extra zoom (scale 1), no black bars via object-fit: cover
  vid.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none;transform:scale(1.0);';
  
  el.insertBefore(vid, el.firstChild);
  vid.play().catch(function(e){});

  
  _run=true;
  _anim();
  return true;
}

function _anim(){
  if(!_run)return;
  _reqFrame = requestAnimationFrame(_anim);
  
  _lp+=(_lt-_lp)*.05;
  var bar=document.getElementById('load-bar-fill');if(bar)bar.style.width=(_lp*100)+'%';
  var pc=document.getElementById('load-pct');if(pc)pc.textContent=Math.floor(_lp*100)+'%';
  
  _mt+=0.016; 
  if(_mt>2.5){
      _mt=0;
      _mi=(_mi+1)%_msgs.length;
      var mg=document.getElementById('load-msg');if(mg)mg.textContent=_msgs[_mi];
  }
}

window.LoadingScreen={
  start:function(){if(_init())console.info('[LoadingScreen] Cinematic AI Boomerang Loop started');},
  setProgress:function(p,msg){
      _lt=Math.min(p,1);
      if(msg){var e=document.getElementById('load-msg');if(e)e.textContent=msg;}
  },
  hide:function(){
      _lt=1;
      setTimeout(function(){
          var el=document.getElementById('loading-container');
          if(el){
              el.style.transition='opacity 1.2s';
              el.style.opacity='0';
              setTimeout(function(){
                  el.style.display='none';
                  _run=false;
                  if(_reqFrame) cancelAnimationFrame(_reqFrame);
                  var v1=document.getElementById('loading-video-1');
                  if(v1){ v1.pause(); v1.removeAttribute('src'); v1.load(); v1.remove(); }
                  var v2=document.getElementById('loading-video-2');
                  if(v2){ v2.pause(); v2.removeAttribute('src'); v2.load(); v2.remove(); }
              },1300);
          }
      },400);
  }
};
})();
