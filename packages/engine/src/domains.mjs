// Domain workspaces. Every operation compiles to a real workflow spec executed by the run engine.
import {check,isObject} from './infra.mjs';
import {validate} from './schema.mjs';

const S=(properties,required)=>({type:'object',properties,required:required||Object.keys(properties),additionalProperties:false});
const str=(title,extra={})=>({type:'string',title,...extra});
const opt=(schema,keys)=>({...schema,required:schema.required.filter(k=>!keys.includes(k))});

const REPORT_SCHEMA=S({title:{type:'string'},summary:{type:'string'},findings:{type:'array',items:S({claim:{type:'string'},evidence:{type:'string'},source:{type:'string'},confidence:{type:'string',enum:['low','medium','high']}})},
  openQuestions:{type:'array',items:{type:'string'}}});
const BILL_SCHEMA=S({title:{type:'string'},shortTitle:{type:'string'},jurisdiction:{type:'string'},findings:{type:'array',items:{type:'string'}},
  definitions:{type:'array',items:S({term:{type:'string'},meaning:{type:'string'}})},
  sections:{type:'array',minItems:1,items:S({number:{type:'string'},heading:{type:'string'},text:{type:'string'}})},
  enforcement:{type:'string'},effectiveDate:{type:'string'},fiscalNote:{type:'string'}});

export const DOMAINS=[
  {id:'research',title:'Research',description:'Investigate questions with cited findings, optionally reading supplied web sources.'},
  {id:'writing',title:'Writing',description:'Poetry, persuasive writing and fiction with versioned drafts and revisions.'},
  {id:'legislation',title:'Legislation',description:'Draft structured bills and analyze legislative text.'},
  {id:'code',title:'Code',description:'Build, edit, run and test software in an isolated workspace with Git history.'},
  {id:'data',title:'Data analysis',description:'Analyze CSV/JSON data by generating and executing code in the sandbox.'},
  {id:'image',title:'Images',description:'Generate images from prompts.'},
  {id:'music',title:'Music',description:'Compose lyrics/structure and render audio.'},
  {id:'video',title:'Video',description:'Generate short videos through asynchronous providers.'},
  {id:'voice',title:'Voice',description:'Text-to-speech narration and speech transcription.'},
  {id:'cross-media',title:'Cross-media',description:'Coordinated campaigns across text, image, voice and music.'},
];

