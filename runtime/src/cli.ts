import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import YAML from "yaml";

type Any = Record<string, any>;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const now = () => new Date().toISOString();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const yaml = (path: string) => YAML.parse(readFileSync(path, "utf8")) as Any;
const ps = join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const observabilityScript = join(root,"efficiency-session.ps1");
const piConfigDir = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.USERPROFILE ?? "C:/Users/ruijie", ".pi", "agent"));

function configuredPiDefaultModel() {
  const readJson=(name:string): Any => { const path=join(piConfigDir,name); try { return JSON.parse(readFileSync(path,"utf8")); } catch { return {}; } };
  const settings=readJson("settings.json"); const store=readJson("models-store.json");
  const candidate=settings.defaultModel ?? settings.model ?? store.defaultModel ?? store.model ?? store.currentModel;
  if(typeof candidate === "string" && candidate.trim()) return candidate.trim();
  if(candidate?.provider && candidate?.model) return `${candidate.provider}/${candidate.model}`;
  return undefined;
}
function resolvePiModel(requested?: string) {
  const model=requested?.trim() || configuredPiDefaultModel();
  if(!model) throw new Error("No Pi default model is configured. Provide --model <provider/model> (for example csbu/glm-5.3-flash).");
  return model;
}
function modelArgs(model: string) { return ["--model",model]; }

class Store {
  db: DatabaseSync;
  runDir: string;
  constructor(path: string) {
    this.db = new DatabaseSync(path); this.runDir = dirname(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,status TEXT,mode TEXT); CREATE TABLE IF NOT EXISTS nodes(run TEXT,id TEXT,status TEXT,attempts INTEGER,detail TEXT,PRIMARY KEY(run,id)); CREATE TABLE IF NOT EXISTS artifacts(run TEXT,type TEXT,version INTEGER,content TEXT,hash TEXT,PRIMARY KEY(run,type,version)); CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,run TEXT,at TEXT,node TEXT,status TEXT,detail TEXT);");
  }
  state(run: string, status: string) { this.db.prepare("UPDATE runs SET status=? WHERE id=?").run(status, run); writeFileSync(join(this.runDir,"run-status.txt"),`${status} ${now()}\n`,{flag:"a"}); }
  event(run: string, node: string, status: string, detail: Any = {}) { this.db.prepare("INSERT INTO events(run,at,node,status,detail) VALUES(?,?,?,?,?)").run(run, now(), node, status, JSON.stringify(detail)); }
  node(run: string, id: string, status: string, attempts = 0, detail: Any = {}) { this.db.prepare("INSERT OR REPLACE INTO nodes VALUES(?,?,?,?,?)").run(run,id,status,attempts,JSON.stringify(detail)); this.event(run,id,status,detail); }
  getNode(run: string, id: string) { return this.db.prepare("SELECT * FROM nodes WHERE run=? AND id=?").get(run,id) as Any; }
  artifact(run: string, type: string) { return this.db.prepare("SELECT * FROM artifacts WHERE run=? AND type=? ORDER BY version DESC LIMIT 1").get(run,type) as Any; }
  put(run: string, type: string, content: string) { const prior=this.artifact(run,type); const version=Number(prior?.version ?? 0)+1; const digest=hash(content); this.db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)").run(run,type,version,content,digest); return {version,hash:digest}; }
}

