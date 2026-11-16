import crypto from 'node:crypto'; import fs from 'node:fs';
const B='http://localhost:8788',priv=fs.readFileSync(process.env.TEST_PRIV||'test-keys/priv.pem');const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt=sub=>{const now=Math.floor(Date.now()/1000);const h=b64({alg:'RS256',typ:'JWT',cat:'cl_B7d4PD111AAA'}),p=b64({sub,azp:B,iat:now,nbf:now-5,exp:now+300});return h+'.'+p+'.'+crypto.sign('RSA-SHA256',Buffer.from(h+'.'+p),priv).toString('base64url')};
const call=async(t,path,body)=>{const r=await fetch(B+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+t,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return [r.status,await r.json()]};
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
const E=jwt('user_ethan'),F=jwt('user_friend'),K=jwt('user_teen');
let [s,r]=await call(F,'/api/ai/plan',{});ok(s===400&&/profile/i.test(r.error),'no profile -> asks to finish profile: '+r.error);
const prof={sex:'male',age:18,heightIn:73,bodyType:'lean',goal:'ripped',activity:'physical',days:5};
await call(F,'/api/settings',{profile:prof});[s,r]=await call(F,'/api/ai/plan',{});ok(s===400&&/weight/i.test(r.error),'no weigh-in -> asks for weight: '+r.error);
await call(F,'/api/weights',{day:'2026-11-15',weight:165});
fs.writeFileSync('/tmp/mockmode','bad');[s,r]=await call(F,'/api/ai/plan',{});
const req=JSON.parse(fs.readFileSync('/tmp/lastreq.json','utf8'));const facts=req.messages[0].content[0].text;
const range=JSON.parse(facts.slice(facts.indexOf('{'))).allowed_calorie_range,tdee=JSON.parse(facts.slice(facts.indexOf('{'))).estimated_maintenance_calories;
console.log('   maintenance',tdee,'allowed',range);
ok(s===200&&r.calories===range[0]&&r.calories>=1600,'AI said 900 cal -> clamped up to safe floor '+r.calories);
ok(r.protein<=Math.round(165*1.1)&&r.protein>=99,'AI said 600g protein -> clamped to '+r.protein);
ok(Object.keys(r.groups).length<=8,'max 8 muscle groups ('+Object.keys(r.groups).length+')');
ok(Object.values(r.groups).every(g=>g.length<=7&&new Set(g).size===g.length&&g.every(x=>x.length<=40)),'exercises: max 7, no duplicates, names trimmed');
ok(Object.keys(r.plan).join()==='Mon,Tue,Wed,Thu,Fri,Sat,Sun'&&!r.plan.Mon.includes('Fake')&&r.plan.Sat.length===0,'schedule: only real days, only real groups');
ok(r.tips.length<=3,'max 3 tips');
// under-18
await call(K,'/api/settings',{profile:{...prof,age:16,goal:'lose'}});await call(K,'/api/weights',{day:'2026-11-15',weight:180});
[s,r]=await call(K,'/api/ai/plan',{});const f2=JSON.parse(fs.readFileSync('/tmp/lastreq.json','utf8'));const fx=JSON.parse(f2.messages[0].content[0].text.slice(f2.messages[0].content[0].text.indexOf('{')));
ok(s===200&&r.calories>=Math.round(fx.estimated_maintenance_calories*0.9)-1,'under 18: max 10% cut ('+r.calories+' vs maintenance '+fx.estimated_maintenance_calories+')');
ok(/under 18/i.test(f2.system),'under-18 coaching rule sent to AI');
// good plan passes through
fs.writeFileSync('/tmp/mockmode','good');[s,r]=await call(F,'/api/ai/plan',{});
ok(s===200&&r.calories===Math.min(range[1],Math.max(range[0],2600))&&r.rx['Bench press']==='4 x 6-8','reasonable plan passes through (calories '+r.calories+', rx kept)');
// isolation: friend's profile not visible to Ethan
let [,a]=await call(E,'/api/state?today=2026-11-15');ok(!a.profile,"Ethan doesn't see friend's profile");
// cap
let codes=[];for(let i=0;i<4;i++)codes.push((await call(F,'/api/ai/plan',{}))[0]);ok(codes.includes(429),'plan builder counts toward AI daily cap');
console.log(`${pass} passed, ${fail} failed`);
// goal direction
for (const [goal,check,label] of [['muscle',(r,m)=>r.calories>=m,'muscle >= maintenance'],['lose',(r,m)=>r.calories<=m-150,'lose < maintenance'],['fit',(r,m)=>Math.abs(r.calories-m)<=m*0.08+1,'maintain within 8%']]){
  const T=jwt('user_dir_'+goal);await call(T,'/api/settings',{profile:{sex:'male',age:25,heightIn:70,bodyType:'athletic',goal,activity:'desk',days:4}});await call(T,'/api/weights',{day:'2026-11-15',weight:180});
  fs.writeFileSync('/tmp/mockmode','bad');const [st,rr]=await call(T,'/api/ai/plan',{});ok(st===200&&check(rr,rr.maintenance),`goal ${goal}: ${label} (${rr.calories} vs ${rr.maintenance})`);
}
console.log(`${pass} passed, ${fail} failed`);
