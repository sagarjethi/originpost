import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { checkRuntime, runCompletion } from './runtime.mjs';

export function createBridge({token,model,executable,run = runCompletion}) {
  if(typeof token !== 'string' || token.length < 32 || !/^[A-Za-z0-9._/-]{1,160}$/.test(model ?? '')) throw new Error('Set a bridge token of at least 32 characters and an exact Codex model ID.');
  let busy=false;
  return createServer(async (req,res)=>{
    const reply=(code,body)=>{if(!res.destroyed){res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}};
    const supplied=Buffer.from(req.headers.authorization ?? ''), expected=Buffer.from(`Bearer ${token}`);
    if(req.headers.origin || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) {reply(401,{error:{message:'Bridge authentication required.'}});return;}
    if(req.method==='GET' && req.url==='/v1/models') {reply(200,{object:'list',data:[{id:model,object:'model',owned_by:'local-codex'}]});return;}
    if(req.method!=='POST' || req.url!=='/v1/chat/completions') {reply(404,{error:{message:'Not found.'}});return;}
    if(busy) {reply(429,{error:{message:'Codex is busy. This request was not started.'}});return;}
    if(req.headers['content-type']?.split(';')[0]!=='application/json'){reply(415,{error:{message:'Send JSON.'}});return;}
    busy=true;
    const controller=new AbortController();
    const cancel=()=>{if(!res.writableEnded)controller.abort();};res.on('close',cancel);
    try {
      let bytes=0;const chunks=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>29*1024*1024)throw new Error('Request is too large.');chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reply(400,{error:{message:'Invalid JSON.'}});return;}
      const result=await run({body,model,executable,signal:controller.signal});reply(200,result);
    } catch(error) {reply(502,{error:{message:error instanceof Error?error.message:'Codex request failed.'}});}
    finally {busy=false;res.removeListener('close',cancel);}
  });
}
export async function startBridge(env=process.env) {
  const executable=env.ORIGINPOST_CODEX_EXECUTABLE;
  if(!executable?.startsWith('/'))throw new Error('Set an absolute ORIGINPOST_CODEX_EXECUTABLE path.');
  await checkRuntime(executable);
  const port=Number(env.ORIGINPOST_CODEX_PORT??8765);
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local port.');
  const server=createBridge({token:env.ORIGINPOST_CODEX_TOKEN,model:env.ORIGINPOST_CODEX_MODEL,executable});
  server.requestTimeout=30000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const shutdown=()=>{
    server.close();
    server.closeAllConnections(); // Response close aborts the active CLI process before cleanup.
  };
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
  server.once('close',()=>{process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);});
  console.log(`Local Codex bridge listening on 127.0.0.1:${port}. No research or image generation is exposed.`);
  return server;
}
