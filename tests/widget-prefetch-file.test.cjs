const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname,'../frontend/widget.js'),'utf8');
function harness() {
 const calls=[], revoked=[], listeners=new Map();let requestCount=0;
 const element=()=>({style:{},classList:{add(){},remove(){}},setAttribute(){},addEventListener(){}});
 class TestURL extends URL {}
 TestURL.createObjectURL=()=>`blob:test-${++requestCount}`;
 TestURL.revokeObjectURL=url=>revoked.push(url);
 const context=vm.createContext({ URL:TestURL,URLSearchParams,AbortSignal,setTimeout,clearTimeout,queueMicrotask,
 window:{location:{search:'',origin:'https://avatar.test'},parent:{postMessage(){}},setTimeout,addEventListener:(name,fn)=>listeners.set(name,fn)},
 document:{querySelector:element,documentElement:{style:{setProperty(){}}},referrer:''},
 fetch:async url=>{if(url==='/api/v1/widget/config')return new Promise(()=>{});calls.push(url);return{ok:true,blob:async()=>({size:1024})};}
 });
 vm.runInContext(source,context);return{context,calls,revoked,listeners};
}
test('prefetch downloads once, loads the real bytes via blob and preserves original pose identity',async()=>{
 const h=harness();await vm.runInContext(`Promise.all([prefetchPoseFile({content_url:'/pose/a'}),prefetchPoseFile({content_url:'/pose/a'})])`,h.context);
 assert.equal(h.calls.length,1);
 h.context.commands=[];h.context.listeners=h.listeners;
 vm.runInContext(`state.unity={SendMessage(_o,method,value){commands.push({method,value});if(method==='LoadPoseUrl')queueMicrotask(()=>listeners.get('avatar3d-pose-load')({detail:{status:'success'}}));}}`,h.context);
 await vm.runInContext(`loadPose({content_url:'/pose/a'})`,h.context);
 assert.ok(h.context.commands.some(c=>c.method==='LoadPoseUrl'&&c.value==='blob:test-1'));
 assert.equal(vm.runInContext('state.activePose.content_url',h.context),'/pose/a');
});
test('prefetch stays bounded and releases replaced blob URLs',async()=>{
 const h=harness();for(let i=0;i<12;i++)await vm.runInContext(`prefetchPoseFile({content_url:'/pose/${i}'})`,h.context);
 assert.equal(vm.runInContext('state.poseFiles.size',h.context),4);
 assert.equal(vm.runInContext('state.poseFileBytes',h.context),4096);
 assert.equal(h.revoked.length,8);
});
test('failed optional warmup leaves normal playback usable and no stale task',async()=>{
 const h=harness();h.context.fetch=async()=>{throw Error('network failure');};
 await vm.runInContext(`runCommand({type:'neotalk:prefetch-pose',pose:{content_url:'/pose/a'}})`,h.context);
 assert.equal(vm.runInContext('state.poseFileTasks.size',h.context),0);
 assert.equal(vm.runInContext('state.poseFiles.size',h.context),0);
});
test('eviction does not revoke the blob URL currently being consumed by Unity',async()=>{
 const h=harness();for(let i=0;i<4;i++)await vm.runInContext(`prefetchPoseFile({content_url:'/pose/${i}'})`,h.context);
 vm.runInContext(`state.pendingPoseLoad={url:'https://avatar.test/pose/0'}`,h.context);
 await vm.runInContext(`prefetchPoseFile({content_url:'/pose/4'})`,h.context);
 assert.equal(vm.runInContext(`state.poseFiles.has('https://avatar.test/pose/0')`,h.context),true);
 assert.deepEqual(h.revoked,['blob:test-2']);
});
