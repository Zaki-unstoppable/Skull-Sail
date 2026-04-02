(function(){
'use strict';
let _run=false, _lp=0, _lt=0;
var _msgs=['Charting the seas...','Hoisting the sails...','Loading cannons...','Brewing grog...','Counting doubloons...','Anchors aweigh...'];
var _mi=0, _mt=0, _reqFrame;

function _init(){
  var el=document.getElementById('loading-container');
  if(!el)return false;
  
  // Create Single HTML5 Video Element with Intelligent EOF-Bypass Looping
  var vid = document.createElement('video');
  vid.id = 'loading-video';
  vid.src = 'loading_bg.mp4';
  vid.autoplay = true;
  vid.muted = true;
  vid.playsInline = true;
  // We strictly disable native 'loop' to prevent the hardware decoder from dumping memory at EOF.
  vid.loop = false;
  
  // Style: scale(1.05) cleanly cuts minor edges
  vid.style.position = 'absolute';
  vid.style.top = '0';
  vid.style.left = '0';
  vid.style.width = '100%';
  vid.style.height = '100%';
  vid.style.objectFit = 'cover';
  vid.style.zIndex = '-1'; 
  vid.style.transform = 'scale(1.05)';
  vid.style.transformOrigin = 'center';
  
  el.insertBefore(vid, el.firstChild);
  
  // Intelligent Time-Jump Looper
  // This completely eliminates:
  // 1. Browser Hardware Decoder freeze (by skipping the EOF dump)
  // 2. CapCut's accidental 1-frame black exports at the end of files
  vid.addEventListener('timeupdate', function() {
      // Trigger the jump 0.15 seconds before the file actually ends 
      if (vid.duration && vid.currentTime >= vid.duration - 0.15) {
          // Jump to 0.05s (skips the very first frame to avoid a double-frame stitch hitch)
          vid.currentTime = 0.05;
          vid.play();
      }
  });

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
                  var vid=document.getElementById('loading-video');
                  if(vid){ vid.pause(); vid.removeAttribute('src'); vid.load(); vid.remove(); }
              },1300);
          }
      },400);
  }
};
})();
