import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { providers, methods } from '../runtime/model-runtime.mjs';
const upstream = await readFile(path.join(process.argv[2] ?? '../deepseek-harness', 'packages/llm/llm-pi-ai/src/provider-data.generated.ts'), 'utf8');
const envs = new Map([...upstream.matchAll(/^  '([^']+)': \{ env: \[([^\]]*)\]/gm)].map(m => [m[1], [...m[2].matchAll(/'([^']+)'/g)].map(x => x[1])]));
const catalog = providers.map(p => ({
  id:p.id, name:p.name, baseUrl:p.baseUrl??'', envKey:(envs.get(p.id)??[]).find(v=>/API_KEY|TOKEN|HF_TOKEN/.test(v))??'', protocol:'pi-ai', methods:methods(p),
  models:p.getModels().map(m=>({...m,ownedBy:p.id,protocol:'pi-ai'})),
}));
await writeFile('src/lib/provider-catalog.json',JSON.stringify(catalog));
console.log(catalog.map(p=>p.id+':'+p.models.length).join(', '));
