import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const challenge = v => crypto.createHash('sha256').update(v).digest('base64url');
const random = () => crypto.randomBytes(32).toString('base64url');
const protocolVersions = ['2025-03-26', '2025-06-18', '2025-11-25'];
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function seal(value, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
}
export function unseal(bytes, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
}
export function config(env = process.env) {
  env = {...env, PUBLIC_URL:env.PUBLIC_URL || env.RENDER_EXTERNAL_URL};
  for (const name of ['PUBLIC_URL','ETSY_CLIENT_ID','ETSY_SHARED_SECRET','ETSY_SHOP_ID','MCP_BEARER_TOKEN','ADMIN_BEARER_TOKEN','TOKEN_ENCRYPTION_KEY']) {
    if (!env[name] || /CHANGE_ME/.test(env[name])) throw Error(`Configure ${name}`);
  }
  const origin = new URL(env.PUBLIC_URL);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw Error('PUBLIC_URL must be an HTTPS origin');
  if (!/^\d+$/.test(env.ETSY_SHOP_ID)) throw Error('Invalid shop ID');
  for (const n of ['MCP_BEARER_TOKEN','ADMIN_BEARER_TOKEN']) if (env[n].length < 43) throw Error(`${n} must have at least 43 characters`);
  if (env.MCP_BEARER_TOKEN === env.ADMIN_BEARER_TOKEN) throw Error('Use distinct admin and MCP tokens');
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32) throw Error('TOKEN_ENCRYPTION_KEY must encode 32 bytes');
  return {origin:origin.origin, client:env.ETSY_CLIENT_ID, secret:env.ETSY_SHARED_SECRET, shop:env.ETSY_SHOP_ID,
    mcp:env.MCP_BEARER_TOKEN, admin:env.ADMIN_BEARER_TOKEN, key, file:path.resolve(env.DATA_DIR || './data','tokens.enc'),
    publish:env.ALLOW_PUBLISH === 'true', port:Number(env.PORT || 3000), host:env.HOST || '127.0.0.1'};
}
const integer = v => Number.isSafeInteger(v) && v > 0;
const schemas = {
  etsy_status:{type:'object',properties:{},additionalProperties:false},
  etsy_create_draft:{type:'object',properties:{quantity:{type:'integer',minimum:1},title:{type:'string',minLength:1,maxLength:140},description:{type:'string',minLength:1},price:{type:'number',exclusiveMinimum:0},who_made:{type:'string',enum:['i_did','someone_else','collective']},when_made:{type:'string'},taxonomy_id:{type:'integer',minimum:1},shipping_profile_id:{type:'integer',minimum:1},readiness_state_id:{type:'integer',minimum:1}},required:['quantity','title','description','price','who_made','when_made','taxonomy_id','shipping_profile_id','readiness_state_id'],additionalProperties:false},
  etsy_upload_image:{type:'object',properties:{listing_id:{type:'integer',minimum:1},image_base64:{type:'string',description:'JPEG or PNG, maximum 5 MiB decoded'}},required:['listing_id','image_base64'],additionalProperties:false},
  etsy_publish_listing:{type:'object',properties:{listing_id:{type:'integer',minimum:1}},required:['listing_id'],additionalProperties:false}
};
function validate(name, args) {
  const schema = schemas[name];
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid tool or arguments');
  for (const k of Object.keys(args)) if (!(k in schema.properties)) throw Error(`Unknown argument: ${k}`);
  for (const k of schema.required || []) if (!(k in args)) throw Error(`Missing argument: ${k}`);
  for (const [k,v] of Object.entries(args)) {
    const s = schema.properties[k];
    if (s.type === 'integer' && !integer(v) || s.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) || s.type === 'string' && (typeof v !== 'string' || !v.trim() || v.length > (s.maxLength || 8_000_000)) || s.enum && !s.enum.includes(v)) throw Error(`Invalid argument: ${k}`);
  }
}
export function createApp(c, fetcher = fetch) {
  let tokens, queue = Promise.resolve();
  const states = new Map();
  const serial = fn => { const p = queue.then(fn); queue = p.catch(()=>{}); return p; };
  async function load() {
    if (tokens) return tokens;
    try { tokens = unseal(await fs.readFile(c.file),c.key); }
    catch(e) { if (e.code !== 'ENOENT') throw Error('Token storage could not be decrypted'); }
    return tokens;
  }
  async function save(t) {
    const next = {...t, expires_at:Date.now() + Number(t.expires_in)*1000};
    if (!next.access_token || !next.refresh_token || !Number.isFinite(next.expires_at)) throw Error('Invalid token response');
    await fs.mkdir(path.dirname(c.file),{recursive:true,mode:0o700});
    await fs.writeFile(c.file+'.tmp',seal(next,c.key),{mode:0o600});
    await fs.rename(c.file+'.tmp',c.file);
    tokens = next;
  }
  async function tokenRequest(fields) {
    const r = await fetcher('https://api.etsy.com/v3/public/oauth/token',{method:'POST',body:new URLSearchParams({client_id:c.client,...fields}),signal:AbortSignal.timeout(30000),redirect:'error'});
    if (!r.ok) throw Error(`Etsy token request failed (${r.status}); reconnect if authorization expired`);
    return r.json();
  }
  async function access() {
    const t = await load();
    if (!t) throw Error('Connect Etsy first');
    if (t.expires_at < Date.now()+60000) await save(await tokenRequest({grant_type:'refresh_token',refresh_token:t.refresh_token}));
    return tokens.access_token;
  }
  async function api(method, suffix, body) {
    const headers = {'x-api-key':`${c.client}:${c.secret}`,Authorization:`Bearer ${await access()}`};
    const r = await fetcher(`https://api.etsy.com/v3/application/shops/${c.shop}${suffix}`,{method,headers,body,signal:AbortSignal.timeout(30000),redirect:'error'});
    if (!r.ok) throw Error(`Etsy API returned ${r.status}; check shop, scopes, listing requirements, or rate limits. Do not blindly retry creation.`);
    return r.json();
  }
  async function tool(name, a) {
    validate(name,a);
    if (name === 'etsy_status') return {connected:!!await load(),shop_id:c.shop,publishing_enabled:c.publish};
    if (name === 'etsy_create_draft') return api('POST','/listings',new URLSearchParams(Object.entries(a).map(([k,v])=>[k,String(v)])));
    if (name === 'etsy_upload_image') {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(a.image_base64)) throw Error('Invalid base64 image');
      const bytes = Buffer.from(a.image_base64,'base64');
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      if ((!jpeg && !png) || bytes.length > 5*1024*1024) throw Error('Provide JPEG or PNG up to 5 MiB');
      const form = new FormData(); form.append('image',new Blob([bytes],{type:jpeg?'image/jpeg':'image/png'}),jpeg?'image.jpg':'image.png');
      return api('POST',`/listings/${a.listing_id}/images`,form);
    }
    if (!c.publish) throw Error('Publishing disabled; operator must set ALLOW_PUBLISH=true');
    return api('PATCH',`/listings/${a.listing_id}`,new URLSearchParams({state:'active'}));
  }
  const send = (res,status,data,headers={}) => {
    if (status >= 400) console.warn(`Request rejected (${status}): ${typeof data?.error === 'string' ? data.error : data?.error?.message || 'Request failed'}`);
    res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers});
    res.end(data === undefined ? undefined : JSON.stringify(data));
  };
  const authorized = (req,key) => equal(req.headers.authorization,`Bearer ${key}`);
  const server = http.createServer(async(req,res)=>{
    try {
      const u = new URL(req.url,c.origin);
      if (req.method === 'GET' && u.pathname === '/healthz') return send(res,200,{ok:true});
      // Do not trust forwarded host headers; requests must address the configured host.
      if (req.headers.host !== new URL(c.origin).host && req.headers.host !== `127.0.0.1:${c.port}`) return send(res,403,{error:'Host denied'});
      if (req.headers.origin && req.headers.origin !== c.origin) return send(res,403,{error:'Origin denied'});
      if (req.method === 'GET' && u.pathname === '/admin') {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"});
        return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect Etsy</title><h1>Connect your Etsy shop</h1><p>Enter the server administrator token. It is sent only to this server.</p><form><label>Administrator token <input type="password" autocomplete="off" required></label><button>Connect Etsy</button></form><p id="message"></p><script src="/admin.js"></script></html>');
      }
      if (req.method === 'GET' && u.pathname === '/admin.js') {
        res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        return res.end(`document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const i=document.querySelector('input');const token=i.value;i.value='';try{const r=await fetch('/admin/connect',{method:'POST',headers:{Authorization:'Bearer '+token}});const d=await r.json();if(!r.ok)throw Error('Connection denied');location.assign(d.authorization_url);}catch{document.getElementById('message').textContent='Connection failed. Check the administrator token and try again.';}});`);
      }
      if (req.method === 'POST' && u.pathname === '/admin/connect') {
        if (!authorized(req,c.admin)) return send(res,401,{error:'Unauthorized'});
        for (const [k,v] of states) if (v.until < Date.now()) states.delete(k);
        if (states.size >= 50) return send(res,429,{error:'Too many pending connections'});
        const state=random(),verifier=random(),cookie=random();
        states.set(state,{verifier,cookie,until:Date.now()+600000});
        const url = new URL('https://www.etsy.com/oauth/connect');
        url.search = new URLSearchParams({response_type:'code',client_id:c.client,redirect_uri:c.origin+'/oauth/callback',scope:'shops_r listings_r listings_w',state,code_challenge:challenge(verifier),code_challenge_method:'S256'});
        return send(res,200,{authorization_url:url.href},{'Set-Cookie':`etsy_connect=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/oauth/callback; Max-Age=600`});
      }
      if (req.method === 'GET' && u.pathname === '/oauth/callback') {
        const state=u.searchParams.get('state'), pending=states.get(state);
        const cookie = /(?:^|;\s*)etsy_connect=([^;]+)/.exec(req.headers.cookie || '')?.[1];
        if (!pending || pending.until < Date.now() || !equal(cookie,pending.cookie)) return send(res,400,{error:'Invalid or expired OAuth session'});
        states.delete(state);
        if (!u.searchParams.get('code') || u.searchParams.has('error')) return send(res,400,{error:'Etsy consent was not completed'});
        await serial(async()=>{
          const t = await tokenRequest({grant_type:'authorization_code',redirect_uri:c.origin+'/oauth/callback',code:u.searchParams.get('code'),code_verifier:pending.verifier});
          // Verify this grant owns the configured shop before replacing saved credentials.
          const user = t.access_token?.split('.')[0];
          if (!/^\d+$/.test(user || '')) throw Error('Invalid Etsy user');
          const r = await fetcher(`https://api.etsy.com/v3/application/users/${user}/shops`,{headers:{'x-api-key':`${c.client}:${c.secret}`,Authorization:`Bearer ${t.access_token}`},signal:AbortSignal.timeout(30000),redirect:'error'});
          if (!r.ok || String((await r.json()).shop_id) !== c.shop) throw Error('Connected account does not own configured shop');
          await save(t);
        });
        return send(res,200,{connected:true},{'Set-Cookie':'etsy_connect=; HttpOnly; Secure; SameSite=Lax; Path=/oauth/callback; Max-Age=0'});
      }
      if (u.pathname !== '/mcp') return send(res,404,{error:'Not found'});
      if (!authorized(req,c.mcp)) return send(res,401,{error:'Unauthorized'},{'WWW-Authenticate':'Bearer'});
      if (req.method !== 'POST') return send(res,405,{error:'Use POST'},{Allow:'POST'});
      if (!req.headers['content-type']?.startsWith('application/json')) return send(res,415,{error:'JSON required'});
      let chunks=[],size=0;
      for await (const chunk of req) {size+=chunk.length;if(size>8_000_000) {send(res,413,{error:'Request too large'});return;} chunks.push(chunk);}
      let m; try {m=JSON.parse(Buffer.concat(chunks));} catch {return send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
      if (!m || Array.isArray(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string' || ('id' in m && typeof m.id !== 'string' && typeof m.id !== 'number')) return send(res,400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}});
      // Negotiate initialization from its body, before enforcing subsequent headers.
      if (m.method !== 'initialize' && req.headers['mcp-protocol-version'] && !protocolVersions.includes(req.headers['mcp-protocol-version'])) return send(res,400,{error:'Unsupported protocol version'});
      if (!('id' in m)) return send(res,202);
      let result;
      switch(m.method) {
        case 'initialize': result={protocolVersion:protocolVersions.includes(m.params?.protocolVersion) ? m.params.protocolVersion : protocolVersions.at(-1),capabilities:{tools:{}},serverInfo:{name:'etsy-starnet',version:'1.0.1'}};break;
        case 'ping': result={};break;
        case 'tools/list': result={tools:Object.entries(schemas).map(([name,inputSchema])=>({name,inputSchema,description:({etsy_status:'Check connection',etsy_create_draft:'Create physical listing draft. Creates a new listing on every call.',etsy_upload_image:'Upload JPEG or PNG to a listing',etsy_publish_listing:'Activate a listing; incurs Etsy fees. Requires operator opt-in.'})[name]}))};break;
        case 'tools/call':
          try {const data=await serial(()=>tool(m.params?.name,m.params?.arguments || {}));result={content:[{type:'text',text:JSON.stringify(data)}]};}
          catch(e) {result={isError:true,content:[{type:'text',text:e.message}]};} break;
        default:return send(res,200,{jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});
      }
      send(res,200,{jsonrpc:'2.0',id:m.id,result});
    } catch {send(res,500,{error:'Operation failed; check configuration or reconnect Etsy. No tokens logged.'});}
  });
  server.requestTimeout=45000; server.headersTimeout=15000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {const c=config();createApp(c).listen(c.port,c.host,()=>console.log('Etsy MCP listening'));}
  catch(e) {console.error(e.message);process.exitCode=1;}
}
