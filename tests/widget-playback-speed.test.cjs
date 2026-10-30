const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const text=fs.readFileSync(path.join(__dirname,'../frontend/widget.js'),'utf8');
function harness(){
 const commands=[],statuses=[];const state={avatar:'elia',runtimeObject:'ELIA Pose Skeleton Preview',eliaPlaybackSpeed:1.5,unity:{SendMessage(...args){commands.push(args)}}};
 const sandbox=vm.createContext({state,Number,emitStatus:(...args)=>statuses.push(args)});
 vm.runInContext(text.slice(text.indexOf('function normalizeEliaPlaybackSpeed'),text.indexOf('function runtimeAssetUrl')),sandbox);
 return {state,commands,statuses,normalize:sandbox.normalizeEliaPlaybackSpeed,apply:sandbox.applyEliaPlaybackSpeed};
}
const capable={presentationPlaybackSpeed:{min:.5,max:1.5}};
test('normalizes environment payload, finite clamp and unset/invalid values',()=>{
 const h=harness();for(const x of [null,undefined,'','  ',true,false,NaN,Infinity,-Infinity,'NaN','no',[],{}])assert.equal(h.normalize(x),null);
 assert.equal(h.normalize('1.5'),1.5);assert.equal(h.normalize(1.2),1.2);assert.equal(h.normalize(2),1.5);assert.equal(h.normalize(.1),.5);
});
test('passes a NUMBER to the float Unity method and targets current runtime object',()=>{
 const h=harness();assert.equal(h.apply(capable),true);assert.deepEqual(h.commands,[['ELIA Pose Skeleton Preview','SetEliaLecturePlaybackSpeed',1.5]]);assert.equal(typeof h.commands[0][2],'number');assert.equal(h.state.effectiveEliaPlaybackSpeed,1.5);
 h.state.runtimeObject='New runtime';h.state.eliaPlaybackSpeed=1.3;h.apply(capable);assert.deepEqual(h.commands[1],['New runtime','SetEliaLecturePlaybackSpeed',1.3]);
});
test('unset leaves Unity default alone, and other avatars never receive ELIA method',()=>{
 const h=harness();h.state.eliaPlaybackSpeed=null;assert.equal(h.apply(capable),false);h.state.eliaPlaybackSpeed=1.5;
 for(const name of ['lia','asuna']){h.state.avatar=name;assert.equal(h.apply(capable),false)}assert.equal(h.commands.length,0);
});
test('missing or incompatible capability skips command instead of breaking older runtime',()=>{
 const h=harness();for(const manifest of [{},null,{presentationPlaybackSpeed:{min:0,max:2}}])assert.equal(h.apply(manifest),false);
 assert.equal(h.commands.length,0);assert.equal(h.statuses[0][0],'playback_speed_unsupported');assert.equal(h.state.effectiveEliaPlaybackSpeed,null);
});
test('initialization applies speed after stale-runtime guard and before bundled preview; bootstrap reads no-store server config',()=>{
 const init=text.slice(text.indexOf('async function initializeAvatar'),text.indexOf('async function loadPose'));
 assert(init.indexOf('applyEliaPlaybackSpeed(manifest)')>init.indexOf('state.unity = instance'));
 assert(init.indexOf('applyEliaPlaybackSpeed(manifest)')<init.indexOf('{ preview: true }'));
 assert.match(text,/state\.eliaPlaybackSpeed = normalizeEliaPlaybackSpeed\(config\.elia_playback_speed\)/);
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'../webgl/elia/manifest.json'),'utf8'));assert.deepEqual(manifest.presentationPlaybackSpeed,capable.presentationPlaybackSpeed);
 const html=fs.readFileSync(path.join(__dirname,'../frontend/widget.html'),'utf8');assert.match(html,/widget\.js\?v=20261030-presentation-controls/);
});
