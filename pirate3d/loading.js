(function(){
'use strict';
let _run=false, _lp=0, _lt=0;
var _msgs=['Charting the seas...','Hoisting the sails...','Loading cannons...','Brewing grog...','Counting doubloons...','Anchors aweigh...'];
var _mi=0, _mt=0, _reqFrame;

function _init(){
  var el=document.getElementById('loading-container');
  if(!el)return false;
  
  // Create Dual HTML5 Video Elements to force a buttery-smooth crossfade loop
  var v1 = document.createElement('video');
  var v2 = document.createElement('video');
  v1.id = 'loading-video-1'; v2.id = 'loading-video-2';
  v1.src = 'loading_bg.mp4'; v2.src = 'loading_bg.mp4';
  v1.muted = true; v2.muted = true;
  v1.playsInline = true; v2.playsInline = true;
  v1.loop = false; v2.loop = false;
  v1.preload = 'auto'; v2.preload = 'auto'; // Force buffer
  
  // Style: generous 1.2s crossfade transition completely hides all jumps
  var vStyle = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:-1;transform:scale(1.05);transform-origin:center;transition:opacity 1.2s ease-in-out;pointer-events:none;';
  v1.style.cssText = vStyle + 'opacity:1;';
  v2.style.cssText = vStyle + 'opacity:0;';
  
  el.insertBefore(v2, el.firstChild);
  el.insertBefore(v1, el.firstChild);
  
  // Pre-decode v2 to guarantee no black flash on first swap
  v1.play().catch(function(e){});
  var _v2Start = v2.play();
  if(_v2Start !== undefined) {
      _v2Start.then(function(){ v2.pause(); v2.currentTime = 0; }).catch(function(){});
  }
  
  window._curVid = v1;
  window._nxtVid = v2;
  
  // Crossfade trigger 1.5s before end of video
  setInterval(function() {
      if(!window._curVid || !window._curVid.duration) return;
      if(window._curVid.currentTime >= window._curVid.duration - 1.5) {
          window._nxtVid.currentTime = 0;
          window._nxtVid.play().catch(function(){});
          window._nxtVid.style.opacity = '1';
          window._curVid.style.opacity = '0'; 
          
          // CRITICAL: Force pause the old video AFTER it has faded out (1.2s) 
          // but BEFORE it hits the CapCut black frame at EOF (1.5s)!
          var outgoingVid = window._curVid;
          setTimeout(function(){
              if(outgoingVid) outgoingVid.pause();
          }, 1200);
          
          var temp = window._curVid;
          window._curVid = window._nxtVid;
          window._nxtVid = temp;
      }
  }, 50);
  
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
