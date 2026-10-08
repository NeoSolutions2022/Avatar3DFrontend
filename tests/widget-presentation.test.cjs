const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../frontend/widget.js'),'utf8');
const pose='# Frame: original - Body Keypoints\n0 0 0\n# Frame: original - Left Hand Keypoints\n1 2 3\n';
function harness(){
 const listeners=new Map(),messages=[],commands=[],revoked=[],downloads=[];
 const element=()=>({hidden:false,textContent:'',style:{},classList:{add(){},remove(){}},setAttribute(){},addEventListener(){}});
 class LocalURL extends URL{} LocalURL.createObjectURL=()=> 'blob:https://widget.test/prepared'; LocalURL.revokeObjectURL=url=>revoked.push(url);
 const sandbox=vm.createContext({URL:LocalURL,URLSearchParams,AbortController,AbortSignal,Blob,setTimeout,clearTimeout,queueMicrotask,performance,console,
  window:{location:{search:'',origin:'https://widget.test'},parent:{postMessage:m=>messages.push(m)},setTimeout,addEventListener:(type,fn)=>listeners.set(type,fn)},
  document:{querySelector:element,documentElement:{style:{setProperty(){}}},referrer:''},
  fetch:async url=>{if(url==='/api/v1/widget/config')return new Promise(()=>{});downloads.push(url);return{ok:true,text:async()=>pose};}
 });
 vm.runInContext(source,sandbox);
 sandbox.commands=commands;sandbox.listeners=listeners;
 vm.runInContext(`state.nativePlayback=true;state.unity={SendMessage(_object,method,value){commands.push({method,value});if(method==='LoadPoseUrl')queueMicrotask(()=>listeners.get('avatar3d-pose-load')({detail:{status:'success'}}));if(method==='PlayFromStart')queueMicrotask(()=>listeners.get('avatar3d-playback')({detail:{playbackId:state.playbackContext.loadId,status:'started',frame:0,frameCount:2,fps:30}}));}};`,sandbox);
 return{sandbox,commands,messages,revoked,downloads,run:code=>vm.runInContext(code,sandbox)};
}
test('prepares one native playlist, pauses on actual first frame and resumes without loading again',async()=>{
 const h=harness();await h.run(`preparePresentation({playlistId:'demo_1',poses:[{content_url:'/a.pose'},{content_url:'/b.pose'}]})`);
 for(let i=0;i<10;i++)await Promise.resolve();
 assert.equal(h.commands.filter(c=>c.method==='LoadPoseUrl').length,1);
 assert.equal(h.downloads.length,2);
 assert.equal(h.messages.filter(m=>m.type==='neotalk:presentation-ready').length,1);
 assert.equal(h.commands.at(-1).method,'PausePlayback');
 await h.run(`runCommand({type:'neotalk:play'})`);await h.run(`runCommand({type:'neotalk:pause'})`);await h.run(`runCommand({type:'neotalk:play'})`);
 assert.equal(h.commands.filter(c=>c.method==='LoadPoseUrl').length,1);
 assert.equal(h.commands.filter(c=>c.method==='ResumePlayback').length,2);
 assert.equal(h.commands.filter(c=>c.method==='PlayFromStart').length,1);
 await h.run(`runCommand({type:'neotalk:stop-presentation'})`);
 assert.equal(h.run('state.presentation'),null);assert.equal(h.run('state.loop'),false);assert.equal(h.revoked.length,1);
});
test('rejects cross-origin pose URLs and oversized or empty playlists before fetching',async()=>{
 const h=harness();
 await assert.rejects(h.run(`preparePresentation({playlistId:'demo',poses:[{content_url:'https://evil.test/a.pose'},{content_url:'/b.pose'}]})`),/servidor do widget/);
 await assert.rejects(h.run(`preparePresentation({playlistId:'demo',poses:[]})`),/2 a 64/);
 await assert.rejects(h.run(`preparePresentation({playlistId:'demo',poses:Array.from({length:65},()=>({content_url:'/a.pose'}))})`),/2 a 64/);
 assert.equal(h.downloads.length,0);
});
test('composition preserves all body/hand records and gives each source frame a unique ordered identity',()=>{
 const h=harness();h.sandbox.pose=pose;
 const clip=h.run('concatenatePresentationPoses([pose,pose])');
 assert.equal(clip.frameCount,2);
 assert.equal((clip.content.match(/0 0 0/g)||[]).length,2);assert.equal((clip.content.match(/1 2 3/g)||[]).length,2);
 assert.match(clip.content,/frame_000000000000_keypoints/);assert.match(clip.content,/frame_000000000001_keypoints/);
 assert.throws(()=>h.run(`concatenatePresentationPoses(['invalid'])`),/inválida/);
 assert.throws(()=>h.run(`concatenatePresentationPoses(Array.from({length:12001},()=>pose))`),/12.000 frames/);
});
