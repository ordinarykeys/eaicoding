import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { operate, providers, methods } from '../runtime/model-runtime.mjs';

// Never consult the developer's real provider environment or credentials.
if (!process.argv.includes('--isolated')) {
  const env = Object.fromEntries(['SystemRoot','TEMP','TMP','PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated'], { env, stdio: 'inherit', windowsHide: true });
  const [code] = await once(child, 'exit'); process.exit(code ?? 1);
}
const emptyAuth = { env: async () => undefined, fileExists: async () => false };
const safeFetch = globalThis.fetch;
globalThis.fetch = async url => { throw new Error('Fixture blocked unexpected outbound request: ' + url); };
const bridge = (patch = {}) => ({ signal: new AbortController().signal, emit: () => {}, prompt: async p => p.options?.[0]?.id ?? 'fixture-value', persist: async () => {}, ...patch });
const login = (provider, prompt, persist = async () => {}) => operate({ provider, operation: 'login', method: 'api_key' }, bridge({ prompt, persist }), { authContext: emptyAuth });
assert.equal(providers.length, 42);
assert.deepEqual(providers.filter(p => methods(p).some(m => m.id === 'oauth')).map(p => p.id), ['anthropic','github-copilot','kimi-coding','meta','openai-codex','openrouter','radius','xai']);
for (const provider of providers.filter(p => p.auth.apiKey?.login)) {
  let stored;
  const result = await login(provider.id, async p => p.options?.[0]?.id ?? 'fixture-key', async value => { stored = value; });
  assert.equal(stored.type, 'api_key', provider.id);
  assert.equal(result.configured, true, provider.id);
}
console.log('PASS all 42 provider methods match Harness; every API/configuration login commits through native storage');

let awsProfile;
await login('amazon-bedrock', async p => p.type === 'select' ? 'aws-profile' : 'fixture-profile', async value => { awsProfile = value; });
assert.equal(awsProfile.env.AWS_PROFILE, 'fixture-profile');
for (const method of ['adc','service-account']) {
  let stored;
  const result = await login('google-vertex', async p => p.type === 'select' ? method : p.message.includes('project') ? 'fixture-project' : p.message.includes('location') ? 'us-central1' : 'D:/fixture/service-account.json', async value => { stored = value; });
  assert.equal(result.configured, false, 'missing ADC file must not report ready');
  const status = await operate({ operation:'status', provider:'google-vertex', credential:stored }, bridge(), { authContext: { ...emptyAuth, fileExists: async () => true } });
  assert.equal(status.configured, true);
}
const wif = Object.fromEntries(['ANTHROPIC_FEDERATION_RULE_ID','ANTHROPIC_ORGANIZATION_ID','ANTHROPIC_IDENTITY_TOKEN_FILE'].map(k => [k,'fixture']));
assert.equal((await operate({operation:'status',provider:'anthropic'},bridge(),{authContext:{...emptyAuth,env:async k=>wif[k]}})).configured,true);
await assert.rejects(login('anthropic',async()=> 'fixture',async()=>{throw new Error('fixture disk full');}), /fixture disk full/);
console.log('PASS AWS Profile, Vertex ADC/service account, Anthropic WIF and failed credential persistence');