export const OPERATIONS=[
  {id:'research.brief',domain:'research',title:'Research brief',description:'A cited research brief answering a question.',
    inputSchema:opt(S({question:str('Question'),sources:{type:'array',title:'Source URLs (optional)',items:{type:'string'}},depth:{type:'string',enum:['quick','thorough'],title:'Depth'}}),['sources','depth']),
    build:i=>({title:`Research: ${i.question}`.slice(0,200),inputs:{question:i.question,sources:i.sources||[]},nodes:[
      {key:'investigate',type:'agent',role:'a meticulous research analyst',tools:i.sources?.length?['web_fetch','artifact_read','artifact_list']:['artifact_list','artifact_read'],maxSteps:10,
        instructions:`Research this question: {{inputs.question}}\n${i.sources?.length?'Read these sources with web_fetch and cite them: '+i.sources.join(', '):'Use your knowledge; be explicit about uncertainty and what should be verified.'}\nProduce detailed notes with evidence and source for every claim.`,artifact:{title:'Research notes'}},
      {key:'brief',type:'agent',dependsOn:['investigate'],role:'a senior editor',outputSchema:REPORT_SCHEMA,instructions:'Turn the research notes into a structured brief. Every finding needs evidence and a source (URL, document, or "model knowledge — verify").',artifact:{title:'Research brief'}},
    ]})},
  {id:'research.deep',domain:'research',title:'Deep research (multi-agent)',description:'A planner splits the question into sub-investigations run by parallel agents, then synthesizes.',
    inputSchema:opt(S({question:str('Question'),maxAgents:{type:'integer',minimum:2,maximum:50,title:'Max parallel agents'}}),['maxAgents']),
    build:i=>({title:`Deep research: ${i.question}`.slice(0,200),inputs:{question:i.question},nodes:[
      {key:'plan',type:'planner',maxTasks:i.maxAgents||5,instructions:'Plan a thorough investigation of: {{inputs.question}}. Each subtask should investigate a distinct angle.',
        worker:{role:'a research specialist',tools:['artifact_list','artifact_read'],maxSteps:6},synthesis:{title:'Deep research report',instructions:'Write the final research report answering: {{inputs.question}}. Integrate every specialist finding, note disagreements and open questions.'}}]})},
  {id:'writing.poem',domain:'writing',title:'Poem',description:'Compose a poem in a chosen form, then a critique-and-revise pass.',
    inputSchema:opt(S({topic:str('Topic'),form:str('Form (e.g. sonnet, free verse, haiku sequence)'),tone:str('Tone')}),['form','tone']),
    build:i=>({title:`Poem: ${i.topic}`.slice(0,200),inputs:i,nodes:[
      {key:'draft',type:'agent',role:'an accomplished poet',instructions:`Write a ${i.form||'free verse'} poem about {{inputs.topic}}${i.tone?' with a '+i.tone+' tone':''}. Attend to imagery, sound and line breaks.`,artifact:{title:`Poem draft — ${i.topic}`.slice(0,200),kind:'poem'}},
      {key:'revise',type:'agent',dependsOn:['draft'],role:'a demanding poetry editor and poet',instructions:'Critique the draft briefly (3-5 bullet points) and then give the full revised poem under a heading "Revised poem".',artifact:{title:`Poem — ${i.topic}`.slice(0,200),kind:'poem'}}]})},
  {id:'writing.persuasive',domain:'writing',title:'Persuasive essay',description:'Argument outline, counter-arguments, then a polished persuasive piece.',
    inputSchema:opt(S({thesis:str('Thesis'),audience:str('Audience'),length:{type:'integer',minimum:150,maximum:5000,title:'Target words'}}),['audience','length']),
    build:i=>({title:`Persuasive: ${i.thesis}`.slice(0,200),inputs:i,nodes:[
      {key:'outline',type:'agent',role:'a debate strategist',outputSchema:S({claims:{type:'array',items:S({claim:{type:'string'},support:{type:'string'}})},counterArguments:{type:'array',items:S({objection:{type:'string'},rebuttal:{type:'string'}})}}),
        instructions:`Build the argument for: {{inputs.thesis}}${i.audience?' (audience: '+i.audience+')':''}. Include the strongest counter-arguments and rebuttals.`,artifact:{title:'Argument map'}},
      {key:'essay',type:'agent',dependsOn:['outline'],role:'a persuasive essayist',instructions:`Write a ${i.length||800}-word persuasive essay using the argument map. Address counter-arguments honestly.`,artifact:{title:`Essay — ${i.thesis}`.slice(0,200),kind:'essay'}}]})},
  {id:'writing.fiction',domain:'writing',title:'Short fiction',description:'Story bible, then a complete short story.',
    inputSchema:opt(S({premise:str('Premise'),genre:str('Genre'),length:{type:'integer',minimum:300,maximum:8000,title:'Target words'}}),['genre','length']),
    build:i=>({title:`Story: ${i.premise}`.slice(0,200),inputs:i,nodes:[
      {key:'bible',type:'agent',role:'a story architect',outputSchema:S({title:{type:'string'},characters:{type:'array',items:S({name:{type:'string'},want:{type:'string'},flaw:{type:'string'}})},setting:{type:'string'},beats:{type:'array',items:{type:'string'}}}),
        instructions:`Design a ${i.genre||'literary'} short story from this premise: {{inputs.premise}}`,artifact:{title:'Story bible'}},
      {key:'story',type:'agent',dependsOn:['bible'],role:'a novelist',instructions:`Write the complete story (~${i.length||1500} words) following the story bible.`,artifact:{title:'Short story',kind:'fiction'}}]})},
  {id:'writing.revise',domain:'writing',title:'Revise an artifact',description:'Apply editing instructions to an existing text artifact, saving a new revision (the old one stays in history).',
    inputSchema:S({artifactId:str('Artifact id'),instructions:str('Editing instructions')}),
    build:i=>({title:'Revision',inputs:i,nodes:[{key:'revise',type:'agent',role:'a careful editor',tools:['artifact_read'],maxSteps:4,reviseArtifactId:i.artifactId,
      instructions:`Read artifact ${i.artifactId} with artifact_read, then apply these instructions: {{inputs.instructions}}\nReturn ONLY the full revised text.`}]})},
  {id:'legislation.draft',domain:'legislation',title:'Draft a bill',description:'Structured bill drafting followed by an independent legal-analysis agent.',
    inputSchema:opt(S({subject:str('Subject'),jurisdiction:str('Jurisdiction'),goals:str('Policy goals')}),['goals']),
    build:i=>({title:`Bill: ${i.subject}`.slice(0,200),inputs:i,nodes:[
      {key:'draft',type:'agent',role:'an experienced legislative drafter',outputSchema:BILL_SCHEMA,instructions:'Draft a bill on {{inputs.subject}} for {{inputs.jurisdiction}}. Goals: {{inputs.goals}}. Use precise statutory language, definitions and numbered sections.',artifact:{title:`Bill — ${i.subject}`.slice(0,200),kind:'bill'}},
      {key:'analysis',type:'agent',dependsOn:['draft'],role:'a nonpartisan legislative counsel',instructions:'Analyze the draft bill: constitutional/legal risks, ambiguities, enforcement gaps, fiscal impact and recommended amendments. This is analysis, not legal advice.',artifact:{title:'Legislative analysis',kind:'analysis'}}]})},
  {id:'legislation.analyze',domain:'legislation',title:'Analyze legislation',description:'Section-by-section analysis of supplied legislative text.',
    inputSchema:S({text:str('Legislative text')}),
    build:i=>({title:'Legislative analysis',inputs:i,nodes:[{key:'analysis',type:'agent',role:'a nonpartisan legislative counsel',instructions:'Provide a section-by-section analysis, plain-language summary, affected parties, and risks for:\n\n{{inputs.text}}',artifact:{title:'Legislative analysis',kind:'analysis'}}]})},
  {id:'code.build',domain:'code',title:'Build software',description:'A coding agent writes files, runs them and their tests in the sandbox, iterates until tests pass, then commits.',
    inputSchema:opt(S({task:str('What to build'),language:{type:'string',enum:['python','node'],title:'Language'}}),['language']),
    build:i=>({title:`Code: ${i.task}`.slice(0,200),inputs:i,nodes:[
      {key:'implement',type:'agent',role:'a senior software engineer',tools:['code','git_commit'],maxSteps:16,maxOutputTokens:16000,
        instructions:`Implement in ${i.language||'python'}: {{inputs.task}}\nWrite the source and automated tests with file_write (${(i.language||'python')==='python'?'tests named test_*.py using unittest':'tests named *.test.mjs using node:test'}). Run the tests with workspace_exec (${(i.language||'python')==='python'?'["python3","-m","unittest","discover","-v"]':'["node","--test"]'}) and fix failures until they pass. Finally call git_commit with a descriptive message and summarize what you built and the test results.`,artifact:{title:'Implementation summary',kind:'code-summary'}},
      {key:'verify',type:'code',dependsOn:['implement'],useWorkspace:true,command:(i.language||'python')==='python'?['python3','-m','unittest','discover','-v']:['node','--test'],artifact:{title:'Test run'}}]})},
  {id:'code.review',domain:'code',title:'Code review',description:'Review the workspace code for defects, security issues and improvements.',
    inputSchema:opt(S({focus:str('Focus (optional)')}),['focus']),
    build:i=>({title:'Code review',inputs:i,nodes:[{key:'review',type:'agent',role:'a principal engineer doing code review',tools:['file_list','file_read','workspace_exec'],maxSteps:12,
      instructions:`Review the project's code${i.focus?' focusing on '+i.focus:''}. Read the files, run the tests if any, and report concrete defects with file/line references and suggested fixes.`,artifact:{title:'Code review',kind:'review'}}]})},
  {id:'data.analyze',domain:'data',title:'Analyze data',description:'Load a CSV/JSON dataset into the workspace, compute statistics with sandboxed Python, and write findings.',
    inputSchema:opt(S({question:str('Question about the data'),data:str('Dataset content (CSV or JSON)'),artifactId:str('Or: artifact id containing the data')}),['data','artifactId']),
    prepare:'dataset',
    build:i=>({title:`Data: ${i.question}`.slice(0,200),inputs:{question:i.question},nodes:[{key:'analyze',type:'agent',role:'a careful data scientist',tools:['code','artifact_write'],maxSteps:12,
      instructions:`The dataset is in the workspace at ${i.datasetPath||'data/input.csv'}. Answer: {{inputs.question}}\nUse workspace_exec with Python (standard library csv/json/statistics) to compute every number you report — never estimate. Show the code results, then a concise findings section.`,artifact:{title:'Data analysis',kind:'analysis'}}]})},
  {id:'image.generate',domain:'image',title:'Generate image',description:'Text-to-image generation saved as a project asset.',
    inputSchema:opt(S({prompt:str('Prompt'),size:{type:'string',enum:['1024x1024','1536x1024','1024x1536'],title:'Size'}}),['size']),
    build:i=>({title:`Image: ${i.prompt}`.slice(0,200),inputs:i,nodes:[{key:'image',type:'media',operation:'image',prompt:i.prompt,size:i.size}]})},
  {id:'image.art-direct',domain:'image',title:'Art-directed image',description:'An art-director agent writes a detailed prompt, then the image is generated.',
    inputSchema:S({brief:str('Creative brief')}),
    build:i=>({title:`Art direction: ${i.brief}`.slice(0,200),inputs:i,nodes:[
      {key:'direction',type:'agent',role:'an art director',outputSchema:S({prompt:{type:'string'},rationale:{type:'string'}}),instructions:'Write a single detailed image-generation prompt (composition, lighting, palette, style) for this brief: {{inputs.brief}}',artifact:{title:'Art direction'}},
      {key:'image',type:'media',dependsOn:['direction'],operation:'image',prompt:'{{nodes.direction.data.prompt}}'}]})},
  {id:'music.compose',domain:'music',title:'Compose music',description:'A composer agent writes the musical brief and lyrics; audio is then rendered.',
    inputSchema:opt(S({idea:str('Song idea'),durationSeconds:{type:'integer',minimum:5,maximum:300,title:'Duration (s)'}}),['durationSeconds']),
    build:i=>({title:`Music: ${i.idea}`.slice(0,200),inputs:i,nodes:[
      {key:'compose',type:'agent',role:'a composer and lyricist',outputSchema:S({title:{type:'string'},genre:{type:'string'},tempoBpm:{type:'integer'},structure:{type:'array',items:{type:'string'}},lyrics:{type:'string'},renderPrompt:{type:'string'}}),
        instructions:'Compose a song for: {{inputs.idea}}. renderPrompt must be a concise music-generation prompt (genre, instruments, mood, tempo).',artifact:{title:'Composition',kind:'music-score'}},
      {key:'render',type:'media',dependsOn:['compose'],operation:'music',prompt:'{{nodes.compose.data.renderPrompt}}',durationSeconds:i.durationSeconds||30,title:`Music — ${i.idea}`.slice(0,150)}]})},
  {id:'video.generate',domain:'video',title:'Generate video',description:'Asynchronous text-to-video generation with durable polling.',
    inputSchema:S({prompt:str('Prompt')}),
    build:i=>({title:`Video: ${i.prompt}`.slice(0,200),inputs:i,nodes:[{key:'video',type:'media',operation:'video',prompt:i.prompt}]})},
  {id:'voice.speak',domain:'voice',title:'Text to speech',description:'Narrate text as audio.',
    inputSchema:opt(S({text:str('Text'),voice:str('Voice')}),['voice']),
    build:i=>({title:'Narration',inputs:i,nodes:[{key:'speech',type:'media',operation:'speech',prompt:i.text,voice:i.voice,title:`Narration: ${i.text}`.slice(0,120)}]})},
  {id:'voice.transcribe',domain:'voice',title:'Transcribe audio',description:'Transcribe an uploaded audio asset into a text artifact.',
    inputSchema:S({assetId:str('Audio asset id')}),
    build:i=>({title:'Transcription',inputs:i,nodes:[{key:'transcribe',type:'media',operation:'transcribe',assetId:i.assetId}]})},
  {id:'crossmedia.campaign',domain:'cross-media',title:'Cross-media campaign',description:'Copywriter → (image ∥ narration ∥ jingle) → producer assembles the campaign.',
    inputSchema:S({topic:str('Campaign topic')}),
    build:i=>({title:`Campaign: ${i.topic}`.slice(0,200),inputs:i,nodes:[
      {key:'copy',type:'agent',role:'a creative director and copywriter',outputSchema:S({headline:{type:'string'},body:{type:'string'},narration:{type:'string'},imagePrompt:{type:'string'},musicPrompt:{type:'string'}}),instructions:'Create a campaign concept for {{inputs.topic}}: headline, body copy, a 2-sentence narration script, an image prompt and a short music prompt.',artifact:{title:'Campaign copy'}},
      {key:'visual',type:'media',dependsOn:['copy'],operation:'image',prompt:'{{nodes.copy.data.imagePrompt}}',title:'Campaign visual'},
      {key:'narration',type:'media',dependsOn:['copy'],operation:'speech',prompt:'{{nodes.copy.data.narration}}',title:'Campaign narration'},
      {key:'jingle',type:'media',dependsOn:['copy'],operation:'music',prompt:'{{nodes.copy.data.musicPrompt}}',durationSeconds:15,title:'Campaign jingle',optional:true},
      {key:'assemble',type:'agent',dependsOn:['copy','visual','narration','jingle'],role:'a campaign producer',instructions:'Assemble the final campaign brief in Markdown: headline, body, and a production sheet referencing each asset/artifact id produced by the earlier steps.',artifact:{title:'Campaign package',kind:'campaign'}}]})},
];

export function listWorkspaces(){return DOMAINS.map(d=>({...d,operations:OPERATIONS.filter(o=>o.domain===d.id).map(({build,prepare,...o})=>o)}));}
export function compileOperation(opId,input,{model,budgetCeilingMicro}={}){
  const op=OPERATIONS.find(o=>o.id===opId);check(op,'operation_not_found',404);
  check(isObject(input),'invalid_input');
  const errors=validate(op.inputSchema,input);check(!errors.length,'invalid_input',400,errors.slice(0,3).join('; '));
  const spec=op.build(input);
  if(model)for(const n of spec.nodes)if(n.type==='agent'||n.type==='planner'){n.model=model;if(n.worker)n.worker.model=model;if(isObject(n.synthesis))n.synthesis.model=model;}
  if(budgetCeilingMicro)spec.budgetCeilingMicro=budgetCeilingMicro;
  return {op,spec};
}
