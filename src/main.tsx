import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Editor, { type OnMount } from '@monaco-editor/react';
import { FileText, FolderOpen, Folder, Search, Plus, MoreHorizontal, ChevronDown, ChevronRight, ChevronLeft, Settings, HelpCircle, CloudOff, TriangleAlert, Upload, FolderPlus, FilePlus2, Image as ImageIcon, FileCode2, File, BookOpen, Play, Download, Share2, Undo2, Redo2, Bold, Italic, Underline, List, ListOrdered, Table2, Sigma, Quote, Link2, Columns2, Maximize2, Minimize2, Square, Star, ZoomIn, ZoomOut, RefreshCw, CircleCheck, Cloud, X, Copy, Trash2, Pencil, Check, AlertCircle, FileArchive, Menu, Keyboard, Sun, Moon, Monitor, Home, ScrollText, Info, PanelLeft, Code2, Sparkles, Compass, Crosshair, Omega, BookPlus, } from 'lucide-react';
import { useTheme, type ThemePref } from './theme';
import { setCompletionFiles, setupMonaco } from './monacoSetup';
import { outlineOf } from './lib/outline';
import { arrayBufferToBase64, buildTree, defaultFile, isBinary, isEditable, isImage, mergeProjects, mimeType, normalizeProject, relative, tabFiles, type Project, type ProjectFile, type TreeNode } from './lib/project';
import { withFileSuggestion, type LogEntry } from './lib/latexLog';
import { diffLines } from './lib/diff';
import { recordEdit, rejectEdit } from './lib/changes';
import { loadTemplateFiles, templates, type TemplateMeta } from './lib/templateStore';
import { TemplateGallery } from './TemplateGallery';
import { applyFix, clipSelection, fixStillApplies, logContext, numberedFile, type LineFix } from './lib/assistant';
import { AssistantPanel, ExplainButton, QUICK_PROMPTS, useAssistant, type AssistantStatus } from './Assistant';
import { Tour, TOUR_KEY, type TourStep } from './Tour';
import { apiUrl, fetchWithWake, ownerHeaders, projectOwnerId } from './lib/api';
import { authReady, currentAccessToken, currentAccount } from './lib/auth';
import { AccountButton, SignInDialog } from './Account';
import { startCollab, type Collab, type Peer } from './collab';
import { CitationDialog } from './Citations';
import { SubmissionCheck } from './Submission';
import { applyFix as applySubmissionChange, type Fix } from './lib/submission';
import { prepareFigure } from './figures';
import { addGraphicx, appendToBody, FIGURE_FOLDER, figureBlock, figureSnippet, graphicxInsertion, hasGraphicx, inDocumentBody, isFigureFile } from './lib/figure';
import { appendEntries } from './lib/bibtex';
import { clearPendingJoin, HistoryPanel, pendingJoin, ShareAccess } from './Sharing';
import { base64ToBytes, compileFiles, contentHash, type SyncState } from './lib/compileSync';
import { PdfViewer, type Zoom } from './PdfViewer';
import { SpellSuggestions, SymbolPalette, WordCountView } from './Tools';
import { attachKeymap, KEYMAPS, type Keymap } from './keymaps';
import { attachSpellcheck, type SpellMenu, type Spellchecker } from './spell/spellcheck';
import { filesFromDrop, isSvg, safeImageName, svgToPngBase64, type Incoming } from './lib/upload';
import './style.css';