const notices = [];
let copilotGrant;
const copilotModelId=providers.find(p=>p.id==='github-copilot').getModels()[0].id;
globalThis.fetch = async (url, init) => {
  const address = String(url);
  if (address === 'https://github.com/login/device/code') return Response.json({device_code:'fixture-device',user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',interval:1,expires_in:300});
  if (address === 'https://github.com/login/oauth/access_token') return Response.json({access_token:'fixture-github-token'});
  if (address === 'https://api.github.com/copilot_internal/v2/token') return Response.json({token:'fixture-copilot-token;proxy-ep=proxy.individual.githubcopilot.com;',expires_at:Math.floor(Date.now()/1000)+3600});
  if (address === 'https://api.individual.githubcopilot.com/models') return Response.json({data:[{id:copilotModelId,model_picker_enabled:true,policy:{state:'enabled'},capabilities:{supports:{tool_calls:true}}}]});
  throw new Error('Unexpected fixture request: ' + address);
};
const copilot = await operate({operation:'login',provider:'github-copilot',method:'oauth'},bridge({prompt:async()=>'',emit:e=>notices.push(e),persist:async c=>{copilotGrant=c;}}),{authContext:emptyAuth});
assert.equal(copilot.configured,true);assert.equal(copilotGrant.type,'oauth');assert.equal(copilot.models.length,1);
assert(notices.some(n=>n.notice?.type==='device_code'&&n.notice.userCode==='ABCD-EFGH'));
assert(!JSON.stringify(notices).includes('fixture-github-token'));
console.log('PASS real Copilot device grant, token exchange, account model filtering and secret-free interaction events');

let grant;
globalThis.fetch = async (url,init) => {
  assert.equal(String(url),'https://openrouter.ai/api/v1/auth/keys');
  assert.equal(JSON.parse(init.body).code,'fixture-code');
  return Response.json({key:'fixture-openrouter-key'});
};
await operate({operation:'login',provider:'openrouter',method:'oauth'},bridge({prompt:async()=> 'fixture-code',persist:async c=>{grant=c;}}),{authContext:emptyAuth});
assert.equal(grant.access,'fixture-openrouter-key');
let refreshes=0, requestHeaders;
globalThis.fetch = async (url,init) => {
  if(String(url)==='https://platform.claude.com/v1/oauth/token'){
    refreshes++; assert.equal(JSON.parse(init.body).grant_type,'refresh_token');
    return Response.json({access_token:'sk-ant-oat01-fixture-refreshed',refresh_token:'fixture-next-refresh',expires_in:3600});
  }
  requestHeaders = new Headers(init?.headers ?? url.headers);
  return Response.json({error:{type:'fixture_error',message:'fixture stop after auth'}},{status:400});
};
const model=providers.find(p=>p.id==='anthropic').getModels()[0];
await assert.rejects(operate({operation:'stream',provider:'anthropic',credential:{type:'oauth',access:'fixture-expired',refresh:'fixture-refresh',expires:0},config:{model:model.id,maxTokens:128},models:[model],context:{messages:[{role:'user',content:'hi',timestamp:1}]}},bridge({persist:async c=>{grant=c;}}),{authContext:emptyAuth}),/fixture stop after auth/);
assert.equal(refreshes,1);assert.equal(grant.access,'sk-ant-oat01-fixture-refreshed');
assert.equal(requestHeaders.get('authorization'),'Bearer sk-ant-oat01-fixture-refreshed');
console.log('PASS real PKCE/manual OAuth exchange and expired Claude grant refresh before authenticated inference');

// Exercise the emitted bundle itself, isolated from node_modules and real env.
const runHost = async (input, answer, shouldCancel=false, fixtureEnv={}) => {
  const child=spawn('src-tauri/target/model-runtime/node.exe',['src-tauri/target/model-runtime/host.cjs'],{env:{SystemRoot:process.env.SystemRoot,...fixtureEnv},stdio:['pipe','pipe','pipe'],windowsHide:true});
  child.stdout.setEncoding('utf8');
  let output='', errors='', buffer='', saved=false, prompts=0;
  child.stderr.on('data',d=>{errors+=d;});
  child.stdout.on('data',d=>{output+=d;buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const row=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);
    if(row.type==='prompt'){prompts++;child.stdin.write(JSON.stringify(shouldCancel?{type:'abort'}:{type:'prompt_reply',promptId:row.promptId,value:answer(row.prompt)})+'\n');}
    if(row.type==='persist'){saved=true;child.stdin.write(JSON.stringify({type:'persist_ack',promptId:row.promptId})+'\n');}
  }});
  child.stdin.write(JSON.stringify(input)+'\n');
  const timer=setTimeout(()=>child.kill(),15000);
  try{const [code]=await once(child,'exit');assert.equal(code,0,errors);return{rows:output.trim().split('\n').map(x=>JSON.parse(x)),saved,prompts};}finally{clearTimeout(timer);child.kill();}
};
const host=await runHost({operation:'login',provider:'amazon-bedrock',method:'api_key'},p=>p.type==='select'?'aws-profile':'fixture-profile');
assert(host.saved);assert(host.rows.some(r=>r.type==='result'&&r.result.configured));
const canceled=await runHost({operation:'login',provider:'openai-codex',method:'oauth'},()=>'',true);
assert(canceled.prompts>0);assert(!canceled.saved);assert(canceled.rows.some(r=>r.type==='failure'));assert(!JSON.stringify(canceled.rows).includes('Cannot find module'));
console.log('PASS packaged Node runtime, static auth loader registration, native write acknowledgement and cancellation');

