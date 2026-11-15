// Built-in model catalog. Prices are USD microunits (1 USD = 1,000,000).
// Text models: per million tokens. Media models: per unit (image, character, minute, second, run).
// Operators can override or add prices in the model_prices table (scripts/admin.mjs set-price).
// A model with an unknown price is never dispatched: budget enforcement requires a price.
const M=usd=>Math.round(usd*1e6);
export const BUILTIN_MODELS=[
  // Anthropic (first-party API list prices, cached 2026-10-06)
  {provider:'anthropic',model:'claude-opus-5-5',label:'Claude Opus 5.5',capabilities:['chat','tools','structured','vision'],price:{input:M(4),output:M(20)},contextWindow:1000000,maxOutput:128000,default:true},
  {provider:'anthropic',model:'claude-sonnet-5-5',label:'Claude Sonnet 5.5',capabilities:['chat','tools','structured','vision'],price:{input:M(2),output:M(10)},contextWindow:1000000,maxOutput:128000},
  {provider:'anthropic',model:'claude-haiku-5-5',label:'Claude Haiku 5.5',capabilities:['chat','tools','structured','vision'],price:{input:M(0.10),output:M(0.50)},contextWindow:1000000,maxOutput:128000},
  {provider:'anthropic',model:'claude-fable-5-1',label:'Claude Fable 5.1',capabilities:['chat','tools','structured','vision'],price:{input:M(10),output:M(50)},contextWindow:1000000,maxOutput:128000},
  // OpenAI (configured list prices; verify against current OpenAI pricing before funding)
  {provider:'openai',model:'gpt-4.1',label:'GPT-4.1',capabilities:['chat','tools','structured','vision'],price:{input:M(2),output:M(8)},contextWindow:1047576,maxOutput:32768},
  {provider:'openai',model:'gpt-4.1-mini',label:'GPT-4.1 mini',capabilities:['chat','tools','structured','vision'],price:{input:M(0.4),output:M(1.6)},contextWindow:1047576,maxOutput:32768},
  {provider:'openai',model:'gpt-image-1',label:'GPT Image 1',capabilities:['image'],price:{unit:M(0.25),per:'image'}},
  {provider:'openai',model:'tts-1',label:'OpenAI TTS',capabilities:['speech'],price:{unit:15,per:'character'}},
  {provider:'openai',model:'whisper-1',label:'Whisper',capabilities:['transcribe'],price:{unit:M(0.006),per:'minute'}},
  // Google Gemini (configured list prices; verify before funding)
  {provider:'gemini',model:'gemini-2.5-pro',label:'Gemini 2.5 Pro',capabilities:['chat','tools','structured','vision'],price:{input:M(1.25),output:M(10)},contextWindow:1048576,maxOutput:65536},
  {provider:'gemini',model:'gemini-2.5-flash',label:'Gemini 2.5 Flash',capabilities:['chat','tools','structured','vision'],price:{input:M(0.3),output:M(2.5)},contextWindow:1048576,maxOutput:65536},
  // ElevenLabs / Replicate: prices depend on plan/model. Unknown until an operator sets them.
  {provider:'elevenlabs',model:'eleven_multilingual_v2',label:'ElevenLabs Multilingual v2',capabilities:['speech'],price:null},
  {provider:'elevenlabs',model:'music_v1',label:'ElevenLabs Music',capabilities:['music'],price:null},
  {provider:'replicate',model:'minimax/video-01',label:'MiniMax Video-01 (Replicate)',capabilities:['video'],price:null},
  {provider:'replicate',model:'meta/musicgen',label:'MusicGen (Replicate)',capabilities:['music'],price:null},
  {provider:'replicate',model:'black-forest-labs/flux-schnell',label:'FLUX schnell (Replicate)',capabilities:['image'],price:null},
  // Deterministic test provider: zero cost, output is SIMULATED and labeled as such.
  {provider:'deterministic',model:'sim-text',label:'Deterministic simulator (text)',capabilities:['chat','tools','structured'],price:{input:0,output:0},contextWindow:200000,maxOutput:8192,simulated:true},
  {provider:'deterministic',model:'sim-media',label:'Deterministic simulator (media)',capabilities:['image','speech','music','video','transcribe'],price:{unit:0,per:'unit'},simulated:true},
];

export const CAPABILITIES=['chat','tools','structured','vision','image','speech','transcribe','music','video'];
