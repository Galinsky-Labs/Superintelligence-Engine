// Local HTTP stand-ins that speak each external service's wire protocol (OpenAI, Anthropic, Gemini,
// ElevenLabs, Replicate, MCP, A2A, generic webhook). They verify request shape and auth headers.
// They are NOT live providers: tests using them prove protocol handling, not real model quality.
import {createServer} from 'node:http';
import {deflateSync,crc32} from 'node:zlib';

const png=()=>{const c=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const x=Buffer.alloc(4);x.writeUInt32BE(crc32(td)>>>0);return Buffer.concat([l,td,x]);};
  const h=Buffer.alloc(13);h.writeUInt32BE(2,0);h.writeUInt32BE(2,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),c('IHDR',h),c('IDAT',deflateSync(Buffer.alloc(14))),c('IEND',Buffer.alloc(0))]);};
const mp3=()=>Buffer.concat([Buffer.from('ID3'),Buffer.from([4,0,0,0,0,0,0]),Buffer.alloc(64,0xff)]);
const body=req=>new Promise(r=>{const c=[];req.on('data',d=>c.push(d));req.on('end',()=>r(Buffer.concat(c)));});

export async function startMockServices(){
  const log=[];const predictions=new Map();let predN=0;
  const sseHead=res=>res.writeHead(200,{'Content-Type':'text/event-stream'});
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://x');const raw=await body(req);let j=null;try{j=JSON.parse(raw.toString()||'null')}catch{}
    log.push({method:req.method,path:url.pathname,headers:req.headers,body:j,raw:j?undefined:raw.length});
    const p=url.pathname;
    // ---- OpenAI-compatible ----
    if(p.startsWith('/openai/v1/')){
      if(req.headers.authorization!=='Bearer sk-test-openai')return res.writeHead(401).end('{"error":{"message":"bad key"}}');
      if(p.endsWith('/chat/completions')){
        sseHead(res);const send=o=>res.write('data: '+JSON.stringify(o)+'\n\n');
        const lastUser=[...j.messages].reverse().find(m=>m.role==='user');const hasToolResult=j.messages.some(m=>m.role==='tool');
        if(j.tools?.length&&!hasToolResult&&/use the calculator/i.test(lastUser.content)){
          send({id:'chatcmpl-1',model:j.model,choices:[{index:0,delta:{tool_calls:[{index:0,id:'call_1',type:'function',function:{name:'calculator',arguments:'{"expression":'}}]}}]});
          send({id:'chatcmpl-1',model:j.model,choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"6*7"}'}}]},finish_reason:'tool_calls'}]});
          send({id:'chatcmpl-1',model:j.model,choices:[],usage:{prompt_tokens:50,completion_tokens:10}});
        }else{
          const text=j.response_format?JSON.stringify({answer:'forty-two',confidence:0.9}):hasToolResult?`The calculator says ${JSON.parse(j.messages.at(-1).content).result}.`:'Hello from the OpenAI wire mock.';
          for(const w of text.match(/.{1,6}/g))send({id:'chatcmpl-2',model:j.model+'-2026',choices:[{index:0,delta:{content:w}}]});
          send({id:'chatcmpl-2',model:j.model+'-2026',choices:[{index:0,delta:{},finish_reason:'stop'}]});
          send({id:'chatcmpl-2',model:j.model+'-2026',choices:[],usage:{prompt_tokens:1000,completion_tokens:500}});
        }
        res.write('data: [DONE]\n\n');return res.end();
      }
      if(p.endsWith('/images/generations')){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({created:1,data:[{b64_json:png().toString('base64')}]}));}
      if(p.endsWith('/audio/speech')){res.writeHead(200,{'Content-Type':'audio/mpeg'});return res.end(mp3());}
      if(p.endsWith('/audio/transcriptions')){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({text:'mock transcript',duration:30}));}
      if(p.endsWith('/models')){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({data:[{id:'gpt-4.1'},{id:'gpt-4.1-mini'}]}));}
    }
    // ---- Anthropic Messages API ----
    if(p==='/anthropic/v1/messages'){
      if(req.headers['x-api-key']!=='sk-ant-test'&&req.headers.authorization!=='Bearer sk-ant-test')return res.writeHead(401,{'Content-Type':'application/json'}).end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
      sseHead(res);const ev=(t,o)=>res.write(`event: ${t}\ndata: ${JSON.stringify({type:t,...o})}\n\n`);
      const text=j.output_config?.format?JSON.stringify({answer:'structured',confidence:1}):'Hello from the Anthropic wire mock.';
      ev('message_start',{message:{id:'msg_mock1',type:'message',role:'assistant',model:j.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:200,output_tokens:1}}});
      ev('content_block_start',{index:0,content_block:{type:'text',text:''}});
      for(const w of text.match(/.{1,5}/g))ev('content_block_delta',{index:0,delta:{type:'text_delta',text:w}});
      ev('content_block_stop',{index:0});
      const toolRound=j.tools?.length&&!j.messages.some(m=>Array.isArray(m.content)&&m.content.some(b=>b.type==='tool_result'));
      if(toolRound){
        ev('content_block_start',{index:1,content_block:{type:'tool_use',id:'toolu_1',name:'calculator',input:{}}});
        ev('content_block_delta',{index:1,delta:{type:'input_json_delta',partial_json:'{"expression":'}});
        ev('content_block_delta',{index:1,delta:{type:'input_json_delta',partial_json:'"2+3"}'}});
        ev('content_block_stop',{index:1});
      }
      ev('message_delta',{delta:{stop_reason:toolRound?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:100}});
      ev('message_stop',{});return res.end();
    }
    // ---- Gemini ----
    if(p.startsWith('/gemini/v1beta/models/')&&p.endsWith(':streamGenerateContent')){
      if(req.headers['x-goog-api-key']!=='gm-test')return res.writeHead(403).end('{}');
      sseHead(res);for(const w of ['Hello ','from ','Gemini ','mock.'])res.write('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text:w}]}}]})+'\n\n');
      res.write('data: '+JSON.stringify({candidates:[{content:{parts:[]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:80,candidatesTokenCount:20},responseId:'gem-r1'})+'\n\n');return res.end();
    }
    // ---- ElevenLabs ----
    if(p.startsWith('/elevenlabs/v1/')){
      if(req.headers['xi-api-key']!=='el-test')return res.writeHead(401).end();
      res.writeHead(200,{'Content-Type':'audio/mpeg'});return res.end(mp3());
    }
    // ---- Replicate ----
    if(p.startsWith('/replicate/v1/')){
      if(req.headers.authorization!=='Bearer r8-test')return res.writeHead(401).end();
      if(req.method==='POST'&&/\/models\/.+\/predictions$/.test(p)){const id='pred'+(++predN)+'abcdef';predictions.set(id,0);res.writeHead(201,{'Content-Type':'application/json'});return res.end(JSON.stringify({id,status:'starting'}));}
      const m=/\/predictions\/(\w+)$/.exec(p);
      if(m){const n=predictions.get(m[1])??99;predictions.set(m[1],n+1);res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify(n<2?{id:m[1],status:'processing'}:{id:m[1],status:'succeeded',output:`http://127.0.0.1:${server.address().port}/files/${m[1]}.mp4`,metrics:{predict_time:4}}));}
    }
    if(p.startsWith('/files/')){res.writeHead(200,{'Content-Type':'video/mp4'});return res.end(Buffer.concat([Buffer.from([0,0,0,0x18]),Buffer.from('ftypmp42'),Buffer.alloc(16)]));}
    // ---- MCP (Streamable HTTP, JSON responses) ----
    if(p==='/mcp'){
      if(req.headers.authorization!=='Bearer mcp-secret')return res.writeHead(401).end();
      const reply=result=>{res.writeHead(200,{'Content-Type':'application/json','Mcp-Session-Id':'sess-1'});res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result}));};
      if(j.method==='initialize')return reply({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'mock',version:'1'}});
      if(j.method==='notifications/initialized'){res.writeHead(202);return res.end();}
      if(j.method==='tools/list')return reply({tools:[{name:'lookup',description:'Look up a fact',inputSchema:{type:'object',properties:{q:{type:'string'}},required:['q']}},{name:'create_ticket',description:'Create a ticket',inputSchema:{type:'object',properties:{title:{type:'string'}},required:['title']}}]});
      if(j.method==='tools/call')return reply({content:[{type:'text',text:j.params.name==='lookup'?`Fact about ${j.params.arguments.q}: it is mocked.`:`Ticket created: ${j.params.arguments.title}`}]});
    }
    // ---- A2A agent ----
    if(p==='/a2a'){
      res.writeHead(200,{'Content-Type':'application/json'});
      const text=j.params.message.parts[0].text;
      return res.end(JSON.stringify({jsonrpc:'2.0',id:j.id,result:{id:'task-9',kind:'task',status:{state:'completed'},artifacts:[{parts:[{kind:'text',text:'External agent handled: '+text.slice(0,60)}]}]}}));
    }
    if(p==='/webhook'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"received":true}');}
    if(p==='/page'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<html><body><h1>Mock page</h1><p>Lithium supply facts.</p><script>evil()</script></body></html>');}
    res.writeHead(404);res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  return {base,log,server,env:{
    OPENAI_API_KEY:'sk-test-openai',SIE_OPENAI_BASE_URL:base+'/openai/v1',
    ANTHROPIC_API_KEY:'sk-ant-test',SIE_ANTHROPIC_BASE_URL:base+'/anthropic',
    GEMINI_API_KEY:'gm-test',SIE_GEMINI_BASE_URL:base+'/gemini/v1beta',
    ELEVENLABS_API_KEY:'el-test',SIE_ELEVENLABS_BASE_URL:base+'/elevenlabs/v1',
    REPLICATE_API_TOKEN:'r8-test',SIE_REPLICATE_BASE_URL:base+'/replicate/v1',
    SIE_ALLOW_HTTP_EGRESS:'1',SIE_ALLOW_PRIVATE_EGRESS:'1',SIE_EGRESS_ALLOWLIST:'127.0.0.1',SIE_ALLOW_HTTP_PROVIDER_URLS:'1'},
    close:()=>new Promise(r=>server.close(r))};
}
