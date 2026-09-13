const mongoose=require('mongoose');
const schema=new mongoose.Schema({accountId:{type:String,required:true,unique:true},reservedCents:{type:Number,default:0},spentCents:{type:Number,default:0},cashFloorCents:Number,brokerCashCents:Number,cashSyncedAt:Date,version:{type:Number,default:0}},{timestamps:true});
module.exports=mongoose.model('AccountCapacity',schema);