const starter=`\\documentclass[12pt,a4paper]{article}

\\usepackage[utf8]{inputenc}
\\usepackage{graphicx}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{geometry}
\\usepackage{hyperref}

\\geometry{margin=1in}

\\title{My First LaTeX Document}
\\author{Author Name}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}

Welcome to the LaTeX Editor.

This is your first document. You can edit this content and compile it into a PDF.

\\section{Mathematical Equations}

An example equation:

\\[
E = mc^2
\\]

\\section{Conclusion}

This document was created using our online LaTeX editor.

\\end{document}
`;
const seed:Project[]=[{id:'p1',name:'Research Paper — Quantum Computing',modified:Date.now()-1000*60*18,files:[{name:'main.tex',content:starter},{name:'references.bib',kind:'bib',content:`@article{feynman1982,
  title={Simulating Physics with Computers},
  author={Feynman, Richard P.},
  journal={International Journal of Theoretical Physics},
  year={1982}
}
`}]}];
const routeProjectId=()=>{const match=window.location.hash.match(/^#\/paper\/([^/?]+)\/?$/)??window.location.pathname.match(/^\/paper\/([^/]+)\/?$/);if(!match)return null;try{return decodeURIComponent(match[1]!)}catch{return null}};
const projectPath=(id:string)=>`/#/paper/${encodeURIComponent(id)}/`;
/** A read-only copy link (?copy=<id>), read once at startup: routing rewrites the URL before the project list loads. */
const sharedCopyId=new URLSearchParams(window.location.search).get('copy');
const initial=()=>{try{const s=localStorage.getItem('paperdesk-projects');return s?(JSON.parse(s) as Project[]).map(p=>normalizeProject(p,'storage')):[]}catch{return []}};
const rewriteImageReferences=(source:string,renames:Map<string,string>)=>[...renames].reduce((body,[from,to])=>{
 const oldName=from.split('/').pop()??from,newName=to.split('/').pop()??to,dot=oldName.lastIndexOf('.');
 let next=body.split(from).join(to);
 if(dot>0){const stem=oldName.slice(0,dot),ext=oldName.slice(dot+1).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),quoted=new RegExp(`\\{\\s*["']${stem.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}["']\\s*\\.${ext}\\s*\\}`,'g');next=next.replace(quoted,`{${newName}}`)}
 return next;
},source);

type Layout='split'|'editor'|'pdf';
type LayoutPrefs={layout:Layout,sidebar:boolean,sidebarWidth:number,previewPct:number,assistant:boolean,wrap:boolean,outline:boolean,keymap:Keymap,spellcheck:boolean,keepImageSize:boolean};
const LAYOUT_KEY='paperdesk-layout';
const NARROW='(max-width: 860px)';
const readLayout=():LayoutPrefs=>{const base:LayoutPrefs={layout:'split',sidebar:true,sidebarWidth:232,previewPct:46,assistant:false,wrap:true,outline:true,keymap:'default',spellcheck:true,keepImageSize:false};try{return{...base,...JSON.parse(localStorage.getItem(LAYOUT_KEY)??'{}')}}catch{return base}};

type Tone='info'|'success'|'error';
type Toast={text:string,tone:Tone};
type CompileState={status:'idle'|'running'|'success'|'error'|'outdated',message:string,entry?:LogEntry,stale?:boolean};
type CompileTimings={queue?:number;sync?:number;tex?:number;read?:number;passes?:number;preamble?:number;total?:number};
type CompileResult={success:boolean|null,log:string,errors:LogEntry[],warnings:LogEntry[],durationMs:number,timings?:CompileTimings};
type CompilePrefs={autoCompile:boolean;autoCompileChosen?:boolean;stopOnFirstError:boolean;draft:boolean;timeout:number;trackChanges:boolean};
type Health={storage?:{mode:string},docker:boolean,image:boolean,compilerMode?:'docker'|'native',compilerImage:string,compilerReady?:boolean,maxCompileTimeoutMs?:number,assistant?:AssistantStatus};
const SHARE_KEY='paperdesk-assistant-context';
/** The project that was open, so a reload returns to it. */
const OPEN_KEY='paperdesk-open-project';
const readFlag=(key:string)=>{try{return localStorage.getItem(key)}catch{return null}};
const writeFlag=(key:string,value:string)=>{try{localStorage.setItem(key,value)}catch{/* storage unavailable: lasts for this visit */}};
type Dialog={title:string,message?:ReactNode,label?:string,initial?:string,placeholder?:string,confirmLabel:string,danger?:boolean,onConfirm:(value:string)=>string|void};
type MenuItem={label:string,run:()=>void,shortcut?:string,icon?:ReactNode,checked?:boolean,danger?:boolean,disabled?:boolean}|'sep';

const themeOptions:{value:ThemePref,label:string,hint:string,icon:ReactNode}[]=[
 {value:'light',label:'Light',hint:'Always light',icon:<Sun size={15}/>},
 {value:'dark',label:'Dark',hint:'Always dark',icon:<Moon size={15}/>},
 {value:'auto',label:'Auto',hint:'Match system setting',icon:<Monitor size={15}/>},
];
const isMac=typeof navigator!=='undefined'&&/Mac|iP(hone|ad)/.test(navigator.platform);
const mod=isMac?'⌘':'Ctrl+';
const NETWORK_HELP='The PaperDesk API isn’t reachable. Start everything with “npm run dev:all”.';
const json={'Content-Type':'application/json'};
// Every API request waits for a saved sign-in to be restored, so none goes out as the anonymous browser by mistake.
const apiFetch=async(input:RequestInfo|URL,init?:RequestInit)=>{await authReady();return fetch(typeof input==='string'&&input.startsWith('/api/')?apiUrl(input):input,{...init,headers:{...ownerHeaders(),...(init?.headers??{})}})};

// Monaco is bundled (monacoLocal.ts) but split into its own chunk; start loading it straight away.
const monacoLoad=import('./monacoLocal');
function useMonacoLoad(){const [state,setState]=useState<'loading'|'ready'|'failed'>('loading');useEffect(()=>{let live=true;monacoLoad.then(()=>{if(live)setState('ready')},()=>{if(live)setState('failed')});return()=>{live=false}},[]);return state}

function useMediaQuery(q:string){const [m,setM]=useState(()=>window.matchMedia(q).matches);useEffect(()=>{const mq=window.matchMedia(q);const on=()=>setM(mq.matches);mq.addEventListener('change',on);return()=>mq.removeEventListener('change',on)},[q]);return m}

function App(){
 const theme=useTheme();
 const firstVisit=useRef(localStorage.getItem('paperdesk-projects')===null);
 const [projects,setProjects]=useState<Project[]>(initial),[projectId,setProjectId]=useState(()=>routeProjectId()??''),[fileName,setFileName]=useState('main.tex'),[activeTab,setActiveTab]=useState(routeProjectId()?'editor':'dashboard'),[compile_,setCompileState]=useState<CompileState>({status:'idle',message:''}),[pdfUrl,setPdfUrl]=useState(''),[page,setPage]=useState(1),[pageTotal,setPageTotal]=useState(0),[zoom,setZoom]=useState<Zoom>('fit'),[saveState,setSaveState]=useState('Saved'),[query,setQuery]=useState(''),[sortBy,setSortBy]=useState<'modified'|'name'>('modified'),[openMenu,setOpenMenu]=useState(''),[modal,setModal]=useState(''),[dialog,setDialog]=useState<Dialog|null>(null),[toast,setToast]=useState<Toast|null>(null),[engine,setEngine]=useState('pdflatex'),[compilePrefs,setCompilePrefs]=useState<CompilePrefs>(()=>{try{const saved=JSON.parse(localStorage.getItem('paperdesk-compile-prefs')??'{}');/* Auto compile used to be on by default and was saved for everyone. Only a choice the person made themselves is kept. */return{stopOnFirstError:true,draft:false,timeout:120,trackChanges:false,...saved,autoCompile:saved.autoCompileChosen===true&&saved.autoCompile===true}}catch{return{autoCompile:false,stopOnFirstError:true,draft:false,timeout:120,trackChanges:false}}}),[rawLogs,setRawLogs]=useState(false),[cursor,setCursor]=useState({line:1,col:1}),[result,setResult]=useState<CompileResult|null>(null),[logState,setLogState]=useState<{loading:boolean,error?:string}>({loading:false}),[apiOnline,setApiOnline]=useState<boolean|null>(null),[health,setHealth]=useState<Health|null>(null),[editorReady,setEditorReady]=useState(false),[collapsed,setCollapsed]=useState<Set<string>>(new Set()),[prefs,setPrefs]=useState<LayoutPrefs>(readLayout),[drawer,setDrawer]=useState(false),[selectionChars,setSelectionChars]=useState(0),[shareContext,setShareContext]=useState(()=>readFlag(SHARE_KEY)!=='off'),[fixReview,setFixReview]=useState<LineFix|null>(null),[tour,setTour]=useState(false),[narrowAssistant,setNarrowAssistant]=useState(false);
 const [spellMenu,setSpellMenu]=useState<SpellMenu|null>(null),spellRef=useRef<Spellchecker|null>(null);
 const [pdfSearch,setPdfSearch]=useState(false);
 const [joinPrompt,setJoinPrompt]=useState(false),[conflict,setConflict]=useState(''),serverModified=useRef(new Map<string,number>()),syncedFiles=useRef(new Map<string,Map<string,ProjectFile>>()),saveChain=useRef<Promise<void>>(Promise.resolve());
 const [collabNames,setCollabNames]=useState<Set<string>|null>(null),[peers,setPeers]=useState<Peer[]>([]),collabRef=useRef<Collab|null>(null),collabEcho=useRef(new Map<string,Set<string>>()),lastMeta=useRef('');
 const [symbolsOpen,setSymbolsOpen]=useState(false),keymapStatus=useRef<HTMLSpanElement|null>(null);
 const [syncPoint,setSyncPoint]=useState<{page:number,x:number,y:number,width?:number,height?:number,n?:number}|null>(null),[pdfData,setPdfData]=useState<Uint8Array|null>(null),[nav,setNav]=useState({page:1,n:0}),[share,setShare]=useState<{state:'idle'|'creating'|'ready'|'error',url?:string,error?:string}>({state:'idle'});
 const [templateBusy,setTemplateBusy]=useState(''),compileOnOpen=useRef('');
 const [autoCompileRevision,setAutoCompileRevision]=useState(0),[pdfRenderMs,setPdfRenderMs]=useState<number|null>(null);
 const compileAbort=useRef<AbortController|null>(null),syncState=useRef<SyncState|null>(null),sourceRevision=useRef(0),startedCompile=useRef(''),pdfSyncPending=useRef(false),pdfSyncNext=useRef<{page:number,x:number,y:number}|null>(null),sourceSyncPending=useRef(false);
 const editorRef=useRef<any>(null),fileInput=useRef<HTMLInputElement>(null),imageInput=useRef<HTMLInputElement>(null),folderInput=useRef<HTMLInputElement>(null),uploadFolder=useRef(''),zipInput=useRef<HTMLInputElement>(null),saveTimer=useRef<number>(),syncHighlightTimer=useRef<number>(),syncDecorations=useRef<any>(null),workRef=useRef<HTMLDivElement>(null),searchRef=useRef<HTMLInputElement>(null),compileRef=useRef<(options?:{auto?:boolean})=>void>(()=>{}),scaleRef=useRef(100),monacoRef=useRef<any>(null),pendingJump=useRef<{file:string,line:number}|null>(null),lastEdit=useRef({file:'',content:''}),storageWarned=useRef(false);
 const monacoState=useMonacoLoad();
 const narrow=useMediaQuery(NARROW),compact=useMediaQuery('(max-width: 640px)');
 const assistant=useAssistant(()=>setHealth(h=>h?{...h,assistant:{model:h.assistant?.model??'',configured:false}}:h));
 const project=(projects.find(p=>p.id===projectId)??(projectId?undefined:projects[0])) as Project; const currentFile=project?.files.find(f=>f.name===fileName)??project?.files[0]; const content=currentFile?.content??'';
 const contentRef=useRef(content);
 const projectRef=useRef(project);projectRef.current=project;
 // The first sync resolves after the page is usable; merge into the list as it is then, not as it was at load,
 // so a project created or opened meanwhile (a template, a shared copy) isn't dropped.
 const projectsRef=useRef(projects);projectsRef.current=projects;
 useEffect(()=>setCompletionFiles(()=>projectRef.current?.files??[]),[]);
 // The selected id can point at a project that no longer exists (the default "p1" after a merge or delete); follow the project actually shown.
 useEffect(()=>{if(project&&project.id!==projectId)setProjectId(project.id)},[project?.id,projectId]);
 useEffect(()=>{if(project?.id)writeFlag(OPEN_KEY,project.id)},[project?.id]);
 useEffect(()=>{contentRef.current=content},[projectId,fileName]);
 const update=(fn:(p:Project)=>Project)=>setProjects(prev=>prev.map(p=>p.id===projectId?fn(p):p));
 useEffect(()=>{
  if(!project)return;
  const used=new Set(project.files.map(file=>file.name)),renames=new Map<string,string>();
  for(const file of project.files){if(!isImage(file.name)||isSvg(file.name))continue;const safe=safeImageName(file.name);if(safe===file.name)continue;used.delete(file.name);let next=safe,n=2;while(used.has(next)){const dot=safe.lastIndexOf('.'),stem=dot>0?safe.slice(0,dot):safe,ext=dot>0?safe.slice(dot):'';next=`${stem}-${n++}${ext}`}used.add(next);renames.set(file.name,next)}
  if(!renames.size)return;
  const id=project.id;setProjects(prev=>prev.map(p=>p.id===id?({...p,files:p.files.map(file=>({...file,name:renames.get(file.name)??file.name,content:file.name.endsWith('.tex')&&typeof file.content==='string'?rewriteImageReferences(file.content,renames):file.content}))}):p));
 },[projectId,project?.files]);
 const notify=(text:string,tone:Tone='info')=>setToast({text,tone});
 // Vim/Emacs bindings attach to the live editor and detach when the setting changes; no editor reload.
 useEffect(()=>{const ed=editorRef.current;if(!editorReady||!ed||prefs.keymap==='default')return;let off:(()=>void)|null=null,live=true;const mode=prefs.keymap;attachKeymap(ed,mode,keymapStatus.current).then(d=>{if(!live){d();return}off=d;keymapStatus.current?.setAttribute('data-keymap',mode)}).catch(()=>notify('The key bindings could not be loaded.','error'));return()=>{live=false;off?.();keymapStatus.current?.removeAttribute('data-keymap')}},[prefs.keymap,editorReady]);
 useEffect(()=>{const ed=editorRef.current,monaco=monacoRef.current;if(!editorReady||!ed||!monaco||!prefs.spellcheck)return;const spell=attachSpellcheck(monaco,ed,setSpellMenu);spellRef.current=spell;return()=>{spell.dispose();spellRef.current=null;setSpellMenu(null)}},[prefs.spellcheck,editorReady]);
 // Real-time co-editing, for shared projects. The live document owns the text of every file it manages:
 // edits from anyone flow into the project state here, and changes made outside the editor flow back into it.
 const echo=(name:string,text:string)=>{let set=collabEcho.current.get(name);if(!set){set=new Set();collabEcho.current.set(name,set)}if(set.size>30)set.clear();set.add(text)};
 const refreshFiles=async()=>{try{const r=await apiFetch(`/api/projects/${projectId}`);if(!r.ok)return;const remote=normalizeProject(await r.json(),'server'),c=collabRef.current,synced=syncedFiles.current.get(projectId)??new Map<string,ProjectFile>();update(p=>{const local=new Map(p.files.map(f=>[f.name,f]));/* Keep files created here that aren't saved yet, and leave out ones deleted here that the server still has. */const files=[...remote.files.filter(f=>local.has(f.name)||!synced.has(f.name)).map(f=>c?.has(f.name)&&f.encoding!=='base64'?{...f,content:c.text(f.name)}:f),...p.files.filter(f=>!synced.has(f.name)&&!remote.files.some(x=>x.name===f.name))];for(const f of files)echo(f.name,f.content);return{...p,files}});syncedFiles.current.set(projectId,new Map(remote.files.map(f=>[f.name,f])))}catch{/* the next change refreshes again */}};
 useEffect(()=>{if(!projectId||!project?.role||!currentAccessToken())return;let stopped=false,live:Collab|null=null;const me=currentAccount();/* What this browser loaded may be a few seconds behind the live document: never push it back. */for(const f of project.files)echo(f.name,f.content);
  startCollab(projectId,{name:me?.name??me?.email??'Guest'},{onTexts:texts=>{for(const[name,text]of texts)echo(name,text);update(p=>({...p,files:p.files.map(f=>texts.has(f.name)&&f.encoding!=='base64'?{...f,content:texts.get(f.name)!}:f)}))},onNames:names=>{setCollabNames(names);void refreshFiles()},onFiles:()=>void refreshFiles(),onPeers:setPeers,onCompiled:success=>{if(compileAbort.current)return;if(success){setPdfData(null);setPdfUrl(apiUrl(`/api/projects/${projectId}/pdf?t=${Date.now()}`));setCompileState({status:'success',message:'Compiled by a collaborator'})}else setCompileState({status:'error',message:'A collaborator’s compile found errors. Recompile to see them.'})}}).then(c=>{if(stopped){c.destroy();return}live=c;collabRef.current=c}).catch(()=>notify('Live editing could not start. Reload the page to try again.','error'));
  return()=>{stopped=true;live?.destroy();collabRef.current=null;collabEcho.current.clear();setCollabNames(null);setPeers([])}},[projectId,project?.role]);
 useEffect(()=>{const c=collabRef.current,ed=editorRef.current;if(c&&ed&&collabNames)c.bind(ed,collabNames.has(fileName)?fileName:null)},[collabNames,fileName,editorReady,projectId]);
 useEffect(()=>{const c=collabRef.current;if(!c||!collabNames||!project)return;for(const f of project.files){if(f.encoding==='base64'||!collabNames.has(f.name))continue;const seen=collabEcho.current.get(f.name);if(f.content===c.text(f.name)){seen?.clear();continue}if(seen?.has(f.content))continue;c.setText(f.name,f.content)}},[project?.files,collabNames]);
 const setPref=<K extends keyof LayoutPrefs>(k:K,v:LayoutPrefs[K])=>setPrefs(p=>({...p,[k]:v}));
 const compiling=compile_.status==='running';
 const maxTimeoutSeconds=Math.max(5,Math.floor((health?.maxCompileTimeoutMs??600_000)/1000));
 // On narrow screens there's only room for one pane: "split" shows the editor and the switcher flips to PDF.
 const layout:Layout=narrow&&prefs.layout==='split'?'editor':prefs.layout;
 const showEditor=layout!=='pdf',showPdf=layout!=='editor';
 // Narrow screens show the file tree as a temporary drawer so the saved desktop preference is untouched.
 const sidebarOpen=narrow?drawer:prefs.sidebar;
 const setSidebar=(v:boolean)=>narrow?setDrawer(v):setPref('sidebar',v);
 // Like the file tree, the assistant is a temporary overlay on narrow screens.
 const assistantOpen=narrow?narrowAssistant:prefs.assistant;
 const setAssistantOpen=(v:boolean)=>{if(narrow){setNarrowAssistant(v);if(v)setDrawer(false)}else setPref('assistant',v)};
 // The startup health check may not have answered yet (a waking server); ask again when the assistant opens.
 useEffect(()=>{if(assistantOpen&&!health?.assistant)fetch(apiUrl('/api/health')).then(r=>r.ok?r.json():null).then(h=>{if(h)setHealth(h)}).catch(()=>undefined)},[assistantOpen]);

 useEffect(()=>{try{localStorage.setItem('paperdesk-projects',JSON.stringify(projects))}catch{if(!storageWarned.current){storageWarned.current=true;notify(apiOnline?'Browser storage is full. Your work is saved on the server, but not offline in this browser.':'Browser storage is full and the API is offline: recent changes may not be saved. Start the API with “npm run dev:all”.','error')}}},[projects]);
 useEffect(()=>{
  const onPopState=()=>{const id=routeProjectId();setProjectId(id??'');setActiveTab(id?'editor':'dashboard')};
  const id=routeProjectId(),url=`/${window.location.search}${id?projectPath(id).slice(1):''}`;
  history.replaceState(id?{screen:'project',id}:{screen:'dashboard'},'',url);
  window.addEventListener('popstate',onPopState);return()=>window.removeEventListener('popstate',onPopState);
 },[]);
 useEffect(()=>{try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(prefs))}catch{/* storage unavailable: layout lasts for this visit */}},[prefs]);
 useEffect(()=>{try{localStorage.setItem('paperdesk-compile-prefs',JSON.stringify(compilePrefs))}catch{/* settings last for this visit */}},[compilePrefs]);
 useEffect(()=>{const maximum=Math.max(5,Math.floor((health?.maxCompileTimeoutMs??600_000)/1000));if(compilePrefs.timeout>maximum)setCompilePrefs(p=>({...p,timeout:maximum}))},[health?.maxCompileTimeoutMs]);
 useEffect(()=>{if(!narrow){setDrawer(false);setNarrowAssistant(false)}},[narrow]);
 useEffect(()=>writeFlag(SHARE_KEY,shareContext?'on':'off'),[shareContext]);
 const openSharedCopy=async()=>{
  const shareId=sharedCopyId;if(!shareId)return;
  history.replaceState(null,'',location.pathname+location.hash);
  try{const r=await fetch(apiUrl(`/api/shares/${encodeURIComponent(shareId)}`));const d=await r.json().catch(()=>null);if(!r.ok||!d)throw new Error(d?.error??'This shared project couldn’t be opened.');
   const copy=normalizeProject({id:crypto.randomUUID(),name:`${d.name} (copy)`,modified:Date.now(),mainFile:d.mainFile,files:d.files},'server');
   history.pushState({screen:'project',id:copy.id},'',projectPath(copy.id));setProjects(x=>[copy,...x]);setProjectId(copy.id);setFileName(defaultFile(copy.files));setActiveTab('editor');notify(`Opened a copy of “${d.name}”. Changes stay in your copy.`,'success')}
  catch(e){notify(e instanceof Error&&!(e instanceof TypeError)?e.message:NETWORK_HELP,'error')}
 };
 useEffect(()=>{const openSample=()=>{if(!firstVisit.current||routeProjectId()||projects.length||sharedCopyId)return;const sample=seed[0]!;firstVisit.current=false;setProjects(seed);setProjectId(sample.id);setFileName(defaultFile(sample.files));setActiveTab('editor');history.pushState({screen:'project',id:sample.id},'',projectPath(sample.id))};const sync=async()=>{try{const signIn=await authReady();if(signIn.error)notify(signIn.error,'error');if(signIn.moved.length){const map=new Map(signIn.moved.map(m=>[m.from,m.to]));projectsRef.current=projectsRef.current.map(p=>map.has(p.id)?{...p,id:map.get(p.id)!}:p);setProjects(projectsRef.current);const open=routeProjectId();if(open&&map.has(open))history.replaceState({screen:'project',id:map.get(open)},'',projectPath(map.get(open)!))}const join=pendingJoin();if(join){if(currentAccessToken()){clearPendingJoin();const j=await apiFetch(`/api/invites/${encodeURIComponent(join)}/accept`,{method:'POST'});const body=await j.json().catch(()=>({}));if(j.ok){history.replaceState({screen:'project',id:body.id},'',projectPath(body.id));notify(body.role==='viewer'?'You joined this project with view access':'You joined this project','success')}else notify(body.error??'This invitation could not be accepted.','error')}else setJoinPrompt(true)}const r=await apiFetch('/api/projects');if(!r.ok)throw new Error();const remote=await r.json();if(!Array.isArray(remote))throw new Error();setApiOnline(true);for(const p of remote as Project[]){if(p.role)serverModified.current.set(p.id,p.modified);syncedFiles.current.set(p.id,new Map((p.files??[]).map(f=>[f.name,f])))}/* The server's copy of a shared project wins, and one you no longer have access to is dropped. */const {merged,upload}=mergeProjects(projectsRef.current.filter(p=>!p.id.startsWith('s-')&&!(remote as Project[]).some(x=>x.id===p.id&&x.role)),remote.map((p:Project)=>normalizeProject(p,'server')));setProjects(merged);if(routeProjectId()){if(merged.some(p=>p.id===routeProjectId())){setProjectId(routeProjectId()!);setActiveTab('editor')}else{history.replaceState({screen:'dashboard'},'', '/');setProjectId('');setActiveTab('dashboard')}}else if(firstVisit.current&&!merged.length)openSample();else if(merged.length)firstVisit.current=false;for(const p of upload)await apiFetch(`/api/projects/${p.id}`,{method:'PUT',headers:json,body:JSON.stringify({name:p.name,files:(syncedFiles.current.set(p.id,new Map(p.files.map(f=>[f.name,f]))),p.files),mainFile:p.mainFile,archived:p.archived,settings:p.settings,versions:p.versions,comments:p.comments,changes:p.changes})})}catch{setApiOnline(false);if(routeProjectId()&&!projectsRef.current.some(p=>p.id===routeProjectId())){history.replaceState({screen:'dashboard'},'', '/');setProjectId('');setActiveTab('dashboard')}else openSample()}};// A shared copy is added after the first sync, which would otherwise replace the project list without it.
  void sync().then(openSharedCopy);fetch(apiUrl('/api/health')).then(r=>r.ok?r.json():null).then(h=>setHealth(h)).catch(()=>setHealth(null))},[]);
 useEffect(()=>{if(!projectId||!project||project.role==='viewer'||conflict===projectId)return;/* Saves run one after another: each is compared with what the previous one left on the server. */const t=window.setTimeout(()=>{saveChain.current=saveChain.current.then(async()=>{try{/* Only files changed since the last save are sent, each with the version it was edited from, so people editing different files never overwrite each other. */const sent=project.files,synced=syncedFiles.current.get(projectId);let files:ProjectFile[]|undefined=sent,patch:{files:(ProjectFile&{base:string|null})[],deleted:string[]}|undefined;if(synced){files=undefined;patch={files:await Promise.all(sent.filter(f=>{const o=synced.get(f.name);return(!o||o.content!==f.content||o.encoding!==f.encoding)&&!(collabNames?.has(f.name)&&f.encoding!=='base64')}).map(async f=>{const o=synced.get(f.name);return{...f,base:o?await contentHash(o.content,o.encoding):null}})),deleted:[...synced.keys()].filter(n=>!sent.some(f=>f.name===n))}}/* Live projects: the server saves the text itself, so only file and settings changes are sent. */if(collabNames&&patch){const meta=JSON.stringify([project.name,project.mainFile,project.archived,project.settings,project.comments,project.changes]);if(!patch.files.length&&!patch.deleted.length&&meta===lastMeta.current)return;lastMeta.current=meta}const save=(body:object)=>apiFetch(`/api/projects/${projectId}`,{method:'PUT',headers:json,body:JSON.stringify({name:project.name,mainFile:project.mainFile,archived:project.archived,settings:project.settings,versions:collabNames?undefined:project.versions,comments:project.comments,changes:project.changes,...body})});let r=await save({files,patch});/* The server no longer has this project (deleted elsewhere): send all of it. */if(r.ok&&patch&&(await r.clone().json().catch(()=>null))?.missing){syncedFiles.current.delete(projectId);r=await save({files:sent})}if(r.status===409){const body=await r.json().catch(()=>({}));setConflict(projectId);notify(`${body.error??'Someone else changed this project. Reload to get their version.'} Your latest edits there aren’t saved.`,'error');return}setApiOnline(r.ok);if(r.ok){syncedFiles.current.set(projectId,new Map(sent.map(f=>[f.name,f])));const saved=await r.json().catch(()=>null);if(saved&&serverModified.current.has(projectId))serverModified.current.set(projectId,saved.modified)}}catch{setApiOnline(false)}})},700);return()=>window.clearTimeout(t)},[projectId,project?.name,project?.files,project?.mainFile,project?.archived,project?.settings,project?.versions,project?.comments,project?.changes]);
 useEffect(()=>{if(project&&!project.files.some(f=>f.name===fileName))setFileName(defaultFile(project.files))},[projectId,project?.files.length]);
 // Only real edits count as changes; opening or switching files must not bump “Last modified”.
 useEffect(()=>{const name=currentFile?.name??'';const prev=lastEdit.current;lastEdit.current={file:name,content};if(prev.file!==name)return;window.clearTimeout(saveTimer.current);setSaveState('Saving…');saveTimer.current=window.setTimeout(()=>{setSaveState('Saved');update(p=>({...p,modified:Date.now()}))},650);return()=>window.clearTimeout(saveTimer.current)},[content,currentFile?.name]);
 useEffect(()=>{if(toast){const t=window.setTimeout(()=>setToast(null),toast.tone==='error'?6000:2800);return()=>window.clearTimeout(t)}},[toast]);
 useEffect(()=>{if(compile_.status==='success'){const t=window.setTimeout(()=>setCompileState(s=>s.status==='success'?{status:s.stale?'outdated':'idle',message:s.stale?'PDF is out of date':''}:s),4000);return()=>window.clearTimeout(t)}},[compile_]);
 /* A project just created from a template compiles once by itself, so it opens with its PDF. */
 useEffect(()=>{if(dashboard||!project||compileOnOpen.current!==project.id)return;const t=window.setTimeout(()=>{if(compileOnOpen.current===project.id){compileOnOpen.current='';compileRef.current()}},300);return()=>window.clearTimeout(t)},[activeTab,project]);
 useEffect(()=>{if(!compilePrefs.autoCompile||dashboard||!project||autoCompileRevision===0)return;const t=window.setTimeout(()=>compileRef.current({auto:true}),1800);return()=>window.clearTimeout(t)},[compilePrefs.autoCompile,autoCompileRevision]);

 // Close menus on outside click; Escape closes the topmost layer.
 useEffect(()=>{
  const down=(e:MouseEvent)=>{if(!(e.target as HTMLElement).closest('[data-menu-root]'))setOpenMenu('')};
  const key=(e:KeyboardEvent)=>{
   if(e.key==='Escape'){if(openMenu)setOpenMenu('');else if(dialog)setDialog(null);else if(modal)setModal('');else if(narrow&&drawer)setDrawer(false);else if(narrow&&narrowAssistant)setNarrowAssistant(false)}
   const cmd=e.metaKey||e.ctrlKey;
   if(cmd&&e.key==='Enter'&&activeTab==='editor'){e.preventDefault();compileRef.current()}
   if(cmd&&e.key.toLowerCase()==='s'){e.preventDefault();if(activeTab==='editor')compileRef.current();else notify('All changes saved','success')}
   if(cmd&&e.key.toLowerCase()==='k'&&activeTab!=='editor'){e.preventDefault();searchRef.current?.focus()}
  };
  document.addEventListener('mousedown',down);document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('mousedown',down);document.removeEventListener('keydown',key)};
 },[openMenu,dialog,modal,activeTab,narrow,drawer,narrowAssistant]);

 const setContent=(value:string)=>{sourceRevision.current++;setAutoCompileRevision(v=>v+1);setCompileState(s=>pdfUrl?{...s,status:s.status==='running'?'running':s.status==='error'?'error':'outdated',message:s.status==='running'?s.message:s.status==='error'?s.message:'PDF is out of date',stale:true}:s);const previous=contentRef.current;contentRef.current=value;update(p=>{const now=Date.now(),latest=p.versions?.[0],recent=latest!==undefined&&latest.label==='Automatic snapshot'&&now-latest.created<1200;return{...p,versions:(recent?(p.versions??[]):[{id:crypto.randomUUID(),label:'Automatic snapshot',created:now,files:p.files.map(f=>({...f}))},...(p.versions??[])]).slice(0,30),changes:compilePrefs.trackChanges?recordEdit(previous,value,fileName,p.changes??[]):p.changes??[],files:p.files.map(f=>f.name===fileName?{...f,content:value}:f)}})};
 const insert=(s:string)=>{const ed=editorRef.current;if(!ed){notify('Open a text file in the editor to insert LaTeX');return}ed.executeEdits('toolbar',[{range:ed.getSelection(),text:s,forceMoveMarkers:true}]);ed.focus()};
 /** Wraps the selection (or places the cursor between `before` and `after` when nothing is selected). */
 const wrap=(before:string,after:string)=>{const ed=editorRef.current,model=ed?.getModel();if(!ed||!model){notify('Open a text file in the editor to insert LaTeX');return}const sels=ed.getSelections()??[];ed.pushUndoStop();ed.executeEdits('toolbar',sels.map((sel:any)=>({range:sel,text:before+model.getValueInRange(sel)+after,forceMoveMarkers:true})));const first=sels[0];if(first&&first.isEmpty()){const pos={lineNumber:first.startLineNumber,column:first.startColumn+before.length};ed.setSelection({startLineNumber:pos.lineNumber,startColumn:pos.column,endLineNumber:pos.lineNumber,endColumn:pos.column})}ed.pushUndoStop();ed.focus()};
 const addCitations=(entries:string[],keys:string[],target:string,cite:boolean)=>{if(entries.length)update(p=>({...p,files:p.files.some(f=>f.name===target)?p.files.map(f=>f.name===target?{...f,content:appendEntries(f.content,entries)}:f):[...p.files,{name:target,content:appendEntries('',entries)}]}));if(cite&&keys.length)insert(`\\cite{${keys.join(',')}}`);notify(entries.length?`Added ${entries.length} ${entries.length===1?'citation':'citations'} to ${target}`:'Citation inserted','success')};
 const edAction=(id:string)=>{const ed=editorRef.current;if(!ed)return;ed.focus();const action=ed.getAction(id);if(action)action.run();else ed.trigger('keyboard',id,null)};

 /** Compiles the open project. Starting a compile replaces one still running. */
 const compile=async({auto=false}:{auto?:boolean}={})=>{
  if(!project)return;
  const target=project,mainFile=target.mainFile??'main.tex',revision=sourceRevision.current;
  if(!target.files.some(f=>f.name===mainFile)){setCompileState({status:'error',message:`Main document ${mainFile} not found. Choose an existing .tex file in Project settings.`});return}
  // Auto compile fires a moment after typing stops; if Recompile already started (or finished) this exact source,
  // restarting it would only throw that compile away.
  const compileKey=`${target.id}|${revision}|${engine}|${mainFile}`;
  if(auto&&startedCompile.current===compileKey)return;
  startedCompile.current=compileKey;
  compileAbort.current?.abort();
  const controller=new AbortController();compileAbort.current=controller;let timedOut=false;
  const timeoutTimer=window.setTimeout(()=>{timedOut=true;controller.abort();if(compileAbort.current===controller)compileAbort.current=null;setCompileState({status:'error',message:`Compile timed out after ${compilePrefs.timeout} seconds. Check the compile log or increase the timeout.`,stale:!!pdfUrl})},(compilePrefs.timeout+15)*1000);
  // A compile you asked for shows the PDF on a phone; an automatic one leaves you in the editor.
  if(!auto&&narrow&&layout==='editor')setPref('layout','pdf');
  setCompileState({status:'running',message:'Compiling…'});
  const started=performance.now();
  try{
   // Only changed files are uploaded; if the server restarted and lost its copy, it answers 409 and everything is sent once.
   const send=async(full:boolean)=>{await authReady();const payload=await compileFiles(target.id,target.files,full?null:syncState.current);const r=await fetchWithWake(apiUrl(`/api/projects/${target.id}/compile`),{method:'POST',signal:controller.signal,headers:{...json,...ownerHeaders()},body:JSON.stringify({name:target.name,files:payload.files,engine,mainFile,timeoutMs:compilePrefs.timeout*1000,draft:compilePrefs.draft,stopOnFirstError:compilePrefs.stopOnFirstError})},()=>setCompileState({status:'running',message:'Waking up the compile server…'}));return{r,payload}};
   let {r,payload}=await send(false);
   if(r.status===409)({r,payload}=await send(true));
   let data:any=null;try{data=await r.json()}catch{/* non-JSON body: the API is unreachable */}
   // 410: another compile of this project (e.g. in another tab) replaced this one; its result will arrive there.
   // With collaborators, a replaced compile means someone else is compiling: their PDF arrives through the live channel.
   if(controller.signal.aborted||r.status===410)return;
   if(!data)throw new Error(NETWORK_HELP);
   if(revision!==sourceRevision.current){setCompileState({status:'outdated',message:'PDF is out of date',stale:!!pdfUrl});return}
   setApiOnline(true);
   if(!r.ok){setCompileState({status:'error',message:String(data.error??'Compilation failed'),stale:!!pdfUrl});if(r.status===503)fetch(apiUrl('/api/health')).then(h=>h.json()).then(setHealth).catch(()=>undefined);return}
   syncState.current={session:String(data.session??''),project:target.id,hashes:payload.hashes};
   const names=target.files.map(f=>f.name),res={...(data as CompileResult),errors:((data as CompileResult).errors??[]).map(e=>withFileSuggestion(e,names))};setResult(res);
   if(res.success){
    setPdfData(typeof data.pdf==='string'?base64ToBytes(data.pdf):null);
    setPdfUrl(`${apiUrl(`/api/projects/${target.id}/pdf?t=${Date.now()}`)}${currentAccessToken()?'':`&owner=${encodeURIComponent(projectOwnerId())}`}`);
    const w=res.warnings.length;
    setCompileState({status:'success',message:`Compiled in ${((performance.now()-started)/1000).toFixed(1)}s${w?` · ${w} warning${w>1?'s':''}`:''}`});
   }else{
    const e=res.errors[0];
    setCompileState({status:'error',message:e?`${e.file?`${e.file}${e.line?`:${e.line}`:''} — `:''}${e.message}`:'Compilation failed',entry:e,stale:!!pdfUrl});
   }
  }catch(e){
   if(timedOut)return;
   if(controller.signal.aborted)return;
   const message=e instanceof TypeError?NETWORK_HELP:e instanceof Error?e.message:'Compilation failed';
   setApiOnline(false);setCompileState({status:'error',message,stale:!!pdfUrl});
  }finally{window.clearTimeout(timeoutTimer);if(compileAbort.current===controller)compileAbort.current=null}
 };
 const stopCompile=()=>{compileAbort.current?.abort();compileAbort.current=null;setCompileState(pdfUrl?{status:'outdated',message:'PDF is out of date',stale:true}:{status:'idle',message:''});notify('Compile stopped')};
 compileRef.current=compile;

 const askName=(title:string,label:string,initialValue:string,confirmLabel:string,onConfirm:(v:string)=>string|void,placeholder?:string)=>setDialog({title,label,initial:initialValue,confirmLabel,onConfirm,placeholder});
 const navigateDashboard=()=>{if(routeProjectId())history.pushState({screen:'dashboard'},'', '/');setProjectId('');setActiveTab('dashboard')};
 const newProject=(name='Untitled Project')=>{const p={id:crypto.randomUUID(),name,modified:Date.now(),files:[{name:'main.tex',content:starter}]};history.pushState({screen:'project',id:p.id},'',projectPath(p.id));setProjects(x=>[p,...x]);setProjectId(p.id);setFileName('main.tex');setPdfUrl('');setPdfData(null);setResult(null);setCompileState({status:'idle',message:''});setActiveTab('editor')};
 const promptNewProject=()=>askName('Create a new project','Project name','','Create project',v=>{if(!v.trim())return 'Enter a project name';newProject(v.trim())},'e.g. My research paper');
 const renameProject=(p:Project)=>{setOpenMenu('');askName('Rename project','Project name',p.name,'Save changes',v=>{if(!v.trim())return 'Enter a project name';setProjects(x=>x.map(q=>q.id===p.id?{...q,name:v.trim()}:q))})};
 const deleteProject=(p:Project)=>{setOpenMenu('');setDialog({title:'Delete project?',message:<>“{p.name}” and its {p.files.length} files will be deleted{p.id===projectId?' and you’ll return to your projects':''}. This can’t be undone.</>,confirmLabel:'Delete project',danger:true,onConfirm:()=>{const next=projects.filter(x=>x.id!==p.id);setProjects(next);apiFetch(`/api/projects/${p.id}`,{method:'DELETE'}).catch(()=>undefined);if(p.id===projectId){navigateDashboard()}notify('Project deleted')}})};
 const duplicate=(p:Project)=>{const cp={...p,id:crypto.randomUUID(),name:p.name+' copy',modified:Date.now(),files:p.files.map(f=>({...f}))};setProjects(x=>[cp,...x]);notify('Project duplicated','success');setOpenMenu('')};
 /* A template becomes a new project with all of its files, opened with its PDF compiling straight away. */
 const startFromTemplate=async(t:TemplateMeta)=>{if(templateBusy)return;setTemplateBusy(t.id);try{const files=await loadTemplateFiles(t.id),id=crypto.randomUUID(),p:Project={id,name:t.name,modified:Date.now(),mainFile:t.mainFile,files};history.pushState({screen:'project',id},'',projectPath(id));setProjects(x=>[p,...x]);setPdfUrl('');setPdfData(null);setResult(null);setCompileState({status:'idle',message:''});setProjectId(id);setFileName(t.mainFile);setActiveTab('editor');compileOnOpen.current=id}catch{notify('This template could not be loaded. Check your connection and try again.','error')}finally{setTemplateBusy('')}};
 const openProject=(p:Project)=>{if(routeProjectId()!==p.id)history.pushState({screen:'project',id:p.id},'',projectPath(p.id));if(p.id!==projectId){setPdfUrl('');setPdfData(null);setResult(null);setCompileState({status:'idle',message:''})}setProjectId(p.id);setFileName(defaultFile(p.files));setActiveTab('editor')};

 const validName=(name:string,current?:string)=>{if(!name)return 'Enter a name';if(/(^|\/)\.\.(\/|$)/.test(name)||name.startsWith('/'))return 'Names can’t start with “/” or contain “..”';if(name!==current&&project.files.some(f=>f.name===name||f.name===name+'/'))return 'A file or folder with that name already exists'};
 const addFile=(folder=false)=>askName(folder?'New folder':'New file',folder?'Folder name':'File name (use “folder/name.tex” to place it in a folder)',folder?'figures':'notes.tex',folder?'Create folder':'Create file',input=>{const name=folder?input.trim().replace(/\/+$/,'')+'/':input.trim();const err=validName(name.replace(/\/$/,''))??validName(name);if(err)return err;update(p=>({...p,files:[...p.files,{name,content:folder?'':`% ${name}\n`}]}));if(!folder)setFileName(name);else setCollapsed(c=>{const n=new Set(c);n.delete(name);return n})});
 const renameFile=(f:ProjectFile)=>{const isFolder=f.name.endsWith('/');const shown=f.name.replace(/\/$/,'');askName(isFolder?'Rename folder':'Rename file','New name',shown,'Rename',input=>{const next=input.trim().replace(/\/+$/,'');if(next===shown)return;const err=validName(next,shown);if(err)return err;if(isFolder){const from=f.name,to=next+'/';update(p=>({...p,files:p.files.map(x=>x.name.startsWith(from)?{...x,name:to+x.name.slice(from.length)}:x)}));if(fileName.startsWith(from))setFileName(to+fileName.slice(from.length))}else{update(p=>({...p,files:p.files.map(x=>x.name===f.name?{...x,name:next}:x)}));if(fileName===f.name)setFileName(next)}})};
 const deleteFile=(f:ProjectFile)=>{const isFolder=f.name.endsWith('/');const affected=isFolder?project.files.filter(x=>x.name.startsWith(f.name)):[f];const remaining=project.files.filter(x=>!affected.includes(x));if(!remaining.some(x=>!x.name.endsWith('/'))){notify('A project must contain at least one file','error');return}setDialog({title:isFolder?'Delete folder?':'Delete file?',message:isFolder?<>“{f.name}” and the {affected.length-1} file(s) inside it will be deleted.</>:<>“{f.name}” will be deleted from this project.</>,confirmLabel:'Delete',danger:true,onConfirm:()=>{update(p=>({...p,files:p.files.filter(x=>!affected.some(a=>a.name===x.name))}));if(affected.some(a=>a.name===fileName))setFileName(remaining.find(x=>!x.name.endsWith('/'))?.name??'main.tex')}})};
 /** Adds files to the project, into `folder` when given ("figures/"). ZIP archives are imported as a whole project. */
 const uploadFiles=async(list:FileList|Incoming[]|null,folder='',insertImage=false)=>{
  if(!list)return;
  // ("File" here is the lucide icon, so tell picked files from dropped entries by their shape.)
  const items:Incoming[]=Array.from(list as ArrayLike<globalThis.File|Incoming>,x=>'path' in x&&'file' in x?x:{file:x as globalThis.File,path:(x as globalThis.File).name});
  const added:ProjectFile[]=[],renames=new Map<string,string>();
  const usedNames=new Set(project?.files.map(f=>f.name)??[]);
  for(const {file:f,path:rel} of items){
   if(!folder&&!rel.includes('/')&&f.name.toLowerCase().endsWith('.zip')){
    try{const current=projects.find(p=>p.id===projectId);if(!current)throw new Error('The project is no longer open.');const saved=await apiFetch(`/api/projects/${projectId}`,{method:'PUT',headers:json,body:JSON.stringify({name:current.name,files:current.files,mainFile:current.mainFile,archived:current.archived,settings:current.settings,versions:current.versions,comments:current.comments,changes:current.changes})});if(!saved.ok)throw new Error('Couldn’t save the project before importing the ZIP.');const form=new FormData();form.append('file',f);const res=await apiFetch(`/api/projects/${projectId}/upload`,{method:'POST',body:form});const d=await res.json().catch(()=>null);if(!res.ok)throw new Error(d?.error??NETWORK_HELP);const imported=normalizeProject(d,'server').files;syncedFiles.current.set(projectId,new Map(imported.map(x=>[x.name,x])));update(p=>({...p,files:imported}));notify(`Imported ${f.name}`,'success')}
    catch(e){notify(e instanceof Error&&!(e instanceof TypeError)?e.message:`ZIP import needs the API. ${NETWORK_HELP}`,'error')}
    continue;
   }
   if(f.size>20*1024*1024){notify(`${f.name} is larger than 20 MB and wasn’t uploaded.`,'error');continue}
   const originalName=(folder+rel).replace(/^\/+/,'');
   if(/(^|\/)\.\.(\/|$)/.test(originalName)){notify(`${originalName} has an invalid path.`,'error');continue}
   let name=isImage(originalName)?safeImageName(originalName):originalName;
   if(name!==originalName){const dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';let candidate=name,n=2;while(usedNames.has(candidate)){candidate=`${stem}-${n++}${ext}`}name=candidate;renames.set(originalName,name)}
   usedNames.add(name);
   if(isSvg(name)){
    // LaTeX can't include SVG; keep the original and add a PNG copy that \includegraphics can use.
    try{added.push({name,content:await f.text()},{name:name.replace(/\.svg$/i,'.png'),content:await svgToPngBase64(f),encoding:'base64'});notify(`Added ${name.replace(/\.svg$/i,'.png')} (a PNG copy of ${name}) — LaTeX can’t include SVG directly.`,'success')}
    catch{notify(`${name} couldn’t be converted to PNG. Export it as PDF or PNG and upload that instead.`,'error')}
    continue;
   }
   // Figures and other binary files are stored as base64; reading them as text would corrupt them.
   added.push(isBinary(name)?{name,content:arrayBufferToBase64(await f.arrayBuffer()),encoding:'base64'}:{name,content:await f.text()});
  }
  if(added.length){
   // Parent folders become explicit entries so the tree shows them even when they only hold the new files.
   const folders=new Set<string>();for(const x of added){const parts=x.name.split('/');for(let i=1;i<parts.length;i++)folders.add(parts.slice(0,i).join('/')+'/')}
   const image=added.find(x=>isImage(x.name)&&!isSvg(x.name));
   const mainTex=project?.files.find(x=>x.name===(project.mainFile??'main.tex'))??project?.files.find(x=>x.name.endsWith('.tex'));
   const figure=image&&insertImage?`\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${image.name}}\n  \\caption{Caption}\n  \\label{fig:${image.name.split('/').pop()?.replace(/\.[^.]+$/,'')}}\n\\end{figure}`:'';
   update(p=>{const names=new Set(added.map(x=>x.name));let kept=p.files.filter(x=>!names.has(x.name));const missing=[...folders].filter(d=>!kept.some(x=>x.name===d)).map(d=>({name:d,content:''}));kept=[...kept,...missing,...added];if(renames.size)kept=kept.map(x=>x.name.endsWith('.tex')&&typeof x.content==='string'?{...x,content:rewriteImageReferences(x.content,renames)}:x);if(figure&&mainTex)kept=kept.map(x=>{if(x.name!==mainTex.name)return x;const body=String(x.content??'');const content=/\\end\{document\}/.test(body)?body.replace(/\\end\{document\}/,`${figure}\n\\end{document}`):`${body}\n\n${figure}\n`;return{...x,content}});return{...p,files:kept}});
   setCollapsed(c=>{const n=new Set(c);for(const d of folders)n.delete(d.replace(/\/$/,''));return n});
   const opened=added.find(x=>!x.name.endsWith('.svg'));if(opened&&!insertImage)setFileName(opened.name);if(figure&&mainTex)setFileName(mainTex.name);
   if(!added.some(x=>isSvg(x.name)))notify(added.length===1?`Uploaded ${added[0].name}`:`Uploaded ${added.length} files`,'success');
  }
  if(fileInput.current)fileInput.current.value='';
  if(imageInput.current)imageInput.current.value='';
  if(folderInput.current)folderInput.current.value='';
 };
 // Images pasted or dropped into the editor (or dropped on the file tree) go to figures/ and, in the editor, get a
 // full figure block at the cursor. Undoing the inserted block also removes the uploaded files; redo restores them.
 const figureUndo=useRef<{model:string,paths:string[],files:ProjectFile[]}[]>([]),addFiguresRef=useRef<(list:globalThis.File[],at?:{x:number,y:number})=>void>(()=>undefined),figureSyncRef=useRef<()=>void>(()=>undefined);
 const addFigures=async(list:globalThis.File[],{insertBlock=true,at}:{insertBlock?:boolean,at?:{x:number,y:number}}={})=>{
  if(!project||project.role==='viewer'||!list.length)return;
  const used=new Set(project.files.map(f=>f.name)),added:ProjectFile[]=[],paths:string[]=[],notes:string[]=[];let failed=0;
  for(const[i,file]of list.entries()){
   notify(list.length>1?`Adding image ${i+1} of ${list.length}…`:`Adding ${file.name||'image'}…`);
   try{const out=await prepareFigure(file,{keepOriginal:prefs.keepImageSize,used});added.push(...out.files);paths.push(out.include);if(out.note)notes.push(out.note)}
   catch(e){failed++;notify(e instanceof Error?e.message:'The image couldn’t be added.','error')}
  }
  if(!added.length)return;
  const names=new Set(added.map(f=>f.name));
  const main=project.files.find(f=>f.name===(project.mainFile??'main.tex'))??project.files.find(f=>f.name.endsWith('.tex'));
  const ed=editorRef.current,model=ed?.getModel(),texOpen=!!ed&&!!model&&!!currentFile&&/\.tex$/i.test(currentFile.name);
  if(texOpen&&at){const target=ed.getTargetAtClientPoint(at.x,at.y);if(target?.position)ed.setPosition(target.position)}
  const position=ed?.getPosition(),atCursor=insertBlock&&texOpen&&!!position&&inDocumentBody(model.getValue(),model.getOffsetAt(position));
  const fallback=insertBlock&&!atCursor&&main?main.name:'';
  update(p=>({...p,files:[...p.files.filter(f=>!names.has(f.name)).map(f=>f.name===fallback?{...f,content:appendToBody(f.content,paths.map(x=>figureBlock(x)).join('\n'))}:f),...(p.files.some(f=>f.name===FIGURE_FOLDER)?[]:[{name:FIGURE_FOLDER,content:''}]),...added]}));
  setCollapsed(c=>{const n=new Set(c);n.delete(FIGURE_FOLDER.replace(/\/$/,''));return n});
  if(atCursor){
   const lead=position.column>1&&model.getLineContent(position.lineNumber).trim()?'\n':'';
   const snippets=ed.getContribution('snippetController2') as {insert?:(template:string)=>void}|null;
   ed.focus();
   if(snippets?.insert)snippets.insert(lead+figureSnippet(paths));else ed.executeEdits('figure',[{range:ed.getSelection()!,text:lead+paths.map(x=>figureBlock(x)).join('\n'),forceMoveMarkers:true}]);
   figureUndo.current=[...figureUndo.current.slice(-9),{model:model.uri.toString(),paths,files:added}];
  }else if(fallback)setFileName(fallback);
  if(!failed)notify(notes.length?notes.join(' '):paths.length===1?`Added ${paths[0]}`:`Added ${paths.length} images to ${FIGURE_FOLDER}`,'success');
  if(insertBlock&&main&&!hasGraphicx(main.content))setDialog({title:'Add the graphicx package?',message:<>Figures need <code>\usepackage{'{graphicx}'}</code>, and {main.name} doesn’t load it yet.</>,confirmLabel:'Add it',onConfirm:()=>{const live=editorRef.current,open=live?.getModel();/* In the open file, add it as an editor edit so the cursor stays in the caption. */if(live&&open&&currentFile?.name===main.name){if(!hasGraphicx(open.getValue())){const spot=graphicxInsertion(open.getValue()),at=open.getPositionAt(spot.offset);live.executeEdits('graphicx',[{range:{startLineNumber:at.lineNumber,startColumn:at.column,endLineNumber:at.lineNumber,endColumn:at.column},text:spot.text}])}window.setTimeout(()=>live.focus(),0)}else update(p=>({...p,files:p.files.map(f=>f.name===main.name&&!hasGraphicx(f.content)?{...f,content:addGraphicx(f.content)}:f)}))}});
 };
 addFiguresRef.current=(list,at)=>void addFigures(list,{at});
 figureSyncRef.current=()=>{const model=editorRef.current?.getModel();if(!model||!project)return;const text=model.getValue();for(const entry of figureUndo.current){if(entry.model!==model.uri.toString())continue;const cited=entry.paths.some(x=>text.includes(`{${x}}`)),stored=project.files.some(f=>f.name===entry.files[0]!.name);if(!cited&&stored){const gone=new Set(entry.files.map(f=>f.name));update(p=>({...p,files:p.files.filter(f=>!gone.has(f.name))}));notify(`Removed ${entry.paths.join(', ')}`)}else if(cited&&!stored)update(p=>({...p,files:[...p.files,...entry.files.filter(f=>!p.files.some(x=>x.name===f.name))]}))}};
 // Pasted images: caught on the document (Monaco's input element is not reliably under the editor's root node).
 useEffect(()=>{const onPaste=(e:ClipboardEvent)=>{if(!(e.target instanceof Element)||!e.target.closest('.editor-canvas'))return;const images=Array.from(e.clipboardData?.files??[]).filter(isFigureFile);if(!images.length)return;e.preventDefault();e.stopPropagation();addFiguresRef.current(images)};document.addEventListener('paste',onPaste,true);return()=>document.removeEventListener('paste',onPaste,true)},[]);
 const [dropTarget,setDropTarget]=useState<string|null>(null);
 const dropProps=(folder:string)=>({
  onDragOver:(e:React.DragEvent)=>{if(!e.dataTransfer.types.includes('Files'))return;e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='copy';setDropTarget(folder)},
  onDragLeave:(e:React.DragEvent)=>{if(!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node))setDropTarget(t=>t===folder?null:t)},
  onDrop:async(e:React.DragEvent)=>{if(!e.dataTransfer.types.includes('Files'))return;e.preventDefault();e.stopPropagation();setDropTarget(null);const items=await filesFromDrop(e.dataTransfer);/* Loose images dropped on the tree itself go to figures/. */if(!folder&&items.length&&items.every(x=>isFigureFile(x.file)&&!x.path.includes('/'))){await addFigures(items.map(x=>x.file),{insertBlock:false});return}await uploadFiles(items,folder)},
 });
 const uploadTo=(folder:string)=>{uploadFolder.current=folder;folderInput.current?.click()};
 const setMainDocument=(f:ProjectFile)=>{update(p=>({...p,mainFile:f.name}));notify(`${f.name} is now the main document`,'success')};
 /** Read-only copy link: stores a snapshot; whoever opens the link gets their own copy and can't change this project. */
 const createShareLink=async()=>{
  setShare({state:'creating'});
  try{const r=await apiFetch(`/api/projects/${project.id}/share`,{method:'POST',headers:json,body:JSON.stringify({name:project.name,mainFile:project.mainFile??'main.tex',files:project.files})});const d=await r.json().catch(()=>null);if(!r.ok||!d?.id)throw new Error(d?.error??'The link couldn’t be created.');setShare({state:'ready',url:`${location.origin}${location.pathname}?copy=${d.id}`})}
  catch(e){setShare({state:'error',error:e instanceof TypeError?NETWORK_HELP:e instanceof Error?e.message:'The link couldn’t be created.'})}
 };
 const copyText=async(text:string,done:string)=>{try{await navigator.clipboard.writeText(text);notify(done,'success')}catch{notify('Select the link and copy it with Ctrl/⌘+C.')}};
 const downloadProject=async()=>{try{const res=await apiFetch(`/api/projects/${projectId}/download`);if(!res.ok)throw 0;const blob=await res.blob();downloadBlob(blob,`${project.name}.zip`)}catch{const data=new Blob([JSON.stringify(project,null,2)],{type:'application/json'});downloadBlob(data,`${project.name.replaceAll(' ','-')}-project.json`);notify('Project downloaded as JSON (start the backend for ZIP export)')}};
 const downloadPdf=async()=>{if(!pdfUrl){notify('Compile the project to create a PDF');return}if(pdfData){downloadBlob(new Blob([pdfData],{type:'application/pdf'}),`${project.name}.pdf`);return}try{const response=await fetch(pdfUrl,{headers:ownerHeaders()});if(!response.ok)throw new Error();downloadBlob(await response.blob(),`${project.name}.pdf`)}catch{notify('Could not download the compiled PDF.','error')}};
 const openLogs=async()=>{setModal('logs');if(result)return;setLogState({loading:true});try{const r=await apiFetch(`/api/projects/${projectId}/logs`);if(!r.ok)throw new Error();const d=await r.json();if(d.success!==null)setResult(d);setLogState({loading:false})}catch{setLogState({loading:false,error:NETWORK_HELP})}};
 const inProject=(file:string|null)=>!!file&&!!project?.files.some(f=>f.name===file);
 /** Opens a file at a line, switching file and layout as needed. Applied once the editor shows that file. */
 /* Fixes offered by "Check before submitting". Deleting files asks first; the others are small, visible edits. */
 const applySubmissionFix=(fix:Fix)=>{
  const run=()=>{update(p=>({...p,files:applySubmissionChange(p.files,fix) as ProjectFile[]}));if(!applySubmissionChange(project.files,fix).some(f=>f.name===fileName))setFileName(project.mainFile??'main.tex');notify(fix.type==='delete-files'?`Deleted ${fix.files.length===1?fix.files[0]:`${fix.files.length} files`}`:fix.type==='remove-bib-entry'?`Removed “${fix.key}” from ${fix.file}`:'Renamed files to plain ASCII and updated the document')};
  if(fix.type==='delete-files')setDialog({title:fix.files.length===1?'Delete file?':`Delete ${fix.files.length} files?`,message:<>{fix.files.length===1?<>“{fix.files[0]}” will be deleted from this project.</>:<>These files will be deleted from this project: {fix.files.join(', ')}.</>}</>,confirmLabel:'Delete',danger:true,onConfirm:run});else run();
 };
 const jumpTo=(file:string|null,line:number|null)=>{
  if(!file||!inProject(file)){notify(file?`${file} isn’t part of this project (it comes from TeX Live).`:'This message has no source location.');return}
  setModal('');pendingJump.current={file,line:line??1};
  if(layout==='pdf')setPref('layout',narrow?'editor':'split');
  if(file!==currentFile?.name)setFileName(file);else applyJump();
 };
 const applyJump=()=>{const j=pendingJump.current,ed=editorRef.current,monaco=monacoRef.current;if(!j||!ed||j.file!==currentFile?.name)return;pendingJump.current=null;const ln=j.line;if(ln<1||ln>(ed.getModel()?.getLineCount()??0)){notify('Couldn’t find this location in the source. Recompile and try again.');return}ed.revealLineInCenter(ln);ed.setPosition({lineNumber:ln,column:1});syncDecorations.current?.clear();syncDecorations.current=ed.createDecorationsCollection([{range:{startLineNumber:ln,startColumn:1,endLineNumber:ln,endColumn:ed.getModel()?.getLineMaxColumn(ln)??1},options:{isWholeLine:true,className:'sync-source-highlight',overviewRuler:{color:'rgba(45, 157, 111, .85)',position:monaco?.editor?.OverviewRulerLane?.Full}}}]);window.clearTimeout(syncHighlightTimer.current);syncHighlightTimer.current=window.setTimeout(()=>syncDecorations.current?.clear(),1800);ed.focus()};
 const syncSourceToPdf=async()=>{
  if(!currentFile||!isEditable(currentFile)){notify('Open a text file before syncing to the PDF.');return}
  if(sourceSyncPending.current)return;
  sourceSyncPending.current=true;
  const position=editorRef.current?.getPosition();
  try{
   const response=await apiFetch(`/api/projects/${projectId}/synctex`,{method:'POST',headers:json,body:JSON.stringify({mode:'forward',file:currentFile.name,line:position?.lineNumber??cursor.line,column:position?.column??cursor.col,mainFile:project.mainFile??'main.tex'})});
   const data=await response.json();if(!response.ok)throw new Error(data.error??'SyncTeX lookup failed.');
   if(!data.found){notify(data.recompile?'Recompile, then try again: this PDF has no position data on the server yet.':'No PDF position is available here. Recompile and try a line with printed text.');return}
  setSyncPoint({page:data.page,x:data.x,y:data.y,width:data.width,height:data.height,n:Date.now()});if(narrow)setPref('layout','pdf');
  }catch(e){notify(e instanceof Error?e.message:'SyncTeX lookup failed.','error')}
  finally{sourceSyncPending.current=false}
 };
 const syncPdfToSource=async(syncPage:number,x:number,y:number)=>{
  // One lookup at a time; a newer request waits and runs next (older queued ones are replaced).
  if(pdfSyncPending.current){pdfSyncNext.current={page:syncPage,x,y};return}
  pdfSyncPending.current=true;
  try{
   const response=await apiFetch(`/api/projects/${projectId}/synctex`,{method:'POST',headers:json,body:JSON.stringify({mode:'inverse',page:syncPage,x,y,mainFile:project.mainFile??'main.tex'})});
   const data=await response.json();if(!response.ok)throw new Error(data.error??'SyncTeX lookup failed.');
   if(!data.found){notify(data.recompile?'Recompile, then try again: this PDF has no position data on the server yet.':'Couldn’t find this location in the source.');return}
   jumpTo(data.file,data.line);
  }catch(e){notify(e instanceof Error?e.message:'SyncTeX lookup failed.','error')}
  finally{pdfSyncPending.current=false;const next=pdfSyncNext.current;pdfSyncNext.current=null;if(next)void syncPdfToSource(next.page,next.x,next.y)}
 };
 // Assistant: what the panel may share, and the actions that only ever run on a click.
 const editableFile=currentFile&&isEditable(currentFile)&&!currentFile.name.endsWith('/')?currentFile:null;
 const sharedItems=[...(editableFile?[editableFile.name,`Ln ${cursor.line}, Col ${cursor.col}`]:[]),...(editableFile&&selectionChars?[`selection (${selectionChars.toLocaleString()} chars)`]:[]),...(result?[`last compile log (${result.errors.length} error${result.errors.length===1?'':'s'})`]:[])];
 const editorContext=()=>{if(!shareContext)return undefined;const ed=editorRef.current,sel=ed?.getSelection(),model=ed?.getModel();const selection=editableFile&&sel&&model&&!sel.isEmpty()?clipSelection(model.getValueInRange(sel)):'';return{...(editableFile?{file:editableFile.name,cursor,content:numberedFile(editableFile.content,cursor.line).content}:{}),...(selection?{selection}:{}),...(result?{log:logContext(result)}:{})}};
 const askAssistant=(question:string)=>{setAssistantOpen(true);assistant.send(question,{context:editorContext()})};
 /** Explains a compile error. Sends the error, the log and the file it points to, numbered, so a fix can name exact lines. */
 const explainError=(e:LogEntry)=>{
  setModal('');setAssistantOpen(true);
  const f=e.file?project.files.find(x=>x.name===e.file):undefined;
  const shown=f&&isEditable(f)?f.content:null;
  assistant.send(`Explain this error: ${e.file??'(unknown file)'}${e.line?` line ${e.line}`:''} — ${e.message}`,{mode:'explain',context:{error:e,...(shown!==null?{file:e.file,content:numberedFile(shown,e.line??1).content}:{}),...(result?{log:logContext(result)}:{})},fixSource:shown!==null&&e.file?{file:e.file,shown}:undefined});
 };
 const quickPrompt=(id:string)=>{
  if(id!=='fix'){askAssistant(QUICK_PROMPTS.find(q=>q.id===id)?.prompt??'');return}
  if(!result){notify('Recompile first so the assistant can see what went wrong.');return}
  const first=result.errors.find(e=>inProject(e.file))??result.errors[0];
  if(!first){notify(result.success?'Your last compile had no errors.':'The log lists no errors. Open Logs to see the raw output.');return}
  explainError(first);
 };
 const insertFromAssistant=(code:string)=>{
  const ed=editorRef.current,pos=ed?.getPosition();
  if(!ed||!pos||!editableFile){notify('Open a .tex file in the editor to insert code.','error');return}
  // Insert at the caret without replacing a selection; start multi-line code on its own line.
  const text=(code.includes('\n')&&pos.column>1?'\n':'')+code;
  ed.executeEdits('assistant',[{range:{startLineNumber:pos.lineNumber,startColumn:pos.column,endLineNumber:pos.lineNumber,endColumn:pos.column},text,forceMoveMarkers:true}]);
  ed.focus();if(narrow){setNarrowAssistant(false);if(layout==='pdf')setPref('layout','editor')}
  notify('Inserted at cursor','success');
 };
 const reviewFix=(fix:LineFix)=>{setFixReview(fix);setModal('fix')};
 const applyAssistantFix=(fix:LineFix)=>{
  const f=project.files.find(x=>x.name===fix.file);
  if(!f||!fixStillApplies(f.content,fix)){notify('The file changed since the assistant read it. Ask again for an up-to-date fix.','error');return}
  const ed=editorRef.current,model=ed?.getModel();
  // In the open file the edit goes through the editor so Undo reverts it; other files get a snapshot first.
  if(fix.file===currentFile?.name&&ed&&model){ed.pushUndoStop();ed.executeEdits('assistant',[{range:{startLineNumber:fix.start,startColumn:1,endLineNumber:fix.end,endColumn:model.getLineMaxColumn(fix.end)},text:fix.replacement,forceMoveMarkers:true}]);ed.pushUndoStop()}
  else{const next=applyFix(f.content,fix);update(p=>({...p,versions:[{id:crypto.randomUUID(),label:'Before assistant fix',created:Date.now(),files:p.files.map(x=>({...x}))},...(p.versions??[])].slice(0,30),files:p.files.map(x=>x.name===fix.file?{...x,content:next}:x)}))}
  assistant.markApplied(fix);setFixReview(null);jumpTo(fix.file,fix.start);notify('Fix applied. Recompile to check it.','success');
 };
 const closeTour=useCallback(()=>{setTour(false);writeFlag(TOUR_KEY,'1')},[]);
 /** Makes the part of the screen each tour step points at visible. */
 const tourStep=(step:TourStep)=>{
  setOpenMenu('');
  if(step.id==='files'){if(narrow){setNarrowAssistant(false);setDrawer(true)}else setPref('sidebar',true);return}
  if(narrow)setDrawer(false);
  if(step.id==='editor'&&layout==='pdf')setPref('layout',narrow?'editor':'split');
  if((step.id==='compile'||step.id==='pdf'||step.id==='logs')&&!showPdf)setPref('layout',narrow?'pdf':'split');
 };
 const changeZoom=(delta:number)=>setZoom(z=>Math.min(300,Math.max(30,Math.round(((typeof z==='number'?z:scaleRef.current)+delta)/10)*10)));
 const goToPage=(n:number)=>setNav(v=>({page:Math.max(1,Math.min(pageTotal||1,n)),n:v.n+1}));

 const onMount:OnMount=(editor,monaco)=>{editorRef.current=editor;monacoRef.current=monaco;setEditorReady(true);editor.onDidChangeModelContent((e:any)=>{if(e.isUndoing||e.isRedoing)window.setTimeout(()=>figureSyncRef.current(),0)});editor.addAction({id:'paperdesk.addCitation',label:'Add citation by DOI or arXiv ID',run:()=>setModal('cite')});editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>compileRef.current());editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.Enter,()=>compileRef.current());editor.onDidChangeCursorPosition((e:any)=>setCursor({line:e.position.lineNumber,col:e.position.column}));editor.onDidChangeCursorSelection((e:any)=>{const model=editor.getModel();setSelectionChars(model&&!e.selection.isEmpty()?model.getValueLengthInRange(e.selection):0)});editor.onDidDispose(()=>{editorRef.current=null;setEditorReady(false)})};
 // Jump once the editor shows the requested file, and show compile problems as squiggles in it.
 useEffect(()=>{if(editorReady)applyJump()},[editorReady,currentFile?.name]);
 useEffect(()=>{const ed=editorRef.current,m=monacoRef.current,model=ed?.getModel();if(!m||!model)return;const name=currentFile?.name;const entries=[...(result?.errors??[]).map(e=>({e,sev:m.MarkerSeverity.Error})),...(result?.warnings??[]).map(e=>({e,sev:m.MarkerSeverity.Warning}))].filter(x=>x.e.file===name&&x.e.line);m.editor.setModelMarkers(model,'latex',entries.map(({e,sev})=>({severity:sev,message:e.message,startLineNumber:e.line!,endLineNumber:e.line!,startColumn:1,endColumn:model.getLineMaxColumn(Math.min(e.line!,model.getLineCount()))})))},[result,editorReady,currentFile?.name]);
 const sortedProjects=useMemo(()=>projects.filter(p=>p.name.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sortBy==='name'?a.name.localeCompare(b.name):b.modified-a.modified),[projects,query,sortBy]);
 const dashboard=activeTab!=='editor'||!project;
 const routePending=!!routeProjectId()&&!projects.some(p=>p.id===routeProjectId());
 useEffect(()=>{if(!dashboard&&editorReady&&!readFlag(TOUR_KEY))setTour(true)},[dashboard,editorReady]);
 const themeMenu=<ThemeMenu pref={theme.pref} resolved={theme.resolved} setPref={theme.setPref} open={openMenu==='theme'} toggle={()=>setOpenMenu(openMenu==='theme'?'':'theme')}/>;

 const menus:{label:string,items:MenuItem[]}[]=project?[
  {label:'File',items:[{label:'New file',icon:<FilePlus2 size={14}/>,run:()=>addFile()},{label:'New folder',icon:<FolderPlus size={14}/>,run:()=>addFile(true)},{label:'Upload files',icon:<Upload size={14}/>,run:()=>fileInput.current?.click()},'sep',{label:'Project history',icon:<ScrollText size={14}/>,run:()=>setModal('history')},{label:'Word count',run:()=>setModal('wordcount')},{label:'Check before submitting',run:()=>setModal('submission')},{label:'Download project',icon:<FileArchive size={14}/>,run:downloadProject},{label:'Download PDF',icon:<Download size={14}/>,run:downloadPdf,disabled:!pdfUrl},'sep',{label:'Compile',icon:<Play size={14}/>,shortcut:`${mod}↵`,run:()=>void compile()},'sep',{label:'Back to projects',icon:<Home size={14}/>,run:navigateDashboard}]},
  {label:'Edit',items:[{label:'Undo',shortcut:`${mod}Z`,run:()=>editorRef.current?.trigger('keyboard','undo',null)},{label:'Redo',shortcut:isMac?'⇧⌘Z':'Ctrl+Y',run:()=>editorRef.current?.trigger('keyboard','redo',null)},'sep',{label:'Find',shortcut:`${mod}F`,run:()=>edAction('actions.find')},{label:'Find and replace',shortcut:isMac?'⌥⌘F':'Ctrl+H',run:()=>edAction('editor.action.startFindReplaceAction')},'sep',{label:'Select all',shortcut:`${mod}A`,run:()=>edAction('editor.action.selectAll')},{label:`Review changes${project.changes?.length?` (${project.changes.length})`:''}`,icon:<ScrollText size={14}/>,run:()=>setModal('changes')},{label:'Comments',icon:<ScrollText size={14}/>,run:()=>setModal('comments')}]},
  {label:'Insert',items:[{label:'Section',run:()=>insert('\n\\section{Section title}\n')},{label:'Subsection',run:()=>insert('\n\\subsection{Subsection title}\n')},{label:'Equation',run:()=>insert('\n\\begin{equation}\n  \n\\end{equation}\n')},{label:'Image',icon:<ImageIcon size={14}/>,run:()=>imageInput.current?.click()},{label:'Table',run:()=>insert('\n\\begin{table}[ht]\n  \\centering\n  \\begin{tabular}{cc}\n    A & B \\\\\n    1 & 2 \\\\\n  \\end{tabular}\n  \\caption{Caption}\n\\end{table}\n')},{label:'Bulleted list',run:()=>insert('\\begin{itemize}\n  \\item Item\n\\end{itemize}')},{label:'Citation',run:()=>wrap('\\cite{','}')},{label:'Citation from DOI or arXiv ID…',icon:<BookPlus size={14}/>,run:()=>setModal('cite')},'sep',{label:'Symbol palette',icon:<Omega size={14}/>,checked:symbolsOpen,run:()=>setSymbolsOpen(o=>!o)}]},
  {label:'View',items:[...(narrow?[]:[{label:'Editor & PDF',checked:prefs.layout==='split',run:()=>setPref('layout','split')}]),{label:'Editor only',checked:prefs.layout==='editor'||(narrow&&layout==='editor'),run:()=>setPref('layout','editor')},{label:'PDF only',checked:layout==='pdf',run:()=>setPref('layout','pdf')},'sep',{label:'File tree',checked:sidebarOpen,run:()=>setSidebar(!sidebarOpen)},{label:'File outline',checked:prefs.outline,run:()=>setPref('outline',!prefs.outline)},{label:'Word wrap',checked:prefs.wrap,run:()=>setPref('wrap',!prefs.wrap)},'sep',...themeOptions.map(o=>({label:`${o.label} theme`,icon:o.icon,checked:theme.pref===o.value,run:()=>theme.setPref(o.value)}))]},
  {label:'Help',items:[{label:'Ask the assistant',icon:<Sparkles size={14}/>,run:()=>setAssistantOpen(true)},{label:'Take the tour',icon:<Compass size={14}/>,run:()=>setTour(true)},'sep',{label:'Keyboard shortcuts',icon:<Keyboard size={14}/>,run:()=>setModal('shortcuts')},{label:'Project settings',icon:<Settings size={14}/>,run:()=>setModal('settings')},{label:'About PaperDesk',icon:<Info size={14}/>,run:()=>notify('PaperDesk is an independent LaTeX editor.')}]},
 ]:[];

 if(routePending)return <div className="app-shell"><div className="pane-loading">Loading project…</div></div>;
 return <div className="app-shell">
  {joinPrompt&&<SignInDialog close={()=>setJoinPrompt(false)} note="Sign in to join the project you were invited to."/>}
 {dashboard?<>
  <header className="dash-header">
   <Brand/>
   <nav className="dash-nav"><button className={activeTab!=='templates'?'nav-active':''} onClick={()=>setActiveTab('dashboard')}>Projects</button><button className={activeTab==='templates'?'nav-active':''} onClick={()=>setActiveTab('templates')}>Templates</button></nav>
   <div className="dash-right"><AccountButton/>{themeMenu}<Dropdown id="dash-help" open={openMenu==='dash-help'} setOpen={setOpenMenu} align="right" trigger={<button className="icon-btn" title="Help" aria-label="Help" onClick={()=>setOpenMenu(openMenu==='dash-help'?'':'dash-help')}><HelpCircle size={17}/></button>} items={[{label:'Take the tour',icon:<Compass size={14}/>,disabled:!projects.length,run:()=>{const recent=sortedProjects[0]??projects[0];if(recent){openProject(recent);setTour(true)}}},{label:'Keyboard shortcuts',icon:<Keyboard size={14}/>,disabled:!projects.length,run:()=>setModal('shortcuts')},{label:'Start from a template',icon:<BookOpen size={14}/>,run:()=>setActiveTab('templates')}]}/></div>
  </header>
  <main className="dash-main">
   <div className="dash-heading"><div><div className="eyebrow">Workspace / My projects</div><h1>{activeTab==='templates'?'Start from a template':'Your projects'}</h1><p className="subhead">{activeTab==='templates'?'Choose a starting point for your next document.':'Pick up where you left off.'}</p></div><button className="btn btn-primary" onClick={promptNewProject}><Plus size={16}/> New project</button></div>
   {activeTab==='templates'&&<TemplateGallery templates={templates} busyId={templateBusy} onUse={t=>void startFromTemplate(t)}/>}
   <div className="section-bar"><div className="section-title"><h2>Recent projects</h2><span className="count-pill">{sortedProjects.length}</span></div><div className="dash-tools"><label className="search-box"><Search size={15}/><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search projects…" aria-label="Search projects"/>{query?<button className="clear-search" aria-label="Clear search" onClick={()=>setQuery('')}><X size={13}/></button>:<kbd>{isMac?'⌘K':'Ctrl K'}</kbd>}</label><Dropdown id="sort" open={openMenu==='sort'} setOpen={setOpenMenu} align="right" trigger={<button className="btn btn-ghost btn-sm" onClick={()=>setOpenMenu(openMenu==='sort'?'':'sort')}>{sortBy==='name'?'Name':'Last modified'} <ChevronDown size={14}/></button>} items={[{label:'Last modified',checked:sortBy==='modified',run:()=>setSortBy('modified')},{label:'Name',checked:sortBy==='name',run:()=>setSortBy('name')}]}/></div></div>
   {sortedProjects.length?<div className="project-list" role="table"><div className="project-list-head" role="row"><span>Name</span><span>Last modified</span><span>Owner</span><span/></div>{sortedProjects.map((p,i)=><div className="project-row" role="row" key={p.id}><button className="project-open" onClick={()=>openProject(p)}><div className={`project-file-icon pfi-${i%4}`}><FileText size={18}/></div><div className="project-name-wrap"><strong>{p.name}</strong><small>{p.files.length} files{p.archived?' · Archived':''} · {p.files.map(f=>f.name).slice(0,2).join(', ')}</small></div></button><span className="muted date-text">{relative(p.modified)}</span><span className="owner">{p.role&&p.role!=='owner'?'Shared with you':'You'}</span><div className="row-actions"><button className="icon-btn" title="Open" aria-label={`Open ${p.name}`} onClick={()=>openProject(p)}><ChevronRight size={17}/></button><Dropdown id={p.id} open={openMenu===p.id} setOpen={setOpenMenu} align="right" trigger={<button className="icon-btn" title="Project actions" aria-label="Project actions" onClick={()=>setOpenMenu(openMenu===p.id?'':p.id)}><MoreHorizontal size={18}/></button>} items={[{label:'Rename',icon:<Pencil size={14}/>,run:()=>renameProject(p)},{label:'Duplicate',icon:<Copy size={14}/>,run:()=>duplicate(p)},{label:p.archived?'Unarchive':'Archive',icon:<FileArchive size={14}/>,run:()=>setProjects(xs=>xs.map(x=>x.id===p.id?{...x,archived:!x.archived}:x))},'sep',{label:'Delete',icon:<Trash2 size={14}/>,danger:true,run:()=>deleteProject(p)}]}/></div></div>)}</div>
   :<div className="empty-state"><div className="empty-icon"><FileText size={24}/></div><h3>No projects found</h3><p>{query?'Try a different search.':'Create your first project to get started.'}</p>{!query&&<button className="btn btn-primary" onClick={promptNewProject}><Plus size={15}/> New project</button>}</div>}
   <div className="dash-footer"><span>PaperDesk <span className="dot">·</span> A thoughtful place to write</span><span>Projects are saved to the PaperDesk server and in this browser</span></div>
  </main>
 </>:<div className="editor-shell">
  <header className="editor-header">
   <button className="icon-btn chrome-btn" title="Back to projects" aria-label="Back to projects" onClick={navigateDashboard}><Home size={16}/></button>
   <span className="chrome-divider"/>
   <nav className="editor-menus" aria-label="Editor menu">
    {compact?<Dropdown id="menu-all" open={openMenu==='menu-all'} setOpen={setOpenMenu} trigger={<button className="text-menu" onClick={()=>setOpenMenu(openMenu==='menu-all'?'':'menu-all')}><Menu size={15}/> Menu</button>} groups={menus}/>
    :menus.map(m=><Dropdown key={m.label} id={'menu-'+m.label} open={openMenu==='menu-'+m.label} setOpen={setOpenMenu} trigger={<button className={`text-menu ${openMenu==='menu-'+m.label?'active':''}`} onClick={()=>setOpenMenu(openMenu==='menu-'+m.label?'':'menu-'+m.label)} onMouseEnter={()=>{if(openMenu.startsWith('menu-')&&openMenu!=='menu-'+m.label)setOpenMenu('menu-'+m.label)}}>{m.label}</button>} items={m.items}/>)}
   </nav>
   <button className="project-title" title="Rename project" onClick={()=>renameProject(project)}><span>{project.name}</span><Pencil size={12}/></button>
   <div className="header-right">
    {collabNames&&<span className="live-badge" data-testid="live-badge" title={peers.length?`Also here: ${peers.map(p=>p.name).join(", ")}`:"Live editing is on"}><span className="live-dot"/>Live{peers.length?` · ${peers.length+1}`:""}</span>}
    {project.role==="viewer"&&<span className="view-only-badge">View only</span>}
    <AccountButton compact/>
    <span className={`save-indicator ${saveState==='Saved'?'':'busy'} ${apiOnline===false?'offline':''}`} aria-live="polite" title={apiOnline===false?'The API is offline: changes are saved in this browser only.':'Changes are saved to the PaperDesk server.'}>{apiOnline===false?<CloudOff size={14}/>:<Cloud size={14}/>}<span className="hide-sm">{saveState==='Saved'&&apiOnline===false?'Saved in browser':saveState}</span></span>
    <div className="segmented" role="radiogroup" aria-label="Layout">
     {!narrow&&<button role="radio" aria-checked={prefs.layout==='split'} className={prefs.layout==='split'?'on':''} title="Editor & PDF" onClick={()=>setPref('layout','split')}><Columns2 size={15}/></button>}
     <button role="radio" aria-checked={layout==='editor'} className={layout==='editor'&&(narrow||prefs.layout==='editor')?'on':''} title="Editor only" onClick={()=>setPref('layout','editor')}><Code2 size={15}/>{narrow&&<span>Editor</span>}</button>
     <button role="radio" aria-checked={layout==='pdf'} className={layout==='pdf'?'on':''} title="PDF only" onClick={()=>setPref('layout','pdf')}><FileText size={15}/>{narrow&&<span>PDF</span>}</button>
    </div>
    <button className={`btn btn-sm assistant-toggle ${assistantOpen?'on':''}`} aria-pressed={assistantOpen} title="Assistant" onClick={()=>setAssistantOpen(!assistantOpen)}><Sparkles size={14}/><span className="hide-sm">Assistant</span></button>
    {!compact&&themeMenu}
    <button className="btn btn-secondary btn-sm hide-sm" onClick={()=>{setShare({state:'idle'});setModal('share')}}><Share2 size={14}/> Share</button>
    {/* On phones these live in the Menu (View → theme, Edit → Comments, Help → Project settings). */}{!compact&&<><button className="icon-btn chrome-btn" title="Comments" aria-label="Comments" onClick={()=>setModal('comments')}><ScrollText size={16}/></button><button className="icon-btn chrome-btn" title="Settings" aria-label="Settings" onClick={()=>setModal('settings')}><Settings size={16}/></button></>}
   </div>
  </header>

  <div className="work-area" ref={workRef} style={{['--sidebar-w' as any]:`${prefs.sidebarWidth}px`,['--preview-pct' as any]:`${prefs.previewPct}%`}}>
   {narrow&&drawer&&<div className="drawer-backdrop" onClick={()=>setDrawer(false)}/>}
   <aside className={`file-sidebar ${sidebarOpen?'':'collapsed'} ${narrow?'drawer':''}`} aria-label="Project files">
    <div className="pane-toolbar side-head"><span className="pane-title">Files</span><span className="side-tools"><button className="icon-btn sm" title="New file" aria-label="New file" onClick={()=>addFile()}><FilePlus2 size={15}/></button><button className="icon-btn sm" title="New folder" aria-label="New folder" onClick={()=>addFile(true)}><FolderPlus size={15}/></button><button className="icon-btn sm" title="Upload files" aria-label="Upload files" onClick={()=>fileInput.current?.click()}><Upload size={14}/></button><button className="icon-btn sm" title="Hide file tree" aria-label="Hide file tree" onClick={()=>setSidebar(false)}><PanelLeft size={15}/></button></span></div>
    <div className={`file-tree ${dropTarget===''?'drop-target':''}`} role="tree" {...dropProps('')}>
     <TreeLevel nodes={buildTree(project.files)} depth={0} selected={currentFile?.name??''} collapsed={collapsed} act={{mainFile:project.mainFile??'main.tex',dropTarget,dropProps,onToggle:p=>setCollapsed(c=>{const n=new Set(c);if(n.has(p))n.delete(p);else n.add(p);return n}),onOpen:f=>{setFileName(f.name);if(narrow)setDrawer(false);if(layout==='pdf')setPref('layout',narrow?'editor':'split')},onRename:renameFile,onDelete:deleteFile,onUpload:uploadTo,onSetMain:setMainDocument}}/>
     <p className="drop-hint">Drop files or folders here to upload</p>
    </div>
    {prefs.outline&&editableFile&&/\.tex$/i.test(editableFile.name)&&<Outline content={editableFile.content} cursorLine={cursor.line} onJump={line=>jumpTo(editableFile.name,line)}/>}
    <div className="side-bottom"><button onClick={downloadProject}><FileArchive size={15}/> Download project</button><button onClick={()=>setModal('settings')}><Settings size={15}/> Project settings</button></div>
    <input ref={fileInput} className="hidden" type="file" multiple accept=".tex,.bib,.bst,.sty,.cls,.png,.jpg,.jpeg,.pdf,.svg,.eps,.csv,.txt,.dat,.zip" onChange={e=>uploadFiles(e.target.files)}/><input ref={imageInput} className="hidden" data-testid="image-upload-input" type="file" multiple accept="image/*,.pdf,.eps,.heic,.heif" onChange={e=>{const picked=Array.from(e.target.files??[]);e.target.value='';void addFigures(picked)}}/><input ref={folderInput} className="hidden" type="file" multiple aria-label="Upload into folder" onChange={e=>uploadFiles(e.target.files,uploadFolder.current)}/><input ref={zipInput} className="hidden" type="file" accept=".zip" onChange={e=>uploadFiles(e.target.files)}/>
   </aside>
   {sidebarOpen&&!narrow&&<Resizer label="Resize file tree" value={prefs.sidebarWidth} min={170} max={420} onChange={v=>setPref('sidebarWidth',v)} fromClientX={x=>x-(workRef.current?.getBoundingClientRect().left??0)} onReset={()=>setPref('sidebarWidth',232)}/>}

   {(showEditor||narrow)&&<main className={`editor-main ${showEditor?'':'hidden-pane'}`} aria-hidden={!showEditor}>
    <div className="pane-toolbar doc-bar">
     {!sidebarOpen&&<button className="icon-btn sm" title="Show file tree" aria-label="Show file tree" onClick={()=>setSidebar(true)}><PanelLeft size={15}/></button>}
     <div className="tabs" role="tablist">{tabFiles(project.files,currentFile?.name).map(f=><button role="tab" aria-selected={currentFile?.name===f.name} key={f.name} className={`doc-tab ${currentFile?.name===f.name?'active':''}`} onClick={()=>setFileName(f.name)} title={f.name}>{fileIcon(f)}<span>{f.name.split('/').pop()}</span></button>)}</div>
     <button className="icon-btn sm" title="New file" aria-label="New file" onClick={()=>addFile()}><Plus size={15}/></button>
    </div>
    <div className="pane-toolbar editor-toolbar" role="toolbar" aria-label="Formatting">
     <button className="tool" title={`Undo (${mod}Z)`} aria-label="Undo" onClick={()=>editorRef.current?.trigger('keyboard','undo',null)}><Undo2 size={15}/></button><button className="tool" title="Redo" aria-label="Redo" onClick={()=>editorRef.current?.trigger('keyboard','redo',null)}><Redo2 size={15}/></button><span className="tool-divider"/>
     <select className="style-select" aria-label="Paragraph style" value="Normal text" onChange={e=>{const v=e.target.value;if(v==='Section')insert('\\section{}');if(v==='Subsection')insert('\\subsection{}');if(v==='Subsubsection')insert('\\subsubsection{}')}}><option>Normal text</option><option>Section</option><option>Subsection</option><option>Subsubsection</option></select><span className="tool-divider"/>
     <button className="tool" title="Bold" aria-label="Bold" onClick={()=>wrap('\\textbf{','}')}><Bold size={15}/></button><button className="tool" title="Italic" aria-label="Italic" onClick={()=>wrap('\\textit{','}')}><Italic size={15}/></button><button className="tool" title="Underline" aria-label="Underline" onClick={()=>wrap('\\underline{','}')}><Underline size={15}/></button><span className="tool-divider"/>
     <button className="tool" title="Bulleted list" aria-label="Bulleted list" onClick={()=>insert('\\begin{itemize}\n  \\item Item\n\\end{itemize}')}><List size={15}/></button><button className="tool" title="Numbered list" aria-label="Numbered list" onClick={()=>insert('\\begin{enumerate}\n  \\item Item\n\\end{enumerate}')}><ListOrdered size={15}/></button><button className="tool" title="Table" aria-label="Table" onClick={()=>insert('\\begin{table}[ht]\n  \\centering\n  \\begin{tabular}{cc}\n    A & B \\\\\n    1 & 2 \\\\\n  \\end{tabular}\n  \\caption{Caption}\n\\end{table}')}><Table2 size={15}/></button><button className="tool" title="Equation" aria-label="Equation" onClick={()=>insert('\\[\n  \n\\]')}><Sigma size={15}/></button><button className={`tool${symbolsOpen?' on':''}`} title="Symbol palette" aria-label="Symbol palette" aria-pressed={symbolsOpen} onClick={()=>setSymbolsOpen(o=>!o)}><Omega size={15}/></button><button className="tool" title="Citation" aria-label="Citation" onClick={()=>wrap('\\cite{','}')}><Quote size={15}/></button><button className="tool" title="Add citation from a DOI or arXiv ID" aria-label="Add citation" onClick={()=>setModal('cite')}><BookPlus size={15}/></button><button className="tool" title="Reference" aria-label="Reference" onClick={()=>wrap('\\ref{','}')}><Link2 size={14}/></button><button className="tool" title="Insert image" aria-label="Insert image" onClick={()=>imageInput.current?.click()}><ImageIcon size={15}/></button><span className="tool-divider"/><button className="tool" title="Sync source to PDF" aria-label="Sync source to PDF" onClick={syncSourceToPdf}><Crosshair size={15}/></button>
    </div>
    <div className="editor-canvas" onDragOverCapture={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='copy'}}} onDropCapture={e=>{const images=Array.from(e.dataTransfer.files).filter(isFigureFile);if(!images.length)return;e.preventDefault();e.stopPropagation();addFiguresRef.current(images,{x:e.clientX,y:e.clientY})}}>
     {currentFile&&!isEditable(currentFile)&&!currentFile.name.endsWith('/')?<div className="binary-file">{isImage(currentFile.name)&&currentFile.content?<img src={`data:${mimeType(currentFile.name)};base64,${currentFile.content}`} alt={currentFile.name}/>:<ImageIcon size={26}/>}<strong>{currentFile.name}</strong><p>{currentFile.content?`${formatBytes(Math.floor(currentFile.content.length*3/4))} · ${isBinary(currentFile.name)?'binary files':'files that aren’t UTF-8 text'} can’t be edited here; they’re included when the project compiles.`:'This file’s contents aren’t available in this browser. Re-upload it to include it in compiles.'}</p></div>
     :monacoState!=='ready'?<div className="pane-loading">{monacoState==='failed'?<><AlertCircle size={15}/> The editor couldn’t load. Reload the page to try again.</>:<><Spinner/> Loading editor…</>}</div>
     :<Editor height="100%" path={`${project.id}/${currentFile?.name??fileName}`} language={(currentFile?.name??fileName).endsWith('.bib')?'bibtex':'latex'} theme={theme.resolved==='dark'?'paperdesk-dark':'paperdesk-light'} beforeMount={setupMonaco} loading={<div className="pane-loading"><Spinner/> Loading editor…</div>} value={collabNames?.has(currentFile?.name??fileName)?undefined:content} onChange={v=>{const text=v??'';if(text===contentRef.current)return;if(collabNames)echo(currentFile?.name??fileName,text);setContent(text)}} onMount={onMount} options={{readOnly:project.role==='viewer',fontFamily:"'DM Mono', ui-monospace, monospace",fontSize:13.5,lineHeight:22,minimap:{enabled:false},padding:{top:14,bottom:24},automaticLayout:true,wordWrap:prefs.wrap?'on':'off',scrollBeyondLastLine:false,renderLineHighlight:'line',lineNumbers:'on',bracketPairColorization:{enabled:true},autoClosingBrackets:'always',autoClosingQuotes:'always',tabSize:2,folding:true,contextmenu:true,smoothScrolling:true,scrollbar:{verticalScrollbarSize:10,horizontalScrollbarSize:10}}}/>}
    </div>
    {spellMenu&&<SpellSuggestions menu={spellMenu} close={()=>setSpellMenu(null)} replace={text=>{spellRef.current?.replace(spellMenu.range,text);setSpellMenu(null)}} addWord={()=>{spellRef.current?.addWord(spellMenu.word);setSpellMenu(null);notify(`Added “${spellMenu.word}” to your dictionary`,'success')}}/>}
    {symbolsOpen&&<SymbolPalette onInsert={insert} onClose={()=>setSymbolsOpen(false)}/>}
    <div className="status-bar">{prefs.keymap!=='default'&&<span className="keymap-status" data-testid="keymap-status" ref={keymapStatus} aria-live="polite"/>}<span className="status-save"><span className={saveState==='Saved'?'status-dot ok':'status-dot busy'}/> {saveState}</span>{currentFile&&isEditable(currentFile)?<><span>Ln {cursor.line}, Col {cursor.col}</span><span className="hide-sm">Spaces: 2</span><span className="hide-sm">UTF-8</span><span>{currentFile.name.endsWith('.bib')?'BibTeX':'LaTeX'}</span></>:<span>{currentFile?.encoding==='base64'&&!isBinary(currentFile.name)?'Read-only (not UTF-8)':'Binary file'}</span>}<button onClick={()=>setModal('shortcuts')}><Keyboard size={13}/> <span className="hide-sm">Shortcuts</span></button></div>
   </main>}

   {showEditor&&showPdf&&<Resizer label="Resize PDF preview" value={prefs.previewPct} min={25} max={70} onChange={v=>setPref('previewPct',v)} fromClientX={x=>{const r=workRef.current!.getBoundingClientRect();return Math.round((r.right-x)/r.width*1000)/10}} onReset={()=>setPref('previewPct',46)} invert/>}

   {showPdf&&<section className={`preview-panel ${showEditor?'':'full'}`} aria-label="PDF preview">
    <div className="pane-toolbar pdf-toolbar">
     <div className="split-btn" data-menu-root>
      <button className="btn btn-primary btn-sm compile-main" onClick={()=>void compile()} title={compiling?'Restart the compile with your latest changes':`Recompile (${mod}↵ or ${mod}S)`}>{compiling?<Spinner light/>:<RefreshCw size={14}/>}{compiling?'Compiling…':'Recompile'}</button>
      <Dropdown id="engine" open={openMenu==='engine'} setOpen={setOpenMenu} trigger={<button className="btn btn-primary btn-sm compile-caret" aria-label="Compiler options" onClick={()=>setOpenMenu(openMenu==='engine'?'':'engine')}><ChevronDown size={14}/></button>} items={[...[['pdflatex','pdfLaTeX'],['xelatex','XeLaTeX'],['lualatex','LuaLaTeX']].map(([v,l])=>({label:l,checked:engine===v,run:()=>setEngine(v)})),'sep',{label:`Auto compile: ${compilePrefs.autoCompile?'On':'Off'}`,checked:compilePrefs.autoCompile,run:()=>setCompilePrefs({...compilePrefs,autoCompile:!compilePrefs.autoCompile,autoCompileChosen:true})},{label:'Stop compilation',icon:<Square size={13}/>,disabled:!compiling,run:stopCompile}]} heading="Compiler"/>
     </div>
     <button className={`btn btn-ghost btn-sm logs-btn ${compile_.status==='error'?'has-error':''}`} onClick={openLogs} title="View compile log"><ScrollText size={14}/><span className="hide-xs">Logs</span>{compile_.status==='error'&&<span className="err-badge" aria-label="Compile error">!</span>}</button>
     <span className={`pdf-state ${compile_.stale||compile_.status==='outdated'?'stale':''}`}><span className={`status-dot ${compile_.status==='running'?'busy':compile_.stale||compile_.status==='outdated'?'warn':pdfUrl?'ok':'idle'}`}/>{compile_.status==='running'?'Compiling…':compile_.stale||compile_.status==='outdated'?'PDF is out of date':pdfUrl?'Up to date':'Not compiled'}</span>
     <div className="toolbar-spacer"/>
     <button className="icon-btn sm" title="Download PDF" aria-label="Download PDF" disabled={!pdfUrl} onClick={downloadPdf}><Download size={15}/></button>
     {showEditor&&<button className="icon-btn sm" title="Hide PDF preview" aria-label="Hide PDF preview" onClick={()=>setPref('layout','editor')}><X size={15}/></button>}
    </div>
    {compile_.status!=='idle'&&<div className={`compile-banner ${compile_.status}`} role={compile_.status==='error'?'alert':'status'}>
     {compile_.status==='running'?<Spinner/>:compile_.status==='success'?<CircleCheck size={15}/>:<AlertCircle size={15}/>}
     <span className="banner-text">{compile_.message}</span>{compile_.status==='outdated'&&compile_.stale&&<strong className="outdated-label">Last successful PDF is still shown.</strong>}
     {compile_.status==='running'&&<button className="banner-link" onClick={stopCompile}>Stop</button>}
     {compile_.status==='error'&&<>{compile_.stale&&<strong className="outdated-label">PDF is out of date · showing the last successful PDF</strong>}{compile_.entry&&inProject(compile_.entry.file)&&<button className="banner-link" onClick={()=>jumpTo(compile_.entry!.file,compile_.entry!.line)}>Go to error</button>}<button className="banner-link" onClick={openLogs}>View log</button><button className="banner-close" aria-label="Dismiss" onClick={()=>setCompileState({status:compile_.stale?'outdated':'idle',message:compile_.stale?'PDF is out of date':'',stale:compile_.stale})}><X size={14}/></button></>}
    </div>}
    <div className="pdf-workspace">
     {pdfUrl?<PdfViewer url={pdfUrl} data={pdfData} zoom={zoom} nav={nav} syncPoint={syncPoint} searchOpen={pdfSearch} onSearchClose={()=>setPdfSearch(false)} onSourceJump={syncPdfToSource} onLoaded={setPageTotal} onPageChange={setPage} onScale={s=>{scaleRef.current=s}} onRenderTime={setPdfRenderMs}/>
     :<div className="pdf-empty"><div className="paper-placeholder"><FileText size={24}/><span>PDF</span></div><strong>Your document will appear here</strong><p>{apiOnline===false?<>The PaperDesk API isn’t running. Start everything with <code>npm run dev:all</code>.</>:health?.compilerMode==='native'&&health.compilerReady===false?'The server LaTeX compiler is unavailable. Try again in a moment.':health?.compilerMode!=='native'&&health&&!health.docker?<>Docker isn’t running. Start Docker Desktop, then recompile.</>:health?.compilerMode!=='native'&&health&&!health.image?<>The LaTeX compiler image isn’t built yet. Run <code>npm run compiler:build</code> once.</>:'Recompile to render a preview of your PDF.'}</p><button className="btn btn-primary" onClick={()=>void compile()}>{compiling?<Spinner light/>:<Play size={13} fill="currentColor"/>} {compiling?'Compiling…':'Compile document'}</button></div>}
     {pdfUrl&&<div className="pdf-controls" role="toolbar" aria-label="PDF controls">
      <button title="Previous page" aria-label="Previous page" disabled={page<=1} onClick={()=>goToPage(page-1)}><ChevronLeft size={15}/></button>
      <span className="page-label"><strong>{page}</strong> / {pageTotal||'—'}</span>
      <button title="Next page" aria-label="Next page" disabled={!!pageTotal&&page>=pageTotal} onClick={()=>goToPage(page+1)}><ChevronRight size={15}/></button>
      <i/>
      <button title="Search the PDF" aria-label="Search the PDF" aria-pressed={pdfSearch} className={pdfSearch?'on':''} disabled={!pdfUrl} onClick={()=>setPdfSearch(o=>!o)}><Search size={15}/></button>
      <button title="Zoom out" aria-label="Zoom out" onClick={()=>changeZoom(-10)}><ZoomOut size={15}/></button>
      <span className="zoom-label">{zoom==='fit'?'Width':zoom==='page'?'Page':`${zoom}%`}</span>
      <button title="Zoom in" aria-label="Zoom in" onClick={()=>changeZoom(10)}><ZoomIn size={15}/></button>
      <button title="Fit to width" aria-label="Fit to width" className={zoom==='fit'?'on':''} onClick={()=>setZoom('fit')}><Maximize2 size={14}/></button>
      <button title="Fit whole page" aria-label="Fit whole page" className={zoom==='page'?'on':''} onClick={()=>setZoom('page')}><Minimize2 size={14}/></button>
     </div>}
    </div>
   </section>}
   {narrow&&assistantOpen&&<div className="drawer-backdrop" onClick={()=>setNarrowAssistant(false)}/>}
   {assistantOpen&&<AssistantPanel assistant={assistant} status={health?.assistant??null} apiOnline={apiOnline} share={shareContext} setShare={setShareContext} shared={sharedItems} onQuick={quickPrompt} onAsk={askAssistant} onInsert={insertFromAssistant} onReviewFix={reviewFix} onClose={()=>setAssistantOpen(false)}/>}
  </div>
  {!assistantOpen&&!tour&&<div className="help-fab" data-menu-root>
   <button className={`help-fab-btn ${readFlag('paperdesk-help-seen')?'':'pulse'}`} aria-label="Help and assistant" title="Help" aria-haspopup="menu" aria-expanded={openMenu==='help-fab'} onClick={()=>{writeFlag('paperdesk-help-seen','1');setOpenMenu(openMenu==='help-fab'?'':'help-fab')}}>?</button>
   {openMenu==='help-fab'&&<div className="pop-menu help-pop" role="menu"><div className="menu-heading">New to LaTeX?</div>{[{label:'Ask the assistant',icon:<Sparkles size={14}/>,run:()=>setAssistantOpen(true)},{label:'Take the tour',icon:<Compass size={14}/>,run:()=>setTour(true)},{label:'Keyboard shortcuts',icon:<Keyboard size={14}/>,run:()=>setModal('shortcuts')}].map(it=><button role="menuitem" key={it.label} onClick={()=>{setOpenMenu('');it.run()}}><span className="menu-icon">{it.icon}</span><span className="menu-label">{it.label}</span></button>)}</div>}
  </div>}
 </div>}

 {toast&&<div className={`toast ${toast.tone}`} role={toast.tone==='error'?'alert':'status'}>{toast.tone==='error'?<AlertCircle size={16}/>:toast.tone==='success'?<CircleCheck size={16}/>:<Info size={16}/>}<span>{toast.text}</span><button aria-label="Dismiss" onClick={()=>setToast(null)}><X size={14}/></button></div>}

 {modal&&project&&<Modal title={modal==='settings'?'Settings':modal==='cite'?'Add citation':modal==='wordcount'?'Word count':modal==='submission'?'Check before submitting':modal==='shortcuts'?'Keyboard shortcuts':modal==='history'?'Project history':modal==='changes'?'Track changes':modal==='comments'?'Comments':modal==='fix'?'Review suggested fix':modal==='share'?'Share project':'Compile log'} close={()=>setModal('')} wide={modal==='submission'||modal==='logs'||modal==='cite'||modal==='history'||modal==='changes'||modal==='fix'}>
  {modal==='share'?<div className="settings-body">{(!project.role||project.role==='owner')?<ShareAccess projectId={project.id} apiFetch={apiFetch} copy={copyText}/>:<p className="dialog-message">Only the owner can change who has access to this project.</p>}<h4>Read-only copy</h4><p className="dialog-message">Anyone with this link can open a copy of <strong>{project.name}</strong> as it is now, in their own browser. They can’t see later changes or edit your project.</p>{share.state==='ready'&&share.url?<div className="share-link"><input className="text-input" readOnly value={share.url} aria-label="Read-only copy link" onFocus={e=>e.currentTarget.select()}/><button className="btn btn-primary" onClick={()=>copyText(share.url!,'Link copied')}><Copy size={14}/> Copy link</button></div>:share.state==='error'?<div className="inline-alert error"><AlertCircle size={15}/><span>{share.error}</span></div>:null}<div className="modal-foot"><button className="btn btn-secondary" onClick={()=>setModal('')}>Close</button>{share.state!=='ready'&&<button className="btn btn-primary" disabled={share.state==='creating'} onClick={createShareLink}>{share.state==='creating'?<Spinner light/>:<Link2 size={14}/>} Create link</button>}</div></div>:modal==='fix'?(fixReview?<FixReview fix={fixReview} file={project.files.find(f=>f.name===fixReview.file)} onCancel={()=>{setFixReview(null);setModal('')}} onApply={()=>applyAssistantFix(fixReview)}/>:null):
modal==='cite'?<CitationDialog bibFiles={project.files.filter(f=>f.name.endsWith('.bib')&&f.encoding!=='base64')} canCite={!!currentFile&&/\.(tex|sty|cls)$/i.test(currentFile.name)&&project.role!=='viewer'} apiFetch={apiFetch} onAdd={addCitations} close={()=>setModal('')}/>
  :modal==='wordcount'?<WordCountView projectId={project.id} files={project.files} mainFile={project.mainFile??'main.tex'} apiFetch={apiFetch}/>:modal==='submission'?<SubmissionCheck projectId={project.id} projectName={project.name} files={project.files} mainFile={project.mainFile??'main.tex'} engine={engine} compile={result} pdfUrl={pdfUrl} pdfData={pdfData} canEdit={project.role!=='viewer'} compiling={compile_.status==='running'} apiFetch={apiFetch} onJump={jumpTo} onFix={applySubmissionFix} onCompile={()=>void compile()} download={downloadBlob}/>
  :modal==='history'&&health?.storage?.mode==='neon-r2'?<HistoryPanel projectId={project.id} files={project.files} initialFile={fileName} canEdit={project.role!=='viewer'} dark={theme.resolved==='dark'} apiFetch={apiFetch} onRestored={(file,text,modified)=>{syncedFiles.current.get(project.id)?.set(file,{name:file,content:text});if(file===fileName)contentRef.current=text;if(serverModified.current.has(project.id))serverModified.current.set(project.id,modified);update(p=>({...p,files:p.files.some(f=>f.name===file)?p.files.map(f=>f.name===file?{...f,content:text}:f):[...p.files,{name:file,content:text}]}));notify(`Restored ${file}`,'success')}}/>
  :modal==='history'?<div className="logs-body">{(project.versions??[]).length===0?<p className="muted">Snapshots are created as you edit this project.</p>:(project.versions??[]).map(v=><div className="history-version" key={v.id}><div className="history-version-head"><div><strong>{v.label}</strong><span>{new Date(v.created).toLocaleString()}</span></div><button className="btn btn-secondary btn-sm" onClick={()=>setDialog({title:'Restore version?',message:'Current project files will be replaced by this snapshot.',confirmLabel:'Restore',onConfirm:()=>{contentRef.current=v.files.find(f=>f.name===fileName)?.content??'';update(p=>({...p,files:v.files.map(f=>({...f}))}));notify('Version restored','success')}})}>Restore</button></div><SideBySideDiff before={v.files.find(f=>f.name===fileName)?.content??''} after={project.files.find(f=>f.name===fileName)?.content??''}/></div>)}<div className="modal-foot"><button className="btn btn-secondary" onClick={()=>askName('Label current version','Version label','', 'Save version',label=>{update(p=>({...p,versions:[{id:crypto.randomUUID(),label:label||'Version',created:Date.now(),files:p.files.map(f=>({...f}))},...(p.versions??[])].slice(0,30)}))})}>Label current version</button><button className="btn btn-primary" onClick={()=>setModal('')}>Close</button></div></div>:modal==='changes'?<div className="logs-body"><p className="muted">Review edits one at a time or apply a decision to every pending change.</p>{(project.changes??[]).length===0?<p className="muted">No pending tracked changes.</p>:(project.changes??[]).map(c=><div className="tracked-change" key={c.id}><div className="tracked-change-copy"><strong>{c.file}:{c.line}</strong><pre><span className="diff-removed">{c.beforeText||'∅'}</span><span className="diff-added">{c.afterText||'∅'}</span></pre></div><div className="tracked-change-actions"><button className="btn btn-secondary btn-sm" aria-label={`Accept change in ${c.file}`} onClick={()=>update(p=>({...p,changes:p.changes?.filter(x=>x.id!==c.id)}))}>Accept</button><button className="btn btn-secondary btn-sm" aria-label={`Reject change in ${c.file}`} onClick={()=>{const f=project.files.find(x=>x.name===c.file);if(!f){notify('This file no longer exists.','error');return}const restored=rejectEdit(f.content,c);if(restored===null){notify('This change conflicts with newer edits and could not be rejected.','error');return}if(c.file===fileName)contentRef.current=restored;update(p=>({...p,files:p.files.map(x=>x.name===c.file?{...x,content:restored}:x),changes:p.changes?.filter(x=>x.id!==c.id)}))}}>Reject</button></div></div>)}<div className="modal-foot"><button className="btn btn-secondary" disabled={!project.changes?.length} onClick={()=>update(p=>({...p,changes:[]}))}>Accept all</button><button className="btn btn-danger" disabled={!project.changes?.length} onClick={()=>{const files=project.files.map(f=>({...f}));const pending=[...(project.changes??[])].sort((a,b)=>a.file.localeCompare(b.file)||b.start-a.start);const rejected=new Set<string>();for(const c of pending){const i=files.findIndex(f=>f.name===c.file);if(i<0)continue;const target=files[i];if(!target)continue;const restored=rejectEdit(target.content,c);if(restored!==null){files[i]={...target,content:restored};rejected.add(c.id)}}contentRef.current=files.find(f=>f.name===fileName)?.content??contentRef.current;update(p=>({...p,files,changes:p.changes?.filter(c=>!rejected.has(c.id))}));if(rejected.size<pending.length)notify(`${pending.length-rejected.size} change(s) conflicted and remain pending.`,'error')}}>Reject all</button><button className="btn btn-primary" onClick={()=>setModal('')}>Close</button></div></div>:modal==='comments'?<div className="logs-body"><p className="muted">Comments are stored locally with this project.</p>{(project.comments??[]).map(c=><div className="field-row" key={c.id}><div><strong>{c.file}:{c.line}</strong><span>{c.text}</span></div><button className="btn btn-secondary btn-sm" onClick={()=>update(p=>({...p,comments:p.comments?.map(x=>x.id===c.id?{...x,resolved:!x.resolved}:x)}))}>{c.resolved?'Reopen':'Resolve'}</button></div>)}<div className="modal-foot"><button className="btn btn-secondary" onClick={()=>askName('Add comment','Comment', '', 'Add comment',text=>{if(!text.trim())return 'Enter a comment';update(p=>({...p,comments:[...(p.comments??[]),{id:crypto.randomUUID(),file:fileName,line:cursor.line,text:text.trim(),created:Date.now(),resolved:false}]}))})}>Add comment at cursor</button><button className="btn btn-primary" onClick={()=>setModal('')}>Close</button></div></div>:modal==='settings'?<div className="settings-body">
   <section><h4>Appearance</h4><div className="field-row"><div><strong>Theme</strong><span>Auto follows your operating system.</span></div><ThemeSegment pref={theme.pref} setPref={theme.setPref}/></div></section>
   <section><h4>Editor</h4>
    <div className="field-row"><div><strong>Key bindings</strong><span>Vim and Emacs modes apply right away.</span></div><select className="select" aria-label="Key bindings" value={prefs.keymap} onChange={e=>setPref('keymap',e.target.value as Keymap)}>{KEYMAPS.map(k=><option key={k.value} value={k.value}>{k.label}</option>)}</select></div>
    <div className="field-row"><div><strong>Keep original image size</strong><span>Otherwise images over 3000 px are scaled down when added.</span></div><input type="checkbox" aria-label="Keep original image size" checked={prefs.keepImageSize} onChange={e=>setPref('keepImageSize',e.target.checked)}/></div>
    <div className="field-row"><div><strong>Spell check</strong><span>English (US). Skips commands, math, citations and comments.</span></div><input type="checkbox" aria-label="Spell check" checked={prefs.spellcheck} onChange={e=>setPref('spellcheck',e.target.checked)}/></div>
   </section>
   <section><h4>Project</h4>
    <div className="field-row"><div><strong>Name</strong><span>{project.name}</span></div><button className="btn btn-secondary btn-sm" onClick={()=>{setModal('');renameProject(project)}}><Pencil size={13}/> Rename</button></div>
    <div className="field-row"><div><strong>Compiler</strong><span>Used by Recompile.</span></div><select className="select" value={engine} onChange={e=>setEngine(e.target.value)} aria-label="Compiler"><option value="pdflatex">pdfLaTeX</option><option value="xelatex">XeLaTeX</option><option value="lualatex">LuaLaTeX</option></select></div>
    <div className="field-row"><div><strong>Main document</strong><span>Choose the root .tex file to compile.</span></div><select className="select" aria-label="Main document" value={project.mainFile??'main.tex'} onChange={e=>update(p=>({...p,mainFile:e.target.value}))}>{project.files.filter(f=>f.name.endsWith('.tex')&&!f.name.includes('/')).map(f=><option key={f.name}>{f.name}</option>)}</select></div>
    <div className="field-row"><div><strong>Auto compile</strong><span>Compile after you pause editing.</span></div><input type="checkbox" checked={compilePrefs.autoCompile} onChange={e=>setCompilePrefs({...compilePrefs,autoCompile:e.target.checked})}/></div>
    <div className="field-row"><div><strong>Stop on first error</strong><span>Stop at the first TeX error.</span></div><input type="checkbox" checked={compilePrefs.stopOnFirstError} onChange={e=>setCompilePrefs({...compilePrefs,stopOnFirstError:e.target.checked})}/></div>
    <div className="field-row"><div><strong>Track changes</strong><span>Keep a before version for each edit.</span></div><input type="checkbox" checked={!!compilePrefs.trackChanges} onChange={e=>setCompilePrefs({...compilePrefs,trackChanges:e.target.checked})}/></div>
    <div className="field-row"><div><strong>Draft mode</strong><span>Faster preview without final graphics.</span></div><input type="checkbox" checked={compilePrefs.draft} onChange={e=>setCompilePrefs({...compilePrefs,draft:e.target.checked})}/></div>
    <div className="field-row"><div><strong>Compile timeout</strong><span>5 to {maxTimeoutSeconds} seconds for this server.</span></div><input className="select" type="number" min="5" max={maxTimeoutSeconds} value={compilePrefs.timeout} onChange={e=>setCompilePrefs({...compilePrefs,timeout:Math.max(5,Math.min(maxTimeoutSeconds,Number(e.target.value)||5))})}/></div>
    <div className="field-row"><div><strong>Clear cached files</strong><span>Remove the saved PDF and current log.</span></div><button className="btn btn-secondary btn-sm" onClick={async()=>{await apiFetch(`/api/projects/${projectId}/cache`,{method:'DELETE'});setPdfUrl('');setPdfData(null);setResult(null);setCompileState({status:'idle',message:''});notify('Cached files cleared','success')}}>Clear cache</button></div>
    <div className="field-row"><div><strong>Storage</strong><span>Browser local storage; synced to the API when it’s running.</span></div></div>
    <div className="field-row"><div><strong>Sharing</strong><span>Create a read-only copy link. Real-time co-editing needs accounts, which PaperDesk doesn’t have yet.</span></div><button className="btn btn-secondary btn-sm" onClick={()=>{setShare({state:'idle'});setModal('share')}}><Share2 size={13}/> Share</button></div>
   </section>
   <div className="modal-foot"><button className="btn btn-secondary" onClick={downloadProject}><Download size={14}/> Download project</button><button className="btn btn-primary" onClick={()=>setModal('')}>Done</button></div>
  </div>
  :modal==='logs'?<div className="logs-body">
   {logState.loading?<div className="pane-loading inline"><Spinner/> Loading log…</div>:logState.error?<div className="inline-alert error"><AlertCircle size={15}/><span>{logState.error}</span></div>:!result?<p className="muted">No compilation has been run yet. Press Recompile ({mod}↵).</p>:<>
    <div className={`log-summary ${result.success?'ok':'failed'}`}>{result.success?<CircleCheck size={15}/>:<AlertCircle size={15}/>}<span>{result.success?'Compiled successfully':'Compilation failed'} · {result.errors.length} error{result.errors.length===1?'':'s'} · {result.warnings.length} warning{result.warnings.length===1?'':'s'} · {(result.durationMs/1000).toFixed(1)}s</span></div>
    {!rawLogs&&[['error',result.errors],['warning',result.warnings]].map(([kind,list])=>(list as LogEntry[]).length>0&&<ul className="log-entries" key={kind as string} aria-label={`${kind}s`}>{(list as LogEntry[]).map((e,i)=>{const linkable=inProject(e.file);return <li key={i} className="log-item"><button className={`log-entry ${kind}`} disabled={!linkable} onClick={()=>jumpTo(e.file,e.line)} title={linkable?`Go to ${e.file}${e.line?` line ${e.line}`:''}`:undefined}>{kind==='error'?<AlertCircle size={14}/>:<TriangleAlert size={14}/>}<span className="log-msg">{e.message}</span>{e.file&&<span className="log-loc">{e.file.split('/').slice(-2).join('/')}{e.line?`:${e.line}`:''}</span>}</button>{kind==='error'&&<ExplainButton entry={e} onExplain={explainError}/>}</li>})}</ul>)}
    <div className="log-view-toggle"><button className={!rawLogs?'on':''} onClick={()=>setRawLogs(false)}>Grouped</button><button className={rawLogs?'on':''} onClick={()=>setRawLogs(true)}>Raw log</button></div>{rawLogs?<pre className="raw-log">{result.log||'(empty)'}</pre>:<><div className="log-heading">Errors</div>{result.errors.length?null:<p className="muted">No errors.</p>}<div className="log-heading">Warnings</div>{result.warnings.length?null:<p className="muted">No warnings.</p>}<div className="log-heading">Typesetting info</div><p className="muted">Compile time: {(result.durationMs/1000).toFixed(1)}s</p><p className="muted compile-timings">Queue {result.timings?.queue??'—'} ms · file sync {result.timings?.sync??'—'} ms · TeX + engine startup {result.timings?.tex??'—'} ms · PDF/log read {result.timings?.read??'—'} ms · browser PDF page render {pdfRenderMs??'—'} ms</p><pre className="typeset-info">{result.log.split(/\r?\n/).filter(line=>/Overfull|Underfull|LaTeX Font|Package .* Info|Warning/.test(line)).join('\n')||'No additional typesetting information.'}</pre></>}
   </>}
   <div className="modal-foot"><button className="btn btn-secondary" disabled={compiling} onClick={()=>{setModal('');compile()}}><RefreshCw size={14}/> Recompile</button><button className="btn btn-primary" onClick={()=>setModal('')}>Close</button></div>
  </div>
  :<div className="settings-body shortcuts">
   {[[`${mod}S`,'Save current project'],[`${mod}↵`,'Recompile document'],[`${mod}F`,'Find in current file'],[isMac?'⌥⌘F':'Ctrl+H','Find and replace'],[`${mod}Z`,'Undo'],['Esc','Close menus and dialogs']].map(([k,d])=><div className="field-row" key={d}><span>{d}</span><kbd>{k}</kbd></div>)}
   <div className="modal-foot"><button className="btn btn-primary" onClick={()=>setModal('')}>Done</button></div>
  </div>}
 </Modal>}
 {dialog&&<PromptDialog dialog={dialog} close={()=>setDialog(null)}/>}
 {tour&&!dashboard&&<Tour onStep={tourStep} onClose={closeTour}/>}
 </div>
}

