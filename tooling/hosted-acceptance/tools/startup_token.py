"""Read-only diagnostic expressions and strict canonical BSON Date parsing.
Not selected by the normal startup probe until separately proven/authorized.
"""
import json,re
HELLO="const h=db.hello();print(JSON.stringify({ok:h.ok,isWritablePrimary:h.isWritablePrimary,secondary:h.secondary,setName:h.setName}))"
# $expr/$type tests the scalar field itself; query $type would also match array elements.
FIND="db.getSiblingDB('acceptance').operationalreadiness.findOne({_id:'execution-write-probe'},{_id:0,checkedAt:1})"
DATE_FIND="db.getSiblingDB('acceptance').operationalreadiness.findOne({_id:'execution-write-probe',$expr:{$eq:[{$type:'$checkedAt'},'date']}},{_id:0,checkedAt:1})"
LOOKUP="const d="+FIND+";if(d===null){print('{\"state\":\"MISSING_DOCUMENT\"}')}else if(!Object.hasOwn(d,'checkedAt')){print('{\"state\":\"MISSING_CHECKED_AT\"}')}else{const t="+DATE_FIND+";const attested=t!==null&&EJSON.stringify(t.checkedAt,null,0,{relaxed:false})===EJSON.stringify(d.checkedAt,null,0,{relaxed:false});print(EJSON.stringify({state:'VALUE',value:d.checkedAt,serverBsonDate:attested},null,0,{relaxed:false}))}"
ALTERNATIVE="const r="+FIND+";if(r===null||!Object.hasOwn(r,'checkedAt')){print('DAPT_PENDING')}else{const t="+DATE_FIND+";if(t===null||EJSON.stringify(t.checkedAt,null,0,{relaxed:false})!==EJSON.stringify(r.checkedAt,null,0,{relaxed:false})){print('DAPT_INVALID_TYPE')}else{print('DAPT_DATE:'+EJSON.stringify(t.checkedAt,null,0,{relaxed:false}))}}"
def unique_object(pairs):
 result={}
 for k,v in pairs:
  if k in result:raise ValueError('DUPLICATE_FIELD')
  result[k]=v
 return result

def load(text):
 if not isinstance(text,str) or len(text)>2048:raise ValueError('TOKEN_SIZE')
 return json.loads(text,object_pairs_hook=unique_object,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('INVALID_CONSTANT')))

def date_token(value):
 if not isinstance(value,dict) or set(value)!={'$date'}:raise ValueError('NOT_CANONICAL_DATE')
 date=value['$date']
 if not isinstance(date,dict) or set(date)!={'$numberLong'}:raise ValueError('NOT_CANONICAL_DATE')
 number=date['$numberLong']
 if not isinstance(number,str) or not re.fullmatch(r'0|-?[1-9][0-9]{0,15}',number) or abs(int(number))>8640000000000000:raise ValueError('INVALID_DATE_NUMBER')
 return 'DAPT_DATE:'+json.dumps(value,separators=(',',':'))

def parse_token(text):
 text=text.strip()
 if text=='DAPT_PENDING':return None
 if not text.startswith('DAPT_DATE:'):raise ValueError('TOKEN_PREFIX')
 return date_token(load(text[len('DAPT_DATE:'):]))

def parse_lookup(text):
 result={'documentFound':False,'checkedAtPresent':False,'checkedAtIsCanonicalBsonDate':False,'classification':'INVALID_SERIALIZATION'}
 try:
  data=load(text)
  if not isinstance(data,dict):return result
  if data=={'state':'MISSING_DOCUMENT'}:return {**result,'classification':'MISSING_DOCUMENT'}
  if data=={'state':'MISSING_CHECKED_AT'}:return {**result,'documentFound':True,'classification':'MISSING_CHECKED_AT'}
  if set(data)!={'state','value','serverBsonDate'} or data['state']!='VALUE' or type(data['serverBsonDate']) is not bool:return result
  value=data['value'];result.update(documentFound=True,checkedAtPresent=True)
  if isinstance(value,str):return {**result,'classification':'STRING'}
  if value is None:return {**result,'classification':'NULL'}
  if not data['serverBsonDate'] or not isinstance(value,dict) or '$date' not in value:return {**result,'classification':'OTHER_TYPE'}
  token=date_token(value)
  return {**result,'checkedAtIsCanonicalBsonDate':True,'classification':'BSON_DATE','token':token}
 except (ValueError,TypeError):return result
