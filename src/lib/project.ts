/** Pure project/file helpers shared by the UI. Kept free of React so they can be unit-tested. */
export type ProjectFile={name:string,content:string,kind?:string};
export type Project={id:string,name:string,modified:number,files:ProjectFile[],compiled?:string};

export const isBinary=(name:string)=>/\.(png|jpe?g|gif|pdf)$/i.test(name);

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
