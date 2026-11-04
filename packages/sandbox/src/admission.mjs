/** This is admission validation only; NOT an isolation mechanism or a runner. */
const RUNTIMES=new Set(['node22','python3']);
const KEYS=['runtime','cpuMillis','memoryMiB','timeoutMs','network','mounts','secrets','workspaceId'];
const fail=()=>{throw new TypeError('Unsafe sandbox admission request')};
export function validateSandboxRequest(input) {
 if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.getPrototypeOf(input)!==Object.prototype||Object.keys(input).length!==KEYS.length||
    KEYS.some(k=>!Object.hasOwn(input,k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,k),'value')))fail();
 const {runtime,cpuMillis,memoryMiB,timeoutMs,network,mounts,secrets,workspaceId}=input;
 if(!RUNTIMES.has(runtime)||!Number.isSafeInteger(cpuMillis)||cpuMillis<100||cpuMillis>30000||
    !Number.isSafeInteger(memoryMiB)||memoryMiB<64||memoryMiB>2048||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000||
    network!=='disabled'||!Array.isArray(mounts)||mounts.length!==0||
    !Array.isArray(secrets)||secrets.length!==0||
    typeof workspaceId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(workspaceId))fail();
 return Object.freeze({runtime,cpuMillis,memoryMiB,timeoutMs,network:'disabled',
   mounts:Object.freeze([]),secrets:Object.freeze([]),workspaceId});
}
