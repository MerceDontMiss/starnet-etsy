import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createApp} from '../src/server.mjs';

async function fixture(t,fetcher) {
  const dir=await fs.mkdtemp(path.join(process.env.TEST_TMP_DIR || os.tmpdir(),'etsy-search-'));
  const c={origin:'https://etsy.example.com',client:'test-client',secret:'test-secret',shop:'123',mcp:'m'.repeat(43),admin:'a'.repeat(43),key:crypto.randomBytes(32),file:path.join(dir,'tokens.enc'),publish:false,port:0};
  const server=createApp(c,fetcher); await new Promise(r=>server.listen(0,'127.0.0.1',r)); c.port=server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
  const rpc=async(method,params={})=>{
    const r=await fetch(`http://127.0.0.1:${c.port}/mcp`,{method:'POST',headers:{Host:'etsy.example.com',Authorization:`Bearer ${c.mcp}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    assert.equal(r.status,200);return (await r.json()).result;
  };
  return {rpc,c};
}
test('five tools discovered; keyword search is read-only, fixed-route and independent of shop OAuth',async t=>{
  const calls=[];
  const {rpc,c}=await fixture(t,async(url,opts)=>{
    calls.push({url,opts});
    return Response.json({count:1,results:[{listing_id:99,shop_id:42,title:'Printed mug',listing_type:'physical',description:'Long '.repeat(1000),rich_description:'Unneeded '.repeat(1000),skus:['PUBLIC-EXAMPLE'],item_length:12,item_width:8,item_height:10,item_dimensions_unit:'cm',price:{amount:2500,divisor:100,currency_code:'USD'}}]});
  });
  const tools=(await rpc('tools/list')).tools;
  assert.deepEqual(tools.map(x=>x.name).sort(),['etsy_status','etsy_create_draft','etsy_upload_image','etsy_publish_listing','etsy_search_marketplace'].sort());
  assert.equal(tools.find(x=>x.name==='etsy_search_marketplace').annotations.readOnlyHint,true);
  const call=arguments_=>rpc('tools/call',{name:'etsy_search_marketplace',arguments:arguments_});
  const first=await call({keywords:' floral mug & gifts ',offset:0});
  assert.ok(!first.isError);
  const data=JSON.parse(first.content[0].text);
  assert.equal(data.source,'Etsy Open API v3 findAllListingsActive');
  assert.equal(data.api_http_status,200);
  assert.equal(data.count,1);assert.equal(data.returned_count,1);
  assert.equal(data.results[0].listing_id,99);
  assert.equal(data.results[0].listing_type,'physical');
  assert.deepEqual(data.results[0].dimensions,{length:12,width:8,height:10,unit:'cm'});
  assert.deepEqual(data.results[0].skus,['PUBLIC-EXAMPLE']);
  assert.equal(data.results[0].price.currency_code,'USD');
  assert.equal(data.results[0].price.amount,2500);assert.ok(data.retrieved_at);
  assert.ok(data.notes.some(note=>note.includes('webpage returning 403')));
  assert.equal(data.results[0].rich_description,undefined);
  assert.equal(data.results[0].description_excerpt.length,240);
  assert.ok(first.content[0].text.length<3000);
  const url=new URL(calls[0].url);
  assert.equal(url.origin+url.pathname,'https://openapi.etsy.com/v3/application/listings/active');
  assert.equal(url.searchParams.get('keywords'),'floral mug & gifts');
  assert.equal(url.searchParams.get('offset'),'0'); assert.equal(url.searchParams.get('limit'),'25');
  assert.equal(url.searchParams.get('sort_on'),'score');
  assert.equal(calls[0].opts.method,'GET');assert.equal(calls[0].opts.body,undefined);
  assert.equal(calls[0].opts.headers['x-api-key'],`${c.client}:${c.secret}`);
  assert.equal(calls[0].opts.headers.Authorization,undefined);assert.equal(calls[0].opts.redirect,'error');
  await call({keywords:'mug',limit:100,offset:100,sort_on:'price',sort_order:'asc'});
  assert.equal(new URL(calls[1].url).searchParams.get('offset'),'100');
  for (const args of [{},{keywords:' '},{keywords:'x'.repeat(257)},{keywords:'mug',limit:101},{keywords:'mug',offset:-1},{keywords:'mug',offset:0.5},{keywords:'mug',sort_on:'sales'},{keywords:'mug',url:'https://evil.example'},{keywords:'mug',constructor:'x'}]) {
    assert.equal((await call(args)).isError,true);
  }
  assert.equal(calls.length,2);
  assert.equal(JSON.parse((await rpc('tools/call',{name:'etsy_status'})).content[0].text).connected,false);
});
test('marketplace errors are explicit, sanitized and not retried',async t=>{
  let mode=403,calls=0;
  const {rpc,c}=await fixture(t,async()=>{
    calls++;
    if(mode==='network') throw Error('private-test-secret');
    if(mode==='invalid') return new Response('{');
    if(mode==='large') return new Response('x'.repeat(2_000_001));
    if(mode==='echo') return Response.json({count:1,results:[{title:'test-secret'}]});
    if(mode==='zero') return Response.json({count:0,results:[]});
    return new Response('private-test-secret',{status:mode});
  });
  for (const setting of [401,403,429,500,'network','invalid','large']) {
    mode=setting;const before=calls;
    const result=await rpc('tools/call',{name:'etsy_search_marketplace',arguments:{keywords:'mug'}});
    assert.equal(result.isError,true);assert.equal(calls,before+1);
    assert.ok(!JSON.stringify(result).includes(c.secret));
  }
  mode='echo';const result=await rpc('tools/call',{name:'etsy_search_marketplace',arguments:{keywords:'mug'}});
  assert.equal(JSON.parse(result.content[0].text).results[0].title,'[REDACTED]');
  mode='zero';const empty=JSON.parse((await rpc('tools/call',{name:'etsy_search_marketplace',arguments:{keywords:'unlikely phrase'}})).content[0].text);
  assert.equal(empty.api_http_status,200);assert.equal(empty.returned_count,0);
});
