import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandArgs, parseRequest, runCompletion, completionFromEvents } from './runtime.mjs';
import { createBridge } from './server.mjs';
const model='gpt-6-astra';
const body={model,messages:[{role:'user',content:'Write a short caption.'}]};
const events=[{type:'thread.started',thread_id:'test'},{type:'item.completed',item:{type:'agent_message',text:'A short caption.'}},{type:'turn.completed',usage:{input_tokens:12,output_tokens:4}}].map(JSON.stringify).join('\n');
test('rejects executable extensions, unexpected models and external image URLs',()=>{
  for(const request of [{...body,model:'other'},{...body,tools:[{}]},{...body,stream:true},{...body,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'http://localhost/private',detail:'high'}}]}]}])assert.throws(()=>parseRequest(request,model));
});
test('builds a fixed tool-disabled ephemeral command without putting prompts on the command line',()=>{
 const args=commandArgs(model,'/tmp/private',['/tmp/private/0.png']);
 for(const flag of ['--ignore-user-config','--ephemeral','read-only','web_search="disabled"','project_doc_max_bytes=0'])assert.ok(args.includes(flag));
 for(const feature of ['shell_tool','unified_exec','apps','plugins','hooks','image_generation','multi_agent','browser_use','view_image'])assert.ok(args.some((arg,i)=>arg==='--disable'&&args[i+1]===feature));
 assert.equal(args.at(-1),'-');
});
test('only accepts a completed final text result and never accepts tool events',()=>{
 assert.equal(completionFromEvents(events,model).usage.total_tokens,16);
 assert.throws(()=>completionFromEvents(events.split('\n').slice(0,2).join('\n'),model));
 assert.throws(()=>completionFromEvents(events+'\n'+JSON.stringify({type:'item.completed',item:{type:'command_execution'}}),model));
 assert.throws(()=>completionFromEvents(JSON.stringify({type:'item.completed',item:{type:'error',message:'Unexpected permission error'}})+'\n'+events,model));
});
test('creates private image files and cleans every temporary run after success or failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-test-'));
 const request={model,messages:[{role:'user',content:[{type:'text',text:'Read this image.'},{type:'image_url',image_url:{url:'data:image/png;base64,aW1hZ2U=',detail:'high'}}]}]};
 try {
  await runCompletion({body:request,model,executable:'/unused',temporaryRoot:root,execute:async (_exe,args,{input,cwd})=>{assert.ok(input.includes('[Attached image 1]'));assert.equal((await readFile(join(cwd,'input-0.png'))).toString(),'image');assert.ok(!args.includes(input));return events;}});
  assert.deepEqual(await readdir(root),[]);
  await assert.rejects(runCompletion({body,model,executable:'/unused',temporaryRoot:root,execute:async()=>{throw new Error('Fixture failure');}}));
  assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('requires server authentication, rejects browser origins, and bounds concurrent work',async()=>{
 const token='a'.repeat(40);let release;let calls=0;
 const bridge=createBridge({token,model,executable:'/unused',run:async()=>{calls++;await new Promise(resolve=>{release=resolve;});return completionFromEvents(events,model);}});
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${bridge.address().port}`;
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 try {
  assert.equal((await fetch(url+'/v1/models')).status,401);
  assert.equal((await fetch(url+'/v1/models',{headers:{...headers,origin:'https://example.org'}})).status,401);
  assert.equal((await fetch(url+'/v1/models',{headers})).status,200);
  const first=fetch(url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(body)});
  while(!release)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await fetch(url+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(body)})).status,429);
  assert.equal(calls,1);release();assert.equal((await first).status,200);
 }finally{bridge.closeAllConnections();await new Promise(resolve=>bridge.close(resolve));}
});

test('kills a timed-out process and removes its temporary directory without retrying',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-timeout-test-'));
 const executable=join(root,'fake-codex');
 await writeFile(executable,'#!/usr/bin/env node\nsetInterval(()=>{},1000);\n',{mode:0o700});
 try {
  await assert.rejects(runCompletion({body,model,executable,temporaryRoot:root,timeoutMs:100}),/timed out/);
  assert.deepEqual(await readdir(root),['fake-codex']);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('preserves Gujarati text when the child splits a UTF-8 character across chunks',async()=>{
 const root=await mkdtemp(join(tmpdir(),'codex-unicode-test-'));
 const executable=join(root,'fake-codex');
 const output=events.replace('A short caption.','ગુજરાત સમાચાર');
 const script='#!/usr/bin/env node\nconst b=Buffer.from('+JSON.stringify(output)+'); const i=b.indexOf(Buffer.from("ગુજરાત"))+1; process.stdout.write(b.subarray(0,i)); setTimeout(()=>process.stdout.write(b.subarray(i)),10);\n';
 await writeFile(executable,script,{mode:0o700});
 try {const result=await runCompletion({body,model,executable,temporaryRoot:root});assert.equal(result.choices[0].message.content,'ગુજરાત સમાચાર');}
 finally{await rm(root,{recursive:true,force:true});}
});
