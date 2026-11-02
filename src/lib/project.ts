/** Pure project/file helpers shared by the UI. Kept free of React so they can be unit-tested. */
/** Text files hold UTF-8 in `content`; binary files (figures, PDFs) hold base64 and set `encoding`. */
export type ProjectFile={name:string,content:string,kind?:string,encoding?:'base64'};
export type Project={id:string,name:string,modified:number,files:ProjectFile[],compiled?:string,mainFile?:string,archived?:boolean,settings?:{autoCompile:boolean,stopOnFirstError:boolean,draft:boolean,timeout:number},versions?:{id:string,label:string,created:number,files:ProjectFile[]}[],comments?:{id:string,file:string,line:number,text:string,created:number,resolved:boolean}[]};

export const isBinary=(name:string)=>/\.(png|jpe?g|gif|bmp|tiff?|pdf|eps|ps|zip|gz|ttf|otf|woff2?)$/i.test(name);
export const isImage=(name:string)=>/\.(png|jpe?g|gif|bmp)$/i.test(name);

/**
 * Normalizes a file from the API or from browser storage. Text must never carry `encoding`:
 * an older client kept encoding:'base64' on files it had already decoded, which made saves and compiles write garbage.
 */
export function normalizeFile(f:ProjectFile,source:'server'|'storage'):ProjectFile{
 const {encoding,...rest}=f;
 if(rest.name.endsWith('/'))return {...rest,content:''};
 if(isBinary(rest.name))return encoding==='base64'?{...rest,encoding}:{...rest,content:''};
 if(encoding==='base64'){
  // Text sent as base64 is either valid UTF-8 (decode it) or another encoding such as Latin-1 (keep the bytes, read-only).
  // Older clients stored already-decoded text tagged as base64; that content isn't valid base64.
  const looksBase64=/^[A-Za-z0-9+/]*={0,2}$/.test(rest.content)&&rest.content.length%4===0;
  if(source==='storage'&&!looksBase64)return {...rest,content:rest.content??''};
  const text=decodeBase64Utf8Strict(rest.content);
  return text===null?{...rest,encoding}:{...rest,content:text};
 }
 return {...rest,content:rest.content??''};
}
/** Whether a file can be edited as text in the editor. */
export const isEditable=(f:ProjectFile)=>!isBinary(f.name)&&f.encoding!=='base64'&&!f.name.endsWith('/');
export const normalizeProject=(p:Project,source:'server'|'storage'):Project=>({...p,files:(p.files??[]).map(f=>normalizeFile(f,source))});

/**
 * Merges projects from the API into the local list. Whichever copy was modified last wins;
 * returns the merged list and the local projects the server is missing or has older copies of.
 */
export function mergeProjects(local:Project[],remote:Project[]){
 const byId=new Map(remote.map(p=>[p.id,p]));
 const merged:Project[]=[];const upload:Project[]=[];
 for(const l of local){const r=byId.get(l.id);byId.delete(l.id);if(r&&r.modified>=l.modified)merged.push(r);else{merged.push(l);upload.push(l)}}
 return {merged:[...merged,...byId.values()],upload};
}

export function arrayBufferToBase64(buf:ArrayBuffer){const bytes=new Uint8Array(buf);let bin='';for(let i=0;i<bytes.length;i+=0x8000)bin+=String.fromCharCode(...bytes.subarray(i,i+0x8000));return btoa(bin)}
export const mimeType=(name:string)=>({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',pdf:'application/pdf'} as Record<string,string>)[name.split('.').pop()!.toLowerCase()]??'application/octet-stream';

export type TreeNode={name:string,path:string,folder:boolean,children:TreeNode[],file:ProjectFile};
/** Builds a folder tree from flat paths. Folder entries end with "/"; folders sort before files. */
export function buildTree(files:ProjectFile[]):TreeNode[]{
 const root:TreeNode[]=[];
 const folder=(list:TreeNode[],name:string,path:string)=>{let n=list.find(x=>x.folder&&x.name===name);if(!n){n={name,path,folder:true,children:[],file:{name:path,content:''}};list.push(n)}return n};
 for(const f of files){const isFolder=f.name.endsWith('/');const parts=f.name.replace(/\/$/,'').split('/');let list=root,path='';
  parts.forEach((part,i)=>{path+=part+(i<parts.length-1||isFolder?'/':'');if(i<parts.length-1||isFolder){const n=folder(list,part,path);if(i===parts.length-1)n.file=f;list=n.children}else list.push({name:part,path:f.name,folder:false,children:[],file:f})})}
 const sort=(l:TreeNode[])=>{l.sort((a,b)=>a.folder!==b.folder?(a.folder?-1:1):a.name.localeCompare(b.name));l.forEach(n=>sort(n.children));return l};
 return sort(root);
}

/** Up to five tabs, always including the active file. */
export function tabFiles(files:ProjectFile[],active?:string){const list=files.filter(f=>!f.name.endsWith('/'));const tabs=list.slice(0,5);const cur=list.find(f=>f.name===active);if(cur&&!tabs.includes(cur))tabs[tabs.length-1]=cur;return tabs}
export function relative(date:number){const m=Math.max(0,Math.floor((Date.now()-date)/60000));if(m<1)return'Just now';if(m<60)return`${m} min ago`;const h=Math.floor(m/60);if(h<24)return`${h} hr ago`;const d=Math.floor(h/24);if(d<7)return`${d} days ago`;return new Date(date).toLocaleDateString('en',{month:'short',day:'numeric'})}
export function decodeBase64Utf8(value:string){try{return new TextDecoder().decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0)))}catch{return ''}}
export function decodeBase64Utf8Strict(value:string){try{return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value),c=>c.charCodeAt(0)))}catch{return null}}
/** The file to open first: main.tex if present, else the first editable text file, else the first file. */
export function defaultFile(files:ProjectFile[]){return (files.find(f=>f.name==='main.tex')??files.find(f=>f.name.endsWith('.tex'))??files.find(isEditable)??files.find(f=>!f.name.endsWith('/')))?.name??'main.tex'}
