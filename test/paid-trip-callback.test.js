import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../backend/server.js',import.meta.url),'utf8');
const start=source.indexOf('async function handleCallback(callback)');
const end=source.indexOf('\nasync function handleUpdate(',start);
assert(start>0&&end>start);
function context(api){const sent=[],telegram=[];const c={bmWaitApi:api,tg:async(method,payload)=>{telegram.push({method,payload});return{};},sendMessage:async(chatId,text)=>sent.push({chatId,text}),String,isAllowed:()=>false};vm.createContext(c);vm.runInContext(source.slice(start,end),c);return{c,sent,telegram};}
const callback={id:'cb1',from:{id:111111},message:{chat:{id:111111},message_id:12},data:'tpaid:'+'a'.repeat(24)};
test('В курсе uses authenticated callback sender and confirms only after saved CRM response',async()=>{
 const calls=[];const {c,sent,telegram}=context(async body=>{calls.push(body);return{ok:true};});
 await c.handleCallback(callback);
 assert.equal(calls[0].telegramUser,'111111');assert.equal(calls[0].op,'trip_paid_ack');
 assert.equal(sent.length,1);assert.match(sent[0].text,/Подтверждение сохранено/);
 assert.equal(telegram.find(t=>t.method==='editMessageReplyMarkup').payload.reply_markup.inline_keyboard.length,0);
});
test('Denied or failed callback never reports a saved acknowledgement or removes the button',async()=>{
 for(const status of[403,409,500]){
  const {c,sent,telegram}=context(async()=>{throw Object.assign(Error('refused'),{status});});
  await c.handleCallback(callback);assert.equal(sent.length,0);
  assert.equal(telegram.filter(t=>t.method==='editMessageReplyMarkup').length,0);
  assert.equal(telegram[0].payload.show_alert,true);
 }
});
