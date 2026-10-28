import postgres from 'npm:postgres@3.4.5';
import {Store,type Sql} from './store.ts';
import {Service} from './service.ts';
import {handler} from './http.ts';
const sql=postgres(Deno.env.get('SUPABASE_DB_URL')!,{prepare:false,max:2,idle_timeout:20});
const store=new Store(sql as unknown as Sql);
const service=new Service(store,{key:Deno.env.get('XAI_API_KEY'),model:Deno.env.get('RESEARCH_AI_MODEL')??'grok-4.3'});
Deno.serve(handler({service,tokens:()=>store.tokens(),origins:(Deno.env.get('RESEARCH_ALLOWED_ORIGINS')??'null,http://localhost:8000,https://chatgpt.com').split(',').map(s=>s.trim()).filter(Boolean)}));