function definition(id: string, workflowDir: string) { for(const path of [join(workflowDir,"nodes",`${id}.yaml`),join(dirname(workflowDir),"nodes",`${id}.yaml`)]) if(existsSync(path)) return yaml(path); return undefined; }
function flow(path: string) { return yaml(resolve(path)); }
function projectWorkflow(_project: string) { return join(root,"..","workflow.yaml"); }
function selectWorkflow(project: string, kind?: string, explicit?: string) {
  if(explicit) return resolve(explicit);
  if(!kind) throw new Error("Select a workflow kind with --kind feature or --kind bugfix.");
  const selectorPath=projectWorkflow(project); if(!existsSync(selectorPath)) throw new Error(`Project workflow selector not found: ${selectorPath}`);
  const selector=yaml(selectorPath); const relative=selector.changeKinds?.[kind]?.workflow;
  if(!relative) throw new Error(`Unknown workflow kind: ${kind}`);
  return resolve(dirname(selectorPath),relative);
}
const supportedNodeTypes=new Set(["observability_start","local_knowledge","pi_generate_design","pi_generate_bugfix_design","pi_review","contract_gate"]);
function preflight(workflowPath: string) {
  const plan=flow(workflowPath); const workflowDir=dirname(workflowPath); const nodes: Any[]=[]; const errors: string[]=[];
  for(const ref of plan.nodes as Any[]) {
    if(ref.enabled !== true) { nodes.push({id:ref.id,status:"DISABLED"}); continue; }
    const def=definition(ref.id,workflowDir);
    if(!def) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:"enabled node YAML is missing"}); errors.push(`Enabled node YAML is missing: ${ref.id}`); continue; }
    if(!supportedNodeTypes.has(def.type)) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:`unsupported node type: ${def.type}`}); errors.push(`Unsupported node type for ${ref.id}: ${def.type}`); continue; }
    if(def.gate) {
      const gate=definition(def.gate.script,workflowDir);
      if(!gate || gate.type!=="contract_gate") { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:`invalid gate script: ${def.gate.script}`}); errors.push(`Invalid gate for ${ref.id}: ${def.gate.script}`); continue; }
      if(!Number.isInteger(def.gate.maxReworkAttempts) || def.gate.maxReworkAttempts < 1) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:"gate maxReworkAttempts must be a positive integer"}); errors.push(`Invalid maxReworkAttempts for ${ref.id}`); continue; }
      const checks=gate.checks;
      if(checks){
        if(checks.minSectionChars != null && (!Number.isInteger(checks.minSectionChars) || checks.minSectionChars < 1)) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:"gate minSectionChars must be a positive integer"}); errors.push(`Invalid minSectionChars for ${def.gate.script}`); continue; }
        if(checks.forbiddenTokens != null && !Array.isArray(checks.forbiddenTokens)) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:"gate forbiddenTokens must be a list"}); errors.push(`Invalid forbiddenTokens for ${def.gate.script}`); continue; }
        if(checks.sections != null && !Array.isArray(checks.sections)) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:"gate sections must be a list"}); errors.push(`Invalid sections checks for ${def.gate.script}`); continue; }
        if(checks.exactSections != null && typeof checks.exactSections !== "boolean") { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:"gate exactSections must be a boolean"}); errors.push(`Invalid exactSections for ${def.gate.script}`); continue; }
        if(checks.verifyAnchors != null && typeof checks.verifyAnchors !== "boolean") { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:"gate verifyAnchors must be a boolean"}); errors.push(`Invalid verifyAnchors for ${def.gate.script}`); continue; }
        for(const item of checks.sections ?? []){
          if(!gate.requiredHeadings?.includes(item.heading)) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:`gate checks target unknown heading: ${item.heading}`}); errors.push(`Unknown checks heading for ${def.gate.script}: ${item.heading}`); continue; }
          if(!item.minAnchors && !item.anyKeywords?.length) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:`gate checks for ${item.heading} define neither minAnchors nor anyKeywords`}); errors.push(`Empty checks for ${def.gate.script}: ${item.heading}`); continue; }
        }
        if(errors.some(error=>error.includes(def.gate.script))) continue;
      }
    }
    if(def.type==="pi_review") {
      if(!Array.isArray(def.input) || def.input.length===0) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:"pi_review input must list at least one artifact"}); errors.push(`Invalid input for ${ref.id}`); continue; }
      if(!def.target || !(plan.nodes as Any[]).some(node=>node.id===def.target)) { nodes.push({id:ref.id,status:"CONFIGURATION_ERROR",reason:`review target node not found: ${def.target}`}); errors.push(`Invalid review target for ${ref.id}: ${def.target}`); continue; }
    }
    nodes.push({id:ref.id,status:"ENABLED",definition:def});
  }
  return {plan,nodes,errors};
}
function gateOwner(nodes: Any[], gateId: string) { return nodes.map(item=>item.definition).find(def=>def?.gate?.script===gateId); }
// __GATE_HELPERS_START__
function escapeRegex(text: string) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function sectionBody(content: string, heading: string) {
  const lines=content.split(/\r?\n/); const level=((heading.match(/^#+/) ?? ["#"])[0] as string).length;
  const start=lines.findIndex(line=>line.trim()===heading.trim()); if(start<0) return "";
  let end=lines.length;
  for(let i=start+1;i<lines.length;i++){ const match=lines[i].match(/^#+\s/); if(match && match[0].trim().length<=level){ end=i; break; } }
  return lines.slice(start+1,end).join("\n");
}
const defaultAnchorPattern="[A-Za-z0-9_.\\-/]+\\.[A-Za-z0-9]+#[A-Za-z0-9_]+";
function anchorCount(text: string, pattern: string) { try { return (text.match(new RegExp(pattern,"g")) ?? []).length; } catch { return 0; } }
function evaluateGate(def: Any, content: string, digest: string, version: number) {
  const checks=def.checks ?? {}; const requiredHeadings:string[]=def.requiredHeadings ?? [];
  const missingHeadings=requiredHeadings.filter((heading:string)=>!content.includes(heading));
  const thinSections:string[]=[]; const minChars=Number(checks.minSectionChars ?? 0);
  for(const heading of requiredHeadings){ if(missingHeadings.includes(heading)) continue; if(minChars && sectionBody(content,heading).replace(/\s/g,"").length<minChars) thinSections.push(heading); }
  const forbiddenHits:Any[]=[];
  for(const token of checks.forbiddenTokens ?? []){ const regex=new RegExp(escapeRegex(String(token)),"i"); for(const heading of requiredHeadings){ if(regex.test(sectionBody(content,heading))){ forbiddenHits.push({heading,token}); break; } } }
  const anchorFailures:Any[]=[]; const keywordFailures:Any[]=[];
  const orderFailures:string[]=[]; const extraSections:string[]=[];
  if(checks.exactSections){
    const lines=content.split(/\r?\n/); let last=-1;
    for(const heading of requiredHeadings){ if(missingHeadings.includes(heading)) continue; const idx=lines.findIndex(line=>line.trim()===heading); if(idx<=last){ orderFailures.push(heading); } else { last=idx; } }
    for(const line of lines){ if(/^(#{1,2})\s/.test(line) && !requiredHeadings.includes(line.trim()) && !orderFailures.includes(line.trim())) extraSections.push(line.trim()); }
  }
  for(const item of checks.sections ?? []){
    const body=sectionBody(content,item.heading);
    if(item.minAnchors){ const found=anchorCount(body,item.anchorPattern ?? defaultAnchorPattern); if(found<item.minAnchors) anchorFailures.push({heading:item.heading,required:item.minAnchors,found,pattern:item.anchorPattern ?? defaultAnchorPattern}); }
    const keywords:string[]=item.anyKeywords ?? [];
    if(keywords.length && !keywords.some((keyword:string)=>body.toLowerCase().includes(keyword.toLowerCase()))) keywordFailures.push({heading:item.heading,anyOf:keywords});
  }
  const passed=missingHeadings.length===0 && thinSections.length===0 && forbiddenHits.length===0 && anchorFailures.length===0 && keywordFailures.length===0 && orderFailures.length===0 && extraSections.length===0;
  return {artifactHash:digest,artifactVersion:version,passed,missingHeadings,thinSections,forbiddenTokens:forbiddenHits,anchorFailures,keywordFailures,orderFailures,extraSections,checkedAt:now()};
}
// __GATE_HELPERS_END__
// Deterministic anchor verification: every LIST-ITEM anchor in the
// anchor-checked sections (References 等) must resolve against the real
// repository. Anchors are SEMANTIC (path#symbol), not spatial (path:line):
// symbols survive unrelated edits and fail loudly when renamed, while line
// numbers rot silently. A trailing ":NN" or "（... N 行）" snapshot note is
// tolerated but NOT verified. Inline mentions in prose/findings are not
// verified — only the reference list is the contract; content-level claims
// belong to AI review.
function verifyAnchors(content: string, project: string, headings: string[]) {
  const broken: Any[]=[]; const seen=new Set<string>(); let verifiedCount=0;
  const text=headings.map(heading=>sectionBody(content,heading)).join("\n");
  for(const line of text.split(/\r?\n/)){
    const match=line.match(/^\s*[-*]\s+([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+)#([A-Za-z0-9_\-]+)/);
    if(!match) continue;
    const anchor=`${match[1]}#${match[2]}`; if(seen.has(anchor)) continue; seen.add(anchor);
    const full=resolve(project,match[1]);
    if(!existsSync(full)) { broken.push({anchor,reason:"file not found"}); continue; }
    if(!readFileSync(full,"utf8").includes(match[2])) broken.push({anchor,reason:"symbol not present in file"}); else verifiedCount++;
  }
  return {verifiedCount,broken};
}
function shell(file: string, args: string[], cwd: string, timeoutMs = 300000, onStdout?: (chunk: string) => void) {
  return new Promise<string>((resolveRun, rejectRun) => {
    const child=spawn(file,args,{cwd,windowsHide:true}); child.stdin?.end(); let stdout="",stderr="",settled=false;
    const finish=(error?: Error) => { if(settled)return; settled=true; clearTimeout(timer); error ? rejectRun(error) : resolveRun(stdout); };
    child.stdout.on("data",d=>{ const chunk=String(d); stdout+=chunk; onStdout?.(chunk); }); child.stderr.on("data",d=>stderr+=d);
    child.on("error",e=>finish(e)); child.on("close",code=>finish(code===0?undefined:new Error(`process exited ${code}: ${stderr.trim()}`)));
    const timer=setTimeout(()=>{ child.kill(); finish(new Error(`process timed out after ${timeoutMs}ms`)); },timeoutMs);
  });
}
async function startObservability(project: string) {
  const output=await shell(ps,["-NoProfile","-File",observabilityScript,"exploration_start","-Repo",project,"-Client","workflow","-Model","pi","-Ide","engineering-workflow"],project,30000);
  const record=JSON.parse(output.trim()); return record.task_id as string;
}
async function finishObservability(project: string, taskId: string) {
  await shell(ps,["-NoProfile","-File",observabilityScript,"exploration_finish","-Repo",project,"-TaskId",taskId,"-Client","workflow","-Model","pi","-Ide","engineering-workflow"],project,30000);
}
const KCC_INSTRUCTION=`Always end your reply with a \`\`\`kcc fenced block containing the KCC change-context draft, using this field order: 变更范围, 关联模块, 变更起因, 改动, 验证依据, 验证结论, 知识目标, 未决项. Fill 变更起因 (one short paragraph from the problem restatement), 关联模块 (scenario or module ids behind your References), 知识目标 (knowledge gaps or findings worth handing to knowledge maintenance), 未决项 (confirmed decisions and their owners — NO open items). Fill 变更范围, 改动, 验证依据, 验证结论 with the literal marker 待coding回填 — the coding node owns them.`;
function splitKccDraft(content: string) { const match=content.match(/```kcc\r?\n([\s\S]*?)```/); if(!match) return { doc: content.trimEnd(), kcc: undefined }; return { doc: content.replace(match[0],"").trimEnd(), kcc: match[1].trim() }; }
function kccSkeleton(meta: Any, context: Any) {
  const modules=(Array.isArray(context?.matched_knowledge)?context.matched_knowledge:[]).map((item: Any)=>String(item.markdown_path ?? "")).filter(Boolean).join("、")||"无";
  const gaps=[...(Array.isArray(context?.knowledge_gap)?context.knowledge_gap:[]),...(Array.isArray(context?.index_gap)?context.index_gap:[])].map((item: Any)=>String(item.missing_reason ?? "")).filter(Boolean).join("；")||"无";
  return `# KCC 草稿（design 节点自动生成，coding 节点回填）\n\n- 变更范围：\n  - 待coding回填\n- 关联模块：${modules}\n- 变更起因：${meta.requirementText}\n- 改动：待coding回填\n- 验证依据：待coding回填\n- 验证结论：待coding回填\n- 知识目标：${gaps}\n- 决策记录：见 designed.md 的 Decisions and constraints\n`;
}
function extractJson(text: string) { const start=text.indexOf("{"); const end=text.lastIndexOf("}"); if(start<0||end<=start) throw new Error("reviewer returned no JSON object"); const parsed=JSON.parse(text.slice(start,end+1)); if(typeof parsed.passed!=="boolean" || !Array.isArray(parsed.issues)) throw new Error("reviewer JSON does not match the contract {passed, issues}"); return parsed; }
// The requirement owner's git identity, injected into design/review prompts:
// every recorded decision must be attributed to a real, traceable person.
async function gitIdentity(project: string) {
  const read=async (args: string[])=>{ try { return (await shell("git",args,project,10000)).trim(); } catch { return ""; } };
  const name=await read(["config","user.name"]); const email=await read(["config","user.email"]);
  return name ? `${name}${email?` <${email}>`:""}` : "unidentified user";
}
async function buildReviewPrompt(requirement: string, design: Any, def: Any, project: string) {
  return `You are the design reviewer of a deterministic workflow, running in a fresh session with no stake in the draft you are auditing.\nRequirement:\n${requirement}\nDesign document under review:\n"""\n${design.content}\n"""\nThe requirement owner's git identity is ${await gitIdentity(project)}.\nAudit the document for dodged user-owned decisions: open questions, deferred choices, invented scope boundaries, risks parked as undecided, and any decision or assumption without an explicit user attribution. Do not rewrite the document and do not modify any file.\nAll human-readable output MUST be written in Chinese — the verdict is read by a Chinese-speaking reviewer. JSON keys stay literal English; every string value must be Chinese (section keeps the document's English heading, quote stays verbatim).\nReply with STRICT JSON only, no markdown fence, no commentary:\n{"passed":boolean,"issues":[{"section":string,"quote":string,"why":string,"default_suggestion":string}]}\npassed=false if and only if at least one issue genuinely requires a user decision before implementation starts.\nWhen you are done auditing, output the verdict JSON as your final message; the workflow extracts it after /quit.`;
}
async function reviewDesign(project: string, runId: string, runDir: string, prompt: string, def: Any) {
  const launcher=join(process.env.APPDATA ?? "C:/Users/ruijie/AppData/Roaming","npm","pi.ps1"); if(!existsSync(launcher)) throw new Error(`Pi launcher missing: ${launcher}`);
  const eventPath=join(runDir,"design_review.pi.events.jsonl"); writeFileSync(eventPath,""); const sessionDir=join(runDir,"pi-session"); mkdirSync(sessionDir,{recursive:true});
  console.log("[design_review] fresh-session AI review is running in batch mode — no window opens. Live output below; the verdict JSON prints when done (may take a few minutes).");
  const promptPath=join(runDir,"design_review.prompt.md"); writeFileSync(promptPath,prompt,"utf8");
  let pending="";
  const relay=(chunk: string) => { appendFileSync(eventPath,chunk); pending+=chunk; const lines=pending.split(/\r?\n/); pending=lines.pop() ?? ""; for(const line of lines) { try { const event=JSON.parse(line); const delta=event.assistantMessageEvent?.delta; if(delta) process.stdout.write(delta); else if(event.type==="tool_execution_start") console.log(`\n[review tool] ${event.toolName ?? "read"}`); } catch {} } };
  const events=await shell(ps,["-NoProfile","-File",launcher,...modelArgs(def.model),"--mode","json","--print","--session-dir",sessionDir,"--session-id",`${runId}-review`,"--no-extensions","--no-skills","--no-context-files","--tools","read,grep,find,ls",`@${promptPath}`],project,(def.batchTimeoutSeconds ?? 1200)*1000,relay);
  return extractJson(assistantText(events));
}
function assistantText(events: string) {
  // Pi's interactive session writer emits `message`; JSON print mode may emit
  // `message_end`. Both contain the same assistant message payload.
  const messages=events.split(/\r?\n/).flatMap(line=>{ try { return [JSON.parse(line)]; } catch { return []; } }).filter(event=>(event.type==="message" || event.type==="message_end") && event.message?.role==="assistant");
  const last=messages.at(-1); return (last?.message?.content ?? []).filter((part:Any)=>part.type==="text").map((part:Any)=>part.text).join("").trim();
}
function quoteWindowsArgument(value: string) { return `"${value.replace(/(\\*)"/g,"$1$1\\\"").replace(/(\\+)$/,"$1$1")}"`; }
function filesUnder(path: string): string[] { if(!existsSync(path)) return []; return readdirSync(path,{recursive:true}).map(String).map(name=>join(path,name)).filter(file=>statSync(file).isFile()); }
async function interactivePi(project: string, runId: string, runDir: string, prompt: string, def: Any, label = "generate_design") {
  const launcher=join(process.env.APPDATA ?? "C:/Users/ruijie/AppData/Roaming","npm","pi.ps1");
  const sessionDir=join(runDir,"pi-session"); mkdirSync(sessionDir,{recursive:true});
  const promptPath=join(runDir,`${label}.prompt.md`); writeFileSync(promptPath,prompt,"utf8");
  console.log("[Pi] opening a separate interactive window. Review the answer, ask follow-up questions, then use /quit there to finish this workflow node.");
  const piArgs=["-NoProfile","-File",launcher,...modelArgs(def.model),"--session-dir",sessionDir,"--session-id",`${runId}-${label}`,"--no-extensions","--no-skills","--no-context-files","--tools","read,grep,find,ls",`@${promptPath}`].map(quoteWindowsArgument).join(" ");
  // START has ambiguous title/executable quoting rules.  Put the invocation in
  // a run-local batch file, then let START launch that file without a title.
  const launcherPath=join(runDir,`${label}.interactive.cmd`);
  writeFileSync(launcherPath,`@echo off\r\ntitle Engineering Workflow - Pi ${label}\r\n${quoteWindowsArgument(ps)} ${piArgs}\r\nexit /b %ERRORLEVEL%\r\n`);
  await new Promise<void>((resolveRun,rejectRun)=>{ const child=spawn("cmd.exe",["/d","/c","start","/wait","","cmd.exe","/d","/c",launcherPath],{cwd:project,stdio:"inherit",windowsHide:false}); let finished=false; let poll: Any;
  // autoAdvance: the window stays visible (progress is watchable) but the
  // runtime closes it as soon as the agent finishes ONE turn — no /quit.
  // Baseline offsets keep pre-existing session content (reopened sessions)
  // from triggering an instant kill.
  if(def.autoAdvance){ const baseline=new Map<string,number>(); try { for(const file of filesUnder(sessionDir)) if(file.endsWith(".jsonl")) baseline.set(file,statSync(file).size); } catch {}
    // Interactive session files contain {type:"message"} entries only — the
    // agent waiting for user input shows up as an appended assistant message
    // with stopReason:"stop" (mid-turn tool calls are "toolUse").
    poll=setInterval(()=>{ try { for(const [file,offset] of baseline){ const size=statSync(file).size; if(size<=offset) continue; if(readFileSync(file,"utf8").slice(offset).includes('"stopReason":"stop"')){ clearInterval(poll); console.log("[Pi] autoAdvance: agent finished its turn — closing the window."); spawn("taskkill",["/pid",String(child.pid),"/T","/F"],{stdio:"ignore"}); return; } } } catch {} },3000); }
  child.on("error",error=>{ if(finished) return; finished=true; if(poll) clearInterval(poll); rejectRun(error); });
  child.on("close",code=>{ if(finished) return; finished=true; if(poll) clearInterval(poll); code===0?resolveRun():rejectRun(new Error(`interactive Pi exited ${code}`)); }); });
  const sessionFile=filesUnder(sessionDir).filter(file=>file.endsWith(".jsonl")).sort((a,b)=>statSync(b).mtimeMs-statSync(a).mtimeMs)[0];
  if(!sessionFile) throw new Error("Pi session contains no event file after interactive exit");
  writeFileSync(join(runDir,`${label}.pi.events.jsonl`),readFileSync(sessionFile,"utf8"));
  return assistantText(readFileSync(sessionFile,"utf8"));
}
function resolveKnowledge(project: string, requirement: string) {
  const indexPath=join(project,"knowledge","bussiness_catalog.md");
  if(!existsSync(indexPath)) throw new Error(`knowledge business index missing: ${indexPath}`);
  const index=readFileSync(indexPath,"utf8");
  const overview=join(project,"knowledge","project","overview.md");
  const matched=existsSync(overview) ? [{markdown_path:"knowledge/project/overview.md",required_read:["knowledge/project/overview.md"],source_anchors:[]}] : [];
  return {question:requirement,index_resolution:[],index_gap:[{missing_reason:"No deterministic business-scenario matcher is installed yet; catalog was read and the gap is explicit.",searched_scope:"knowledge/bussiness_catalog.md"}],matched_knowledge:matched,knowledge_hint:[],knowledge_gap:matched.length?[]:[{missing_reason:"Project overview is unavailable.",searched_scope:"knowledge/project/overview.md",suggested_scope:"project overview"}],resolver_evidence:{business_index_bytes:Buffer.byteLength(index),project_overview_exists:existsSync(overview)}};
}
async function generateDesign(project: string, runId: string, runDir: string, requirement: string, context: Any, def: Any) {
  const overview=join(project,"knowledge","project","overview.md");
  const prompt=`You are the design-document node of a deterministic workflow.\nRequirement:\n${requirement}\nWorkflow-selected knowledge context:\n${JSON.stringify(context)}\nYou may use the read tool on any file in this project (READ-ONLY) to verify claims before asserting them; a project overview is available at ${overview}. Real evidence needs semantic anchors: cite files you actually read as relative/path.ext#symbol (the symbol must exist in that file), never invent an anchor and never use bare path:line.\nYou are talking to the requirement owner; their git identity is ${await gitIdentity(project)}. Every user-owned decision must be asked and answered in-session, then recorded under Decisions and constraints attributed to that identity — the document may not contain open questions, undecided risks, or unattributed assumptions.\nProduce Markdown only. It must contain these headings exactly: ${def.requiredHeadings.join(", ")}. Do not modify source code or any file. ${KCC_INSTRUCTION}`;
  const launcher=join(process.env.APPDATA ?? "C:/Users/ruijie/AppData/Roaming","npm","pi.ps1");
  if(!existsSync(launcher)) throw new Error(`Pi launcher missing: ${launcher}`);
  // The workflow owns observability and knowledge resolution.  Pi is a pure
  // read-only generator: loading project extensions in non-interactive mode
  // can wait for their own prompts and deadlock this node.
  const eventPath=join(runDir,"generate_design.pi.events.jsonl"); let pending="";
  const relay=(chunk: string) => { appendFileSync(eventPath,chunk); pending+=chunk; const lines=pending.split(/\r?\n/); pending=lines.pop() ?? ""; for(const line of lines) { try { const event=JSON.parse(line); const delta=event.assistantMessageEvent?.delta; if(delta) process.stdout.write(delta); else if(event.type==="tool_execution_start") console.log(`\n[Pi tool] ${event.toolName ?? "read"}`); else if(event.type==="agent_end") console.log("\n[Pi] generation finished"); } catch { console.log(line); } } };
  const sessionDir=join(runDir,"pi-session"); mkdirSync(sessionDir,{recursive:true});
  const promptPath=join(runDir,"generate_design.prompt.md"); writeFileSync(promptPath,prompt,"utf8");
  const events=await shell(ps,["-NoProfile","-File",launcher,...modelArgs(def.model),"--mode","json","--print","--session-dir",sessionDir,"--session-id",`${runId}-generate_design`,"--no-extensions","--no-skills","--no-context-files","--tools","read,grep,find,ls",`@${promptPath}`],project,(def.batchTimeoutSeconds ?? 1800)*1000,relay);
  return assistantText(events);
}
async function execute(runId: string, runDir: string, meta: Any, store: Store) {
  const checked=preflight(meta.workflowPath); if(checked.errors.length) throw new Error(`CONFIGURATION_ERROR: ${checked.errors.join("; ")}`);
  const enabled=checked.nodes.filter(item=>item.status==="ENABLED").map(item=>item.definition);
  // A rejected draft restarts the node loop: the owner node reopens its same
  // Pi session with the failure report injected, until the gate/review passes
  // or maxReworkAttempts is exhausted. Blocked/error statuses still end the run.
  let restart=true;
  while(restart){
   restart=false;
  for(const def of enabled) {
    const prior=store.getNode(runId,def.id); let rework=Boolean(def.gate?.script) && store.getNode(runId,def.gate.script)?.status==="REWORK_REQUIRED";
    if((def.type==="pi_generate_design"||def.type==="pi_generate_bugfix_design") && def.reviewedBy && store.getNode(runId,def.reviewedBy)?.status==="REWORK_REQUIRED") rework=true;
    if(def.type==="pi_review" || def.type==="contract_gate") { const inputArt=store.artifact(runId,def.input[0]); const priorResult=store.artifact(runId,def.output.type); if(priorResult && inputArt) { try { if(Number(JSON.parse(priorResult.content).artifactVersion ?? 0) < inputArt.version) rework=true; } catch {} } }
    if(prior?.status === "SUCCEEDED" && !rework) continue;
    const attempt=Number(prior?.attempts ?? 0)+1; store.node(runId,def.id,"RUNNING",attempt); console.log(`${def.id}: running (attempt ${attempt})`);
    if(def.type === "observability_start") { const taskId=await startObservability(meta.project); store.put(runId,"observability_session",JSON.stringify({taskId,startedAt:now()})); }
    else if(def.type === "local_knowledge") { const context=resolveKnowledge(meta.project,meta.requirementText); const text=JSON.stringify(context,null,2); store.put(runId,"knowledge_context",text); writeFileSync(join(runDir,"knowledge-context.json"),text); }
    else if(def.type === "pi_generate_design" || def.type === "pi_generate_bugfix_design") {
      try {
        const context=store.artifact(runId,"knowledge_context"); if(!context) throw new Error("Missing required Artifact: knowledge_context");
        const contextObject=JSON.parse(context.content); const overview=join(meta.project,"knowledge","project","overview.md"); const gateDef=definition(def.gate.script,dirname(meta.workflowPath)); const gate=gateDef ? store.artifact(runId,gateDef.output.type) : undefined; let reworkInstruction=gate ? `\nThe workflow gate rejected the previous draft with: ${gate.content}\nRevise the previous draft to address every failed item, then output the complete revised document.` : "";
        if(def.reviewedBy && store.getNode(runId,def.reviewedBy)?.status==="REWORK_REQUIRED") { const reviewDef=definition(def.reviewedBy,dirname(meta.workflowPath)); const reviewResult=reviewDef?store.artifact(runId,reviewDef.output.type):undefined; if(reviewResult) reworkInstruction+=`\nA fresh-session reviewer rejected the previous draft because it dodges user-owned decisions: ${reviewResult.content}\nFor every issue: ask the user in THIS session, get an explicit answer, and only then incorporate it. Items the user confirms as non-blocking must state the confirmed default assumption. Do not silently keep the old defaults. Then output the complete revised document with the KCC block.`; } const documentLabel=def.type==="pi_generate_bugfix_design" ? "bugfix-design" : "design"; const prompt=`You are the ${documentLabel} node of a deterministic workflow.\nRequirement:\n${meta.requirementText}\nWorkflow-selected knowledge context:\n${JSON.stringify(contextObject)}\nYou may use the read tool on any file in this project (READ-ONLY) to verify claims before asserting them; a project overview is available at ${overview}. Real evidence needs semantic anchors: cite files you actually read as relative/path.ext#symbol (the symbol must exist in that file), never invent an anchor and never use bare path:line.\nYou are talking to the requirement owner; their git identity is ${await gitIdentity(meta.project)}. Every user-owned decision must be asked and answered in-session, then recorded under Decisions and constraints attributed to that identity — the document may not contain open questions, undecided risks, or unattributed assumptions.\nProduce Markdown only. It must contain these headings exactly: ${def.requiredHeadings.join(", ")}. Do not modify source code or any file. ${KCC_INSTRUCTION}${reworkInstruction}`;
        store.put(runId,"pi_session",JSON.stringify({sessionDir:join(runDir,"pi-session"),sessionId:`${runId}-generate_design`}));
        const executorDef={...def,model:resolvePiModel(meta.model)};
        const design=executorDef.executionMode==="interactive" ? await interactivePi(meta.project,runId,runDir,prompt,executorDef) : await generateDesign(meta.project,runId,runDir,meta.requirementText,contextObject,executorDef);
        if(!design) throw new Error("Pi produced an empty design");
        const { doc: designDoc, kcc }=splitKccDraft(design);
        store.put(runId,def.output.type,designDoc); writeFileSync(join(runDir,def.type==="pi_generate_bugfix_design" ? "bugfix-designed.md" : "designed.md"),designDoc);
        const kccDraft=kcc ?? kccSkeleton(meta,contextObject); store.put(runId,"kcc",kccDraft); writeFileSync(join(runDir,"kcc-draft.md"),kccDraft);
      } catch (error) {
        const message=error instanceof Error ? error.message : String(error);
        const status=message.includes("Missing required Artifact:") ? "BLOCKED" : message.includes("timed out") ? "TIMED_OUT" : "FAILED";
        store.node(runId,def.id,status,attempt,{message,endedAt:now()}); store.state(runId,status);
        throw error;
      }
    } else if(def.type === "pi_review") {
      try {
        const design=store.artifact(runId,def.input[0]); if(!design) { store.node(runId,def.id,"BLOCKED",attempt,{message:`Missing required Artifact: ${def.input[0]}`}); store.state(runId,"BLOCKED"); return; }
        const executorDef={...def,model:resolvePiModel(meta.model)};
        const reviewPrompt=await buildReviewPrompt(meta.requirementText,design,executorDef,meta.project);
        const verdictText=executorDef.executionMode==="interactive" ? await interactivePi(meta.project,runId,runDir,reviewPrompt,executorDef,"design_review") : await reviewDesign(meta.project,runId,runDir,reviewPrompt,executorDef);
        const verdict=extractJson(verdictText);
        const result={artifactVersion:design.version,...verdict,reviewedAt:now()}; store.put(runId,def.output.type,JSON.stringify(result));
        if(!verdict.passed) { const max=Number(def.maxReworkAttempts ?? 1); const exhausted=attempt>=max; const status=exhausted ? def.onExhausted ?? "HUMAN_INTERVENTION_REQUIRED" : "REWORK_REQUIRED"; store.node(runId,def.id,status,attempt,{...result,maxReworkAttempts:max}); store.state(runId,status); reportRun(runDir,def.id,status,{runId,result,maxReworkAttempts:max}); console.log(`${def.id}: ${status} — review rejected the draft (${(verdict.issues ?? []).length} issue(s)); details in run-events.log`); if(!exhausted){ restart=true; break; } return; }
      console.log(`${def.id}: PASSED — design draft accepted by review.`);
      } catch (error) {
        const message=error instanceof Error ? error.message : String(error);
        const status=message.includes("Missing required Artifact:") ? "BLOCKED" : message.includes("timed out") ? "TIMED_OUT" : "FAILED";
        store.node(runId,def.id,status,attempt,{message,endedAt:now()}); store.state(runId,status);
        throw error;
      }
    } else if(def.type === "contract_gate") {
      const design=store.artifact(runId,def.input[0]); if(!design) { store.node(runId,def.id,"BLOCKED",attempt,{message:"Missing required Artifact: design"}); store.state(runId,"BLOCKED"); return; }
      const result=evaluateGate(def,design.content,design.hash,design.version);
      if(def.checks?.verifyAnchors){ const anchorHeadings=(def.checks.sections ?? []).filter((item:Any)=>item.minAnchors).map((item:Any)=>item.heading); const anchors=verifyAnchors(design.content,meta.project,anchorHeadings); result.anchorsVerified=anchors.verifiedCount; if(anchors.broken.length){ result.passed=false; result.anchorFailures=[...(result.anchorFailures ?? []),...anchors.broken]; } }
      if(def.checks?.requireIdentity){ const identity=await gitIdentity(meta.project); const owner=identity.split(" <")[0]; const decisionBody=sectionBody(design.content,"## Decisions and constraints"); if(!owner || owner==="unidentified user" || !decisionBody.includes(owner)) { result.passed=false; result.identityFailure={expectedOwner:owner,section:"## Decisions and constraints"}; } }
      store.put(runId,def.output.type,JSON.stringify(result));
      if(!result.passed) { const owner=gateOwner(checked.nodes,def.id); const max=owner?.gate?.maxReworkAttempts ?? 1; const exhausted=attempt>=max; const status=exhausted ? owner?.gate?.onExhausted ?? "HUMAN_INTERVENTION_REQUIRED" : "REWORK_REQUIRED"; store.node(runId,def.id,status,attempt,{...result,maxReworkAttempts:max}); store.state(runId,status); reportRun(runDir,def.id,status,{runId,result,maxReworkAttempts:max}); console.log(`${def.id}: ${status} — ${(result.missingHeadings??[]).length+result.thinSections.length+result.forbiddenTokens.length+result.anchorFailures.length+result.keywordFailures.length+result.orderFailures.length+result.extraSections.length} failed check(s); details in run-events.log`); if(!exhausted){ restart=true; break; } return; }
      console.log(`${def.id}: PASSED (v${result.artifactVersion}, anchors verified: ${result.anchorsVerified ?? "n/a"})`);
    }
    else throw new Error(`unsupported node type: ${def.type}`);
    store.node(runId,def.id,"SUCCEEDED",attempt);
  }
   if(restart) console.log("[workflow] draft rejected — reopening the design session with the failure report. Answer, revise, then /quit again.");
  }
  const session=store.artifact(runId,"observability_session"); if(session) { const {taskId}=JSON.parse(session.content); await finishObservability(meta.project,taskId); store.event(runId,"start_observability","FINISHED",{taskId,endedAt:now()}); }
  store.state(runId,"SUCCEEDED"); const designArt=store.artifact(runId,"design"); const bugfixArt=store.artifact(runId,"bugfix_design"); const finalDesign=designArt ?? bugfixArt; const finalKcc=store.artifact(runId,"kcc"); console.log(`[workflow] SUCCEEDED — final design: ${finalDesign?join(runDir,designArt?"designed.md":"bugfix-designed.md")+" (v"+finalDesign.version+")":"(none)"}${finalKcc?`, KCC draft: ${join(runDir,"kcc-draft.md")}`:""}`); console.log(`[workflow] artifacts and detailed event log: ${runDir}`);
}
// Detailed per-node events (gate failures, review verdicts) go to
// run-events.log in the run dir; the console only carries key steps/results.
function reportRun(runDir: string, node: string, status: string, detail: Any) { try { appendFileSync(join(runDir,"run-events.log"),`${now()} ${node} ${status} ${JSON.stringify(detail)}\n`); } catch {} }
async function main() {
  const command=process.argv[2] ?? "start";
  if(command === "plan") { const mode=arg("--mode") ?? "pilot"; const project=resolve(arg("--project") ?? "D:/dlp-develop/dlp-endpoint"); const kind=arg("--kind"); const workflowPath=selectWorkflow(project,kind,arg("--workflow")); const checked=preflight(workflowPath); console.log(YAML.stringify({project,kind,workflow:workflowPath,mode,nodes:checked.nodes.map(({id,status,reason}:Any)=>({id,status,...(reason?{reason}:{})})),errors:checked.errors})); process.exitCode=checked.errors.length?1:0; return; }
  if(command === "resume") { const runDir=resolve(arg("--run") ?? ""); const meta=yaml(join(runDir,"run.yaml")); meta.model=resolvePiModel(meta.model); const store=new Store(join(runDir,"workflow.sqlite")); store.state(meta.runId,"RUNNING"); await execute(meta.runId,runDir,meta,store); return; }
  if(command !== "start") throw new Error("Use start, plan, or resume");
  const text=arg("--requirement-text") ?? (arg("--requirement") ? readFileSync(resolve(arg("--requirement")!),"utf8") : undefined); if(!text) throw new Error("Provide --requirement-text or --requirement");
  const project=resolve(arg("--project") ?? "D:/dlp-develop/dlp-endpoint"); const kind=arg("--kind"); const workflowPath=selectWorkflow(project,kind,arg("--workflow")); const checked=preflight(workflowPath); if(checked.errors.length) throw new Error(`CONFIGURATION_ERROR: ${checked.errors.join("; ")}`); console.log(YAML.stringify({event:"PREFLIGHT_PASSED",kind,workflow:workflowPath,nodes:checked.nodes.map(({id,status}:Any)=>({id,status}))})); const model=resolvePiModel(arg("--model")); const runDir=join(root,"runs",`${kind}-${now().replace(/[:.]/g,"-")}`); mkdirSync(runDir,{recursive:true}); const meta={runId:runDir.split("\\").at(-1),workflowPath,project,kind,mode:arg("--mode") ?? "pilot",model,requirementText:text}; writeFileSync(join(runDir,"run.yaml"),YAML.stringify(meta)); const store=new Store(join(runDir,"workflow.sqlite")); store.db.prepare("INSERT INTO runs VALUES(?,?,?)").run(meta.runId,"RUNNING",meta.mode); await execute(meta.runId,runDir,meta,store);
}
main().catch(error=>{ console.error(`WORKFLOW_FAILED: ${error.message}`); process.exitCode=1; });
