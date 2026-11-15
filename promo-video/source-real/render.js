const { chromium } = require('playwright');
const { spawn } = require('child_process');
(async()=>{
  const FPS=30, out=process.argv[2];
  const b = await chromium.launch();
  const p = await b.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
  p.on('pageerror',e=>{console.error('PAGEERR',e.message);process.exit(2)});
  await p.goto('file://'+__dirname+'/promo.html'); await p.evaluate(()=>document.fonts.ready); await p.waitForTimeout(800);
  const D = await p.evaluate(()=>window.DURATION); const N = Math.round(D*FPS);
  const ff = spawn('ffmpeg',['-y','-v','error','-f','image2pipe','-framerate',String(FPS),'-c:v','mjpeg','-i','-','-c:v','libx264','-preset','slow','-crf','16','-pix_fmt','yuv420p','-movflags','+faststart',out],{stdio:['pipe','inherit','inherit']});
  for(let f=0; f<N; f++){
    await p.evaluate(t=>renderFrame(t), f/FPS);
    const buf = await p.screenshot({type:'jpeg',quality:95});
    if(!ff.stdin.write(buf)) await new Promise(r=>ff.stdin.once('drain',r));
    if(f%150===0) console.log('frame',f,'/',N);
  }
  ff.stdin.end(); await new Promise(r=>ff.on('close',r)); await b.close(); console.log('DONE',N);
})();
