// Minimal OpenTelemetry trace export (OTLP/HTTP JSON). Enabled when OTEL_EXPORTER_OTLP_ENDPOINT is set.
// Each run is one trace (trace id = run id), each node execution and provider call is a span;
// API requests continue an incoming W3C traceparent.
import {randomBytes} from 'node:crypto';

const hex=n=>randomBytes(n).toString('hex');
const nowNs=()=>BigInt(Date.now())*1000000n+BigInt(Math.floor((performance.now()%1)*1e6));
function attrs(o){return Object.entries(o||{}).filter(([,v])=>v!==undefined&&v!==null).map(([key,v])=>({key,value:typeof v==='number'?(Number.isInteger(v)?{intValue:String(v)}:{doubleValue:v}):typeof v==='boolean'?{boolValue:v}:{stringValue:String(v).slice(0,1000)}}));}

export class Tracer {
  constructor({endpoint=process.env.OTEL_EXPORTER_OTLP_ENDPOINT,headers=process.env.OTEL_EXPORTER_OTLP_HEADERS,service=process.env.OTEL_SERVICE_NAME||'superintelligence-engine',flushMs=2000}={}){
    this.endpoint=endpoint?endpoint.replace(/\/$/,'')+'/v1/traces':null;this.service=service;this.buf=[];
    this.headers=Object.fromEntries(String(headers||'').split(',').map(h=>h.split('=').map(s=>s.trim())).filter(x=>x[0]&&x[1]));
    if(this.endpoint){this.timer=setInterval(()=>this.flush(),flushMs);this.timer.unref?.();}
  }
  configure({endpoint,headers,service}={}){
    clearInterval(this.timer);this.endpoint=endpoint?endpoint.replace(/\/$/,'')+'/v1/traces':null;if(service)this.service=service;
    this.headers=Object.fromEntries(String(headers||'').split(',').map(h=>h.split('=').map(s=>s.trim())).filter(x=>x[0]&&x[1]));
    if(this.endpoint){this.timer=setInterval(()=>this.flush(),2000);this.timer.unref?.();}
  }
  get enabled(){return Boolean(this.endpoint);}
  static parseTraceparent(h){const m=/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(String(h||''));return m?{traceId:m[1],spanId:m[2]}:null;}
  start(name,{traceId,parentSpanId,kind=1,attributes}={}){
    const span={traceId:traceId||hex(16),spanId:hex(8),parentSpanId,name,kind,startTimeUnixNano:nowNs(),attributes:{...attributes},status:{code:0}};
    const t=this;
    return {...span,set(k,v){span.attributes[k]=v;return this;},error(msg){span.status={code:2,message:String(msg).slice(0,300)};return this;},
      end(){if(!t.enabled)return;span.endTimeUnixNano=nowNs();t.buf.push(span);if(t.buf.length>=512)t.flush();},
      traceparent:`00-${span.traceId}-${span.spanId}-01`};
  }
  async flush(){
    if(!this.endpoint||!this.buf.length)return;
    const spans=this.buf.splice(0,this.buf.length).map(s=>({traceId:s.traceId,spanId:s.spanId,...(s.parentSpanId?{parentSpanId:s.parentSpanId}:{}),name:s.name,kind:s.kind,
      startTimeUnixNano:String(s.startTimeUnixNano),endTimeUnixNano:String(s.endTimeUnixNano),attributes:attrs(s.attributes),status:s.status}));
    const body={resourceSpans:[{resource:{attributes:attrs({'service.name':this.service,'service.version':'0.2.0'})},scopeSpans:[{scope:{name:'sie.engine'},spans}]}]};
    try{await fetch(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...this.headers},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});}catch{}
  }
  async shutdown(){clearInterval(this.timer);await this.flush();}
}
export const runTraceId=runId=>String(runId).replace(/-/g,'').toLowerCase();
export const tracer=new Tracer();
