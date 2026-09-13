const mongoose=require('mongoose');
const schema=new mongoose.Schema({accountId:{type:String,required:true},period:{type:String,required:true},key:{type:String,required:true},spentCents:{type:Number,default:0},reservedCents:{type:Number,default:0}},{timestamps:true});
schema.index({accountId:1,period:1,key:1},{unique:true});
module.exports=mongoose.model('SpendingBucket',schema);
