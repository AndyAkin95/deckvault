import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync('app.js','utf8');
const first=app.indexOf('function normalizeScanText(text){');
const end=app.indexOf('async function startActiveScan(){',first);
assert(first>=0&&end>first,'Could not locate scanner matcher functions');
const source=app.slice(first,end);

const sampleSets=[
  {id:'sv3',name:'Obsidian Flames',cardCount:{official:197,total:230}},
  {id:'sv4',name:'Another Set',cardCount:{official:180,total:197}},
  {id:'sv5',name:'Unrelated Set',cardCount:{official:190,total:240}}
];
for(let n=0;n<25;n++)sampleSets.push({
  id:'old'+n,name:'Older set '+n,cardCount:{official:197,total:220}
});
const cards=[
  {id:'sv3-161',localId:'161',name:'Pikachu',image:''},
  {id:'sv4-161',localId:'161',name:'Charizard',image:''},
  {id:'sv5-161',localId:'161',name:'Not Eligible',image:''},
  {id:'old24-161',localId:'161',name:'Late Set Match',image:''}
];
let requested=0,details=0;
const ctx=vm.createContext({
  console,
  pokemonSets:async()=>sampleSets,
  pokemonSearch:async()=>{requested++;return cards;},
  pokemonSetCard:async(setId,localId)=>{details++;return null;},
  Promise
});
vm.runInContext(source,ctx,{filename:'scanner matcher'});
const parse=text=>ctx.parseCardFraction(text);
assert.equal(parse(' 161 / 197 ')?.localId,'161');
assert.equal(parse(' 161 / 197 ')?.denominator,197);
assert.equal(parse('TG05/TG30')?.localId,'TG05');
assert.equal(parse('TG05/TG30')?.denominator,30);
assert.equal(ctx.normalizeCollectorId(parse('O61 / I97')?.localId),'61');
assert.equal(parse('O61 / I97')?.denominator,197);
assert.equal(parse('random label with no number'),null);
assert.equal(ctx.parseCardFractions('11/197 ... 161/197')[0].localId,'161');
assert.equal(parse('001/102')?.localId,'001');
assert.equal(ctx.normalizeCollectorId('TG05'),'TG5');

let candidates=await ctx.lookupScanCandidates({localId:'161',denominator:197,raw:'161/197'});
const ids=Array.from(candidates,x=>x.id);
assert(ids.includes('sv3-161'),'Expected official-count match');
assert(ids.includes('sv4-161'),'Expected total-count match');
assert(ids.includes('old24-161'),'Search must not stop at first 18 sets');
assert(!ids.includes('sv5-161'),'Must exclude unmatching set when valid matches exist');
assert.equal(requested,1,'Should use indexed query rather than one request per set');
assert.equal(details,0,'Should not fetch every full card');

candidates=await ctx.lookupScanCandidates({localId:'161',denominator:198,raw:'161/198'});
assert(candidates.length>0&&candidates.every(x=>x.verifiedSetTotal===false),
  'Denominator OCR mismatch should offer unverified alternatives');

candidates=await ctx.lookupScanCandidates({localId:'161',denominator:197,raw:'161/197'},'Pikachu');
assert.equal(candidates[0].name,'Pikachu','Name hint should rank matching card first');

ctx.pokemonSearch=async()=>[];
ctx.pokemonSetCard=async(setId,id)=>{
  details++;
  return setId==='sv4'?{
    id:'sv4-'+id,localId:id,name:'Fallback Card',image:'',
    set:{id:setId,name:'Another Set'}
  }:null;
};
candidates=await ctx.lookupScanCandidates({localId:'161',denominator:197,raw:'161/197'});
assert(Array.from(candidates,x=>x.id).includes('sv4-161'),
  'Per-set endpoint fallback should work when indexed card search returns no matches');

console.log('SCANNER MATCH TESTS PASS: numeric/OCR/gallery parsing; all matching sets; indexed lookup; alternatives; name ranking; API fallback');
