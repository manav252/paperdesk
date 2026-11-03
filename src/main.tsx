import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import Editor, { type OnMount } from '@monaco-editor/react';
import { FileText, FolderOpen, Folder, Search, Plus, MoreHorizontal, ChevronDown, ChevronRight, ChevronLeft, Settings, HelpCircle, CloudOff, TriangleAlert, Bell, Upload, FolderPlus, FilePlus2, Image as ImageIcon, FileCode2, File, BookOpen, Play, Download, Share2, Undo2, Redo2, Bold, Italic, Underline, List, ListOrdered, Table2, Sigma, Quote, Link2, Columns2, Maximize2, ZoomIn, ZoomOut, RefreshCw, CircleCheck, Cloud, X, Copy, Trash2, Pencil, Check, AlertCircle, FileArchive, Menu, Keyboard, Sun, Moon, Monitor, Home, ScrollText, Info, PanelLeft, Code2, Sparkles, Compass, } from 'lucide-react';
import { useTheme, type ThemePref } from './theme';
import { setupMonaco } from './monacoSetup';
import { arrayBufferToBase64, buildTree, defaultFile, isBinary, isEditable, isImage, mergeProjects, mimeType, normalizeProject, relative, tabFiles, type Project, type ProjectFile, type TreeNode } from './lib/project';
import type { LogEntry } from './lib/latexLog';
import { diffLines } from './lib/diff';
import { recordEdit, rejectEdit } from './lib/changes';
import { templateStarters } from './lib/templates';
import { applyFix, clipSelection, fixStillApplies, logContext, numberedFile, type LineFix } from './lib/assistant';
import { AssistantPanel, ExplainButton, QUICK_PROMPTS, useAssistant, type AssistantStatus } from './Assistant';
import { Tour, TOUR_KEY, type TourStep } from './Tour';
import { apiUrl, fetchWithWake, ownerHeaders, projectOwnerId } from './lib/api';
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
const initial=()=>{try{const s=localStorage.getItem('paperdesk-projects');return s?(JSON.parse(s) as Project[]).map(p=>normalizeProject(p,'storage')):seed}catch{return seed}};

type Layout='split'|'editor'|'pdf';
type LayoutPrefs={layout:Layout,sidebar:boolean,sidebarWidth:number,previewPct:number,assistant:boolean};
const LAYOUT_KEY='paperdesk-layout';
const NARROW='(max-width: 860px)';
const readLayout=():LayoutPrefs=>{const base:LayoutPrefs={layout:'split',sidebar:true,sidebarWidth:232,previewPct:46,assistant:false};try{return{...base,...JSON.parse(localStorage.getItem(LAYOUT_KEY)??'{}')}}catch{return base}};

type Tone='info'|'success'|'error';
type Toast={text:string,tone:Tone};
type CompileState={status:'idle'|'running'|'success'|'error',message:string,entry?:LogEntry};
type CompileResult={success:boolean|null,log:string,errors:LogEntry[],warnings:LogEntry[],durationMs:number};
type CompilePrefs={autoCompile:boolean;stopOnFirstError:boolean;draft:boolean;timeout:number;trackChanges:boolean};
type Health={docker:boolean,image:boolean,compilerImage:string,compilerReady?:boolean,maxCompileTimeoutMs?:number,assistant?:AssistantStatus};
const SHARE_KEY='paperdesk-assistant-context';
const readFlag=(key:string)=>{try{return localStorage.getItem(key)}catch{return null}};
const writeFlag=(key:string,value:string)=>{try{localStorage.setItem(key,value)}catch{/* storage unavailable: lasts for this visit */}};
type Dialog={title:string,message?:ReactNode,label?:string,initial?:string,placeholder?:string,confirmLabel:string,danger?:boolean,onConfirm:(value:string)=>string|void};
type MenuItem={label:string,run:()=>void,shortcut?:string,icon?:ReactNode,checked?:boolean,danger?:boolean,disabled?:boolean}|'sep';
type Zoom=number|'fit';

const themeOptions:{value:ThemePref,label:string,hint:string,icon:ReactNode}[]=[
 {value:'light',label:'Light',hint:'Always light',icon:<Sun size={15}/>},
 {value:'dark',label:'Dark',hint:'Always dark',icon:<Moon size={15}/>},
 {value:'auto',label:'Auto',hint:'Match system setting',icon:<Monitor size={15}/>},
];
const isMac=typeof navigator!=='undefined'&&/Mac|iP(hone|ad)/.test(navigator.platform);
const mod=isMac?'⌘':'Ctrl+';
const NETWORK_HELP='The PaperDesk API isn’t reachable. Start everything with “npm run dev:all”.';
const json={'Content-Type':'application/json'};
const apiFetch=(input:RequestInfo|URL,init?:RequestInit)=>fetch(typeof input==='string'&&input.startsWith('/api/')?apiUrl(input):input,{...init,headers:{...ownerHeaders(),...(init?.headers??{})}});

// Monaco is bundled (monacoLocal.ts) but split into its own chunk; start loading it straight away.
const monacoLoad=import('./monacoLocal');
function useMonacoLoad(){const [state,setState]=useState<'loading'|'ready'|'failed'>('loading');useEffect(()=>{let live=true;monacoLoad.then(()=>{if(live)setState('ready')},()=>{if(live)setState('failed')});return()=>{live=false}},[]);return state}

function useMediaQuery(q:string){const [m,setM]=useState(()=>window.matchMedia(q).matches);useEffect(()=>{const mq=window.matchMedia(q);const on=()=>setM(mq.matches);mq.addEventListener('change',on);return()=>mq.removeEventListener('change',on)},[q]);return m}

