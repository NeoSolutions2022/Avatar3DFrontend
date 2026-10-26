const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../frontend/widget.js'),'utf8');
const fn=source.slice(source.indexOf('async function fetchSignPose('),source.indexOf('// Fetch the actual immutable content'));
function harness(replies){let now=0;const waits=[],calls=[];
 const c=vm.createContext({performance:{now:()=>now},Date,Number,Error,maxPollAttempts:8,
  pollDelayForAttempt:i=>[0,300,500,800,1200][Math.min(i,4)],emitStatus(){},cachePose(){},
  wait:async ms=>{waits.push(ms);now+=ms;},api:async p=>{calls.push(p);const r=replies.shift();now+=r.ms;if(r.error)throw Object.assign(new Error('temporary'),{status:r.error});
   return{payload:r.payload,response:{status:r.status||200,headers:{get:()=>null}}};}});
 vm.runInContext(fn+'\nthis.run=fetchSignPose;',c);return{c,waits,calls};
}
test('separates observed retry/poll waits, request time and nested proxy spans without changing polling',async()=>{
 const h=harness([{ms:10,error:502},{ms:20,payload:{task_id:'t',timings_ms:{upstream_submit_ms:8}}},
  {ms:30,status:202,payload:{timings_ms:{upstream_status_ms:12}}},
  {ms:40,payload:{pose:{content_url:'/pose'},pose_cache_hit:false,palavras_encontradas:['TESTE.pose'],timings_ms:{upstream_status_ms:15,download_ms:7,validation_persist_ms:3,storage_lookup_ms:1,secret:'private'}}}]);
 const r=await h.c.run('private phrase');const m=r.timingsMs;
 assert.equal(m.submit_request_ms,30);assert.equal(m.poll_request_ms,70);assert.equal(m.poll_wait_ms,300);
 assert.equal(m.retry_wait_ms,350);assert.equal(m.total_ms,750);assert.equal(m.proxy_upstream_status_ms,27);
 assert.equal(m.proxy_download_ms,7);assert.equal(r.poseCacheHit,false);assert.deepEqual(h.waits,[350,300]);
 assert.equal(h.calls.length,4);assert.ok(!JSON.stringify(m).includes('private'));
});
test('old proxy leaves nested timing absent, never fabricates a worker or download duration',async()=>{
 const h=harness([{ms:5,payload:{task_id:'t'}},{ms:7,payload:{pose:{content_url:'/pose'}}}]);
 const r=await h.c.run('TESTE');assert.equal(r.timingsMs.total_ms,12);
 assert.equal(r.timingsMs.proxy_download_ms,undefined);assert.equal(r.poseCacheHit,undefined);
 assert.equal(r.timingsMs.worker_ms,undefined);
});
test('cancelled request does not emit a successful timing result',async()=>{
 const h=harness([{ms:5,payload:{task_id:'t'}}]);
 assert.equal(await h.c.run('TESTE',()=>false),null);assert.equal(h.calls.length,1);
});
