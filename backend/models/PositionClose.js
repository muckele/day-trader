const Q = require('../services/shareQuantity');
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
 accountId:{type:String,required:true},userId:{type:String,required:true},symbol:{type:String,required:true},
 idempotencyKey:{type:String,required:true},requestedQty:Q.schemaField(mongoose),qty:Q.schemaField(mongoose),intentId:mongoose.Schema.Types.ObjectId,
 needsProtectionRecovery:{type:Boolean,default:false},exitCancelRequested:{type:Boolean,default:false},state:{type:String,default:'discovering'},active:{type:Boolean,default:true},error:String,deadlineAt:Date,
 stops:{type:[{brokerOrderId:String,clientOrderId:String,cancelRequested:Boolean}],default:[]}
},{timestamps:true,optimisticConcurrency:true});
schema.index({accountId:1,idempotencyKey:1},{unique:true});
schema.index({accountId:1,symbol:1},{unique:true,partialFilterExpression:{active:true}});
module.exports=mongoose.model('PositionClose',schema);