// A real signed AWS SDK request to a local fixture; no AWS service is contacted.
let authorization;
const server=createServer((req,res)=>{authorization=req.headers.authorization;req.resume();res.writeHead(400,{'content-type':'application/json','x-amzn-errortype':'ValidationException'});res.end(JSON.stringify({message:'fixture AWS signed request'}));});
server.listen(0,'127.0.0.1');await once(server,'listening');
process.env.AWS_ACCESS_KEY_ID='FIXTUREACCESSKEY';process.env.AWS_SECRET_ACCESS_KEY='fixture-secret';process.env.AWS_BEDROCK_FORCE_HTTP1='1';process.env.AWS_REGION='us-east-1';
try{
  const aws=providers.find(p=>p.id==='amazon-bedrock').getModels().find(m=>m.id.includes('claude'));
  await assert.rejects(operate({operation:'stream',provider:'amazon-bedrock',baseUrl:`http://127.0.0.1:${server.address().port}`,config:{model:aws.id,maxTokens:128},context:{messages:[{role:'user',content:'hi',timestamp:1}]}},bridge()),/fixture AWS signed request/);
  assert(authorization.startsWith('AWS4-HMAC-SHA256 Credential=FIXTUREACCESSKEY/'));
  const bundled=await runHost({operation:'stream',provider:'amazon-bedrock',baseUrl:`http://127.0.0.1:${server.address().port}`,config:{model:aws.id,maxTokens:128},context:{messages:[{role:'user',content:'hi',timestamp:1}]}},()=>'',false,{AWS_ACCESS_KEY_ID:'FIXTUREACCESSKEY',AWS_SECRET_ACCESS_KEY:'fixture-secret',AWS_BEDROCK_FORCE_HTTP1:'1',AWS_REGION:'us-east-1'});
  assert(bundled.rows.some(row=>row.type==='failure'&&row.message.includes('fixture AWS signed request')));
  assert(authorization.startsWith('AWS4-HMAC-SHA256 Credential=FIXTUREACCESSKEY/'));
}finally{await new Promise(r=>server.close(r));}
const longText='长文本完整输出'.repeat(30000);
const streaming=createServer((req,res)=>{
  req.resume();res.writeHead(200,{'content-type':'text/event-stream'});
  const events=[{type:'message_start',message:{id:'fixture',type:'message',role:'assistant',model:model.id,content:[],usage:{input_tokens:1,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:longText}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];
  res.end(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''));
});
streaming.listen(0,'127.0.0.1');await once(streaming,'listening');
try{
  const long=await runHost({operation:'stream',provider:'anthropic',credential:{type:'api_key',key:'fixture-key'},baseUrl:`http://127.0.0.1:${streaming.address().port}`,config:{model:model.id,maxTokens:128},context:{messages:[{role:'user',content:'hi',timestamp:1}]}},()=> '');
  assert(long.rows.some(row=>row.type==='result'&&row.result.completed));
  assert.equal(long.rows.find(row=>row.type==='done').message.content.find(part=>part.type==='text').text,longText);
}finally{await new Promise(r=>streaming.close(r));}
globalThis.fetch=safeFetch;
console.log('PASS packaged AWS SigV4 stack and complete large UTF-8 stream/replay frames against local HTTP fixtures');
