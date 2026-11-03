import { defineConfig } from 'vite'; import react from '@vitejs/plugin-react';
// Monaco is a large but lazily loaded chunk, so the warning threshold is raised to fit it.
export default defineConfig({base:'/',plugins:[react()],build:{chunkSizeWarningLimit:4000},
// Pre-bundle Monaco up front; discovering it on first use makes Vite reload the page mid-session.
// The e2e dev server gets its own dependency cache so it can't clash with a running `npm run dev`.
cacheDir:process.env.PAPERDESK_VITE_CACHE ?? 'node_modules/.vite',
optimizeDeps:{include:['monaco-editor/esm/vs/editor/edcore.main','@monaco-editor/react']},server:{port:5173,proxy:{'/api':{target:process.env.PAPERDESK_API_PROXY ?? 'http://localhost:3001',changeOrigin:true},'/socket.io':{target:process.env.PAPERDESK_API_PROXY ?? 'http://localhost:3001',ws:true}}}});
