import crypto from 'node:crypto'; import fs from 'node:fs';
const B='http://localhost:8788', priv=fs.readFileSync(process.env.TEST_PRIV||'test-keys/priv.pem'), evil=fs.readFileSync(process.env.TEST_EVIL||'test-keys/evil.pem');
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub,{key=priv,azp=B,exp=60,sid='sess_1'}={}){const now=Math.floor(Date.now()/1000);
  const h=b64({alg:'RS256',typ:'JWT',kid:'ins_test',cat:'cl_B7d4PD111AAA'}),p=b64({sub,azp,sid,iss:'https://grand-kid-8056.clerk.accounts.dev',iat:now,nbf:now-5,exp:now+exp});
  return h+'.'+p+'.'+crypto.sign('RSA-SHA256',Buffer.from(h+'.'+p),key).toString('base64url')}
async function call(tok,path,body,method){const h={};if(tok)h.authorization='Bearer '+tok;if(body)h['content-type']='application/json';
  const r=await fetch(B+path,{method:method||(body?'POST':'GET'),headers:h,body:body?JSON.stringify(body):undefined});return [r.status,await r.json().catch(()=>({}))]}
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
const A=jwt('user_ethan'),A2=jwt('user_ethan',{sid:'sess_phone'}),Bt=jwt('user_friend');
const T='?today=2026-11-15';
// --- auth rejections
ok((await call(null,'/api/state'+T))[0]===401,'no token -> 401');
ok((await call('garbage','/api/state'+T))[0]===401,'garbage token -> 401');
ok((await call(jwt('user_ethan',{key:evil}),'/api/state'+T))[0]===401,'token signed by wrong key -> 401');
ok((await call(jwt('user_ethan',{exp:-120}),'/api/state'+T))[0]===401,'expired token -> 401');
ok((await call(jwt('user_ethan',{azp:'https://evil.example'}),'/api/state'+T))[0]===401,'token issued for another site (azp) -> 401');
ok((await call(jwt('admin'),'/api/state'+T))[0]===401,'non-user subject -> 401');
ok((await call(null,'/api/config'))[0]===200,'public config works without login');
// --- owner claims legacy data
let [s,a]=await call(A,'/api/state'+T);
ok(s===200&&a.meals.length===4&&a.goal===3100&&a.proteinGoal===167&&a.favorites.length===4&&a.checks.length===5&&a.plan.Fri.length===3&&a.isOwner,'owner sees all existing data (4 meals, goals, plan, 4 favorites, 5 checks)');
// --- friend sees nothing of owner's
let [s2,b]=await call(Bt,'/api/state'+T);
ok(s2===200&&b.meals.length===0&&b.goal===0&&b.favorites.length===0&&b.checks.length===0&&!b.isOwner,'friend starts empty with defaults');
// friend writes
const [,mB]=await call(Bt,'/api/meals',{day:'2026-11-15',name:'Friend burrito',calories:900,protein:40,user_id:'user_ethan'});
await call(Bt,'/api/settings',{goal:2500,favorites:[{name:'Friend shake',calories:300,protein:40}],user_id:'user_ethan'});
await call(Bt,'/api/check',{week:'2026-11-09',k:'Mon|Chest|Bench press',on:true,user_id:'user_ethan'});
const [,lB]=await call(Bt,'/api/lifts',{day:'2026-11-15',exercise:'Bench press',weight:225,reps:5,sets:3});
[,a]=await call(A,'/api/state'+T);
ok(a.meals.length===4&&!a.meals.some(m=>m.name==='Friend burrito'),"owner doesn't see friend's meal (even with user_id spoofed in body)");
ok(a.goal===3100&&a.favorites.length===4,"friend's settings didn't touch owner's");
ok(a.checks.length===5&&a.lifts.length===0,"friend's checks/lifts not visible to owner");
[,b]=await call(Bt,'/api/state'+T);
ok(b.meals.length===1&&b.goal===2500&&b.checks.length===1&&b.lifts.length===1,'friend sees only own data');
// --- tampering: delete other user's rows by id
let [d1]=await call(Bt,'/api/meals/1',null,'DELETE');
let [d2]=await call(A,'/api/meals/'+mB.id,null,'DELETE');
let [d3]=await call(A,'/api/lifts/'+lB.id,null,'DELETE');
[,a]=await call(A,'/api/state'+T);[,b]=await call(Bt,'/api/state'+T);
ok(d1===404&&a.meals.some(m=>m.id===1),"friend can't delete owner's meal by guessing id");
ok(d2===404&&d3===404&&b.meals.length===1&&b.lifts.length===1,"owner can't delete friend's meal/lift by id");
// id-guessing via query param / path tricks
let [q]=await call(Bt,'/api/state?today=2026-11-15&user_id=user_ethan');
[,b]=await call(Bt,'/api/state?today=2026-11-15&user_id=user_ethan');
ok(b.meals.length===1&&!b.meals.some(m=>m.id===1),'?user_id= in URL is ignored');
// --- same user on 2 devices
let [,a2]=await call(A2,'/api/state'+T);
await call(A2,'/api/meals',{day:'2026-11-15',name:'Logged on phone',calories:100,protein:5});
[,a]=await call(A,'/api/state'+T);
ok(a2.meals.length===4&&a.meals.some(m=>m.name==='Logged on phone'),'same account syncs across devices (different sessions)');
// owner delete own works
const ph=a.meals.find(m=>m.name==='Logged on phone');let [d4]=await call(A,'/api/meals/'+ph.id,null,'DELETE');ok(d4===200,'owner can delete own meal');
// --- AI cap (limit 2 in test): friend 3rd call blocked, owner exempt
let r1=(await call(Bt,'/api/ai/parse',{text:'x'}))[0],r2=(await call(Bt,'/api/ai/parse',{text:'x'}))[0],r3=(await call(Bt,'/api/ai/parse',{text:'x'}));
ok(r3[0]===429&&r1!==429&&r2!==429,'friend AI capped after daily limit -> '+r3[1].error);
let o=[];for(let i=0;i<4;i++)o.push((await call(A,'/api/ai/parse',{text:'x'}))[0]);
ok(!o.includes(429),'owner exempt from AI cap');
console.log(`\n${pass} passed, ${fail} failed`);