function SideBySideDiff({before,after,firstLine=1}:{before:string,after:string,firstLine?:number}){const rows=diffLines(before,after);let beforeNumber=firstLine-1,afterNumber=firstLine-1;const lined=rows.map(r=>({row:r,beforeNumber:r.before===null?null:++beforeNumber,afterNumber:r.after===null?null:++afterNumber}));return <div className="side-by-side-diff"><div className="diff-pane"><div className="diff-pane-title">Previous</div>{lined.map(({row:r,beforeNumber:n},i)=><div className={`diff-row ${r.kind==='removed'?'diff-removed':r.kind==='added'?'diff-empty':''}`} key={`old-${i}`}><span className="diff-line-number">{n??''}</span><code>{r.before??' '}</code></div>)}</div><div className="diff-pane"><div className="diff-pane-title">Current</div>{lined.map(({row:r,afterNumber:n},i)=><div className={`diff-row ${r.kind==='added'?'diff-added':r.kind==='removed'?'diff-empty':''}`} key={`new-${i}`}><span className="diff-line-number">{n??''}</span><code>{r.after??' '}</code></div>)}</div></div>}

/** Shows an assistant fix as a before/after diff with a few lines of context. Nothing is applied until "Apply fix". */
function FixReview({fix,file,onCancel,onApply}:{fix:LineFix,file?:ProjectFile,onCancel:()=>void,onApply:()=>void}){
 const current=file?.content??'',ok=!!file&&fixStillApplies(current,fix);
 const all=current.split(/\r?\n/),from=Math.max(1,fix.start-3),to=Math.min(all.length,fix.end+3);
 const added=fix.replacement.split(/\r?\n/).length-(fix.end-fix.start+1);
 const before=all.slice(from-1,to).join('\n'),after=ok?applyFix(current,fix).split(/\r?\n/).slice(from-1,to+added).join('\n'):before;
 return <div className="logs-body">
  <p className="muted">The assistant suggests changing <strong>{fix.file}</strong>, line{fix.start===fix.end?` ${fix.start}`:`s ${fix.start}–${fix.end}`}. Nothing changes until you click Apply fix, and you can undo it afterwards.</p>
  {!ok&&<div className="inline-alert error"><AlertCircle size={15}/><span>{file?'This part of the file changed after the assistant read it, so the fix can’t be applied. Ask again for an up-to-date fix.':'This file is no longer in the project.'}</span></div>}
  <SideBySideDiff before={before} after={after} firstLine={from}/>
  <div className="modal-foot"><button className="btn btn-secondary" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={!ok} onClick={onApply}><Check size={14}/> Apply fix</button></div>
 </div>;
}

