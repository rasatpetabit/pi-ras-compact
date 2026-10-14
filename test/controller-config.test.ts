import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { validateControllerConfig, loadControllerConfig, selectProfile } from '../src/client/controller-config.js';
import { existsSync } from 'node:fs';
const fixture=()=>parse(readFileSync(controllerConfigUrl(),'utf8'));
// The controller config ships in the package (config/) and, in a monorepo checkout, one
// level above it; resolve whichever is present so the file loads in both layouts.
function controllerConfigUrl(): URL {
  const packaged = new URL('../config/jev.controller.toml', import.meta.url);
  if (existsSync(packaged)) return packaged;
  return new URL('../../config/jev.controller.toml', import.meta.url);
}
test('provisional sibling strictly validates and exact-route profiles never wildcard',()=>{
 const raw:any=fixture(); assert.ok(validateControllerConfig(raw).config);
 for(const patch of [{unknown:1},{policy:{...raw.policy,working_window_share:.99}},{policy:{...raw.policy,horizon_requests:100}},{profiles:[{provider:'*',id:'x',api:'x',source:'fixture'}]}]) assert.equal(validateControllerConfig({...raw,...patch}).config,undefined);
 const c:any=validateControllerConfig({...raw,profiles:[{provider:'p',id:'m',api:'a',source:'fixture',working_ceiling:372000,bands:[{input_tokens_above:272000,multiplier:2,terms:['input']}]}]}).config;
 assert.ok(c);assert.equal(selectProfile(c,{provider:'p',id:'m',api:'b'}),undefined);assert.ok(selectProfile(c,{provider:'p',id:'m',api:'a'}));
});
test('absent invalid and text reload do not retain stale enabled config',()=>{
 const dir=mkdtempSync(join(tmpdir(),'jev-config-'));const base=join(dir,'jev.toml');
 try { assert.equal(loadControllerConfig(base).mode,'off');writeFileSync(join(dir,'jev.controller.toml'),readFileSync(controllerConfigUrl()));assert.equal(loadControllerConfig(base).mode,'shadow');writeFileSync(join(dir,'jev.controller.toml'),'bad=1');assert.equal(loadControllerConfig(base).mode,'off'); }finally{rmSync(dir,{recursive:true,force:true});}
});

test('present invalid optional profile fields fail closed rather than being ignored',()=>{
 for(const patch of [{rates:null},{bands:null},{cache:false},{overhead:0},{assessment_overhead:false}]){
 const raw:any=fixture();raw.profiles=[{provider:'p',id:'m',api:'a',source:'fixture',...patch}];assert.equal(validateControllerConfig(raw).config,undefined);
 }
});

test('projection_error_share_bounds_and_unknown_key',()=>{
 const raw:any=fixture();const c:any=validateControllerConfig(raw).config;assert.equal(c.policy.projectionErrorShare,.15);
 assert.ok(validateControllerConfig({...raw,policy:{...raw.policy,projection_error_share:0}}).config,'zero uncertainty is a valid explicit policy');
 for(const v of [1,-.01,NaN,'0.15',null]) assert.equal(validateControllerConfig({...raw,policy:{...raw.policy,projection_error_share:v}}).config,undefined,String(v));
 const {projection_error_share:_,...absent}=raw.policy;assert.equal(validateControllerConfig({...raw,policy:absent}).config,undefined,'absent fails closed');
 assert.equal(validateControllerConfig({...raw,policy:{...raw.policy,projection_error_margin:.1}}).config,undefined);
});
