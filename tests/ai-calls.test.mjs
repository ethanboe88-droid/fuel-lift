import crypto from 'node:crypto'; import fs from 'node:fs';
const B='http://localhost:8788',priv=fs.readFileSync(process.env.TEST_PRIV||'test-keys/priv.pem');const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt=sub=>{const now=Math.floor(Date.now()/1000);const h=b64({alg:'RS256',typ:'JWT',cat:'cl_B7d4PD111AAA'}),p=b64({sub,azp:B,iat:now,nbf:now-5,exp:now+300});return h+'.'+p+'.'+crypto.sign('RSA-SHA256',Buffer.from(h+'.'+p),priv).toString('base64url')};
const call=async(t,path,body)=>{const r=await fetch(B+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+t,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return [r.status,await r.json()]};
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+m)};
// sanity: mock rejects forced tool_choice like the real API
const raw=await fetch('http://localhost:8799/v1/messages',{method:'POST',body:JSON.stringify({tools:[{name:'x'}],tool_choice:{type:'tool',name:'x'},messages:[]})});ok(raw.status===400,'mock rejects forced tool_choice (same as real API)');
const E=jwt('user_ethan');
let [s,r]=await call(E,'/api/ai/parse',{text:'chipotle bowl'});ok(s===200&&r.meals[0].calories===1050,'quick log works with auto tool_choice ('+s+')');
const sent=JSON.parse(fs.readFileSync('/tmp/lastreq.json','utf8'));ok(sent.tool_choice.type==='auto'&&/calling the log_entries tool/.test(sent.system),'sends tool_choice auto + instruction');
[s,r]=await call(E,'/api/ai/recap',{summary:{x:1}});ok(s===200&&/Line one/.test(r.text),'weekly check-in works');
await call(E,'/api/settings',{profile:{sex:'male',age:18,heightIn:73,bodyType:'lean',goal:'ripped',activity:'physical',days:3}});await call(E,'/api/weights',{day:'2026-11-15',weight:165});
fs.writeFileSync('/tmp/mockmode','good');[s,r]=await call(E,'/api/ai/plan',{});ok(s===200&&r.calories>0&&Object.keys(r.groups).length,'AI plan builds ('+s+(r.error?' '+r.error:'')+')');
fs.writeFileSync('/tmp/mockmode','textfirst');[s,r]=await call(E,'/api/ai/plan',{});ok(s===200&&Object.keys(r.groups).length,'if AI answers in text first, it retries and still builds ('+s+')');
console.log(`${pass} passed, ${fail} failed`);
