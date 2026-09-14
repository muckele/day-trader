'use strict';
// Arithmetic never uses binary floating point. BSON whole-share Numbers remain
// backward compatible; fractional persistence and wire values are canonical strings.
const SCALE=1000000000n;
const invalid=()=>Object.assign(new Error('Quantity must be nonnegative with at most nine decimal places.'),{code:'QUANTITY_INVALID',status:400});
function units(value){
 if(typeof value!=='string'&&typeof value!=='number')throw invalid();
 if(typeof value==='number'&&(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER))throw invalid();
 const text=String(value);if(!/^\d+(\.\d{1,9})?$/.test(text))throw invalid();
 const [whole,fraction='']=text.split('.');return BigInt(whole)*SCALE+BigInt(fraction.padEnd(9,'0'));
}
function format(value){
 if(typeof value!=='bigint')throw invalid();
 const negative=value<0n;const n=negative?-value:value;
 const fraction=String(n%SCALE).padStart(9,'0').replace(/0+$/,'');
 return (negative?'-':'')+String(n/SCALE)+(fraction?'.'+fraction:'');
}
const normalize=value=>format(units(value));
const compare=(a,b)=>units(a)<units(b)?-1:units(a)>units(b)?1:0;
const add=(a,b)=>format(units(a)+units(b));
function subtract(a,b){const n=units(a)-units(b);if(n<0n)throw invalid();return format(n);}
const whole=value=>units(value)%SCALE===0n;
const positive=value=>units(value)>0n;
const zero=value=>units(value)===0n;
function opening(value){const n=units(value);if(n<=0n||n%SCALE||n/SCALE>BigInt(Number.MAX_SAFE_INTEGER))throw Object.assign(new Error('A positive whole share quantity is required.'),{code:'ORDER_INVALID',status:400});return Number(n/SCALE);}
function persist(value){const n=units(value);return n%SCALE===0n&&n/SCALE<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n/SCALE):format(n);}
function signedUnits(value){return typeof value==='string'&&value.startsWith('-')?-units(value.slice(1)):units(value);}
function signedPersist(value){return value<0n?format(value):persist(format(value));}
function schemaField(mongoose,extra={}){return {type:mongoose.Schema.Types.Mixed,set:value=>value==null?value:persist(value),validate:{validator:value=>{try{return value==null||normalize(value)!=='';}catch{return false;}},message:'Invalid exact share quantity'},...extra};}
module.exports={SCALE,units,format,normalize,compare,add,subtract,whole,positive,zero,opening,persist,signedUnits,signedPersist,schemaField};
