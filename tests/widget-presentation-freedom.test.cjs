const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const text=fs.readFileSync(path.join(__dirname,'../frontend/widget.js'),'utf8');
const capable={presentationFreedom:{min:0,max:1},presentationPlaybackSpeed:{min:.5,max:1.5}};
function harness(){
 const commands=[],statuses=[];
 const state={avatar:'elia',runtimeObject:'ELIA Pose Skeleton Preview',eliaPlaybackSpeed:1.5,eliaPresentationFreedom:.5,unity:{SendMessage(...args){commands.push(args)}}};
 const sandbox=vm.createContext({state,Number,emitStatus:(...args)=>statuses.push(args)});
 vm.runInContext(text.slice(text.indexOf('function normalizeEliaPlaybackSpeed'),text.indexOf('function runtimeAssetUrl')),sandbox);
 vm.runInContext(text.slice(text.indexOf('async function unloadRuntime'),text.indexOf('async function initializeAvatar')),sandbox);
 return {state,commands,statuses,normalize:sandbox.normalizeEliaPresentationFreedom,apply:sandbox.applyEliaPresentationFreedom,speed:sandbox.applyEliaPlaybackSpeed,unload:sandbox.unloadRuntime};
}
test('freedom normalizer preserves explicit zero, clamps finite values and ignores invalid types',()=>{
 const h=harness();for(const x of [null,undefined,'',' ',true,false,NaN,Infinity,-Infinity,'NaN','bad',[],{}])assert.equal(h.normalize(x),null);
 for(const [x,y]of [[0,0],['0',0],[.5,.5],['0.5',.5],[1,1],[2,1],[-1,0]])assert.equal(h.normalize(x),y);
});
test('numeric float command reaches the current runtime, including explicit rollback zero',()=>{
 const h=harness();assert.equal(h.apply(capable),true);h.state.runtimeObject='New runtime';h.state.eliaPresentationFreedom=0;assert.equal(h.apply(capable),true);
 assert.deepEqual(h.commands,[['ELIA Pose Skeleton Preview','SetEliaLectureFreedom',.5],['New runtime','SetEliaLectureFreedom',0]]);
 assert.equal(typeof h.commands[0][2],'number');assert.equal(h.state.effectiveEliaPresentationFreedom,0);
});
test('absent override keeps Unity saved value; other avatars and missing instance never get setter',()=>{
 const h=harness();h.state.eliaPresentationFreedom=null;assert.equal(h.apply(capable),false);h.state.eliaPresentationFreedom=.5;
 for(const avatar of ['lia','asuna']){h.state.avatar=avatar;assert.equal(h.apply(capable),false)}
 h.state.avatar='elia';h.state.unity=null;assert.equal(h.apply(capable),false);assert.equal(h.commands.length,0);
});
test('older or incompatible builds skip freedom and emit diagnostic, while supported speed still works',()=>{
 const h=harness();for(const manifest of [{},null,{presentationFreedom:{min:0,max:2}},{presentationFreedom:{min:'0',max:'1'}}])assert.equal(h.apply(manifest),false);
 const old=JSON.parse(fs.readFileSync(path.join(__dirname,'../webgl/elia/manifest.json'),'utf8'));
 assert.equal(old.presentationFreedom,undefined);assert.equal(h.apply(old),false);assert.equal(h.commands.length,0);
 assert.equal(h.statuses[0][0],'presentation_freedom_unsupported');assert.equal(h.speed(old),true);assert.equal(h.commands[0][1],'SetEliaLecturePlaybackSpeed');
});
test('speed and freedom are independent and do not rewrite pose or playback state',()=>{
 const h=harness();h.state.activePose={content_url:'/original.pose'};h.state.playbackContext={playbackId:'original-id'};
 h.speed(capable);h.apply(capable);assert.equal(h.state.effectiveEliaPlaybackSpeed,1.5);assert.equal(h.state.effectiveEliaPresentationFreedom,.5);
 assert.deepEqual(h.state.activePose,{content_url:'/original.pose'});assert.deepEqual(h.state.playbackContext,{playbackId:'original-id'});
 assert.deepEqual(h.commands.map(x=>x[1]),['SetEliaLecturePlaybackSpeed','SetEliaLectureFreedom']);
});
test('avatar unload clears effective capability but keeps chosen value for a new instance',async()=>{
 const h=harness();h.apply(capable);await h.unload();
 assert.equal(h.state.eliaPresentationFreedom,.5);assert.equal(h.state.effectiveEliaPresentationFreedom,null);assert.equal(h.state.canSetEliaPresentationFreedom,false);
 h.state.unity={SendMessage(...args){h.commands.push(args)}};assert.equal(h.apply(capable),true);assert.equal(h.commands.length,2);
});
test('new command is applied only at initialization after stale-runtime guard and before first pose',()=>{
 const init=text.slice(text.indexOf('async function initializeAvatar'),text.indexOf('async function loadPose'));
 assert(init.indexOf('applyEliaPresentationFreedom(manifest)')>init.indexOf('state.unity = instance'));
 assert(init.indexOf('applyEliaPresentationFreedom(manifest)')<init.indexOf('{ preview: true }'));
 assert.equal(text.match(/applyEliaPresentationFreedom\(manifest\)/g).length,2); // definition and one call
 assert.match(text,/state\.eliaPresentationFreedom = normalizeEliaPresentationFreedom\(config\.elia_presentation_freedom\)/);
 assert.match(text,/presentationFreedom: state\.effectiveEliaPresentationFreedom/);
 assert.match(text,/state\.canSetEliaPresentationFreedom \? \["presentation-freedom"\]/);
 const html=fs.readFileSync(path.join(__dirname,'../frontend/widget.html'),'utf8');assert.match(html,/widget\.js\?v=20261030-presentation-controls/);
});
test('upper freedom limit remains independent of playback speed, and supported control works without speed override',()=>{
 const h=harness();h.state.eliaPresentationFreedom=4;h.state.eliaPlaybackSpeed=null;
 assert.equal(h.speed(capable),false);assert.equal(h.apply({presentationFreedom:{min:0,max:1}}),true);
 assert.deepEqual(h.commands,[['ELIA Pose Skeleton Preview','SetEliaLectureFreedom',1]]);
 assert.equal(h.state.effectiveEliaPlaybackSpeed,null);assert.equal(h.state.effectiveEliaPresentationFreedom,1);
});