function Brand(){return <div className="brand"><span className="brand-mark"><span/><span/><span/></span><span>paperdesk</span><small>STUDIO</small></div>}
function Spinner({light}:{light?:boolean}){return <span className={`spinner ${light?'light':''}`} aria-hidden/>}

function Dropdown({id,open,setOpen,trigger,items,groups,align='left',heading}:{id:string,open:boolean,setOpen:(v:string)=>void,trigger:ReactNode,items?:MenuItem[],groups?:{label:string,items:MenuItem[]}[],align?:'left'|'right',heading?:string}){
 const render=(list:MenuItem[],prefix:string)=>list.map((it,i)=>it==='sep'?<div className="menu-sep" key={prefix+i}/>:<button role={it.checked!==undefined?'menuitemcheckbox':'menuitem'} aria-checked={it.checked} key={prefix+it.label} disabled={it.disabled} className={it.danger?'danger':''} onClick={()=>{setOpen('');it.run()}}><span className="menu-icon">{it.checked!==undefined?(it.checked?<Check size={14}/>:null):it.icon}</span><span className="menu-label">{it.label}</span>{it.shortcut&&<kbd>{it.shortcut}</kbd>}</button>);
 return <div className="menu-anchor" data-menu-root data-menu-id={id}>{trigger}{open&&<div className={`pop-menu ${align==='right'?'align-right':''}`} role="menu">{heading&&<div className="menu-heading">{heading}</div>}{items&&render(items,'')}{groups?.map(g=><React.Fragment key={g.label}><div className="menu-heading">{g.label}</div>{render(g.items,g.label)}</React.Fragment>)}</div>}</div>;
}