function App(){
 const theme=useTheme();
 const [projects,setProjects]=useState<Project[]>(initial),[projectId,setProjectId]=useState('p1'),[fileName,setFileName]=useState('main.tex'),[activeTab,setActiveTab]=useState('editor'),[compile_,setCompileState]=useState<CompileState>({status:'idle',message:''}),[pdfUrl,setPdfUrl]=useState(''),[page,setPage]=useState(1),[pageTotal,setPageTotal]=useState(0),[zoom,setZoom]=useState<Zoom>('fit'),[saveState,setSaveState]=useState('Saved'),[query,setQuery]=useState(''),[sortBy,setSortBy]=useState<'modified'|'name'>('modified'),[openMenu,setOpenMenu]=useState(''),[modal,setModal]=useState(''),[dialog,setDialog]=useState<Dialog|null>(null),[toast,setToast]=useState<Toast|null>(null),[engine,setEngine]=useState('pdflatex'),[compilePrefs,setCompilePrefs]=useState<CompilePrefs>(()=>{try{return{autoCompile:false,stopOnFirstError:true,draft:false,timeout:120,trackChanges:false,...JSON.parse(localStorage.getItem('paperdesk-compile-prefs')??'{}')}}catch{return{autoCompile:false,stopOnFirstError:true,draft:false,timeout:120,trackChanges:false}}}),[rawLogs,setRawLogs]=useState(false),[cursor,setCursor]=useState({line:1,col:1}),[result,setResult]=useState<CompileResult|null>(null),[logState,setLogState]=useState<{loading:boolean,error?:string}>({loading:false}),[apiOnline,setApiOnline]=useState<boolean|null>(null),[health,setHealth]=useState<Health|null>(null),[editorReady,setEditorReady]=useState(false),[collapsed,setCollapsed]=useState<Set<string>>(new Set()),[prefs,setPrefs]=useState<LayoutPrefs>(readLayout),[drawer,setDrawer]=useState(false),[selectionChars,setSelectionChars]=useState(0),[shareContext,setShareContext]=useState(()=>readFlag(SHARE_KEY)!=='off'),[fixReview,setFixReview]=useState<LineFix|null>(null),[tour,setTour]=useState(false),[narrowAssistant,setNarrowAssistant]=useState(false);
 const [syncPoint,setSyncPoint]=useState<{page:number,x:number,y:number}|null>(null);
 const editorRef=useRef<any>(null),fileInput=useRef<HTMLInputElement>(null),zipInput=useRef<HTMLInputElement>(null),saveTimer=useRef<number>(),workRef=useRef<HTMLDivElement>(null),searchRef=useRef<HTMLInputElement>(null),compileRef=useRef<()=>void>(()=>{}),scaleRef=useRef(100),monacoRef=useRef<any>(null),pendingJump=useRef<{file:string,line:number}|null>(null),lastEdit=useRef({file:'',content:''}),storageWarned=useRef(false);
 const monacoState=useMonacoLoad();
 const narrow=useMediaQuery(NARROW),compact=useMediaQuery('(max-width: 640px)');
 const assistant=useAssistant(()=>setHealth(h=>h?{...h,assistant:{model:h.assistant?.model??'',configured:false}}:h));
 const project=projects.find(p=>p.id===projectId)??projects[0]; const currentFile=project?.files.find(f=>f.name===fileName)??project?.files[0]; const content=currentFile?.content??'';
 const contentRef=useRef(content);
 useEffect(()=>{contentRef.current=content},[projectId,fileName]);
 const update=(fn:(p:Project)=>Project)=>setProjects(prev=>prev.map(p=>p.id===projectId?fn(p):p));
 const notify=(text:string,tone:Tone='info')=>setToast({text,tone});
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

 useEffect(()=>{try{localStorage.setItem('paperdesk-projects',JSON.stringify(projects))}catch{if(!storageWarned.current){storageWarned.current=true;notify(apiOnline?'Browser storage is full. Your work is saved on the server, but not offline in this browser.':'Browser storage is full and the API is offline: recent changes may not be saved. Start the API with “npm run dev:all”.','error')}}},[projects]);
 useEffect(()=>{try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(prefs))}catch{/* storage unavailable: layout lasts for this visit */}},[prefs]);
 useEffect(()=>{try{localStorage.setItem('paperdesk-compile-prefs',JSON.stringify(compilePrefs))}catch{/* settings last for this visit */}},[compilePrefs]);
 useEffect(()=>{const maximum=Math.max(5,Math.floor((health?.maxCompileTimeoutMs??600_000)/1000));if(compilePrefs.timeout>maximum)setCompilePrefs(p=>({...p,timeout:maximum}))},[health?.maxCompileTimeoutMs]);
 useEffect(()=>{if(!narrow){setDrawer(false);setNarrowAssistant(false)}},[narrow]);
 useEffect(()=>writeFlag(SHARE_KEY,shareContext?'on':'off'),[shareContext]);
 useEffect(()=>{const sync=async()=>{try{const r=await apiFetch('/api/projects');if(!r.ok)throw new Error();const remote=await r.json();if(!Array.isArray(remote))throw new Error();setApiOnline(true);const {merged,upload}=mergeProjects(projects,remote.map((p:Project)=>normalizeProject(p,'server')));setProjects(merged);if(!merged.some(p=>p.id===projectId)&&merged[0])setProjectId(merged[0].id);for(const p of upload)await apiFetch(`/api/projects/${p.id}`,{method:'PUT',headers:json,body:JSON.stringify({name:p.name,files:p.files,mainFile:p.mainFile,archived:p.archived,settings:p.settings,versions:p.versions,comments:p.comments,changes:p.changes})})}catch{setApiOnline(false)}};sync();fetch(apiUrl('/api/health')).then(r=>r.ok?r.json():null).then(h=>setHealth(h)).catch(()=>setHealth(null))},[]);
 useEffect(()=>{if(!projectId||!project)return;const t=window.setTimeout(async()=>{try{const r=await apiFetch(`/api/projects/${projectId}`,{method:'PUT',headers:json,body:JSON.stringify({name:project.name,files:project.files,mainFile:project.mainFile,archived:project.archived,settings:project.settings,versions:project.versions,comments:project.comments,changes:project.changes})});setApiOnline(r.ok)}catch{setApiOnline(false)}},700);return()=>window.clearTimeout(t)},[projectId,project?.name,project?.files,project?.mainFile,project?.archived,project?.settings,project?.versions,project?.comments,project?.changes]);
 useEffect(()=>{if(project&&!project.files.some(f=>f.name===fileName))setFileName(defaultFile(project.files))},[projectId,project?.files.length]);
 // Only real edits count as changes; opening or switching files must not bump “Last modified”.
 useEffect(()=>{const name=currentFile?.name??'';const prev=lastEdit.current;lastEdit.current={file:name,content};if(prev.file!==name)return;window.clearTimeout(saveTimer.current);setSaveState('Saving…');saveTimer.current=window.setTimeout(()=>{setSaveState('Saved');update(p=>({...p,modified:Date.now()}))},650);return()=>window.clearTimeout(saveTimer.current)},[content,currentFile?.name]);
 useEffect(()=>{if(toast){const t=window.setTimeout(()=>setToast(null),toast.tone==='error'?6000:2800);return()=>window.clearTimeout(t)}},[toast]);
 useEffect(()=>{if(compile_.status==='success'){const t=window.setTimeout(()=>setCompileState(s=>s.status==='success'?{status:'idle',message:''}:s),4000);return()=>window.clearTimeout(t)}},[compile_]);
 useEffect(()=>{if(pageTotal&&page>pageTotal)setPage(pageTotal)},[pageTotal]);
 useEffect(()=>{if(!compilePrefs.autoCompile||dashboard||!project)return;const t=window.setTimeout(()=>compileRef.current(),1800);return()=>window.clearTimeout(t)},[compilePrefs.autoCompile,project?.files,project?.mainFile,engine]);

 // Close menus on outside click; Escape closes the topmost layer.
 useEffect(()=>{
  const down=(e:MouseEvent)=>{if(!(e.target as HTMLElement).closest('[data-menu-root]'))setOpenMenu('')};
  const key=(e:KeyboardEvent)=>{
   if(e.key==='Escape'){if(openMenu)setOpenMenu('');else if(dialog)setDialog(null);else if(modal)setModal('');else if(narrow&&drawer)setDrawer(false);else if(narrow&&narrowAssistant)setNarrowAssistant(false)}
   const cmd=e.metaKey||e.ctrlKey;
   if(cmd&&e.key==='Enter'&&activeTab==='editor'){e.preventDefault();compileRef.current()}
   if(cmd&&e.key.toLowerCase()==='s'){e.preventDefault();setSaveState('Saved');notify('All changes saved','success')}
   if(cmd&&e.key.toLowerCase()==='k'&&activeTab!=='editor'){e.preventDefault();searchRef.current?.focus()}
  };
  document.addEventListener('mousedown',down);document.addEventListener('keydown',key);
  return()=>{document.removeEventListener('mousedown',down);document.removeEventListener('keydown',key)};
 },[openMenu,dialog,modal,activeTab,narrow,drawer,narrowAssistant]);

 const setContent=(value:string)=>{const previous=contentRef.current;contentRef.current=value;update(p=>{const now=Date.now(),latest=p.versions?.[0],recent=latest!==undefined&&latest.label==='Automatic snapshot'&&now-latest.created<1200;return{...p,versions:(recent?(p.versions??[]):[{id:crypto.randomUUID(),label:'Automatic snapshot',created:now,files:p.files.map(f=>({...f}))},...(p.versions??[])]).slice(0,30),changes:compilePrefs.trackChanges?recordEdit(previous,value,fileName,p.changes??[]):p.changes??[],files:p.files.map(f=>f.name===fileName?{...f,content:value}:f)}})};
 const insert=(s:string)=>{const ed=editorRef.current;if(!ed){notify('Open a text file in the editor to insert LaTeX');return}ed.executeEdits('toolbar',[{range:ed.getSelection(),text:s,forceMoveMarkers:true}]);ed.focus()};
 const edAction=(id:string)=>{const ed=editorRef.current;if(!ed)return;ed.focus();const action=ed.getAction(id);if(action)action.run();else ed.trigger('keyboard',id,null)};

 const compile=async()=>{
  if(compiling||!project)return;
  const mainFile=project.mainFile??'main.tex';if(!project.files.some(f=>f.name===mainFile)){setCompileState({status:'error',message:`Main document ${mainFile} not found. Choose an existing .tex file in Project settings.`});return}
  if(narrow&&layout==='editor')setPref('layout','pdf');
  setCompileState({status:'running',message:'Compiling…'});
  try{
   const r=await fetchWithWake(apiUrl(`/api/projects/${projectId}/compile`),{method:'POST',headers:{...json,...ownerHeaders()},body:JSON.stringify({files:project.files,engine,mainFile:project.mainFile??'main.tex',timeoutMs:compilePrefs.timeout*1000,draft:compilePrefs.draft,stopOnFirstError:compilePrefs.stopOnFirstError})},()=>setCompileState({status:'running',message:'Waking up the compile server…'}));
   let data:any=null;try{data=await r.json()}catch{/* non-JSON body: the API is unreachable */}
   if(!data)throw new Error(NETWORK_HELP);
   setApiOnline(true);
   if(!r.ok){setCompileState({status:'error',message:String(data.error??'Compilation failed')});if(r.status===503)fetch(apiUrl('/api/health')).then(h=>h.json()).then(setHealth).catch(()=>undefined);return}
   const res=data as CompileResult;setResult(res);
   if(res.success){
    setPdfUrl(`${apiUrl(`/api/projects/${projectId}/pdf?t=${Date.now()}`)}&owner=${encodeURIComponent(projectOwnerId())}`);
    const w=res.warnings.length;
    setCompileState({status:'success',message:`Compiled in ${(res.durationMs/1000).toFixed(1)}s${w?` · ${w} warning${w>1?'s':''}`:''}`});
   }else{
    const e=res.errors[0];
    setCompileState({status:'error',message:e?`${e.file?`${e.file}${e.line?`:${e.line}`:''} — `:''}${e.message}`:'Compilation failed',entry:e});
   }
  }catch(e){
   const message=e instanceof TypeError?NETWORK_HELP:e instanceof Error?e.message:'Compilation failed';
   setApiOnline(false);setCompileState({status:'error',message});
  }
 };
 compileRef.current=compile;

 const askName=(title:string,label:string,initialValue:string,confirmLabel:string,onConfirm:(v:string)=>string|void,placeholder?:string)=>setDialog({title,label,initial:initialValue,confirmLabel,onConfirm,placeholder});
 const newProject=(name='Untitled Project')=>{const p={id:crypto.randomUUID(),name,modified:Date.now(),files:[{name:'main.tex',content:starter}]};setProjects(x=>[p,...x]);setProjectId(p.id);setFileName('main.tex');setPdfUrl('');setResult(null);setCompileState({status:'idle',message:''});setActiveTab('editor')};
 const promptNewProject=()=>askName('Create a new project','Project name','','Create project',v=>{if(!v.trim())return 'Enter a project name';newProject(v.trim())},'e.g. My research paper');
 const renameProject=(p:Project)=>{setOpenMenu('');askName('Rename project','Project name',p.name,'Save changes',v=>{if(!v.trim())return 'Enter a project name';setProjects(x=>x.map(q=>q.id===p.id?{...q,name:v.trim()}:q))})};
 const deleteProject=(p:Project)=>{setOpenMenu('');setDialog({title:'Delete project?',message:<>“{p.name}” and its {p.files.length} files will be deleted{p.id===projectId?' and you’ll return to your projects':''}. This can’t be undone.</>,confirmLabel:'Delete project',danger:true,onConfirm:()=>{const next=projects.filter(x=>x.id!==p.id);setProjects(next);apiFetch(`/api/projects/${p.id}`,{method:'DELETE'}).catch(()=>undefined);if(p.id===projectId){setProjectId(next[0]?.id??'');setActiveTab('dashboard')}notify('Project deleted')}})};
 const duplicate=(p:Project)=>{const cp={...p,id:crypto.randomUUID(),name:p.name+' copy',modified:Date.now(),files:p.files.map(f=>({...f}))};setProjects(x=>[cp,...x]);notify('Project duplicated','success');setOpenMenu('')};
 const openProject=(p:Project)=>{if(p.id!==projectId){setPdfUrl('');setResult(null);setCompileState({status:'idle',message:''})}setProjectId(p.id);setFileName(defaultFile(p.files));setActiveTab('editor')};

 const validName=(name:string,current?:string)=>{if(!name)return 'Enter a name';if(/(^|\/)\.\.(\/|$)/.test(name)||name.startsWith('/'))return 'Names can’t start with “/” or contain “..”';if(name!==current&&project.files.some(f=>f.name===name||f.name===name+'/'))return 'A file or folder with that name already exists'};
 const addFile=(folder=false)=>askName(folder?'New folder':'New file',folder?'Folder name':'File name (use “folder/name.tex” to place it in a folder)',folder?'figures':'notes.tex',folder?'Create folder':'Create file',input=>{const name=folder?input.trim().replace(/\/+$/,'')+'/':input.trim();const err=validName(name.replace(/\/$/,''))??validName(name);if(err)return err;update(p=>({...p,files:[...p.files,{name,content:folder?'':`% ${name}\n`}]}));if(!folder)setFileName(name);else setCollapsed(c=>{const n=new Set(c);n.delete(name);return n})});
 const renameFile=(f:ProjectFile)=>{const isFolder=f.name.endsWith('/');const shown=f.name.replace(/\/$/,'');askName(isFolder?'Rename folder':'Rename file','New name',shown,'Rename',input=>{const next=input.trim().replace(/\/+$/,'');if(next===shown)return;const err=validName(next,shown);if(err)return err;if(isFolder){const from=f.name,to=next+'/';update(p=>({...p,files:p.files.map(x=>x.name.startsWith(from)?{...x,name:to+x.name.slice(from.length)}:x)}));if(fileName.startsWith(from))setFileName(to+fileName.slice(from.length))}else{update(p=>({...p,files:p.files.map(x=>x.name===f.name?{...x,name:next}:x)}));if(fileName===f.name)setFileName(next)}})};
 const deleteFile=(f:ProjectFile)=>{const isFolder=f.name.endsWith('/');const affected=isFolder?project.files.filter(x=>x.name.startsWith(f.name)):[f];const remaining=project.files.filter(x=>!affected.includes(x));if(!remaining.some(x=>!x.name.endsWith('/'))){notify('A project must contain at least one file','error');return}setDialog({title:isFolder?'Delete folder?':'Delete file?',message:isFolder?<>“{f.name}” and the {affected.length-1} file(s) inside it will be deleted.</>:<>“{f.name}” will be deleted from this project.</>,confirmLabel:'Delete',danger:true,onConfirm:()=>{update(p=>({...p,files:p.files.filter(x=>!affected.some(a=>a.name===x.name))}));if(affected.some(a=>a.name===fileName))setFileName(remaining.find(x=>!x.name.endsWith('/'))?.name??'main.tex')}})};
 const uploadFiles=async(list:FileList|null)=>{
  if(!list)return;
  for(const f of Array.from(list)){
   if(f.name.toLowerCase().endsWith('.zip')){
    try{const current=projects.find(p=>p.id===projectId);if(!current)throw new Error('The project is no longer open.');const saved=await apiFetch(`/api/projects/${projectId}`,{method:'PUT',headers:json,body:JSON.stringify({name:current.name,files:current.files,mainFile:current.mainFile,archived:current.archived,settings:current.settings,versions:current.versions,comments:current.comments,changes:current.changes})});if(!saved.ok)throw new Error('Couldn’t save the project before importing the ZIP.');const form=new FormData();form.append('file',f);const res=await apiFetch(`/api/projects/${projectId}/upload`,{method:'POST',body:form});const d=await res.json().catch(()=>null);if(!res.ok)throw new Error(d?.error??NETWORK_HELP);update(p=>({...p,files:normalizeProject(d,'server').files}));notify(`Imported ${f.name}`,'success')}
    catch(e){notify(e instanceof Error&&!(e instanceof TypeError)?e.message:`ZIP import needs the API. ${NETWORK_HELP}`,'error')}
    continue;
   }
   if(f.size>20*1024*1024){notify(`${f.name} is larger than 20 MB and wasn’t uploaded.`,'error');continue}
   // Figures and other binary files are stored as base64; reading them as text would corrupt them.
   const file:ProjectFile=isBinary(f.name)?{name:f.name,content:arrayBufferToBase64(await f.arrayBuffer()),encoding:'base64'}:{name:f.name,content:await f.text()};
   update(p=>({...p,files:[...p.files.filter(x=>x.name!==f.name),file]}));setFileName(f.name);notify(`Uploaded ${f.name}`,'success');
  }
  if(fileInput.current)fileInput.current.value='';
 };
 const downloadProject=async()=>{try{const res=await apiFetch(`/api/projects/${projectId}/download`);if(!res.ok)throw 0;const blob=await res.blob();downloadBlob(blob,`${project.name}.zip`)}catch{const data=new Blob([JSON.stringify(project,null,2)],{type:'application/json'});downloadBlob(data,`${project.name.replaceAll(' ','-')}-project.json`);notify('Project downloaded as JSON (start the backend for ZIP export)')}};
 const downloadPdf=async()=>{if(!pdfUrl){notify('Compile the project to create a PDF');return}try{const response=await fetch(pdfUrl);if(!response.ok)throw new Error();downloadBlob(await response.blob(),`${project.name}.pdf`)}catch{notify('Could not download the compiled PDF.','error')}};
 const openLogs=async()=>{setModal('logs');if(result)return;setLogState({loading:true});try{const r=await apiFetch(`/api/projects/${projectId}/logs`);if(!r.ok)throw new Error();const d=await r.json();if(d.success!==null)setResult(d);setLogState({loading:false})}catch{setLogState({loading:false,error:NETWORK_HELP})}};
 const inProject=(file:string|null)=>!!file&&!!project?.files.some(f=>f.name===file);
 /** Opens a file at a line, switching file and layout as needed. Applied once the editor shows that file. */
 const jumpTo=(file:string|null,line:number|null)=>{
  if(!file||!inProject(file)){notify(file?`${file} isn’t part of this project (it comes from TeX Live).`:'This message has no source location.');return}
  setModal('');pendingJump.current={file,line:line??1};
  if(layout==='pdf')setPref('layout',narrow?'editor':'split');
  if(file!==currentFile?.name)setFileName(file);else applyJump();
 };
 const applyJump=()=>{const j=pendingJump.current,ed=editorRef.current;if(!j||!ed||j.file!==currentFile?.name)return;pendingJump.current=null;const ln=Math.min(j.line,ed.getModel()?.getLineCount()??j.line);ed.revealLineInCenter(ln);ed.setPosition({lineNumber:ln,column:1});ed.focus()};
 const syncSourceToPdf=async()=>{
  if(!currentFile||!isEditable(currentFile)){notify('Open a text file before syncing to the PDF.');return}
  const position=editorRef.current?.getPosition();
  try{
   const response=await apiFetch(`/api/projects/${projectId}/synctex`,{method:'POST',headers:json,body:JSON.stringify({mode:'forward',file:currentFile.name,line:position?.lineNumber??cursor.line,column:position?.column??cursor.col,mainFile:project.mainFile??'main.tex'})});
   const data=await response.json();if(!response.ok)throw new Error(data.error??'SyncTeX lookup failed.');
   if(!data.found){notify('No PDF position is available here. Recompile and try a line with printed text.');return}
   setSyncPoint({page:data.page,x:data.x,y:data.y});setPage(data.page);if(narrow)setPref('layout','pdf');
  }catch(e){notify(e instanceof Error?e.message:'SyncTeX lookup failed.','error')}
 };
 const syncPdfToSource=async(syncPage:number,x:number,y:number)=>{
  try{
   const response=await apiFetch(`/api/projects/${projectId}/synctex`,{method:'POST',headers:json,body:JSON.stringify({mode:'inverse',page:syncPage,x,y,mainFile:project.mainFile??'main.tex'})});
   const data=await response.json();if(!response.ok)throw new Error(data.error??'SyncTeX lookup failed.');
   if(!data.found){notify('No source position is available here.');return}
   jumpTo(data.file,data.line);
  }catch(e){notify(e instanceof Error?e.message:'SyncTeX lookup failed.','error')}
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
 const changeZoom=(delta:number)=>setZoom(z=>Math.min(300,Math.max(30,Math.round(((z==='fit'?scaleRef.current:z)+delta)/10)*10)));

 const onMount:OnMount=(editor,monaco)=>{editorRef.current=editor;monacoRef.current=monaco;setEditorReady(true);editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>{setSaveState('Saved');notify('All changes saved','success')});editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.Enter,()=>compileRef.current());editor.onDidChangeCursorPosition((e:any)=>setCursor({line:e.position.lineNumber,col:e.position.column}));editor.onDidChangeCursorSelection((e:any)=>{const model=editor.getModel();setSelectionChars(model&&!e.selection.isEmpty()?model.getValueLengthInRange(e.selection):0)});editor.onDidDispose(()=>{editorRef.current=null;setEditorReady(false)})};
 // Jump once the editor shows the requested file, and show compile problems as squiggles in it.
 useEffect(()=>{if(editorReady)applyJump()},[editorReady,currentFile?.name]);
 useEffect(()=>{const ed=editorRef.current,m=monacoRef.current,model=ed?.getModel();if(!m||!model)return;const name=currentFile?.name;const entries=[...(result?.errors??[]).map(e=>({e,sev:m.MarkerSeverity.Error})),...(result?.warnings??[]).map(e=>({e,sev:m.MarkerSeverity.Warning}))].filter(x=>x.e.file===name&&x.e.line);m.editor.setModelMarkers(model,'latex',entries.map(({e,sev})=>({severity:sev,message:e.message,startLineNumber:e.line!,endLineNumber:e.line!,startColumn:1,endColumn:model.getLineMaxColumn(Math.min(e.line!,model.getLineCount()))})))},[result,editorReady,currentFile?.name]);
 const sortedProjects=useMemo(()=>projects.filter(p=>p.name.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>sortBy==='name'?a.name.localeCompare(b.name):b.modified-a.modified),[projects,query,sortBy]);
 const dashboard=activeTab!=='editor'||!project;
 useEffect(()=>{if(!dashboard&&editorReady&&!readFlag(TOUR_KEY))setTour(true)},[dashboard,editorReady]);
 const themeMenu=<ThemeMenu pref={theme.pref} resolved={theme.resolved} setPref={theme.setPref} open={openMenu==='theme'} toggle={()=>setOpenMenu(openMenu==='theme'?'':'theme')}/>;

 const menus:{label:string,items:MenuItem[]}[]=project?[
  {label:'File',items:[{label:'New file',icon:<FilePlus2 size={14}/>,run:()=>addFile()},{label:'New folder',icon:<FolderPlus size={14}/>,run:()=>addFile(true)},{label:'Upload files',icon:<Upload size={14}/>,run:()=>fileInput.current?.click()},'sep',{label:'Project history',icon:<ScrollText size={14}/>,run:()=>setModal('history')},{label:'Download project',icon:<FileArchive size={14}/>,run:downloadProject},{label:'Download PDF',icon:<Download size={14}/>,run:downloadPdf,disabled:!pdfUrl},'sep',{label:'Compile',icon:<Play size={14}/>,shortcut:`${mod}↵`,run:compile},'sep',{label:'Back to projects',icon:<Home size={14}/>,run:()=>setActiveTab('dashboard')}]},
  {label:'Edit',items:[{label:'Undo',shortcut:`${mod}Z`,run:()=>editorRef.current?.trigger('keyboard','undo',null)},{label:'Redo',shortcut:isMac?'⇧⌘Z':'Ctrl+Y',run:()=>editorRef.current?.trigger('keyboard','redo',null)},'sep',{label:'Find',shortcut:`${mod}F`,run:()=>edAction('actions.find')},{label:'Find and replace',shortcut:isMac?'⌥⌘F':'Ctrl+H',run:()=>edAction('editor.action.startFindReplaceAction')},'sep',{label:'Select all',shortcut:`${mod}A`,run:()=>edAction('editor.action.selectAll')},{label:`Review changes${project.changes?.length?` (${project.changes.length})`:''}`,icon:<ScrollText size={14}/>,run:()=>setModal('changes')},{label:'Comments',icon:<ScrollText size={14}/>,run:()=>setModal('comments')}]},
  {label:'Insert',items:[{label:'Section',run:()=>insert('\n\\section{Section title}\n')},{label:'Subsection',run:()=>insert('\n\\subsection{Subsection title}\n')},{label:'Equation',run:()=>insert('\n\\begin{equation}\n  \n\\end{equation}\n')},{label:'Figure',run:()=>insert('\n\\begin{figure}[ht]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{image.png}\n  \\caption{Caption}\n\\end{figure}\n')},{label:'Table',run:()=>insert('\n\\begin{table}[ht]\n  \\centering\n  \\begin{tabular}{cc}\n    A & B \\\\\n    1 & 2 \\\\\n  \\end{tabular}\n  \\caption{Caption}\n\\end{table}\n')},{label:'Bulleted list',run:()=>insert('\\begin{itemize}\n  \\item Item\n\\end{itemize}')},{label:'Citation',run:()=>insert('\\cite{}')}]},
  {label:'View',items:[...(narrow?[]:[{label:'Editor & PDF',checked:prefs.layout==='split',run:()=>setPref('layout','split')}]),{label:'Editor only',checked:prefs.layout==='editor'||(narrow&&layout==='editor'),run:()=>setPref('layout','editor')},{label:'PDF only',checked:layout==='pdf',run:()=>setPref('layout','pdf')},'sep',{label:'File tree',checked:sidebarOpen,run:()=>setSidebar(!sidebarOpen)},'sep',...themeOptions.map(o=>({label:`${o.label} theme`,icon:o.icon,checked:theme.pref===o.value,run:()=>theme.setPref(o.value)}))]},
  {label:'Help',items:[{label:'Ask the assistant',icon:<Sparkles size={14}/>,run:()=>setAssistantOpen(true)},{label:'Take the tour',icon:<Compass size={14}/>,run:()=>setTour(true)},'sep',{label:'Keyboard shortcuts',icon:<Keyboard size={14}/>,run:()=>setModal('shortcuts')},{label:'Project settings',icon:<Settings size={14}/>,run:()=>setModal('settings')},{label:'About PaperDesk',icon:<Info size={14}/>,run:()=>notify('PaperDesk is an independent LaTeX editor.')}]},
 ]:[];

 return <div className="app-shell">
 {dashboard?<>
  <header className="dash-header">
   <Brand/>
   <nav className="dash-nav"><button className={activeTab!=='templates'?'nav-active':''} onClick={()=>setActiveTab('dashboard')}>Projects</button><button className={activeTab==='templates'?'nav-active':''} onClick={()=>setActiveTab('templates')}>Templates</button></nav>
   <div className="dash-right">{themeMenu}<button className="icon-btn" title="Help" aria-label="Help" onClick={()=>notify('Open a project, then use Help → Take the tour, or the ? button, for a guided start.')}><HelpCircle size={17}/></button><button className="icon-btn" title="Notifications" aria-label="Notifications" onClick={()=>notify('You’re all caught up')}><Bell size={17}/></button><button className="avatar" title="Account settings" onClick={()=>notify('Account settings are not implemented yet')}>JD</button></div>
  </header>
  <main className="dash-main">
   <div className="dash-heading"><div><div className="eyebrow">Workspace / My projects</div><h1>{activeTab==='templates'?'Start from a template':'Your projects'}</h1><p className="subhead">{activeTab==='templates'?'Choose a starting point for your next document.':'Pick up where you left off.'}</p></div><button className="btn btn-primary" onClick={promptNewProject}><Plus size={16}/> New project</button></div>
   {activeTab==='templates'&&<div className="template-grid">{templateStarters.map(t=>{const icon=t.id==='beamer-template'?<Columns2 size={20}/>:t.id==='article-template'||t.id==='report-template'||t.id==='cv-template'?<FileText size={20}/>:<BookOpen size={20}/>;return <button className="template-card" key={t.id} onClick={()=>{const id=crypto.randomUUID();const p={id,name:t.name+' project',modified:Date.now(),mainFile:'main.tex',files:[{name:'main.tex',content:t.source},...(t.files??[])]};setProjects(x=>[p,...x]);setProjectId(id);setFileName('main.tex');setActiveTab('editor')}}><div className="template-icon">{icon}</div><strong>{t.name}</strong><span>{t.description}</span><em>Use template <ChevronRight size={14}/></em></button>})}</div>}
   <div className="section-bar"><div className="section-title"><h2>Recent projects</h2><span className="count-pill">{sortedProjects.length}</span></div><div className="dash-tools"><label className="search-box"><Search size={15}/><input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search projects…" aria-label="Search projects"/>{query?<button className="clear-search" aria-label="Clear search" onClick={()=>setQuery('')}><X size={13}/></button>:<kbd>{isMac?'⌘K':'Ctrl K'}</kbd>}</label><Dropdown id="sort" open={openMenu==='sort'} setOpen={setOpenMenu} align="right" trigger={<button className="btn btn-ghost btn-sm" onClick={()=>setOpenMenu(openMenu==='sort'?'':'sort')}>{sortBy==='name'?'Name':'Last modified'} <ChevronDown size={14}/></button>} items={[{label:'Last modified',checked:sortBy==='modified',run:()=>setSortBy('modified')},{label:'Name',checked:sortBy==='name',run:()=>setSortBy('name')}]}/></div></div>
   {sortedProjects.length?<div className="project-list" role="table"><div className="project-list-head" role="row"><span>Name</span><span>Last modified</span><span>Owner</span><span/></div>{sortedProjects.map((p,i)=><div className="project-row" role="row" key={p.id}><button className="project-open" onClick={()=>openProject(p)}><div className={`project-file-icon pfi-${i%4}`}><FileText size={18}/></div><div className="project-name-wrap"><strong>{p.name}</strong><small>{p.files.length} files{p.archived?' · Archived':''} · {p.files.map(f=>f.name).slice(0,2).join(', ')}</small></div></button><span className="muted date-text">{relative(p.modified)}</span><span className="owner"><span className="tiny-avatar">JD</span> You</span><div className="row-actions"><button className="icon-btn" title="Open" aria-label={`Open ${p.name}`} onClick={()=>openProject(p)}><ChevronRight size={17}/></button><Dropdown id={p.id} open={openMenu===p.id} setOpen={setOpenMenu} align="right" trigger={<button className="icon-btn" title="Project actions" aria-label="Project actions" onClick={()=>setOpenMenu(openMenu===p.id?'':p.id)}><MoreHorizontal size={18}/></button>} items={[{label:'Rename',icon:<Pencil size={14}/>,run:()=>renameProject(p)},{label:'Duplicate',icon:<Copy size={14}/>,run:()=>duplicate(p)},{label:p.archived?'Unarchive':'Archive',icon:<FileArchive size={14}/>,run:()=>setProjects(xs=>xs.map(x=>x.id===p.id?{...x,archived:!x.archived}:x))},'sep',{label:'Delete',icon:<Trash2 size={14}/>,danger:true,run:()=>deleteProject(p)}]}/></div></div>)}</div>
   :<div className="empty-state"><div className="empty-icon"><FileText size={24}/></div><h3>No projects found</h3><p>{query?'Try a different search.':'Create your first project to get started.'}</p>{!query&&<button className="btn btn-primary" onClick={promptNewProject}><Plus size={15}/> New project</button>}</div>}
   <div className="dash-footer"><span>PaperDesk <span className="dot">·</span> A thoughtful place to write</span><span>Projects are saved to the PaperDesk server and in this browser</span></div>
  </main>
 </>:<div className="editor-shell">
  <header className="editor-header">
   <button className="icon-btn chrome-btn" title="Back to projects" aria-label="Back to projects" onClick={()=>setActiveTab('dashboard')}><Home size={16}/></button>
   <span className="chrome-divider"/>
   <nav className="editor-menus" aria-label="Editor menu">
    {compact?<Dropdown id="menu-all" open={openMenu==='menu-all'} setOpen={setOpenMenu} trigger={<button className="text-menu" onClick={()=>setOpenMenu(openMenu==='menu-all'?'':'menu-all')}><Menu size={15}/> Menu</button>} groups={menus}/>
    :menus.map(m=><Dropdown key={m.label} id={'menu-'+m.label} open={openMenu==='menu-'+m.label} setOpen={setOpenMenu} trigger={<button className={`text-menu ${openMenu==='menu-'+m.label?'active':''}`} onClick={()=>setOpenMenu(openMenu==='menu-'+m.label?'':'menu-'+m.label)} onMouseEnter={()=>{if(openMenu.startsWith('menu-')&&openMenu!=='menu-'+m.label)setOpenMenu('menu-'+m.label)}}>{m.label}</button>} items={m.items}/>)}
   </nav>
   <button className="project-title" title="Rename project" onClick={()=>renameProject(project)}><span>{project.name}</span><Pencil size={12}/></button>
   <div className="header-right">
    <span className={`save-indicator ${saveState==='Saved'?'':'busy'} ${apiOnline===false?'offline':''}`} aria-live="polite" title={apiOnline===false?'The API is offline: changes are saved in this browser only.':'Changes are saved to the PaperDesk server.'}>{apiOnline===false?<CloudOff size={14}/>:<Cloud size={14}/>}<span className="hide-sm">{saveState==='Saved'&&apiOnline===false?'Saved in browser':saveState}</span></span>
    <div className="segmented" role="radiogroup" aria-label="Layout">
     {!narrow&&<button role="radio" aria-checked={prefs.layout==='split'} className={prefs.layout==='split'?'on':''} title="Editor & PDF" onClick={()=>setPref('layout','split')}><Columns2 size={15}/></button>}
     <button role="radio" aria-checked={layout==='editor'} className={layout==='editor'&&(narrow||prefs.layout==='editor')?'on':''} title="Editor only" onClick={()=>setPref('layout','editor')}><Code2 size={15}/>{narrow&&<span>Editor</span>}</button>
     <button role="radio" aria-checked={layout==='pdf'} className={layout==='pdf'?'on':''} title="PDF only" onClick={()=>setPref('layout','pdf')}><FileText size={15}/>{narrow&&<span>PDF</span>}</button>
    </div>
    <button className={`btn btn-sm assistant-toggle ${assistantOpen?'on':''}`} aria-pressed={assistantOpen} title="Assistant" onClick={()=>setAssistantOpen(!assistantOpen)}><Sparkles size={14}/><span className="hide-sm">Assistant</span></button>
    {!compact&&themeMenu}
    <button className="btn btn-secondary btn-sm hide-sm" onClick={()=>notify('Sharing and live collaboration are planned, not available yet')}><Share2 size={14}/> Share</button>
    {/* On phones these live in the Menu (View → theme, Edit → Comments, Help → Project settings). */}{!compact&&<><button className="icon-btn chrome-btn" title="Comments" aria-label="Comments" onClick={()=>setModal('comments')}><ScrollText size={16}/></button><button className="icon-btn chrome-btn" title="Settings" aria-label="Settings" onClick={()=>setModal('settings')}><Settings size={16}/></button></>}
   </div>
  </header>

  <div className="work-area" ref={workRef} style={{['--sidebar-w' as any]:`${prefs.sidebarWidth}px`,['--preview-pct' as any]:`${prefs.previewPct}%`}}>
   {narrow&&drawer&&<div className="drawer-backdrop" onClick={()=>setDrawer(false)}/>}
   <aside className={`file-sidebar ${sidebarOpen?'':'collapsed'} ${narrow?'drawer':''}`} aria-label="Project files">
    <div className="pane-toolbar side-head"><span className="pane-title">Files</span><span className="side-tools"><button className="icon-btn sm" title="New file" aria-label="New file" onClick={()=>addFile()}><FilePlus2 size={15}/></button><button className="icon-btn sm" title="New folder" aria-label="New folder" onClick={()=>addFile(true)}><FolderPlus size={15}/></button><button className="icon-btn sm" title="Upload files" aria-label="Upload files" onClick={()=>fileInput.current?.click()}><Upload size={14}/></button><button className="icon-btn sm" title="Hide file tree" aria-label="Hide file tree" onClick={()=>setSidebar(false)}><PanelLeft size={15}/></button></span></div>
    <div className="file-tree" role="tree">
     <TreeLevel nodes={buildTree(project.files)} depth={0} selected={currentFile?.name??''} collapsed={collapsed} onToggle={p=>setCollapsed(c=>{const n=new Set(c);if(n.has(p))n.delete(p);else n.add(p);return n})} onOpen={f=>{setFileName(f.name);if(narrow)setDrawer(false);if(layout==='pdf')setPref('layout',narrow?'editor':'split')}} onRename={renameFile} onDelete={deleteFile}/>
    </div>
    <div className="side-bottom"><button onClick={downloadProject}><FileArchive size={15}/> Download project</button><button onClick={()=>setModal('settings')}><Settings size={15}/> Project settings</button></div>
    <input ref={fileInput} className="hidden" type="file" multiple accept=".tex,.bib,.sty,.cls,.png,.jpg,.jpeg,.pdf,.csv,.txt,.zip" onChange={e=>uploadFiles(e.target.files)}/><input ref={zipInput} className="hidden" type="file" accept=".zip" onChange={e=>uploadFiles(e.target.files)}/>
   </aside>
   {sidebarOpen&&!narrow&&<Resizer label="Resize file tree" value={prefs.sidebarWidth} min={170} max={420} onChange={v=>setPref('sidebarWidth',v)} fromClientX={x=>x-(workRef.current?.getBoundingClientRect().left??0)} onReset={()=>setPref('sidebarWidth',232)}/>}

   {showEditor&&<main className="editor-main">
    <div className="pane-toolbar doc-bar">
     {!sidebarOpen&&<button className="icon-btn sm" title="Show file tree" aria-label="Show file tree" onClick={()=>setSidebar(true)}><PanelLeft size={15}/></button>}
     <div className="tabs" role="tablist">{tabFiles(project.files,currentFile?.name).map(f=><button role="tab" aria-selected={currentFile?.name===f.name} key={f.name} className={`doc-tab ${currentFile?.name===f.name?'active':''}`} onClick={()=>setFileName(f.name)} title={f.name}>{fileIcon(f)}<span>{f.name.split('/').pop()}</span></button>)}</div>
     <button className="icon-btn sm" title="New file" aria-label="New file" onClick={()=>addFile()}><Plus size={15}/></button>
    </div>
    <div className="pane-toolbar editor-toolbar" role="toolbar" aria-label="Formatting">
     <button className="tool" title={`Undo (${mod}Z)`} aria-label="Undo" onClick={()=>editorRef.current?.trigger('keyboard','undo',null)}><Undo2 size={15}/></button><button className="tool" title="Redo" aria-label="Redo" onClick={()=>editorRef.current?.trigger('keyboard','redo',null)}><Redo2 size={15}/></button><span className="tool-divider"/>
     <select className="style-select" aria-label="Paragraph style" value="Normal text" onChange={e=>{const v=e.target.value;if(v==='Section')insert('\\section{}');if(v==='Subsection')insert('\\subsection{}');if(v==='Subsubsection')insert('\\subsubsection{}')}}><option>Normal text</option><option>Section</option><option>Subsection</option><option>Subsubsection</option></select><span className="tool-divider"/>
     <button className="tool" title="Bold" aria-label="Bold" onClick={()=>insert('\\textbf{}')}><Bold size={15}/></button><button className="tool" title="Italic" aria-label="Italic" onClick={()=>insert('\\textit{}')}><Italic size={15}/></button><button className="tool" title="Underline" aria-label="Underline" onClick={()=>insert('\\underline{}')}><Underline size={15}/></button><span className="tool-divider"/>
     <button className="tool" title="Bulleted list" aria-label="Bulleted list" onClick={()=>insert('\\begin{itemize}\n  \\item Item\n\\end{itemize}')}><List size={15}/></button><button className="tool" title="Numbered list" aria-label="Numbered list" onClick={()=>insert('\\begin{enumerate}\n  \\item Item\n\\end{enumerate}')}><ListOrdered size={15}/></button><button className="tool" title="Table" aria-label="Table" onClick={()=>insert('\\begin{table}[ht]\n  \\centering\n  \\begin{tabular}{cc}\n    A & B \\\\\n    1 & 2 \\\\\n  \\end{tabular}\n  \\caption{Caption}\n\\end{table}')}><Table2 size={15}/></button><button className="tool" title="Equation" aria-label="Equation" onClick={()=>insert('\\[\n  \n\\]')}><Sigma size={15}/></button><button className="tool" title="Citation" aria-label="Citation" onClick={()=>insert('\\cite{}')}><Quote size={15}/></button><button className="tool" title="Reference" aria-label="Reference" onClick={()=>insert('\\ref{}')}><Link2 size={14}/></button><button className="tool" title="Figure" aria-label="Figure" onClick={()=>insert('\\includegraphics[width=0.8\\linewidth]{image.png}')}><ImageIcon size={15}/></button><span className="tool-divider"/><button className="tool" title="Sync source to PDF" aria-label="Sync source to PDF" onClick={syncSourceToPdf}><Link2 size={15}/></button>
    </div>
    <div className="editor-canvas">
     {currentFile&&!isEditable(currentFile)&&!currentFile.name.endsWith('/')?<div className="binary-file">{isImage(currentFile.name)&&currentFile.content?<img src={`data:${mimeType(currentFile.name)};base64,${currentFile.content}`} alt={currentFile.name}/>:<ImageIcon size={26}/>}<strong>{currentFile.name}</strong><p>{currentFile.content?`${formatBytes(Math.floor(currentFile.content.length*3/4))} · ${isBinary(currentFile.name)?'binary files':'files that aren’t UTF-8 text'} can’t be edited here; they’re included when the project compiles.`:'This file’s contents aren’t available in this browser. Re-upload it to include it in compiles.'}</p></div>
     :monacoState!=='ready'?<div className="pane-loading">{monacoState==='failed'?<><AlertCircle size={15}/> The editor couldn’t load. Reload the page to try again.</>:<><Spinner/> Loading editor…</>}</div>
     :<Editor height="100%" path={`${project.id}/${currentFile?.name??fileName}`} language={(currentFile?.name??fileName).endsWith('.bib')?'bibtex':'latex'} theme={theme.resolved==='dark'?'paperdesk-dark':'paperdesk-light'} beforeMount={setupMonaco} loading={<div className="pane-loading"><Spinner/> Loading editor…</div>} value={content} onChange={v=>setContent(v??'')} onMount={onMount} options={{fontFamily:"'DM Mono', ui-monospace, monospace",fontSize:13.5,lineHeight:22,minimap:{enabled:false},padding:{top:14,bottom:24},automaticLayout:true,wordWrap:'on',scrollBeyondLastLine:false,renderLineHighlight:'line',lineNumbers:'on',bracketPairColorization:{enabled:true},autoClosingBrackets:'always',autoClosingQuotes:'always',tabSize:2,folding:true,contextmenu:true,smoothScrolling:true,scrollbar:{verticalScrollbarSize:10,horizontalScrollbarSize:10}}}/>}
    </div>
    <div className="status-bar"><span className="status-save"><span className={saveState==='Saved'?'status-dot ok':'status-dot busy'}/> {saveState}</span>{currentFile&&isEditable(currentFile)?<><span>Ln {cursor.line}, Col {cursor.col}</span><span className="hide-sm">Spaces: 2</span><span className="hide-sm">UTF-8</span><span>{currentFile.name.endsWith('.bib')?'BibTeX':'LaTeX'}</span></>:<span>{currentFile?.encoding==='base64'&&!isBinary(currentFile.name)?'Read-only (not UTF-8)':'Binary file'}</span>}<button onClick={()=>setModal('shortcuts')}><Keyboard size={13}/> <span className="hide-sm">Shortcuts</span></button></div>
   </main>}

   {showEditor&&showPdf&&<Resizer label="Resize PDF preview" value={prefs.previewPct} min={25} max={70} onChange={v=>setPref('previewPct',v)} fromClientX={x=>{const r=workRef.current!.getBoundingClientRect();return Math.round((r.right-x)/r.width*1000)/10}} onReset={()=>setPref('previewPct',46)} invert/>}

   {showPdf&&<section className={`preview-panel ${showEditor?'':'full'}`} aria-label="PDF preview">
    <div className="pane-toolbar pdf-toolbar">
     <div className="split-btn" data-menu-root>
      <button className="btn btn-primary btn-sm compile-main" disabled={compiling} onClick={compile} title={`Recompile (${mod}↵)`}>{compiling?<Spinner light/>:<RefreshCw size={14}/>}{compiling?'Compiling…':'Recompile'}</button>
      <Dropdown id="engine" open={openMenu==='engine'} setOpen={setOpenMenu} trigger={<button className="btn btn-primary btn-sm compile-caret" aria-label="Compiler options" onClick={()=>setOpenMenu(openMenu==='engine'?'':'engine')}><ChevronDown size={14}/></button>} items={[...[['pdflatex','pdfLaTeX'],['xelatex','XeLaTeX'],['lualatex','LuaLaTeX']].map(([v,l])=>({label:l,checked:engine===v,run:()=>setEngine(v)}))]} heading="Compiler"/>
     </div>
     <button className={`btn btn-ghost btn-sm logs-btn ${compile_.status==='error'?'has-error':''}`} onClick={openLogs} title="View compile log"><ScrollText size={14}/><span className="hide-xs">Logs</span>{compile_.status==='error'&&<span className="err-badge" aria-label="Compile error">!</span>}</button>
     <span className="pdf-state"><span className={`status-dot ${pdfUrl?'ok':'idle'}`}/>{pdfUrl?'Up to date':'Not compiled'}</span>
     <div className="toolbar-spacer"/>
     <button className="icon-btn sm" title="Download PDF" aria-label="Download PDF" disabled={!pdfUrl} onClick={downloadPdf}><Download size={15}/></button>
     {showEditor&&<button className="icon-btn sm" title="Hide PDF preview" aria-label="Hide PDF preview" onClick={()=>setPref('layout','editor')}><X size={15}/></button>}
    </div>
    {compile_.status!=='idle'&&<div className={`compile-banner ${compile_.status}`} role={compile_.status==='error'?'alert':'status'}>
     {compile_.status==='running'?<Spinner/>:compile_.status==='success'?<CircleCheck size={15}/>:<AlertCircle size={15}/>}
     <span className="banner-text">{compile_.message}</span>
     {compile_.status==='error'&&<>{compile_.entry&&inProject(compile_.entry.file)&&<button className="banner-link" onClick={()=>jumpTo(compile_.entry!.file,compile_.entry!.line)}>Go to error</button>}<button className="banner-link" onClick={openLogs}>View log</button><button className="banner-close" aria-label="Dismiss" onClick={()=>setCompileState({status:'idle',message:''})}><X size={14}/></button></>}
    </div>}
    <div className="pdf-workspace">
     {pdfUrl?<PdfViewer url={pdfUrl} zoom={zoom} page={page} syncPoint={syncPoint} onSourceJump={syncPdfToSource} onLoaded={setPageTotal} onScale={s=>{scaleRef.current=s}}/>
     :<div className="pdf-empty"><div className="paper-placeholder"><FileText size={24}/><span>PDF</span></div><strong>Your document will appear here</strong><p>{apiOnline===false?<>The PaperDesk API isn’t running. Start everything with <code>npm run dev:all</code>.</>:health&&!health.docker?<>Docker isn’t running. Start Docker Desktop, then recompile.</>:health&&!health.image?<>The LaTeX compiler image isn’t built yet. Run <code>npm run compiler:build</code> once.</>:'Recompile to render a preview of your PDF.'}</p><button className="btn btn-primary" disabled={compiling} onClick={compile}>{compiling?<Spinner light/>:<Play size={13} fill="currentColor"/>} {compiling?'Compiling…':'Compile document'}</button></div>}
     {pdfUrl&&<div className="pdf-controls" role="toolbar" aria-label="PDF controls">
      <button title="Previous page" aria-label="Previous page" disabled={page<=1} onClick={()=>setPage(Math.max(1,page-1))}><ChevronLeft size={15}/></button>
      <span className="page-label"><strong>{page}</strong> / {pageTotal||'—'}</span>
      <button title="Next page" aria-label="Next page" disabled={!!pageTotal&&page>=pageTotal} onClick={()=>setPage(Math.min(pageTotal||page+1,page+1))}><ChevronRight size={15}/></button>
      <i/>
      <button title="Zoom out" aria-label="Zoom out" onClick={()=>changeZoom(-10)}><ZoomOut size={15}/></button>
      <span className="zoom-label">{zoom==='fit'?'Fit':`${zoom}%`}</span>
      <button title="Zoom in" aria-label="Zoom in" onClick={()=>changeZoom(10)}><ZoomIn size={15}/></button>
      <button title="Fit to width" aria-label="Fit to width" className={zoom==='fit'?'on':''} onClick={()=>setZoom('fit')}><Maximize2 size={14}/></button>
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

 {modal&&project&&<Modal title={modal==='settings'?'Settings':modal==='shortcuts'?'Keyboard shortcuts':modal==='history'?'Project history':modal==='changes'?'Track changes':modal==='comments'?'Comments':modal==='fix'?'Review suggested fix':'Compile log'} close={()=>setModal('')} wide={modal==='logs'||modal==='history'||modal==='changes'||modal==='fix'}>
  {modal==='fix'?(fixReview?<FixReview fix={fixReview} file={project.files.find(f=>f.name===fixReview.file)} onCancel={()=>{setFixReview(null);setModal('')}} onApply={()=>applyAssistantFix(fixReview)}/>:null):
modal==='history'?<div className="logs-body">{(project.versions??[]).length===0?<p className="muted">Snapshots are created as you edit this project.</p>:(project.versions??[]).map(v=><div className="history-version" key={v.id}><div className="history-version-head"><div><strong>{v.label}</strong><span>{new Date(v.created).toLocaleString()}</span></div><button className="btn btn-secondary btn-sm" onClick={()=>setDialog({title:'Restore version?',message:'Current project files will be replaced by this snapshot.',confirmLabel:'Restore',onConfirm:()=>{contentRef.current=v.files.find(f=>f.name===fileName)?.content??'';update(p=>({...p,files:v.files.map(f=>({...f}))}));notify('Version restored','success')}})}>Restore</button></div><SideBySideDiff before={v.files.find(f=>f.name===fileName)?.content??''} after={project.files.find(f=>f.name===fileName)?.content??''}/></div>)}<div className="modal-foot"><button className="btn btn-secondary" onClick={()=>askName('Label current version','Version label','', 'Save version',label=>{update(p=>({...p,versions:[{id:crypto.randomUUID(),label:label||'Version',created:Date.now(),files:p.files.map(f=>({...f}))},...(p.versions??[])].slice(0,30)}))})}>Label current version</button><button className="btn btn-primary" onClick={()=>setModal('')}>Close</button></div></div>:modal==='changes'?<div className="logs-body"><p className="muted">Review edits one at a time or apply a decision to every pending change.</p>{(project.changes??[]).length===0?<p className="muted">No pending tracked changes.</p>:(project.changes??[]).map(c=><div className="tracked-change" key={c.id}><div className="tracked-change-copy"><strong>{c.file}:{c.line}</strong><pre><span className="diff-removed">{c.beforeText||'∅'}</span><span className="diff-added">{c.afterText||'∅'}</span></pre></div><div className="tracked-change-actions"><button className="btn btn-secondary btn-sm" aria-label={`Accept change in ${c.file}`} onClick={()=>update(p=>({...p,changes:p.changes?.filter(x=>x.id!==c.id)}))}>Accept</button><button className="btn btn-secondary btn-sm" aria-label={`Reject change in ${c.file}`} onClick={()=>{const f=project.files.find(x=>x.name===c.file);if(!f){notify('This file no longer exists.','error');return}const restored=rejectEdit(f.content,c);if(restored===null){notify('This change conflicts with newer edits and could not be rejected.','error');return}if(c.file===fileName)contentRef.current=restored;update(p=>({...p,files:p.files.map(x=>x.name===c.file?{...x,content:restored}:x),changes:p.changes?.filter(x=>x.id!==c.id)}))}}>Reject</button></div></div>)}<div className="modal-foot"><button className="btn btn-secondary" disabled={!project.changes?.length} onClick={()=>update(p=>({...p,changes:[]}))}>Accept all</button><button className="btn btn-danger" disabled={!project.changes?.length} onClick={()=>{const files=project.files.map(f=>({...f}));const pending=[...(project.changes??[])].sort((a,b)=>a.file.localeCompare(b.file)||b.start-a.start);const rejected=new Set<string>();for(const c of pending){const i=files.findIndex(f=>f.name===c.file);if(i<0)continue;const target=files[i];if(!target)continue;const restored=rejectEdit(target.content,c);if(restored!==null){files[i]={...target,content:restored};rejected.add(c.id)}}contentRef.current=files.find(f=>f.name===fileName)?.content??contentRef.current;update(p=>({...p,files,changes:p.changes?.filter(c=>!rejected.has(c.id))}));if(rejected.size<pending.length)notify(`${pending.length-rejected.size} change(s) conflicted and remain pending.`,'error')}}>Reject all</button><button className="btn btn-primary" onClick={()=>setModal('')}>Close</button></div></div>:modal==='comments'?<div className="logs-body"><p className="muted">Comments are stored locally with this project.</p>{(project.comments??[]).map(c=><div className="field-row" key={c.id}><div><strong>{c.file}:{c.line}</strong><span>{c.text}</span></div><button className="btn btn-secondary btn-sm" onClick={()=>update(p=>({...p,comments:p.comments?.map(x=>x.id===c.id?{...x,resolved:!x.resolved}:x)}))}>{c.resolved?'Reopen':'Resolve'}</button></div>)}<div className="modal-foot"><button className="btn btn-secondary" onClick={()=>askName('Add comment','Comment', '', 'Add comment',text=>{if(!text.trim())return 'Enter a comment';update(p=>({...p,comments:[...(p.comments??[]),{id:crypto.randomUUID(),file:fileName,line:cursor.line,text:text.trim(),created:Date.now(),resolved:false}]}))})}>Add comment at cursor</button><button className="btn btn-primary" onClick={()=>setModal('')}>Close</button></div></div>:modal==='settings'?<div className="settings-body">
   <section><h4>Appearance</h4><div className="field-row"><div><strong>Theme</strong><span>Auto follows your operating system.</span></div><ThemeSegment pref={theme.pref} setPref={theme.setPref}/></div></section>
   <section><h4>Project</h4>
    <div className="field-row"><div><strong>Name</strong><span>{project.name}</span></div><button className="btn btn-secondary btn-sm" onClick={()=>{setModal('');renameProject(project)}}><Pencil size={13}/> Rename</button></div>
    <div className="field-row"><div><strong>Compiler</strong><span>Used by Recompile.</span></div><select className="select" value={engine} onChange={e=>setEngine(e.target.value)} aria-label="Compiler"><option value="pdflatex">pdfLaTeX</option><option value="xelatex">XeLaTeX</option><option value="lualatex">LuaLaTeX</option></select></div>
    <div className="field-row"><div><strong>Main document</strong><span>Choose the root .tex file to compile.</span></div><select className="select" aria-label="Main document" value={project.mainFile??'main.tex'} onChange={e=>update(p=>({...p,mainFile:e.target.value}))}>{project.files.filter(f=>f.name.endsWith('.tex')&&!f.name.includes('/')).map(f=><option key={f.name}>{f.name}</option>)}</select></div>
    <div className="field-row"><div><strong>Auto compile</strong><span>Compile after you pause editing.</span></div><input type="checkbox" checked={compilePrefs.autoCompile} onChange={e=>setCompilePrefs({...compilePrefs,autoCompile:e.target.checked})}/></div>
    <div className="field-row"><div><strong>Stop on first error</strong><span>Stop at the first TeX error.</span></div><input type="checkbox" checked={compilePrefs.stopOnFirstError} onChange={e=>setCompilePrefs({...compilePrefs,stopOnFirstError:e.target.checked})}/></div>
    <div className="field-row"><div><strong>Track changes</strong><span>Keep a before version for each edit.</span></div><input type="checkbox" checked={!!compilePrefs.trackChanges} onChange={e=>setCompilePrefs({...compilePrefs,trackChanges:e.target.checked})}/></div>
    <div className="field-row"><div><strong>Draft mode</strong><span>Faster preview without final graphics.</span></div><input type="checkbox" checked={compilePrefs.draft} onChange={e=>setCompilePrefs({...compilePrefs,draft:e.target.checked})}/></div>
    <div className="field-row"><div><strong>Compile timeout</strong><span>5 to {maxTimeoutSeconds} seconds for this server.</span></div><input className="select" type="number" min="5" max={maxTimeoutSeconds} value={compilePrefs.timeout} onChange={e=>setCompilePrefs({...compilePrefs,timeout:Math.max(5,Math.min(maxTimeoutSeconds,Number(e.target.value)||5))})}/></div>
    <div className="field-row"><div><strong>Clear cached files</strong><span>Remove the saved PDF and current log.</span></div><button className="btn btn-secondary btn-sm" onClick={async()=>{await apiFetch(`/api/projects/${projectId}/cache`,{method:'DELETE'});setPdfUrl('');setResult(null);setCompileState({status:'idle',message:''});notify('Cached files cleared','success')}}>Clear cache</button></div>
    <div className="field-row"><div><strong>Storage</strong><span>Browser local storage; synced to the API when it’s running.</span></div></div>
    <div className="field-row"><div><strong>Collaboration</strong><span>Sharing and real-time editing are not implemented yet.</span></div></div>
   </section>
   <div className="modal-foot"><button className="btn btn-secondary" onClick={downloadProject}><Download size={14}/> Download project</button><button className="btn btn-primary" onClick={()=>setModal('')}>Done</button></div>
  </div>
  :modal==='logs'?<div className="logs-body">
   {logState.loading?<div className="pane-loading inline"><Spinner/> Loading log…</div>:logState.error?<div className="inline-alert error"><AlertCircle size={15}/><span>{logState.error}</span></div>:!result?<p className="muted">No compilation has been run yet. Press Recompile ({mod}↵).</p>:<>
    <div className={`log-summary ${result.success?'ok':'failed'}`}>{result.success?<CircleCheck size={15}/>:<AlertCircle size={15}/>}<span>{result.success?'Compiled successfully':'Compilation failed'} · {result.errors.length} error{result.errors.length===1?'':'s'} · {result.warnings.length} warning{result.warnings.length===1?'':'s'} · {(result.durationMs/1000).toFixed(1)}s</span></div>
    {!rawLogs&&[['error',result.errors],['warning',result.warnings]].map(([kind,list])=>(list as LogEntry[]).length>0&&<ul className="log-entries" key={kind as string} aria-label={`${kind}s`}>{(list as LogEntry[]).map((e,i)=>{const linkable=inProject(e.file);return <li key={i} className="log-item"><button className={`log-entry ${kind}`} disabled={!linkable} onClick={()=>jumpTo(e.file,e.line)} title={linkable?`Go to ${e.file}${e.line?` line ${e.line}`:''}`:undefined}>{kind==='error'?<AlertCircle size={14}/>:<TriangleAlert size={14}/>}<span className="log-msg">{e.message}</span>{e.file&&<span className="log-loc">{e.file.split('/').slice(-2).join('/')}{e.line?`:${e.line}`:''}</span>}</button>{kind==='error'&&<ExplainButton entry={e} onExplain={explainError}/>}</li>})}</ul>)}
    <div className="log-view-toggle"><button className={!rawLogs?'on':''} onClick={()=>setRawLogs(false)}>Grouped</button><button className={rawLogs?'on':''} onClick={()=>setRawLogs(true)}>Raw log</button></div>{rawLogs?<pre className="raw-log">{result.log||'(empty)'}</pre>:<><div className="log-heading">Errors</div>{result.errors.length?null:<p className="muted">No errors.</p>}<div className="log-heading">Warnings</div>{result.warnings.length?null:<p className="muted">No warnings.</p>}<div className="log-heading">Typesetting info</div><p className="muted">Compile time: {(result.durationMs/1000).toFixed(1)}s</p><pre className="typeset-info">{result.log.split(/\r?\n/).filter(line=>/Overfull|Underfull|LaTeX Font|Package .* Info|Warning/.test(line)).join('\n')||'No additional typesetting information.'}</pre></>}
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


function TreeLevel({nodes,depth,selected,collapsed,onToggle,onOpen,onRename,onDelete}:{nodes:TreeNode[],depth:number,selected:string,collapsed:Set<string>,onToggle:(p:string)=>void,onOpen:(f:ProjectFile)=>void,onRename:(f:ProjectFile)=>void,onDelete:(f:ProjectFile)=>void}){
 return <>{nodes.map(n=>{const open=!collapsed.has(n.path);return <div key={n.path} role="treeitem" aria-expanded={n.folder?open:undefined} aria-selected={selected===n.path}>
  <div className={`file-row ${selected===n.path?'selected':''}`} style={{paddingLeft:8+depth*14}} tabIndex={0} onClick={()=>n.folder?onToggle(n.path):onOpen(n.file)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();if(n.folder)onToggle(n.path);else onOpen(n.file)}}}>
   <span className="tree-caret">{n.folder?(open?<ChevronDown size={13}/>:<ChevronRight size={13}/>):null}</span>
   {n.folder?(open?<FolderOpen size={15}/>:<Folder size={15}/>):fileIcon(n.file)}
   <span className="file-label">{n.name}</span>
   <span className="file-actions"><button title="Rename" aria-label={`Rename ${n.name}`} onClick={e=>{e.stopPropagation();onRename(n.file)}}><Pencil size={12}/></button><button className="danger" title="Delete" aria-label={`Delete ${n.name}`} onClick={e=>{e.stopPropagation();onDelete(n.file)}}><Trash2 size={12}/></button></span>
  </div>
  {n.folder&&open&&(n.children.length?<TreeLevel nodes={n.children} depth={depth+1} selected={selected} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} onRename={onRename} onDelete={onDelete}/>:<div className="file-row empty-folder" style={{paddingLeft:30+depth*14}}>Empty folder</div>)}
 </div>})}</>;
}

function fileIcon(f:ProjectFile){return f.name.endsWith('.tex')?<FileCode2 size={15} className="fi fi-tex"/>:f.name.endsWith('.bib')?<BookOpen size={15} className="fi fi-bib"/>:f.name.endsWith('/')?<FolderOpen size={15}/>:isBinary(f.name)?<ImageIcon size={15} className="fi fi-img"/>:<File size={15} className="fi"/>}
function formatBytes(n:number){return n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`}
function downloadBlob(blob:Blob,name:string){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),3000)}

function PdfViewer({url,zoom,page,onLoaded,onScale,syncPoint,onSourceJump}:{url:string,zoom:Zoom,page:number,onLoaded:(n:number)=>void,onScale:(pct:number)=>void,syncPoint:{page:number,x:number,y:number}|null,onSourceJump:(page:number,x:number,y:number)=>void}){
 const canvasRef=useRef<HTMLCanvasElement>(null),boxRef=useRef<HTMLDivElement>(null),docRef=useRef<{url:string,doc:any}|null>(null),taskRef=useRef<any>(null),viewportRef=useRef<any>(null),cbRef=useRef({onLoaded,onScale,onSourceJump});cbRef.current={onLoaded,onScale,onSourceJump};
 const [loading,setLoading]=useState(true),[err,setErr]=useState(''),[width,setWidth]=useState(0);
 useEffect(()=>{const el=boxRef.current;if(!el)return;let raf=0;const ro=new ResizeObserver(()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>setWidth(el.clientWidth))});ro.observe(el);return()=>{ro.disconnect();cancelAnimationFrame(raf)}},[]);
 const render=useCallback(async(cancelled:()=>boolean)=>{
  try{
   setErr('');
   const pdfjs=await import('pdfjs-dist');pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString();
   if(docRef.current?.url!==url){setLoading(true);docRef.current?.doc.destroy?.();docRef.current={url,doc:await pdfjs.getDocument(url).promise}}
   const pdf=docRef.current!.doc;if(cancelled())return;cbRef.current.onLoaded(pdf.numPages);
   const p=await pdf.getPage(Math.min(Math.max(1,page),pdf.numPages));if(cancelled())return;
   const base=p.getViewport({scale:1});const scale=zoom==='fit'?Math.max(.3,((boxRef.current?.clientWidth??600)-40)/base.width):zoom/100;cbRef.current.onScale(Math.round(scale*100));
   const viewport=p.getViewport({scale});viewportRef.current=viewport;const canvas=canvasRef.current;if(!canvas)return;const ctx=canvas.getContext('2d');if(!ctx)return;
   const dpr=window.devicePixelRatio||1;taskRef.current?.cancel();
   canvas.width=Math.floor(viewport.width*dpr);canvas.height=Math.floor(viewport.height*dpr);canvas.style.width=`${Math.floor(viewport.width)}px`;canvas.style.height=`${Math.floor(viewport.height)}px`;
   const task=p.render({canvasContext:ctx,viewport,transform:dpr!==1?[dpr,0,0,dpr,0,0]:undefined});taskRef.current=task;await task.promise;if(!cancelled()){setLoading(false);if(syncPoint?.page===page){const [,y]=viewport.convertToViewportPoint(syncPoint.x,syncPoint.y);if(boxRef.current)boxRef.current.scrollTop=Math.max(0,y-boxRef.current.clientHeight/2)}}
  }catch(e:any){if(e?.name==='RenderingCancelledException'||cancelled())return;setLoading(false);setErr(e?.status===404||/Missing PDF|404/.test(String(e?.message))?'No compiled PDF was found. Recompile the project to generate it.':e instanceof Error?`Couldn’t display the PDF: ${e.message}`:'Couldn’t display the PDF.')}
 },[url,zoom,page,width,syncPoint]);
 useEffect(()=>{let c=false;render(()=>c);return()=>{c=true}},[render]);
 useEffect(()=>()=>{taskRef.current?.cancel();docRef.current?.doc.destroy?.()},[]);
 return <div className="pdf-scroll" ref={boxRef}>{err?<div className="pdf-error" role="alert"><AlertCircle size={18}/><span>{err}</span></div>:<><canvas ref={canvasRef} aria-label={`PDF page ${page}`} title="Click to jump to source" className={loading?'is-loading':''} onClick={e=>{const canvas=canvasRef.current,viewport=viewportRef.current;if(!canvas||!viewport)return;const rect=canvas.getBoundingClientRect();const [x,y]=viewport.convertToPdfPoint(e.clientX-rect.left,e.clientY-rect.top);cbRef.current.onSourceJump(page,x,y)}}/>{loading&&<div className="pane-loading overlay"><Spinner/> Rendering PDF…</div>}</>}</div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
