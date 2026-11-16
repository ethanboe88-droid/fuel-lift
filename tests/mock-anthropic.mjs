import http from 'node:http'; import fs from 'node:fs';
const mode = () => { try { return fs.readFileSync('/tmp/mockmode','utf8').trim() } catch { return 'bad' } };
http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
  fs.writeFileSync('/tmp/lastreq.json',b);
  const groups=[];for(let i=0;i<10;i++)groups.push({name:i<3?['Chest','Back','Legs'][i]:'Group'+i,exercises:[{name:'Bench press',prescription:'4 x 6-8'},{name:'Bench press',prescription:'dup'},{name:'X'.repeat(90),prescription:'3 x 10'},...Array.from({length:9},(_, j)=>({name:'Move '+j,prescription:'3 x 12'}))]});
  const good=mode()==='good';
  const input={calories:good?2600:900,protein:good?150:600,summary:'Plan summary.',
    schedule:{Mon:['Chest','Fake'],Tue:['Back'],Wed:[],Thu:['Legs'],Fri:['Chest','Back'],Sat:['Nonexistent'],Sun:[], Funday:['Chest']},
    groups:good?groups.slice(0,3):groups, tips:['Sleep 8h','Hit protein','Progressive overload','extra tip']};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({content:[{type:'tool_use',name:'save_plan',input}]}));
})}).listen(8799,()=>console.log('mock up'));