function ThemeMenu({pref,resolved,setPref,open,toggle}:{pref:ThemePref,resolved:'light'|'dark',setPref:(p:ThemePref)=>void,open:boolean,toggle:()=>void}){
 const icon=pref==='auto'?<Monitor size={16}/>:resolved==='dark'?<Moon size={16}/>:<Sun size={16}/>;
 return <div className="menu-anchor" data-menu-root><button className="icon-btn chrome-btn" title={`Theme: ${pref[0].toUpperCase()+pref.slice(1)}`} aria-label="Change theme" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>{icon}</button>
  {open&&<div className="pop-menu align-right theme-pop" role="menu"><div className="menu-heading">Theme</div>{themeOptions.map(o=><button key={o.value} role="menuitemradio" aria-checked={pref===o.value} className={pref===o.value?'current':''} onClick={()=>{setPref(o.value);toggle()}}><span className="menu-icon">{o.icon}</span><span className="menu-label">{o.label}<small>{o.value==='auto'?`${o.hint} (now ${resolved})`:o.hint}</small></span>{pref===o.value&&<Check size={14} className="menu-check"/>}</button>)}</div>}
 </div>;
}

function ThemeSegment({pref,setPref}:{pref:ThemePref,setPref:(p:ThemePref)=>void}){
 return <div className="segmented labeled" role="radiogroup" aria-label="Theme">{themeOptions.map(o=><button key={o.value} role="radio" aria-checked={pref===o.value} className={pref===o.value?'on':''} onClick={()=>setPref(o.value)}>{o.icon}<span>{o.label}</span></button>)}</div>;
}

