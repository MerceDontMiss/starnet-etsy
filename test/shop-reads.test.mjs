import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createApp,seal} from '../src/server.mjs';

test('owner-only shop reads support duplicate, shipping, SKU, image, partner and readiness checks',async t=>{
  const dir=await fs.mkdtemp(path.join(process.env.TEST_TMP_DIR || os.tmpdir(),'etsy-shop-'));
  const calls=[];
  const c={origin:'https://etsy.example.com',client:'test-client',secret:'test-secret',shop:'123',mcp:'m'.repeat(43),admin:'a'.repeat(43),key:crypto.randomBytes(32),file:path.join(dir,'tokens.enc'),publish:false,port:0};
  await fs.writeFile(c.file,seal({access_token:'123.test-access-token',refresh_token:'test-refresh-token',expires_at:Date.now()+3600000},c.key));
  const server=createApp(c,async(url,opts)=>{
    const u=new URL(url);calls.push({url:u.href,opts});
    if(u.pathname==='/v3/application/shops/123/listings')return Response.json({count:1,results:[{listing_id:77,shop_id:123,title:'Original art card',state:u.searchParams.get('state'),price:{amount:2000,divisor:100,currency_code:'USD'}}]});
    if(u.pathname==='/v3/application/listings/77')return Response.json({listing_id:77,shop_id:123,title:'Original art card',state:'draft',production_partner_ids:[9],readiness_state_id:4,shipping_profile_id:8});
    if(u.pathname==='/v3/application/listings/88')return Response.json({listing_id:88,shop_id:999});
    if(u.pathname==='/v3/application/listings/77/inventory')return Response.json({products:[{sku:'OWN-SKU',offerings:[{price:{amount:2000,divisor:100,currency_code:'USD'}}]}]});
    if(u.pathname==='/v3/application/listings/77/images')return Response.json({count:1,results:[{listing_image_id:55,url_fullxfull:'https://example.com/image.png'}]});
    if(u.pathname==='/v3/application/shops/123/shipping-profiles')return Response.json({count:1,results:[{shipping_profile_id:8,title:'US free buyer shipping'}]});
    if(u.pathname==='/v3/application/shops/123/readiness-state-definitions')return Response.json({count:1,results:[{readiness_state_id:4,readiness_state:'made_to_order'}]});
    if(u.pathname==='/v3/application/shops/123/production-partners')return Response.json({count:1,results:[{production_partner_id:9,partner_name:'Test partner'}]});
    throw Error(`Unexpected test URL ${u.pathname}`);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));c.port=server.address().port;
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
  const rpc=async(name,args={})=>{
    const r=await fetch(`http://127.0.0.1:${c.port}/mcp`,{method:'POST',headers:{Host:'etsy.example.com',Authorization:`Bearer ${c.mcp}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    assert.equal(r.status,200);const result=(await r.json()).result;
    assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);
  };
  const health=await fetch(`http://127.0.0.1:${c.port}/healthz`);assert.deepEqual(await health.json(),{ok:true,version:'1.2.0',tool_count:12});
  const list=await rpc('etsy_list_shop_listings',{state:'draft',limit:10,offset:0});
  assert.equal(list.count,1);assert.equal(list.results[0].listing_id,77);assert.equal(list.results[0].state,'draft');
  assert.equal((await rpc('etsy_get_listing',{listing_id:77})).production_partner_ids[0],9);
  assert.equal((await rpc('etsy_get_listing_inventory',{listing_id:77})).data.products[0].sku,'OWN-SKU');
  assert.equal((await rpc('etsy_get_listing_images',{listing_id:77})).data.results[0].listing_image_id,55);
  assert.equal((await rpc('etsy_get_shipping_profiles')).data.results[0].shipping_profile_id,8);
  assert.equal((await rpc('etsy_get_readiness_states',{limit:10,offset:0})).data.results[0].readiness_state_id,4);
  assert.equal((await rpc('etsy_get_production_partners')).data.results[0].production_partner_id,9);
  assert.ok(calls.every(x=>x.opts.method==='GET' && x.opts.headers.Authorization==='Bearer 123.test-access-token' && x.opts.redirect==='error'));
  assert.ok(calls.every(x=>new URL(x.url).hostname==='api.etsy.com'||new URL(x.url).hostname==='openapi.etsy.com'));
  const before=calls.length;
  const bad=await fetch(`http://127.0.0.1:${c.port}/mcp`,{method:'POST',headers:{Host:'etsy.example.com',Authorization:`Bearer ${c.mcp}`,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'etsy_get_listing',arguments:{listing_id:88}}})});
  assert.equal((await bad.json()).result.isError,true);
  assert.equal(calls.length,before+1);
});