function Modal({title,close,children,wide}:{title:string,close:()=>void,children:ReactNode,wide?:boolean}){
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className={`modal ${wide?'wide':''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><h3>{title}</h3><button className="icon-btn" aria-label="Close" onClick={close}><X size={17}/></button></div>{children}</div></div>;
}

function PromptDialog({dialog,close}:{dialog:Dialog,close:()=>void}){
 const [value,setValue]=useState(dialog.initial??''),[error,setError]=useState('');
 const inputRef=useRef<HTMLInputElement>(null);
 useEffect(()=>{const el=inputRef.current;if(el){el.focus();const dot=el.value.lastIndexOf('.');el.setSelectionRange(0,dot>0?dot:el.value.length)}},[]);
 const submit=()=>{const err=dialog.onConfirm(value);if(err){setError(err);return}close()};
 return <Modal title={dialog.title} close={close}>
  {dialog.message&&<p className="dialog-message">{dialog.message}</p>}
  {dialog.label!==undefined&&<><label className="field-label" htmlFor="dialog-input">{dialog.label}</label><input id="dialog-input" ref={inputRef} className={`text-input ${error?'invalid':''}`} value={value} placeholder={dialog.placeholder} aria-invalid={!!error} aria-describedby={error?'dialog-error':undefined} onChange={e=>{setValue(e.target.value);setError('')}} onKeyDown={e=>{if(e.key==='Enter')submit()}}/>{error&&<p className="field-error" id="dialog-error"><AlertCircle size={13}/>{error}</p>}</>}
  <div className="modal-foot"><button className="btn btn-secondary" onClick={close}>Cancel</button><button className={`btn ${dialog.danger?'btn-danger':'btn-primary'}`} onClick={submit} autoFocus={dialog.label===undefined}>{dialog.confirmLabel}</button></div>
 </Modal>;
}

function Resizer({label,value,min,max,onChange,fromClientX,onReset,invert}:{label:string,value:number,min:number,max:number,onChange:(v:number)=>void,fromClientX:(x:number)=>number,onReset:()=>void,invert?:boolean}){
 const clamp=(v:number)=>Math.min(max,Math.max(min,v));
 const start=(e:React.PointerEvent)=>{e.preventDefault();const el=e.currentTarget as HTMLElement;el.setPointerCapture(e.pointerId);document.body.classList.add('is-resizing');
  const move=(ev:PointerEvent)=>onChange(clamp(fromClientX(ev.clientX)));
  const up=()=>{document.body.classList.remove('is-resizing');el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up)};
  el.addEventListener('pointermove',move);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up)};
 const step=max>100?16:2;
 return <div className="resizer" role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max} tabIndex={0} title="Drag to resize · double-click to reset" onPointerDown={start} onDoubleClick={onReset} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();const dir=(e.key==='ArrowRight'?1:-1)*(invert?-1:1);onChange(clamp(value+dir*step))}}}/>;
}


type TreeActions={mainFile:string,dropTarget:string|null,dropProps:(folder:string)=>Record<string,unknown>,onToggle:(p:string)=>void,onOpen:(f:ProjectFile)=>void,onRename:(f:ProjectFile)=>void,onDelete:(f:ProjectFile)=>void,onUpload:(folder:string)=>void,onSetMain:(f:ProjectFile)=>void};
function TreeLevel({nodes,depth,selected,collapsed,act}:{nodes:TreeNode[],depth:number,selected:string,collapsed:Set<string>,act:TreeActions}){
 return <>{nodes.map(n=>{const open=!collapsed.has(n.path);const folder=n.folder?`${n.path.replace(/\/+$/,'')}/`:'';const isMain=!n.folder&&n.path===act.mainFile;const canBeMain=!n.folder&&n.path.endsWith('.tex')&&!n.path.includes('/')&&!isMain;return <div key={n.path} role="treeitem" aria-expanded={n.folder?open:undefined} aria-selected={selected===n.path} {...(n.folder?act.dropProps(folder):{})}>
  <div className={`file-row ${selected===n.path?'selected':''} ${n.folder&&act.dropTarget===folder?'drop-target':''}`} style={{paddingLeft:8+depth*14}} tabIndex={0} onClick={()=>n.folder?act.onToggle(n.path):act.onOpen(n.file)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();if(n.folder)act.onToggle(n.path);else act.onOpen(n.file)}}}>
   <span className="tree-caret">{n.folder?(open?<ChevronDown size={13}/>:<ChevronRight size={13}/>):null}</span>
   {n.folder?(open?<FolderOpen size={15}/>:<Folder size={15}/>):fileIcon(n.file)}
   <span className="file-label">{n.name}</span>
   {isMain&&<span className="main-badge" title="Main document: this file is compiled">main</span>}
   <span className="file-actions">
    {n.folder&&<button title={`Upload into ${n.name}`} aria-label={`Upload into ${n.name}`} onClick={e=>{e.stopPropagation();act.onUpload(folder)}}><Upload size={12}/></button>}
    {canBeMain&&<button title="Set as main document" aria-label={`Set ${n.name} as main document`} onClick={e=>{e.stopPropagation();act.onSetMain(n.file)}}><Star size={12}/></button>}
    <button title="Rename" aria-label={`Rename ${n.name}`} onClick={e=>{e.stopPropagation();act.onRename(n.file)}}><Pencil size={12}/></button><button className="danger" title="Delete" aria-label={`Delete ${n.name}`} onClick={e=>{e.stopPropagation();act.onDelete(n.file)}}><Trash2 size={12}/></button>
   </span>
  </div>
  {n.folder&&open&&(n.children.length?<TreeLevel nodes={n.children} depth={depth+1} selected={selected} collapsed={collapsed} act={act}/>:<div className="file-row empty-folder" style={{paddingLeft:30+depth*14}}>Empty folder · drop files here</div>)}
 </div>})}</>;
}

/** File outline: the open file's sectioning commands; click one to jump to it. */
function Outline({content,cursorLine,onJump}:{content:string,cursorLine:number,onJump:(line:number)=>void}){
 const items=useMemo(()=>outlineOf(content),[content]);
 const [open,setOpen]=useState(true);
 const current=[...items].reverse().find(i=>i.line<=cursorLine)?.line;
 return <div className="outline" aria-label="File outline">
  <button className="outline-head" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?<ChevronDown size={13}/>:<ChevronRight size={13}/>}<span className="pane-title">File outline</span></button>
  {open&&(items.length?<ul>{items.map(i=><li key={i.line}><button className={i.line===current?'current':''} style={{paddingLeft:10+i.level*12}} title={`Line ${i.line}`} onClick={()=>onJump(i.line)}>{i.title}</button></li>)}</ul>:<p className="outline-empty">Sections you add with {"\\section"} appear here.</p>)}
 </div>;
}

function fileIcon(f:ProjectFile){return f.name.endsWith('.tex')?<FileCode2 size={15} className="fi fi-tex"/>:f.name.endsWith('.bib')?<BookOpen size={15} className="fi fi-bib"/>:f.name.endsWith('/')?<FolderOpen size={15}/>:isBinary(f.name)?<ImageIcon size={15} className="fi fi-img"/>:<File size={15} className="fi"/>}
function formatBytes(n:number){return n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`}
function downloadBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000)}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
